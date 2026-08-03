use std::{net::SocketAddr, sync::Arc};

use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, Path, Query, State},
    http::{
        HeaderMap, StatusCode,
        header::{self, HeaderValue},
    },
    response::{IntoResponse, Response},
    routing::{delete, get, patch, post},
};
use axum_extra::extract::cookie::{Cookie, CookieJar, SameSite};
use chrono::Utc;
use futures_util::TryStreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    auth::{
        AuthContext, AuthMethod, SESSION_COOKIE, create_session, delete_session, hash_password,
        matching_trusted_access_rule_for_request, normalize_domain, permissions_allow,
        permissions_allow_traversal, require_access, revoke_other_sessions, user_permissions,
        verify_password,
    },
    config::StorageConfig,
    error::{AppError, AppResult},
    models::{
        Access, CreateDirectoryRequest, CreateUserRequest, FileEntry, GrantPermissionRequest,
        LoginOptionsRequest, LoginOptionsView, LoginRequest, MoveRequest, PermissionRecord,
        RuntimeSettingsView, SaveStorageConnectionRequest, SaveTrustedAccessRuleRequest,
        SessionView, StorageConnectionRecord, StorageConnectionView, StorageView,
        TrustedAccessRuleRecord, TrustedAccessRuleView, UpdateAccountRequest,
        UpdateRuntimeSettingsRequest, UpdateUserRequest, UserRecord, UserView,
    },
    state::{AppState, parse_cidrs},
    storage::{Storage, build_storage, normalize_path, path_is_within, paths_equal},
};

const MAX_SEARCH_LIMIT: usize = 500;
const MAX_SEARCH_SCANNED: usize = 50_000;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/login-options", post(login_options))
        .route("/api/auth/login", post(login))
        .route("/api/auth/session", get(current_session).delete(logout))
        .route("/api/account", patch(update_account))
        .route("/api/storages", get(list_storages))
        .route(
            "/api/files/{storage_id}",
            get(list_files).put(upload_file).delete(delete_file),
        )
        .route("/api/files/{storage_id}/directory", post(create_directory))
        .route("/api/files/{storage_id}/download", get(download_file))
        .route("/api/files/{storage_id}/move", post(move_file))
        .route("/api/search/{storage_id}", get(search_files))
        .route("/api/admin/users", get(list_users).post(create_user))
        .route("/api/admin/users/{user_id}", patch(update_user))
        .route(
            "/api/admin/trusted-access",
            get(list_trusted_access_rules).post(create_trusted_access_rule),
        )
        .route(
            "/api/admin/trusted-access/{rule_id}",
            patch(update_trusted_access_rule).delete(delete_trusted_access_rule),
        )
        .route(
            "/api/admin/settings",
            get(get_runtime_settings).put(update_runtime_settings),
        )
        .route(
            "/api/admin/storage-connections",
            get(list_storage_connections).post(create_storage_connection),
        )
        .route(
            "/api/admin/storage-connections/{storage_id}",
            patch(update_storage_connection).delete(delete_storage_connection),
        )
        .route(
            "/api/admin/permissions",
            get(list_permissions).post(grant_permission),
        )
        .route(
            "/api/admin/permissions/{permission_id}",
            delete(delete_permission),
        )
        .with_state(state)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn login_options(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<LoginOptionsRequest>,
) -> AppResult<Json<LoginOptionsView>> {
    let user_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM users WHERE username = ? AND is_active = 1")
            .bind(request.username.trim())
            .fetch_optional(&state.pool)
            .await?;
    let password_required = if let Some(user_id) = user_id {
        matching_trusted_access_rule_for_request(&state, &user_id, peer.ip(), &headers)
            .await?
            .is_none()
    } else {
        true
    };
    Ok(Json(LoginOptionsView { password_required }))
}

async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    jar: CookieJar,
    Json(request): Json<LoginRequest>,
) -> AppResult<impl IntoResponse> {
    let user = sqlx::query_as::<_, UserRecord>(
        "SELECT id, username, password_hash, role, is_active, created_at FROM users WHERE username = ? AND is_active = 1",
    )
    .bind(request.username.trim())
    .fetch_optional(&state.pool)
    .await?;
    let Some(user) = user else {
        return Err(AppError::Unauthorized);
    };
    let method = if matching_trusted_access_rule_for_request(&state, &user.id, peer.ip(), &headers)
        .await?
        .is_some()
    {
        AuthMethod::Bypass
    } else {
        let Some(password) = request.password else {
            return Err(AppError::Unauthorized);
        };
        let Some(encoded) = user.password_hash.clone() else {
            return Err(AppError::Unauthorized);
        };
        if !verify_password(password, encoded)
            .await
            .map_err(AppError::Internal)?
        {
            return Err(AppError::Unauthorized);
        }
        AuthMethod::Session
    };

    let token = create_session(&state, &user.id, method).await?;
    let secure_cookies = state.settings.load().secure_cookies;
    let cookie = Cookie::build((SESSION_COOKIE, token))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(secure_cookies)
        .build();
    Ok((
        jar.add(cookie),
        Json(SessionView {
            user: user.into(),
            auth_method: method.as_str().into(),
        }),
    ))
}

async fn current_session(auth: AuthContext) -> Json<SessionView> {
    Json(SessionView {
        user: auth.user.into(),
        auth_method: auth.method.as_str().into(),
    })
}

