use std::{str::FromStr, time::Duration};

use anyhow::{Context, bail};
use sqlx::{SqlitePool, sqlite::SqliteConnectOptions};
use uuid::Uuid;

use crate::{auth::hash_password, config::Config};

pub async fn connect(config: &Config) -> anyhow::Result<SqlitePool> {
    if let Some(path) = config.database.url.strip_prefix("sqlite://")
        && path != ":memory:"
        && let Some(parent) = std::path::Path::new(path).parent()
    {
        tokio::fs::create_dir_all(parent).await?;
    }
    let options = SqliteConnectOptions::from_str(&config.database.url)?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(5));
    let pool = SqlitePool::connect_with(options).await?;

    for statement in SCHEMA {
        sqlx::query(*statement).execute(&pool).await?;
    }
    ensure_session_auth_method(&pool).await?;
    ensure_runtime_settings(&pool, config).await?;
    ensure_bootstrap_admin(&pool, config).await?;
    import_legacy_bypass_rules(&pool, config).await?;
    Ok(pool)
}

async fn ensure_bootstrap_admin(pool: &SqlitePool, config: &Config) -> anyhow::Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        return Ok(());
    }

    let password = std::env::var(&config.auth.bootstrap_admin_password_env).with_context(|| {
        format!(
            "{} must be set when initializing the first administrator",
            config.auth.bootstrap_admin_password_env
        )
    })?;
    if password.is_empty() {
        bail!("bootstrap administrator password must not be empty");
    }
    let password_hash = hash_password(password).await?;
    sqlx::query(
        "INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, ?, 'admin', 1)",
    )
    .bind(Uuid::now_v7().to_string())
    .bind(&config.auth.bootstrap_admin_username)
    .bind(password_hash)
    .execute(pool)
    .await?;
    Ok(())
}

async fn ensure_session_auth_method(pool: &SqlitePool) -> anyhow::Result<()> {
    let exists: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pragma_table_info('sessions') WHERE name = 'auth_method'",
    )
    .fetch_one(pool)
    .await?;
    if exists == 0 {
        sqlx::query("ALTER TABLE sessions ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'session'")
            .execute(pool)
            .await?;
    }
    Ok(())
}

async fn ensure_runtime_settings(pool: &SqlitePool, config: &Config) -> anyhow::Result<()> {
    sqlx::query(
        r#"INSERT INTO runtime_settings
           (id, session_hours, secure_cookies, max_upload_bytes, trusted_proxy_cidrs_json)
           VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING"#,
    )
    .bind(config.auth.session_hours)
    .bind(config.auth.secure_cookies)
    .bind(config.server.max_upload_bytes as i64)
    .bind(serde_json::to_string(&config.auth.trusted_proxy_cidrs)?)
    .execute(pool)
    .await?;
    Ok(())
}

async fn import_legacy_bypass_rules(pool: &SqlitePool, config: &Config) -> anyhow::Result<()> {
    let imported: Option<String> = sqlx::query_scalar(
        "SELECT value FROM system_metadata WHERE key = 'legacy_bypass_imported'",
    )
    .fetch_optional(pool)
    .await?;
    if imported.is_some() {
        return Ok(());
    }

    for rule in &config.auth.bypass_rules {
        sqlx::query(
            "INSERT INTO users (id, username, password_hash, role, is_active) VALUES (?, ?, NULL, 'member', 1) ON CONFLICT(username) DO NOTHING",
        )
        .bind(Uuid::now_v7().to_string())
        .bind(&rule.user)
        .execute(pool)
        .await?;
        let user_id: String = sqlx::query_scalar("SELECT id FROM users WHERE username = ?")
            .bind(&rule.user)
            .fetch_one(pool)
            .await?;
        sqlx::query(
            r#"INSERT INTO trusted_access_rules
               (id, user_id, name, enabled, cidrs_json, domains_json)
               VALUES (?, ?, 'Imported trusted access', 1, ?, ?)"#,
        )
        .bind(Uuid::now_v7().to_string())
        .bind(user_id)
        .bind(serde_json::to_string(&rule.cidrs)?)
        .bind(serde_json::to_string(&rule.domains)?)
        .execute(pool)
        .await?;
    }
    sqlx::query("INSERT INTO system_metadata (key, value) VALUES ('legacy_bypass_imported', '1')")
        .execute(pool)
        .await?;
    Ok(())
}

const SCHEMA: &[&str] = &[
    "PRAGMA journal_mode = WAL",
    r#"CREATE TABLE IF NOT EXISTS system_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    )"#,
    r#"CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT,
        role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )"#,
    r#"CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )"#,
    r#"CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        storage_id TEXT NOT NULL,
        path_prefix TEXT NOT NULL DEFAULT '',
        can_read INTEGER NOT NULL DEFAULT 0,
        can_write INTEGER NOT NULL DEFAULT 0,
        can_manage INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, storage_id, path_prefix)
    )"#,
    r#"CREATE TABLE IF NOT EXISTS runtime_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_hours INTEGER NOT NULL CHECK (session_hours > 0),
        secure_cookies INTEGER NOT NULL DEFAULT 0,
        max_upload_bytes INTEGER NOT NULL CHECK (max_upload_bytes > 0),
        trusted_proxy_cidrs_json TEXT NOT NULL DEFAULT '[]',
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )"#,
    r#"CREATE TABLE IF NOT EXISTS trusted_access_rules (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cidrs_json TEXT NOT NULL DEFAULT '[]',
        domains_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )"#,
    r#"CREATE TABLE IF NOT EXISTS storage_connections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_ciphertext TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )"#,
    "CREATE INDEX IF NOT EXISTS idx_permissions_user_storage ON permissions(user_id, storage_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_trusted_access_user ON trusted_access_rules(user_id, enabled)",
];
