use std::{collections::HashMap, sync::Arc};

use anyhow::Context;
use arc_swap::ArcSwap;
use ipnet::IpNet;
use sqlx::SqlitePool;

use crate::{
    archive::ArchiveTickets,
    config::Config,
    db,
    models::RuntimeSettingsView,
    secrets::SecretCipher,
    storage::{Storage, build_storage, materialize_secrets},
};

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub storages: Arc<ArcSwap<HashMap<String, Arc<Storage>>>>,
    pub settings: Arc<ArcSwap<RuntimeSettings>>,
    pub cipher: Arc<SecretCipher>,
    pub archive_tickets: ArchiveTickets,
}

#[derive(Debug, Clone)]
pub struct RuntimeSettings {
    pub session_hours: i64,
    pub secure_cookies: bool,
    pub max_upload_bytes: usize,
    pub trusted_proxy_cidrs: Vec<String>,
    pub trusted_proxies: Vec<IpNet>,
}

impl AppState {
    pub async fn new(config: Config) -> anyhow::Result<Self> {
        let pool = db::connect(&config).await?;
        let cipher = Arc::new(SecretCipher::load()?);
        import_legacy_storages(&pool, &cipher, &config).await?;
        let settings = RuntimeSettings::load(&pool).await?;
        let state = Self {
            pool,
            storages: Arc::new(ArcSwap::from_pointee(HashMap::new())),
            settings: Arc::new(ArcSwap::from_pointee(settings)),
            cipher,
            archive_tickets: ArchiveTickets::new(),
        };
        state.reload_storages().await?;
        Ok(state)
    }

    pub async fn reload_settings(&self) -> anyhow::Result<()> {
        self.settings
            .store(Arc::new(RuntimeSettings::load(&self.pool).await?));
        Ok(())
    }

    pub async fn reload_storages(&self) -> anyhow::Result<()> {
        let records = sqlx::query_as::<_, (String, String)>(
            "SELECT id, config_ciphertext FROM storage_connections WHERE enabled = 1 ORDER BY id",
        )
        .fetch_all(&self.pool)
        .await?;
        let mut storages = HashMap::new();
        for (id, ciphertext) in records {
            let result = match self.cipher.decrypt(&ciphertext) {
                Ok(config) => build_storage(&config).await,
                Err(error) => Err(error),
            };
            match result {
                Ok(storage) => {
                    storages.insert(id.clone(), Arc::new(storage));
                    sqlx::query("UPDATE storage_connections SET last_error = NULL WHERE id = ?")
                        .bind(&id)
                        .execute(&self.pool)
                        .await?;
                }
                Err(error) => {
                    let message = format!("{error:#}");
                    tracing::error!(storage_id = %id, error = %message, "failed to load storage");
                    sqlx::query("UPDATE storage_connections SET last_error = ? WHERE id = ?")
                        .bind(message)
                        .bind(&id)
                        .execute(&self.pool)
                        .await?;
                }
            }
        }
        self.storages.store(Arc::new(storages));
        Ok(())
    }
}

async fn import_legacy_storages(
    pool: &SqlitePool,
    cipher: &SecretCipher,
    config: &Config,
) -> anyhow::Result<()> {
    let imported: Option<String> = sqlx::query_scalar(
        "SELECT value FROM system_metadata WHERE key = 'legacy_storages_imported'",
    )
    .fetch_optional(pool)
    .await?;
    if imported.is_some() {
        return Ok(());
    }
    for legacy in &config.storages {
        let storage = materialize_secrets(legacy)?;
        let ciphertext = cipher.encrypt(&storage)?;
        sqlx::query(
            r#"INSERT INTO storage_connections
               (id, name, kind, enabled, config_ciphertext)
               VALUES (?, ?, ?, 1, ?)
               ON CONFLICT(id) DO NOTHING"#,
        )
        .bind(storage.id())
        .bind(storage.name())
        .bind(storage.kind())
        .bind(ciphertext)
        .execute(pool)
        .await?;
    }
    sqlx::query(
        "INSERT INTO system_metadata (key, value) VALUES ('legacy_storages_imported', '1')",
    )
    .execute(pool)
    .await?;
    Ok(())
}

impl RuntimeSettings {
    async fn load(pool: &SqlitePool) -> anyhow::Result<Self> {
        let (session_hours, secure_cookies, max_upload_bytes, trusted_proxy_cidrs_json) =
            sqlx::query_as::<_, (i64, bool, i64, String)>(
                r#"SELECT session_hours, secure_cookies, max_upload_bytes,
                          trusted_proxy_cidrs_json
                   FROM runtime_settings WHERE id = 1"#,
            )
            .fetch_one(pool)
            .await?;
        let trusted_proxy_cidrs: Vec<String> = serde_json::from_str(&trusted_proxy_cidrs_json)
            .context("invalid trusted proxy CIDRs in database")?;
        let trusted_proxies = parse_cidrs(&trusted_proxy_cidrs)?;
        let max_upload_bytes = usize::try_from(max_upload_bytes)
            .context("max upload size in database does not fit usize")?;
        Ok(Self {
            session_hours,
            secure_cookies,
            max_upload_bytes,
            trusted_proxy_cidrs,
            trusted_proxies,
        })
    }

    pub fn view(&self) -> RuntimeSettingsView {
        RuntimeSettingsView {
            session_hours: self.session_hours,
            secure_cookies: self.secure_cookies,
            max_upload_bytes: self.max_upload_bytes,
            trusted_proxy_cidrs: self.trusted_proxy_cidrs.clone(),
        }
    }
}

pub fn parse_cidrs(values: &[String]) -> anyhow::Result<Vec<IpNet>> {
    values
        .iter()
        .map(|value| {
            value
                .parse::<IpNet>()
                .with_context(|| format!("invalid CIDR {value}"))
        })
        .collect()
}