async fn logout(State(state): State<AppState>, jar: CookieJar) -> AppResult<impl IntoResponse> {
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        delete_session(&state, cookie.value()).await?;
    }
    let removal = Cookie::build(SESSION_COOKIE).path("/").build();
    Ok((jar.remove(removal), StatusCode::NO_CONTENT))
}

async fn update_account(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<UpdateAccountRequest>,
) -> AppResult<Json<UserView>> {
    if matches!(auth.method, AuthMethod::Bypass) {
        return Err(AppError::BadRequest(
            "trusted-network accounts must be managed by an administrator".into(),
        ));
    }
    let username = validate_username(&request.username)?;
    let Some(current_hash) = auth.user.password_hash.clone() else {
        return Err(AppError::BadRequest(
            "this account does not have a password".into(),
        ));
    };
    if !verify_password(request.current_password, current_hash)
        .await
        .map_err(AppError::Internal)?
    {
        return Err(AppError::Unauthorized);
    }

    let new_password = request.new_password.filter(|password| !password.is_empty());
    let new_password_hash = if let Some(password) = new_password {
        validate_password(&password)?;
        Some(hash_password(password).await.map_err(AppError::Internal)?)
    } else {
        None
    };
    let result = sqlx::query(
        "UPDATE users SET username = ?, password_hash = COALESCE(?, password_hash) WHERE id = ?",
    )
    .bind(&username)
    .bind(&new_password_hash)
    .bind(&auth.user.id)
    .execute(&state.pool)
    .await;
    handle_user_write(result)?;

    if new_password_hash.is_some() {
        revoke_other_sessions(&state, &auth.user.id, auth.session_hash.as_deref()).await?;
    }
    let user = fetch_user(&state, &auth.user.id).await?;
    Ok(Json(user.into()))
}

async fn list_storages(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<StorageView>>> {
    let mut result = Vec::new();
    let storages = state.storages.load();
    for storage in storages.values() {
        let permissions = user_permissions(&state, &auth, &storage.id).await?;
        let is_admin = auth.user.role == "admin";
        let can_read = is_admin
            || permissions
                .iter()
                .any(|permission| grants(permission, Access::Read));
        if !can_read {
            continue;
        }
        let roots = if is_admin {
            vec![String::new()]
        } else {
            visible_roots(&permissions)
        };
        result.push(StorageView {
            id: storage.id.clone(),
            name: storage.name.clone(),
            kind: storage.kind.clone(),
            can_read,
            can_write: is_admin
                || permissions
                    .iter()
                    .any(|permission| grants(permission, Access::Write)),
            can_manage: is_admin
                || permissions
                    .iter()
                    .any(|permission| grants(permission, Access::Manage)),
            roots,
        });
    }
    result.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

async fn list_files(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<PathQuery>,
) -> AppResult<Json<Vec<FileEntry>>> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&query.path, true).map_err(bad_request)?;
    let permissions = user_permissions(&state, &auth, &storage_id).await?;
    let is_admin = auth.user.role == "admin";
    if !is_admin && !permissions_allow_traversal(&permissions, &path) {
        return Err(AppError::Forbidden);
    }
    let entries = storage.operator.list(&path).await?;
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        if paths_equal(entry.path(), &path) {
            continue;
        }
        if !is_admin && !permissions_allow_traversal(&permissions, entry.path()) {
            continue;
        }
        result.push(file_entry(entry.path(), entry.metadata()));
    }
    result.sort_by(|left, right| {
        let left_dir = left.kind == "directory";
        let right_dir = right.kind == "directory";
        right_dir
            .cmp(&left_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(Json(result))
}

async fn download_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<PathQuery>,
) -> AppResult<Response> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&query.path, false).map_err(bad_request)?;
    if path.is_empty() {
        return Err(AppError::BadRequest("a file path is required".into()));
    }
    require_access(&state, &auth, &storage_id, &path, Access::Read).await?;
    let metadata = storage.operator.stat(&path).await?;
    if metadata.is_dir() {
        return Err(AppError::BadRequest("cannot download a directory".into()));
    }
    let reader = storage.operator.reader(&path).await?;
    let stream = reader.into_bytes_stream(..).await?;
    let filename = path.rsplit('/').next().unwrap_or("download");
    let safe_filename: String = filename
        .chars()
        .filter(|character| !matches!(character, '"' | '\r' | '\n'))
        .collect();
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(
            mime_guess::from_path(&path)
                .first_or_octet_stream()
                .as_ref(),
        )
        .map_err(|error| AppError::Internal(error.into()))?,
    );
    response.headers_mut().insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&metadata.content_length().to_string())
            .map_err(|error| AppError::Internal(error.into()))?,
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{safe_filename}\""))
            .map_err(|error| AppError::Internal(error.into()))?,
    );
    Ok(response)
}

async fn upload_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<PathQuery>,
    body: Body,
) -> AppResult<StatusCode> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&query.path, false).map_err(bad_request)?;
    if path.is_empty() {
        return Err(AppError::BadRequest("a file path is required".into()));
    }
    require_access(&state, &auth, &storage_id, &path, Access::Write).await?;
    let max_upload_bytes = state.settings.load().max_upload_bytes;
    let bytes = to_bytes(body, max_upload_bytes)
        .await
        .map_err(|_| AppError::BadRequest("upload exceeds configured size limit".into()))?;
    storage.operator.write(&path, bytes).await?;
    Ok(StatusCode::CREATED)
}

