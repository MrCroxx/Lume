use std::{collections::HashMap, sync::Arc};

use arc_swap::ArcSwap;
use axum::{
    body::{Body, Bytes, to_bytes},
    http::{Request, StatusCode},
    response::Response,
};
use futures_util::stream;
use serde_json::{Value, json};
use sqlx::sqlite::SqlitePoolOptions;
use tower::ServiceExt;

use super::router;
use crate::{
    archive::ArchiveTickets,
    auth::{AuthMethod, create_session},
    config::StorageConfig,
    db,
    secrets::SecretCipher,
    state::{AppState, RuntimeSettings},
    storage::build_storage,
};

struct TestApp {
    state: AppState,
    token: String,
    root: tempfile::TempDir,
}

impl TestApp {
    async fn new(limit: usize) -> Self {
        let root = tempfile::tempdir().unwrap();
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for statement in db::SCHEMA {
            sqlx::query(*statement).execute(&pool).await.unwrap();
        }
        sqlx::query("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'session'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO users (id, username, role) VALUES ('admin', 'admin', 'admin'), ('member', 'member', 'member')")
            .execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO runtime_settings (id, session_hours, max_upload_bytes) VALUES (1, 24, ?)",
        )
        .bind(limit as i64)
        .execute(&pool)
        .await
        .unwrap();
        let storage = build_storage(&StorageConfig::Fs {
            id: "local".into(),
            name: "Local".into(),
            root: root.path().to_str().unwrap().into(),
        })
        .await
        .unwrap();
        let state = AppState {
            pool,
            storages: Arc::new(ArcSwap::from_pointee(HashMap::from([(
                "local".into(),
                Arc::new(storage),
            )]))),
            settings: Arc::new(ArcSwap::from_pointee(RuntimeSettings {
                session_hours: 24,
                secure_cookies: false,
                max_upload_bytes: limit,
                trusted_proxy_cidrs: vec![],
                trusted_proxies: vec![],
            })),
            cipher: Arc::new(SecretCipher::from_key([7; 32])),
            archive_tickets: ArchiveTickets::new(),
            reload_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let token = create_session(
            &state,
            "admin",
            AuthMethod::Session,
            "127.0.0.1".parse().unwrap(),
        )
        .await
        .unwrap()
        .token;
        Self { state, token, root }
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        body: Body,
        headers: &[(&str, &str)],
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header("Authorization", format!("Bearer {}", self.token));
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        router(self.state.clone())
            .oneshot(request.body(body).unwrap())
            .await
            .unwrap()
    }
}

async fn assert_json_error(response: Response, status: StatusCode) -> String {
    assert_eq!(response.status(), status);
    assert_eq!(response.headers()["content-type"], "application/json");
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let value: Value = serde_json::from_slice(&bytes).unwrap();
    value["error"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn upload_above_two_mib_and_empty_file_return_empty_created() {
    let size = 3 * 1024 * 1024;
    let app = TestApp::new(size).await;
    let bytes = vec![0xa5; size];
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=large.bin",
            Body::from(bytes.clone()),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(
        to_bytes(response.into_body(), 1024)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        tokio::fs::read(app.root.path().join("large.bin"))
            .await
            .unwrap(),
        bytes
    );
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=empty.bin",
            Body::empty(),
            &[("Content-Length", "0")],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        tokio::fs::metadata(app.root.path().join("empty.bin"))
            .await
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn oversized_known_and_chunked_uploads_preserve_existing_files() {
    let app = TestApp::new(4).await;
    tokio::fs::write(app.root.path().join("file"), b"original")
        .await
        .unwrap();
    for headers in [vec![("Content-Length", "5")], vec![]] {
        let body = Body::from_stream(stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"1234")),
            Ok(Bytes::from_static(b"5")),
        ]));
        let response = app
            .send("PUT", "/api/files/local?path=file", body, &headers)
            .await;
        assert!(
            assert_json_error(response, StatusCode::PAYLOAD_TOO_LARGE)
                .await
                .contains("4 bytes")
        );
        assert_eq!(
            tokio::fs::read(app.root.path().join("file")).await.unwrap(),
            b"original"
        );
    }
}

