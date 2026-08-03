use std::net::{IpAddr, SocketAddr};

use argon2::{
    Argon2,
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use axum::{
    extract::{FromRef, FromRequestParts, connect_info::ConnectInfo},
    http::{HeaderMap, header, request::Parts},
};
use axum_extra::extract::cookie::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{Duration, Utc};
use rand_core::OsRng;
use sha2::{Digest, Sha256};
use sqlx::FromRow;

use crate::{
    error::{AppError, AppResult},
    models::{Access, PermissionRecord, UserRecord},
    state::{AppState, parse_cidrs},
    storage::path_is_within,
};

pub const SESSION_COOKIE: &str = "lume_session";

#[derive(Debug, Clone)]
pub struct AuthContext {
    pub user: UserRecord,
    pub method: AuthMethod,
    pub session_hash: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub enum AuthMethod {
    Session,
    Bypass,
}

impl AuthMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Bypass => "bypass",
        }
    }

    fn from_database(value: &str) -> Option<Self> {
        match value {
            "session" => Some(Self::Session),
            "bypass" => Some(Self::Bypass),
            _ => None,
        }
    }
}

impl<S> FromRequestParts<S> for AuthContext
where
    AppState: FromRef<S>,
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Self::Rejection> {
        let state = AppState::from_ref(state);
        let jar = CookieJar::from_headers(&parts.headers);
        let bearer = parts
            .headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "));
        let token = bearer.or_else(|| jar.get(SESSION_COOKIE).map(|cookie| cookie.value()));

        if let Some(token) = token
            && let Some((user, method)) = user_from_session(&state, token, parts).await?
        {
            return Ok(Self {
                user,
                method,
                session_hash: Some(session_hash(token)),
            });
        }

        Err(AppError::Unauthorized)
    }
}

pub async fn hash_password(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || {
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|error| anyhow::anyhow!("failed to hash password: {error}"))
    })
    .await?
}

pub async fn verify_password(password: String, encoded: String) -> anyhow::Result<bool> {
    tokio::task::spawn_blocking(move || {
        let hash = PasswordHash::new(&encoded)
            .map_err(|error| anyhow::anyhow!("stored password hash is invalid: {error}"))?;
        Ok(Argon2::default()
            .verify_password(password.as_bytes(), &hash)
            .is_ok())
    })
    .await?
}

pub async fn create_session(
    state: &AppState,
    user_id: &str,
    method: AuthMethod,
) -> AppResult<String> {
    let raw = rand::random::<[u8; 32]>();
    let token = URL_SAFE_NO_PAD.encode(raw);
    let token_hash = session_hash(&token);
    let expires_at = Utc::now() + Duration::hours(state.settings.load().session_hours);
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, expires_at, auth_method) VALUES (?, ?, ?, ?)",
    )
    .bind(token_hash)
    .bind(user_id)
    .bind(expires_at)
    .bind(method.as_str())
    .execute(&state.pool)
    .await?;
    Ok(token)
}

pub async fn delete_session(state: &AppState, token: &str) -> AppResult<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(session_hash(token))
        .execute(&state.pool)
        .await?;
    Ok(())
}