async fn create_directory(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Json(request): Json<CreateDirectoryRequest>,
) -> AppResult<StatusCode> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&request.path, true).map_err(bad_request)?;
    if path.is_empty() {
        return Err(AppError::BadRequest("a directory path is required".into()));
    }
    require_access(&state, &auth, &storage_id, &path, Access::Write).await?;
    storage.operator.create_dir(&path).await?;
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
struct DeleteQuery {
    path: String,
    #[serde(default)]
    recursive: bool,
}

async fn delete_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<DeleteQuery>,
) -> AppResult<StatusCode> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&query.path, query.recursive).map_err(bad_request)?;
    if path.is_empty() {
        return Err(AppError::BadRequest(
            "deleting a storage root is not allowed".into(),
        ));
    }
    require_access(&state, &auth, &storage_id, &path, Access::Write).await?;
    if query.recursive {
        storage.operator.delete_with(&path).recursive(true).await?;
    } else {
        storage.operator.delete(&path).await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn move_file(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Json(request): Json<MoveRequest>,
) -> AppResult<StatusCode> {
    let storage = get_storage(&state, &storage_id)?;
    let from = normalize_path(&request.from, request.from.ends_with('/')).map_err(bad_request)?;
    let to = normalize_path(&request.to, request.to.ends_with('/')).map_err(bad_request)?;
    if from.is_empty() || to.is_empty() {
        return Err(AppError::BadRequest(
            "source and destination paths are required".into(),
        ));
    }
    require_access(&state, &auth, &storage_id, &from, Access::Write).await?;
    require_access(&state, &auth, &storage_id, &to, Access::Write).await?;
    storage.operator.rename(&from, &to).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    #[serde(default)]
    path: String,
    limit: Option<usize>,
}

async fn search_files(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<Vec<FileEntry>>> {
    let storage = get_storage(&state, &storage_id)?;
    let base = normalize_path(&query.path, true).map_err(bad_request)?;
    let permissions = user_permissions(&state, &auth, &storage_id).await?;
    let is_admin = auth.user.role == "admin";
    if !is_admin && !permissions_allow(&permissions, &base, Access::Read) {
        return Err(AppError::Forbidden);
    }
    let needle = query.q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Json(Vec::new()));
    }
    let limit = query.limit.unwrap_or(100).clamp(1, MAX_SEARCH_LIMIT);
    let mut lister = storage.operator.lister_with(&base).recursive(true).await?;
    let mut result = Vec::new();
    let mut scanned = 0;
    while let Some(entry) = lister.try_next().await? {
        scanned += 1;
        if scanned > MAX_SEARCH_SCANNED || result.len() >= limit {
            break;
        }
        if paths_equal(entry.path(), &base) {
            continue;
        }
        if !is_admin && !permissions_allow(&permissions, entry.path(), Access::Read) {
            continue;
        }
        let name = entry
            .path()
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or("");
        if name.to_lowercase().contains(&needle) {
            result.push(file_entry(entry.path(), entry.metadata()));
        }
    }
    Ok(Json(result))
}