#[tokio::test]
async fn multi_chunk_upload_commits_every_byte() {
    use tokio::io::AsyncReadExt;

    let chunk_size = 1024 * 1024;
    let chunk_count = 17;
    let app = TestApp::new(chunk_size * chunk_count).await;
    let body =
        Body::from_stream(stream::iter((0..chunk_count).map(|index| {
            Ok::<_, std::io::Error>(Bytes::from(vec![index as u8; 1024 * 1024]))
        })));
    let response = app
        .send("PUT", "/api/files/local?path=chunks.bin", body, &[])
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let mut file = tokio::fs::File::open(app.root.path().join("chunks.bin"))
        .await
        .unwrap();
    assert_eq!(
        file.metadata().await.unwrap().len(),
        (chunk_size * chunk_count) as u64
    );
    let mut buffer = vec![0; chunk_size];
    for index in 0..chunk_count {
        file.read_exact(&mut buffer).await.unwrap();
        assert!(buffer.iter().all(|byte| *byte == index as u8));
    }
}

#[tokio::test]
async fn interrupted_uploads_are_not_reported_as_size_errors() {
    let app = TestApp::new(1024).await;
    tokio::fs::write(app.root.path().join("file"), b"original")
        .await
        .unwrap();
    let body = Body::from_stream(stream::iter([
        Ok(Bytes::from_static(b"partial")),
        Err(std::io::Error::other("connection reset")),
    ]));
    let response = app
        .send("PUT", "/api/files/local?path=file", body, &[])
        .await;
    assert!(
        assert_json_error(response, StatusCode::BAD_REQUEST)
            .await
            .contains("interrupted")
    );
    assert_eq!(
        tokio::fs::read(app.root.path().join("file")).await.unwrap(),
        b"original"
    );
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=file",
            Body::from("short"),
            &[("Content-Length", "10")],
        )
        .await;
    assert!(
        assert_json_error(response, StatusCode::BAD_REQUEST)
            .await
            .contains("Content-Length")
    );
    assert_eq!(
        tokio::fs::read(app.root.path().join("file")).await.unwrap(),
        b"original"
    );
}