pub async fn revoke_other_sessions(
    state: &AppState,
    user_id: &str,
    current_session_hash: Option<&str>,
) -> AppResult<()> {
    if let Some(current_session_hash) = current_session_hash {
        sqlx::query("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?")
            .bind(user_id)
            .bind(current_session_hash)
            .execute(&state.pool)
            .await?;
    } else {
        sqlx::query("DELETE FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

pub async fn require_access(
    state: &AppState,
    auth: &AuthContext,
    storage_id: &str,
    path: &str,
    access: Access,
) -> AppResult<()> {
    if access_allowed(state, auth, storage_id, path, access).await? {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

async fn access_allowed(
    state: &AppState,
    auth: &AuthContext,
    storage_id: &str,
    path: &str,
    access: Access,
) -> AppResult<bool> {
    if auth.user.role == "admin" {
        return Ok(true);
    }
    let permissions = user_permissions(state, auth, storage_id).await?;
    Ok(permissions.into_iter().any(|permission| {
        path_is_within(path, &permission.path_prefix) && permission_grants(&permission, access)
    }))
}

pub async fn user_permissions(
    state: &AppState,
    auth: &AuthContext,
    storage_id: &str,
) -> AppResult<Vec<PermissionRecord>> {
    if auth.user.role == "admin" {
        return Ok(Vec::new());
    }
    Ok(sqlx::query_as::<_, PermissionRecord>(
        "SELECT id, user_id, storage_id, path_prefix, can_read, can_write, can_manage FROM permissions WHERE user_id = ? AND storage_id = ?",
    )
    .bind(&auth.user.id)
    .bind(storage_id)
    .fetch_all(&state.pool)
    .await?)
}

pub fn permissions_allow(permissions: &[PermissionRecord], path: &str, access: Access) -> bool {
    permissions.iter().any(|permission| {
        path_is_within(path, &permission.path_prefix) && permission_grants(permission, access)
    })
}

pub fn permissions_allow_traversal(permissions: &[PermissionRecord], path: &str) -> bool {
    permissions.iter().any(|permission| {
        permission_grants(permission, Access::Read)
            && (path_is_within(path, &permission.path_prefix)
                || path_is_within(&permission.path_prefix, path))
    })
}

fn permission_grants(permission: &PermissionRecord, access: Access) -> bool {
    match access {
        Access::Read => permission.can_read || permission.can_write || permission.can_manage,
        Access::Write => permission.can_write || permission.can_manage,
        Access::Manage => permission.can_manage,
    }
}

#[derive(FromRow)]
struct SessionUserRecord {
    id: String,
    username: String,
    password_hash: Option<String>,
    role: String,
    is_active: bool,
    created_at: chrono::DateTime<Utc>,
    auth_method: String,
}

async fn user_from_session(
    state: &AppState,
    token: &str,
    parts: &Parts,
) -> AppResult<Option<(UserRecord, AuthMethod)>> {
    let record = sqlx::query_as::<_, SessionUserRecord>(
        r#"SELECT u.id, u.username, u.password_hash, u.role, u.is_active, u.created_at,
                  s.auth_method
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ? AND u.is_active = 1"#,
    )
    .bind(session_hash(token))
    .bind(Utc::now())
    .fetch_optional(&state.pool)
    .await?;
    let Some(record) = record else {
        return Ok(None);
    };
    let Some(method) = AuthMethod::from_database(&record.auth_method) else {
        return Ok(None);
    };
    if matches!(method, AuthMethod::Bypass)
        && matching_trusted_access_rule(state, &record.id, parts)
            .await?
            .is_none()
    {
        return Ok(None);
    }
    Ok(Some((
        UserRecord {
            id: record.id,
            username: record.username,
            password_hash: record.password_hash,
            role: record.role,
            is_active: record.is_active,
            created_at: record.created_at,
        },
        method,
    )))
}

fn session_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

pub async fn matching_trusted_access_rule(
    state: &AppState,
    user_id: &str,
    parts: &Parts,
) -> AppResult<Option<String>> {
    let peer_ip = parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("missing peer address")))?;
    matching_trusted_access_rule_for_request(state, user_id, peer_ip, &parts.headers).await
}

pub async fn matching_trusted_access_rule_for_request(
    state: &AppState,
    user_id: &str,
    peer_ip: IpAddr,
    headers: &HeaderMap,
) -> AppResult<Option<String>> {
    let settings = state.settings.load();
    let peer_is_trusted = settings
        .trusted_proxies
        .iter()
        .any(|network| network.contains(&peer_ip));
    let client_ip = trusted_client_ip(&settings.trusted_proxies, peer_ip, headers);
    let host = peer_is_trusted
        .then(|| {
            headers
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .and_then(host_without_port)
                .map(|value| value.trim_end_matches('.').to_ascii_lowercase())
        })
        .flatten();
    drop(settings);

    let records = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT id, cidrs_json, domains_json
           FROM trusted_access_rules
           WHERE user_id = ? AND enabled = 1
           ORDER BY created_at, id"#,
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await?;
    for (id, cidrs_json, domains_json) in records {
        let cidr_values: Vec<String> =
            serde_json::from_str(&cidrs_json).map_err(|error| AppError::Internal(error.into()))?;
        let cidrs = parse_cidrs(&cidr_values).map_err(AppError::Internal)?;
        let domains: Vec<String> = serde_json::from_str::<Vec<String>>(&domains_json)
            .map_err(|error| AppError::Internal(error.into()))?
            .into_iter()
            .map(|domain| normalize_domain(&domain))
            .collect();
        if trusted_access_rule_matches(&cidrs, &domains, client_ip, host.as_deref()) {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

fn trusted_client_ip(
    trusted_proxies: &[ipnet::IpNet],
    peer_ip: IpAddr,
    headers: &HeaderMap,
) -> IpAddr {
    let peer_is_trusted = trusted_proxies
        .iter()
        .any(|network| network.contains(&peer_ip));
    if !peer_is_trusted {
        return peer_ip;
    }
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(peer_ip)
}

fn trusted_access_rule_matches(
    cidrs: &[ipnet::IpNet],
    domains: &[String],
    client_ip: IpAddr,
    host: Option<&str>,
) -> bool {
    let ip_matches = cidrs.is_empty() || cidrs.iter().any(|cidr| cidr.contains(&client_ip));
    let domain_matches = domains.is_empty()
        || host.is_some_and(|host| domains.iter().any(|domain| matches_domain(host, domain)));
    ip_matches && domain_matches
}

pub fn normalize_domain(value: &str) -> String {
    value.trim().trim_end_matches('.').to_ascii_lowercase()
}

fn matches_domain(host: &str, pattern: &str) -> bool {
    pattern
        .strip_prefix("*.")
        .map_or(host == pattern, |suffix| {
            host != suffix && host.ends_with(&format!(".{suffix}"))
        })
}

fn host_without_port(host: &str) -> Option<&str> {
    if host.starts_with('[') {
        return host.strip_prefix('[')?.split(']').next();
    }
    Some(host.split(':').next().unwrap_or(host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_patterns_do_not_match_apex() {
        assert!(matches_domain("files.example.com", "*.example.com"));
        assert!(!matches_domain("example.com", "*.example.com"));
        assert!(!matches_domain("badexample.com", "*.example.com"));
    }

    #[test]
    fn bypass_rule_uses_and_semantics() {
        let cidrs = vec!["10.0.0.0/8".parse().unwrap()];
        let domains = vec!["files.example.com".into()];
        assert!(trusted_access_rule_matches(
            &cidrs,
            &domains,
            "10.1.2.3".parse().unwrap(),
            Some("files.example.com")
        ));
        assert!(!trusted_access_rule_matches(
            &cidrs,
            &domains,
            "192.168.1.1".parse().unwrap(),
            Some("files.example.com")
        ));
        assert!(!trusted_access_rule_matches(
            &cidrs,
            &domains,
            "10.1.2.3".parse().unwrap(),
            Some("public.example.com")
        ));
    }

    #[test]
    fn permissions_respect_segment_boundaries() {
        let permission = PermissionRecord {
            id: "permission".into(),
            user_id: "user".into(),
            storage_id: "storage".into(),
            path_prefix: "team/docs".into(),
            can_read: true,
            can_write: false,
            can_manage: false,
        };
        assert!(permissions_allow(
            std::slice::from_ref(&permission),
            "team/docs/report.pdf",
            Access::Read
        ));
        assert!(!permissions_allow(
            std::slice::from_ref(&permission),
            "team/docs-old/report.pdf",
            Access::Read
        ));
        assert!(permissions_allow_traversal(
            std::slice::from_ref(&permission),
            "team/"
        ));
    }
}