async fn list_users(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<UserView>>> {
    require_admin(&auth)?;
    let users = sqlx::query_as::<_, UserRecord>(
        "SELECT id, username, password_hash, role, is_active, created_at FROM users ORDER BY username",
    )
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(UserView::from)
    .collect();
    Ok(Json(users))
}

async fn create_user(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<CreateUserRequest>,
) -> AppResult<(StatusCode, Json<UserView>)> {
    require_admin(&auth)?;
    let username = validate_username(&request.username)?;
    validate_password(&request.password)?;
    validate_role(&request.role)?;
    let user = UserRecord {
        id: Uuid::now_v7().to_string(),
        username,
        password_hash: Some(
            hash_password(request.password)
                .await
                .map_err(AppError::Internal)?,
        ),
        role: request.role,
        is_active: true,
        created_at: Utc::now(),
    };
    let result = sqlx::query(
        "INSERT INTO users (id, username, password_hash, role, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)",
    )
    .bind(&user.id)
    .bind(&user.username)
    .bind(&user.password_hash)
    .bind(&user.role)
    .bind(user.created_at)
    .execute(&state.pool)
    .await;
    handle_user_write(result)?;
    Ok((StatusCode::CREATED, Json(user.into())))
}

async fn update_user(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(user_id): Path<String>,
    Json(request): Json<UpdateUserRequest>,
) -> AppResult<Json<UserView>> {
    require_admin(&auth)?;
    let existing = fetch_user(&state, &user_id).await?;
    let username = validate_username(&request.username)?;
    validate_role(&request.role)?;
    if auth.user.id == user_id && !request.is_active {
        return Err(AppError::BadRequest(
            "you cannot disable your own account".into(),
        ));
    }
    if existing.role == "admin"
        && existing.is_active
        && (request.role != "admin" || !request.is_active)
    {
        let active_admins: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1")
                .fetch_one(&state.pool)
                .await?;
        if active_admins <= 1 {
            return Err(AppError::Conflict(
                "at least one active administrator is required".into(),
            ));
        }
    }

    let password = request.password.filter(|password| !password.is_empty());
    let password_hash = if let Some(password) = password {
        validate_password(&password)?;
        Some(hash_password(password).await.map_err(AppError::Internal)?)
    } else {
        None
    };
    let result = sqlx::query(
        "UPDATE users SET username = ?, password_hash = COALESCE(?, password_hash), role = ?, is_active = ? WHERE id = ?",
    )
    .bind(&username)
    .bind(&password_hash)
    .bind(&request.role)
    .bind(request.is_active)
    .bind(&user_id)
    .execute(&state.pool)
    .await;
    handle_user_write(result)?;

    if password_hash.is_some() || !request.is_active {
        let current_session_hash = (auth.user.id == user_id && request.is_active)
            .then_some(auth.session_hash.as_deref())
            .flatten();
        revoke_other_sessions(&state, &user_id, current_session_hash).await?;
    }
    let user = fetch_user(&state, &user_id).await?;
    Ok(Json(user.into()))
}

async fn list_trusted_access_rules(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<TrustedAccessRuleView>>> {
    require_admin(&auth)?;
    let records = sqlx::query_as::<_, TrustedAccessRuleRecord>(
        r#"SELECT id, user_id, name, enabled, cidrs_json, domains_json, created_at, updated_at
           FROM trusted_access_rules ORDER BY user_id, name, created_at"#,
    )
    .fetch_all(&state.pool)
    .await?;
    let rules = records
        .into_iter()
        .map(trusted_access_rule_view)
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(rules))
}

async fn create_trusted_access_rule(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<SaveTrustedAccessRuleRequest>,
) -> AppResult<(StatusCode, Json<TrustedAccessRuleView>)> {
    require_admin(&auth)?;
    let (name, cidrs, domains) = validate_trusted_access_rule(&request)?;
    ensure_active_user(&state, &request.user_id).await?;
    let id = Uuid::now_v7().to_string();
    sqlx::query(
        r#"INSERT INTO trusted_access_rules
           (id, user_id, name, enabled, cidrs_json, domains_json)
           VALUES (?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&id)
    .bind(&request.user_id)
    .bind(name)
    .bind(request.enabled)
    .bind(serde_json::to_string(&cidrs).map_err(|error| AppError::Internal(error.into()))?)
    .bind(serde_json::to_string(&domains).map_err(|error| AppError::Internal(error.into()))?)
    .execute(&state.pool)
    .await?;
    let record = fetch_trusted_access_rule(&state, &id).await?;
    Ok((StatusCode::CREATED, Json(trusted_access_rule_view(record)?)))
}

async fn update_trusted_access_rule(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(rule_id): Path<String>,
    Json(request): Json<SaveTrustedAccessRuleRequest>,
) -> AppResult<Json<TrustedAccessRuleView>> {
    require_admin(&auth)?;
    let (name, cidrs, domains) = validate_trusted_access_rule(&request)?;
    ensure_active_user(&state, &request.user_id).await?;
    let result = sqlx::query(
        r#"UPDATE trusted_access_rules
           SET user_id = ?, name = ?, enabled = ?, cidrs_json = ?, domains_json = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?"#,
    )
    .bind(&request.user_id)
    .bind(name)
    .bind(request.enabled)
    .bind(serde_json::to_string(&cidrs).map_err(|error| AppError::Internal(error.into()))?)
    .bind(serde_json::to_string(&domains).map_err(|error| AppError::Internal(error.into()))?)
    .bind(&rule_id)
    .execute(&state.pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("trusted access rule not found".into()));
    }
    let record = fetch_trusted_access_rule(&state, &rule_id).await?;
    Ok(Json(trusted_access_rule_view(record)?))
}

async fn delete_trusted_access_rule(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(rule_id): Path<String>,
) -> AppResult<StatusCode> {
    require_admin(&auth)?;
    let result = sqlx::query("DELETE FROM trusted_access_rules WHERE id = ?")
        .bind(rule_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("trusted access rule not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn get_runtime_settings(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<RuntimeSettingsView>> {
    require_admin(&auth)?;
    Ok(Json(state.settings.load().view()))
}

async fn update_runtime_settings(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<UpdateRuntimeSettingsRequest>,
) -> AppResult<Json<RuntimeSettingsView>> {
    require_admin(&auth)?;
    if request.session_hours <= 0 {
        return Err(AppError::BadRequest(
            "session duration must be greater than zero".into(),
        ));
    }
    if request.max_upload_bytes == 0 {
        return Err(AppError::BadRequest(
            "maximum upload size must be greater than zero".into(),
        ));
    }
    let trusted_proxy_cidrs = normalize_values(request.trusted_proxy_cidrs);
    parse_cidrs(&trusted_proxy_cidrs).map_err(bad_request)?;
    sqlx::query(
        r#"UPDATE runtime_settings
           SET session_hours = ?, secure_cookies = ?, max_upload_bytes = ?,
               trusted_proxy_cidrs_json = ?,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = 1"#,
    )
    .bind(request.session_hours)
    .bind(request.secure_cookies)
    .bind(request.max_upload_bytes as i64)
    .bind(
        serde_json::to_string(&trusted_proxy_cidrs)
            .map_err(|error| AppError::Internal(error.into()))?,
    )
    .execute(&state.pool)
    .await?;
    state.reload_settings().await.map_err(AppError::Internal)?;
    Ok(Json(state.settings.load().view()))
}

async fn list_storage_connections(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<StorageConnectionView>>> {
    require_admin(&auth)?;
    let records = fetch_storage_connection_records(&state).await?;
    let views = records
        .into_iter()
        .map(|record| storage_connection_view(&state, record))
        .collect::<AppResult<Vec<_>>>()?;
    Ok(Json(views))
}

async fn create_storage_connection(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<SaveStorageConnectionRequest>,
) -> AppResult<(StatusCode, Json<StorageConnectionView>)> {
    require_admin(&auth)?;
    let config = storage_config_from_request(&request, None, None)?;
    validate_storage_connection(&config, request.enabled).await?;
    let ciphertext = state.cipher.encrypt(&config).map_err(AppError::Internal)?;
    let result = sqlx::query(
        r#"INSERT INTO storage_connections
           (id, name, kind, enabled, config_ciphertext)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(config.id())
    .bind(config.name())
    .bind(config.kind())
    .bind(request.enabled)
    .bind(ciphertext)
    .execute(&state.pool)
    .await;
    if let Err(sqlx::Error::Database(error)) = &result
        && error.is_unique_violation()
    {
        return Err(AppError::Conflict("storage id already exists".into()));
    }
    result?;
    state.reload_storages().await.map_err(AppError::Internal)?;
    let record = fetch_storage_connection_record(&state, config.id()).await?;
    Ok((
        StatusCode::CREATED,
        Json(storage_connection_view(&state, record)?),
    ))
}

async fn update_storage_connection(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Json(mut request): Json<SaveStorageConnectionRequest>,
) -> AppResult<Json<StorageConnectionView>> {
    require_admin(&auth)?;
    let existing_record = fetch_storage_connection_record(&state, &storage_id).await?;
    let existing: StorageConfig = state
        .cipher
        .decrypt(&existing_record.config_ciphertext)
        .map_err(AppError::Internal)?;
    request.id = storage_id.clone();
    let config = storage_config_from_request(&request, Some(&existing), Some(&storage_id))?;
    validate_storage_connection(&config, request.enabled).await?;
    let ciphertext = state.cipher.encrypt(&config).map_err(AppError::Internal)?;
    sqlx::query(
        r#"UPDATE storage_connections
           SET name = ?, kind = ?, enabled = ?, config_ciphertext = ?, last_error = NULL,
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?"#,
    )
    .bind(config.name())
    .bind(config.kind())
    .bind(request.enabled)
    .bind(ciphertext)
    .bind(&storage_id)
    .execute(&state.pool)
    .await?;
    state.reload_storages().await.map_err(AppError::Internal)?;
    let record = fetch_storage_connection_record(&state, &storage_id).await?;
    Ok(Json(storage_connection_view(&state, record)?))
}

async fn delete_storage_connection(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
) -> AppResult<StatusCode> {
    require_admin(&auth)?;
    let mut transaction = state.pool.begin().await?;
    sqlx::query("DELETE FROM permissions WHERE storage_id = ?")
        .bind(&storage_id)
        .execute(&mut *transaction)
        .await?;
    let result = sqlx::query("DELETE FROM storage_connections WHERE id = ?")
        .bind(&storage_id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("storage connection not found".into()));
    }
    transaction.commit().await?;
    state.reload_storages().await.map_err(AppError::Internal)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn list_permissions(
    State(state): State<AppState>,
    auth: AuthContext,
) -> AppResult<Json<Vec<PermissionRecord>>> {
    require_admin(&auth)?;
    let permissions = sqlx::query_as::<_, PermissionRecord>(
        "SELECT id, user_id, storage_id, path_prefix, can_read, can_write, can_manage FROM permissions ORDER BY storage_id, path_prefix",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(permissions))
}

async fn grant_permission(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<GrantPermissionRequest>,
) -> AppResult<(StatusCode, Json<PermissionRecord>)> {
    require_admin(&auth)?;
    get_storage(&state, &request.storage_id)?;
    let path_prefix = normalize_path(&request.path_prefix, false).map_err(bad_request)?;
    let id = Uuid::now_v7().to_string();
    sqlx::query(
        r#"INSERT INTO permissions (id, user_id, storage_id, path_prefix, can_read, can_write, can_manage)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(user_id, storage_id, path_prefix) DO UPDATE SET
             can_read = excluded.can_read,
             can_write = excluded.can_write,
             can_manage = excluded.can_manage"#,
    )
    .bind(&id)
    .bind(&request.user_id)
    .bind(&request.storage_id)
    .bind(&path_prefix)
    .bind(request.can_read)
    .bind(request.can_write)
    .bind(request.can_manage)
    .execute(&state.pool)
    .await?;
    let permission = sqlx::query_as::<_, PermissionRecord>(
        "SELECT id, user_id, storage_id, path_prefix, can_read, can_write, can_manage FROM permissions WHERE user_id = ? AND storage_id = ? AND path_prefix = ?",
    )
    .bind(&request.user_id)
    .bind(&request.storage_id)
    .bind(&path_prefix)
    .fetch_one(&state.pool)
    .await?;
    Ok((StatusCode::CREATED, Json(permission)))
}

async fn delete_permission(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(permission_id): Path<String>,
) -> AppResult<StatusCode> {
    require_admin(&auth)?;
    let result = sqlx::query("DELETE FROM permissions WHERE id = ?")
        .bind(permission_id)
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::NotFound("permission not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

fn get_storage(state: &AppState, storage_id: &str) -> AppResult<Arc<Storage>> {
    state
        .storages
        .load()
        .get(storage_id)
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("storage {storage_id} not found")))
}

async fn fetch_storage_connection_records(
    state: &AppState,
) -> AppResult<Vec<StorageConnectionRecord>> {
    Ok(sqlx::query_as::<_, StorageConnectionRecord>(
        r#"SELECT id, name, kind, enabled, config_ciphertext, last_error, created_at, updated_at
           FROM storage_connections ORDER BY name, id"#,
    )
    .fetch_all(&state.pool)
    .await?)
}

async fn fetch_storage_connection_record(
    state: &AppState,
    storage_id: &str,
) -> AppResult<StorageConnectionRecord> {
    sqlx::query_as::<_, StorageConnectionRecord>(
        r#"SELECT id, name, kind, enabled, config_ciphertext, last_error, created_at, updated_at
           FROM storage_connections WHERE id = ?"#,
    )
    .bind(storage_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("storage connection not found".into()))
}

fn storage_connection_view(
    state: &AppState,
    record: StorageConnectionRecord,
) -> AppResult<StorageConnectionView> {
    let config: StorageConfig = state
        .cipher
        .decrypt(&record.config_ciphertext)
        .map_err(AppError::Internal)?;
    let mut view = StorageConnectionView {
        id: record.id,
        name: record.name,
        kind: record.kind,
        enabled: record.enabled,
        root: String::new(),
        endpoint: None,
        mount_path: None,
        username: None,
        bucket: None,
        region: None,
        known_hosts_strategy: None,
        has_password: false,
        has_key: false,
        has_access_key_id: false,
        has_secret_access_key: false,
        last_error: record.last_error,
        created_at: record.created_at,
        updated_at: record.updated_at,
    };
    match config {
        StorageConfig::Fs { root, .. } => view.root = root,
        StorageConfig::Smb { mount_path, .. } => view.mount_path = Some(mount_path),
        StorageConfig::Ftp {
            endpoint,
            root,
            user,
            password,
            password_env,
            ..
        } => {
            view.endpoint = Some(endpoint);
            view.root = root;
            view.username = user;
            view.has_password = password.is_some() || password_env.is_some();
        }
        StorageConfig::Sftp {
            endpoint,
            root,
            user,
            key,
            key_env,
            known_hosts_strategy,
            ..
        } => {
            view.endpoint = Some(endpoint);
            view.root = root;
            view.username = user;
            view.has_key = key.is_some() || key_env.is_some();
            view.known_hosts_strategy = known_hosts_strategy;
        }
        StorageConfig::Webdav {
            endpoint,
            root,
            username,
            password,
            password_env,
            ..
        } => {
            view.endpoint = Some(endpoint);
            view.root = root;
            view.username = username;
            view.has_password = password.is_some() || password_env.is_some();
        }
        StorageConfig::S3 {
            bucket,
            root,
            region,
            endpoint,
            access_key_id,
            access_key_id_env,
            secret_access_key,
            secret_access_key_env,
            ..
        } => {
            view.bucket = Some(bucket);
            view.root = root;
            view.region = region;
            view.endpoint = endpoint;
            view.has_access_key_id = access_key_id.is_some() || access_key_id_env.is_some();
            view.has_secret_access_key =
                secret_access_key.is_some() || secret_access_key_env.is_some();
        }
    }
    Ok(view)
}

fn storage_config_from_request(
    request: &SaveStorageConnectionRequest,
    existing: Option<&StorageConfig>,
    fixed_id: Option<&str>,
) -> AppResult<StorageConfig> {
    let id = fixed_id.unwrap_or(request.id.trim());
    validate_storage_id(id)?;
    let name = required_text(&request.name, "storage name")?;
    let root = request.root.trim().to_string();
    let config = match request.kind.as_str() {
        "fs" => StorageConfig::Fs {
            id: id.into(),
            name,
            root: required_text(&root, "filesystem root")?,
        },
        "smb" => StorageConfig::Smb {
            id: id.into(),
            name,
            mount_path: required_optional(&request.mount_path, "SMB mount path")?,
        },
        "ftp" => {
            let (password, password_env) = ftp_password(request, existing);
            StorageConfig::Ftp {
                id: id.into(),
                name,
                endpoint: required_optional(&request.endpoint, "FTP endpoint")?,
                root,
                user: optional_text(&request.username),
                password,
                password_env,
            }
        }
        "sftp" => {
            let (key, key_env) = sftp_key(request, existing);
            StorageConfig::Sftp {
                id: id.into(),
                name,
                endpoint: required_optional(&request.endpoint, "SFTP endpoint")?,
                root,
                user: optional_text(&request.username),
                key,
                key_env,
                known_hosts_strategy: optional_text(&request.known_hosts_strategy),
            }
        }
        "webdav" => {
            let (password, password_env) = webdav_password(request, existing);
            StorageConfig::Webdav {
                id: id.into(),
                name,
                endpoint: required_optional(&request.endpoint, "WebDAV endpoint")?,
                root,
                username: optional_text(&request.username),
                password,
                password_env,
            }
        }
        "s3" => {
            let (access_key_id, access_key_id_env, secret_access_key, secret_access_key_env) =
                s3_credentials(request, existing);
            StorageConfig::S3 {
                id: id.into(),
                name,
                bucket: required_optional(&request.bucket, "S3 bucket")?,
                root,
                region: optional_text(&request.region),
                endpoint: optional_text(&request.endpoint),
                access_key_id,
                access_key_id_env,
                secret_access_key,
                secret_access_key_env,
            }
        }
        _ => {
            return Err(AppError::BadRequest(
                "storage kind must be fs, smb, ftp, sftp, webdav or s3".into(),
            ));
        }
    };
    Ok(config)
}

async fn validate_storage_connection(config: &StorageConfig, enabled: bool) -> AppResult<()> {
    if enabled {
        build_storage(config).await.map_err(|error| {
            AppError::BadRequest(format!("storage configuration failed: {error:#}"))
        })?;
    }
    Ok(())
}

fn validate_storage_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(AppError::BadRequest(
            "storage id must contain only ASCII letters, digits, '-' or '_'".into(),
        ));
    }
    Ok(())
}

fn required_text(value: &str, field: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::BadRequest(format!("{field} must not be empty")));
    }
    Ok(value.into())
}

fn required_optional(value: &Option<String>, field: &str) -> AppResult<String> {
    required_text(value.as_deref().unwrap_or(""), field)
}

fn optional_text(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn ftp_password(
    request: &SaveStorageConnectionRequest,
    existing: Option<&StorageConfig>,
) -> (Option<String>, Option<String>) {
    if let Some(password) = optional_text(&request.password) {
        return (Some(password), None);
    }
    match existing {
        Some(StorageConfig::Ftp {
            password,
            password_env,
            ..
        }) => (password.clone(), password_env.clone()),
        _ => (None, None),
    }
}

fn webdav_password(
    request: &SaveStorageConnectionRequest,
    existing: Option<&StorageConfig>,
) -> (Option<String>, Option<String>) {
    if let Some(password) = optional_text(&request.password) {
        return (Some(password), None);
    }
    match existing {
        Some(StorageConfig::Webdav {
            password,
            password_env,
            ..
        }) => (password.clone(), password_env.clone()),
        _ => (None, None),
    }
}

fn sftp_key(
    request: &SaveStorageConnectionRequest,
    existing: Option<&StorageConfig>,
) -> (Option<String>, Option<String>) {
    if let Some(key) = request.key.as_ref().filter(|key| !key.is_empty()) {
        return (Some(key.clone()), None);
    }
    match existing {
        Some(StorageConfig::Sftp { key, key_env, .. }) => (key.clone(), key_env.clone()),
        _ => (None, None),
    }
}

fn s3_credentials(
    request: &SaveStorageConnectionRequest,
    existing: Option<&StorageConfig>,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let existing_values = match existing {
        Some(StorageConfig::S3 {
            access_key_id,
            access_key_id_env,
            secret_access_key,
            secret_access_key_env,
            ..
        }) => (
            access_key_id.clone(),
            access_key_id_env.clone(),
            secret_access_key.clone(),
            secret_access_key_env.clone(),
        ),
        _ => (None, None, None, None),
    };
    let (access_key_id, access_key_id_env) = optional_text(&request.access_key_id)
        .map(|value| (Some(value), None))
        .unwrap_or((existing_values.0, existing_values.1));
    let (secret_access_key, secret_access_key_env) = optional_text(&request.secret_access_key)
        .map(|value| (Some(value), None))
        .unwrap_or((existing_values.2, existing_values.3));
    (
        access_key_id,
        access_key_id_env,
        secret_access_key,
        secret_access_key_env,
    )
}

fn require_admin(auth: &AuthContext) -> AppResult<()> {
    if auth.user.role == "admin" {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

async fn fetch_user(state: &AppState, user_id: &str) -> AppResult<UserRecord> {
    sqlx::query_as::<_, UserRecord>(
        "SELECT id, username, password_hash, role, is_active, created_at FROM users WHERE id = ?",
    )
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("user not found".into()))
}

async fn ensure_active_user(state: &AppState, user_id: &str) -> AppResult<()> {
    let exists: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ? AND is_active = 1")
            .bind(user_id)
            .fetch_one(&state.pool)
            .await?;
    if exists == 0 {
        return Err(AppError::BadRequest("active user not found".into()));
    }
    Ok(())
}

async fn fetch_trusted_access_rule(
    state: &AppState,
    rule_id: &str,
) -> AppResult<TrustedAccessRuleRecord> {
    sqlx::query_as::<_, TrustedAccessRuleRecord>(
        r#"SELECT id, user_id, name, enabled, cidrs_json, domains_json, created_at, updated_at
           FROM trusted_access_rules WHERE id = ?"#,
    )
    .bind(rule_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::NotFound("trusted access rule not found".into()))
}

fn trusted_access_rule_view(record: TrustedAccessRuleRecord) -> AppResult<TrustedAccessRuleView> {
    let cidrs = serde_json::from_str(&record.cidrs_json)
        .map_err(|error| AppError::Internal(error.into()))?;
    let domains = serde_json::from_str(&record.domains_json)
        .map_err(|error| AppError::Internal(error.into()))?;
    Ok(TrustedAccessRuleView {
        id: record.id,
        user_id: record.user_id,
        name: record.name,
        enabled: record.enabled,
        cidrs,
        domains,
        created_at: record.created_at,
        updated_at: record.updated_at,
    })
}

fn validate_trusted_access_rule(
    request: &SaveTrustedAccessRuleRequest,
) -> AppResult<(String, Vec<String>, Vec<String>)> {
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::BadRequest("rule name must not be empty".into()));
    }
    let cidrs = normalize_values(request.cidrs.clone());
    parse_cidrs(&cidrs).map_err(bad_request)?;
    let domains = normalize_values(request.domains.clone())
        .into_iter()
        .map(|domain| normalize_domain(&domain))
        .collect::<Vec<_>>();
    if cidrs.is_empty() && domains.is_empty() {
        return Err(AppError::BadRequest(
            "trusted access rule must contain a CIDR or domain".into(),
        ));
    }
    if domains.iter().any(|domain| !valid_domain_pattern(domain)) {
        return Err(AppError::BadRequest(
            "domain must be a hostname or a wildcard such as *.example.com".into(),
        ));
    }
    Ok((name.into(), cidrs, domains))
}

fn normalize_values(values: Vec<String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn valid_domain_pattern(value: &str) -> bool {
    let hostname = value.strip_prefix("*.").unwrap_or(value);
    !hostname.is_empty()
        && !hostname.starts_with('.')
        && !hostname.ends_with('.')
        && hostname
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '.' | '-'))
}