#[tokio::test]
async fn runtime_upload_limit_changes_apply_to_subsequent_requests() {
    let app = TestApp::new(4).await;
    let response = app.send("PUT", "/api/admin/settings", Body::from(json!({
        "session_hours": 24, "secure_cookies": false, "max_upload_bytes": 8, "trusted_proxy_cidrs": [],
    }).to_string()), &[("Content-Type", "application/json")]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(app.state.settings.load().max_upload_bytes, 8);
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=file",
            Body::from("12345678"),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
}

#[tokio::test]
async fn invalid_settings_do_not_modify_persisted_limit() {
    let app = TestApp::new(4).await;
    for limit in [0_u64, u64::MAX] {
        let response = app.send("PUT", "/api/admin/settings", Body::from(json!({
            "session_hours": 24, "secure_cookies": false, "max_upload_bytes": limit, "trusted_proxy_cidrs": [],
        }).to_string()), &[("Content-Type", "application/json")]).await;
        assert_json_error(response, StatusCode::BAD_REQUEST).await;
        let persisted: i64 =
            sqlx::query_scalar("SELECT max_upload_bytes FROM runtime_settings WHERE id = 1")
                .fetch_one(&app.state.pool)
                .await
                .unwrap();
        assert_eq!(persisted, 4);
        assert_eq!(app.state.settings.load().max_upload_bytes, 4);
    }
}

#[tokio::test]
async fn api_rejections_are_json_including_unknown_routes() {
    let app = TestApp::new(1024).await;
    for (method, uri, body, status) in [
        (
            "POST",
            "/api/files/local/directory",
            "{",
            StatusCode::BAD_REQUEST,
        ),
        (
            "POST",
            "/api/files/local/directory",
            "{}",
            StatusCode::UNPROCESSABLE_ENTITY,
        ),
        (
            "GET",
            "/api/search/local?q=test&limit=no",
            "",
            StatusCode::BAD_REQUEST,
        ),
        ("GET", "/api/unknown", "", StatusCode::NOT_FOUND),
        ("GET", "/api", "", StatusCode::NOT_FOUND),
        ("POST", "/api/health", "", StatusCode::METHOD_NOT_ALLOWED),
    ] {
        let response = app
            .send(
                method,
                uri,
                Body::from(body),
                &[("Content-Type", "application/json")],
            )
            .await;
        assert!(!assert_json_error(response, status).await.is_empty());
    }
    let response = app
        .send("POST", "/api/files/local/directory", Body::from("{}"), &[])
        .await;
    assert_json_error(response, StatusCode::UNSUPPORTED_MEDIA_TYPE).await;
    let response = app
        .send(
            "POST",
            "/api/files/local/directory",
            Body::from(" ".repeat(3 * 1024 * 1024)),
            &[("Content-Type", "application/json")],
        )
        .await;
    assert_json_error(response, StatusCode::PAYLOAD_TOO_LARGE).await;
}

#[tokio::test]
async fn upload_requires_permission_and_rejects_traversal() {
    let mut app = TestApp::new(1024).await;
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=../outside",
            Body::from("data"),
            &[],
        )
        .await;
    assert_json_error(response, StatusCode::BAD_REQUEST).await;
    app.token = create_session(
        &app.state,
        "member",
        AuthMethod::Session,
        "127.0.0.1".parse().unwrap(),
    )
    .await
    .unwrap()
    .token;
    let response = app
        .send("PUT", "/api/files/local?path=file", Body::from("data"), &[])
        .await;
    assert_json_error(response, StatusCode::FORBIDDEN).await;
    assert!(!app.root.path().join("file").exists());
    app.token.clear();
    let response = app
        .send("PUT", "/api/files/local?path=file", Body::from("data"), &[])
        .await;
    assert_json_error(response, StatusCode::UNAUTHORIZED).await;
}