fn validate_username(value: &str) -> AppResult<String> {
    let username = value.trim();
    if username.len() < 3
        || !username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err(AppError::BadRequest(
            "username must be at least 3 characters and contain only letters, digits, '.', '_' or '-'"
                .into(),
        ));
    }
    Ok(username.into())
}

fn validate_password(value: &str) -> AppResult<()> {
    if value.is_empty() {
        return Err(AppError::BadRequest("password must not be empty".into()));
    }
    Ok(())
}

fn validate_role(value: &str) -> AppResult<()> {
    if !matches!(value, "admin" | "member") {
        return Err(AppError::BadRequest("role must be admin or member".into()));
    }
    Ok(())
}

fn handle_user_write(
    result: Result<sqlx::sqlite::SqliteQueryResult, sqlx::Error>,
) -> AppResult<()> {
    if let Err(sqlx::Error::Database(error)) = &result
        && error.is_unique_violation()
    {
        return Err(AppError::Conflict("username already exists".into()));
    }
    result?;
    Ok(())
}

fn file_entry(path: &str, metadata: &opendal::Metadata) -> FileEntry {
    let normalized = path.trim_end_matches('/');
    FileEntry {
        name: normalized.rsplit('/').next().unwrap_or("").into(),
        path: path.into(),
        kind: if metadata.is_dir() {
            "directory".into()
        } else {
            "file".into()
        },
        size: metadata.content_length(),
        modified_at: metadata.last_modified().and_then(|timestamp| {
            chrono::DateTime::parse_from_rfc3339(&timestamp.to_string())
                .ok()
                .map(|value| value.with_timezone(&Utc))
        }),
    }
}

fn grants(permission: &PermissionRecord, access: Access) -> bool {
    match access {
        Access::Read => permission.can_read || permission.can_write || permission.can_manage,
        Access::Write => permission.can_write || permission.can_manage,
        Access::Manage => permission.can_manage,
    }
}

fn visible_roots(permissions: &[PermissionRecord]) -> Vec<String> {
    let mut roots: Vec<String> = permissions
        .iter()
        .filter(|permission| grants(permission, Access::Read))
        .map(|permission| permission.path_prefix.clone())
        .filter(|candidate| {
            !permissions.iter().any(|other| {
                other.path_prefix != *candidate
                    && grants(other, Access::Read)
                    && path_is_within(candidate, &other.path_prefix)
            })
        })
        .collect();
    roots.sort();
    roots.dedup();
    roots
}

fn bad_request(error: anyhow::Error) -> AppError {
    AppError::BadRequest(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_validation_has_no_length_requirement() {
        assert!(validate_password("x").is_ok());
        assert!(validate_password("").is_err());
    }

    #[test]
    fn trusted_access_validation_normalizes_values() {
        let request = SaveTrustedAccessRuleRequest {
            user_id: "user".into(),
            name: " Home ".into(),
            enabled: true,
            cidrs: vec![" 192.168.1.0/24 ".into(), "192.168.1.0/24".into()],
            domains: vec![" Files.Home.Arpa. ".into()],
        };
        let (name, cidrs, domains) = validate_trusted_access_rule(&request).unwrap();
        assert_eq!(name, "Home");
        assert_eq!(cidrs, ["192.168.1.0/24"]);
        assert_eq!(domains, ["files.home.arpa"]);
    }

    #[test]
    fn trusted_access_requires_a_matcher() {
        let request = SaveTrustedAccessRuleRequest {
            user_id: "user".into(),
            name: "Empty".into(),
            enabled: true,
            cidrs: Vec::new(),
            domains: Vec::new(),
        };
        assert!(validate_trusted_access_rule(&request).is_err());
    }

    #[test]
    fn storage_update_preserves_existing_password() {
        let existing = StorageConfig::Webdav {
            id: "dav".into(),
            name: "Old".into(),
            endpoint: "https://old.example.com".into(),
            root: "/".into(),
            username: Some("alice".into()),
            password: Some("secret".into()),
            password_env: None,
        };
        let request = SaveStorageConnectionRequest {
            id: "dav".into(),
            name: "New".into(),
            kind: "webdav".into(),
            enabled: true,
            root: "/files".into(),
            endpoint: Some("https://new.example.com".into()),
            mount_path: None,
            username: Some("bob".into()),
            password: None,
            key: None,
            bucket: None,
            region: None,
            access_key_id: None,
            secret_access_key: None,
            known_hosts_strategy: None,
        };
        let updated = storage_config_from_request(&request, Some(&existing), Some("dav")).unwrap();
        let StorageConfig::Webdav {
            name,
            endpoint,
            username,
            password,
            ..
        } = updated
        else {
            panic!("expected WebDAV storage");
        };
        assert_eq!(name, "New");
        assert_eq!(endpoint, "https://new.example.com");
        assert_eq!(username.as_deref(), Some("bob"));
        assert_eq!(password.as_deref(), Some("secret"));
    }
}