#[tokio::test]
async fn upload_and_download_preserve_spaces_and_unicode_file_names() {
    let app = TestApp::new(1024).await;
    let query = "path=caf%C3%A9%20file.txt";
    let response = app
        .send(
            "PUT",
            &format!("/api/files/local?{query}"),
            Body::from("data"),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert!(app.root.path().join("caf\u{e9} file.txt").exists());
    let response = app
        .send(
            "GET",
            &format!("/api/files/local/download?{query}"),
            Body::empty(),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let disposition = response.headers()["content-disposition"].to_str().unwrap();
    assert!(disposition.contains("filename*=UTF-8''caf%C3%A9%20file%2Etxt"));
    assert_eq!(to_bytes(response.into_body(), 1024).await.unwrap(), "data");
    let response = app
        .send(
            "PUT",
            "/api/files/local?path=%20caf%C3%A9%20file.txt%20",
            Body::from("replacement"),
            &[],
        )
        .await;
    assert_json_error(response, StatusCode::BAD_REQUEST).await;
    assert_eq!(
        tokio::fs::read(app.root.path().join("caf\u{e9} file.txt"))
            .await
            .unwrap(),
        b"data"
    );
}

#[tokio::test]
async fn concurrent_admin_demotions_preserve_one_active_administrator() {
    let app = TestApp::new(1024).await;
    sqlx::query("UPDATE users SET role = 'admin' WHERE id = 'member'")
        .execute(&app.state.pool)
        .await
        .unwrap();
    let user = super::fetch_user(&app.state, "admin").await.unwrap();
    let auth = crate::auth::AuthContext {
        user,
        method: AuthMethod::Session,
        session_hash: None,
    };
    let update = |id: &'static str| {
        super::update_user(
            axum::extract::State(app.state.clone()),
            auth.clone(),
            axum::extract::Path(id.into()),
            super::Json(crate::models::UpdateUserRequest {
                username: id.into(),
                password: None,
                role: "member".into(),
                is_active: true,
            }),
        )
    };
    let (first, second) = tokio::join!(update("admin"), update("member"));
    assert_ne!(first.is_ok(), second.is_ok());
    let error = if let Err(error) = first {
        error
    } else {
        second.unwrap_err()
    };
    assert!(matches!(error, crate::error::AppError::Conflict(_)));
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1")
            .fetch_one(&app.state.pool)
            .await
            .unwrap();
    assert_eq!(count, 1);
}

#[tokio::test]
async fn account_changes_roll_back_when_session_revocation_fails() {
    let app = TestApp::new(1024).await;
    let password_hash = crate::auth::hash_password("original".into()).await.unwrap();
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = 'admin'")
        .bind(&password_hash)
        .execute(&app.state.pool)
        .await
        .unwrap();
    create_session(
        &app.state,
        "admin",
        AuthMethod::Session,
        "127.0.0.2".parse().unwrap(),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'injected revocation failure'); END")
        .execute(&app.state.pool).await.unwrap();
    for (method, uri, payload) in [
        (
            "PATCH",
            "/api/account",
            json!({ "username": "changed", "current_password": "original", "new_password": "replacement" }),
        ),
        (
            "PATCH",
            "/api/admin/users/admin",
            json!({ "username": "changed", "password": "replacement", "role": "admin", "is_active": true }),
        ),
    ] {
        let response = app
            .send(
                method,
                uri,
                Body::from(payload.to_string()),
                &[("Content-Type", "application/json")],
            )
            .await;
        assert_json_error(response, StatusCode::INTERNAL_SERVER_ERROR).await;
        let user = super::fetch_user(&app.state, "admin").await.unwrap();
        assert_eq!(user.username, "admin");
        assert_eq!(user.password_hash.as_deref(), Some(password_hash.as_str()));
    }
    sqlx::query("DROP TRIGGER fail_session_delete")
        .execute(&app.state.pool)
        .await
        .unwrap();
    let response = app.send("PATCH", "/api/account", Body::from(json!({
        "username": "changed", "current_password": "original", "new_password": "replacement",
    }).to_string()), &[("Content-Type", "application/json")]).await;
    assert_eq!(response.status(), StatusCode::OK);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = 'admin'")
        .fetch_one(&app.state.pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1);
    let response = app
        .send("GET", "/api/auth/session", Body::empty(), &[])
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let user = super::fetch_user(&app.state, "admin").await.unwrap();
    assert_eq!(user.username, "changed");
    assert!(
        crate::auth::verify_password("replacement".into(), user.password_hash.unwrap())
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn archive_tickets_recheck_permissions_before_downloading() {
    let mut app = TestApp::new(1024).await;
    tokio::fs::write(app.root.path().join("file"), b"private")
        .await
        .unwrap();
    sqlx::query("INSERT INTO permissions (id, user_id, storage_id, path_prefix, can_read) VALUES ('permission', 'member', 'local', '', 1)")
        .execute(&app.state.pool).await.unwrap();
    app.token = create_session(
        &app.state,
        "member",
        AuthMethod::Session,
        "127.0.0.1".parse().unwrap(),
    )
    .await
    .unwrap()
    .token;
    let response = app
        .send(
            "POST",
            "/api/archives",
            Body::from(
                json!({
                    "entries": [{ "storage_id": "local", "path": "file", "kind": "file" }],
                })
                .to_string(),
            ),
            &[("Content-Type", "application/json")],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let ticket: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
    sqlx::query("DELETE FROM permissions WHERE id = 'permission'")
        .execute(&app.state.pool)
        .await
        .unwrap();
    let response = app
        .send(
            "GET",
            ticket["download_url"].as_str().unwrap(),
            Body::empty(),
            &[],
        )
        .await;
    assert_json_error(response, StatusCode::FORBIDDEN).await;
}

#[tokio::test]
async fn file_info_checks_access_and_reports_metadata() {
    let mut app = TestApp::new(1024).await;
    tokio::fs::write(app.root.path().join("note.txt"), b"hello")
        .await
        .unwrap();
    let response = app
        .send(
            "GET",
            "/api/files/local/info?path=note.txt",
            Body::empty(),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let info: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(info["size"], 5);
    assert_eq!(info["content_type"], "text/plain");
    assert!(info["modified_at"].is_string());
    assert!(info["media"].is_null());
    assert!(info["media_error"].is_null());
    assert_json_error(
        app.send(
            "GET",
            "/api/files/local/info?path=../note.txt",
            Body::empty(),
            &[],
        )
        .await,
        StatusCode::BAD_REQUEST,
    )
    .await;
    assert_json_error(
        app.send(
            "GET",
            "/api/files/local/info?path=missing.txt",
            Body::empty(),
            &[],
        )
        .await,
        StatusCode::NOT_FOUND,
    )
    .await;
    app.token = create_session(
        &app.state,
        "member",
        AuthMethod::Session,
        "127.0.0.1".parse().unwrap(),
    )
    .await
    .unwrap()
    .token;
    assert_json_error(
        app.send(
            "GET",
            "/api/files/local/info?path=note.txt",
            Body::empty(),
            &[],
        )
        .await,
        StatusCode::FORBIDDEN,
    )
    .await;
    app.token = "expired".into();
    assert_json_error(
        app.send(
            "GET",
            "/api/files/local/info?path=note.txt",
            Body::empty(),
            &[],
        )
        .await,
        StatusCode::UNAUTHORIZED,
    )
    .await;
}

#[tokio::test]
async fn failed_media_inspection_preserves_basic_info() {
    let app = TestApp::new(1024).await;
    tokio::fs::write(app.root.path().join("broken.mkv"), b"invalid video")
        .await
        .unwrap();
    let response = app
        .send(
            "GET",
            "/api/files/local/info?path=broken.mkv",
            Body::empty(),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let info: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert_eq!(info["size"], 13);
    assert!(info["media"].is_null());
    assert!(info["media_error"].is_string());
}

#[tokio::test]
#[ignore = "requires ffmpeg and ffprobe on PATH"]
async fn video_info_includes_fractional_frame_rate_and_all_track_types() {
    let app = TestApp::new(1024).await;
    let subtitles = app.root.path().join("captions.srt");
    tokio::fs::write(
        &subtitles,
        "1\n00:00:00,000 --> 00:00:01,000\nTest caption\n",
    )
    .await
    .unwrap();
    // MP4 writes its metadata at the end by default, exercising HTTP seeking.
    let output = tokio::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=64x64:rate=30000/1001",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000",
        ])
        .arg("-i")
        .arg(&subtitles)
        .args([
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-map",
            "2:s",
            "-t",
            "1",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-c:s",
            "mov_text",
            "-metadata:s:a:0",
            "language=eng",
        ])
        .arg(app.root.path().join("sample.mp4"))
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response = app
        .send(
            "GET",
            "/api/files/local/info?path=sample.mp4",
            Body::empty(),
            &[],
        )
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let info: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await.unwrap())
            .unwrap();
    assert!(info["media_error"].is_null(), "{info}");
    assert!(
        info["media"]["format"]["duration"]
            .as_str()
            .unwrap()
            .parse::<f64>()
            .unwrap()
            >= 1.0
    );
    let streams = info["media"]["streams"].as_array().unwrap();
    assert_eq!(streams.len(), 3);
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .unwrap();
    assert_eq!(video["avg_frame_rate"], "30000/1001");
    assert_eq!(video["width"], 64);
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio")
        .unwrap();
    assert_eq!(audio["tags"]["language"], "eng");
    assert!(
        streams
            .iter()
            .any(|stream| stream["codec_type"] == "subtitle")
    );
}
