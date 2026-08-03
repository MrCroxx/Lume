use std::{env, path::Path};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
pub struct Config {
    pub server: ServerConfig,
    pub database: DatabaseConfig,
    pub auth: AuthConfig,
    #[serde(default)]
    pub storages: Vec<StorageConfig>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ServerConfig {
    #[serde(default = "default_address")]
    pub address: String,
    #[serde(default = "default_frontend_dist")]
    pub frontend_dist: String,
    #[serde(default = "default_upload_limit")]
    pub max_upload_bytes: usize,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DatabaseConfig {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthConfig {
    #[serde(default = "default_session_hours")]
    pub session_hours: i64,
    #[serde(default)]
    pub secure_cookies: bool,
    #[serde(default = "default_admin_username")]
    pub bootstrap_admin_username: String,
    #[serde(default = "default_admin_password_env")]
    pub bootstrap_admin_password_env: String,
    #[serde(default)]
    pub trusted_proxy_cidrs: Vec<String>,
    #[serde(default)]
    pub bypass_rules: Vec<BypassRule>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BypassRule {
    pub user: String,
    #[serde(default)]
    pub cidrs: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StorageConfig {
    Fs {
        id: String,
        name: String,
        root: String,
    },
    Smb {
        id: String,
        name: String,
        mount_path: String,
    },
    Ftp {
        id: String,
        name: String,
        endpoint: String,
        #[serde(default)]
        root: String,
        user: Option<String>,
        #[serde(default)]
        password: Option<String>,
        password_env: Option<String>,
    },
    Sftp {
        id: String,
        name: String,
        endpoint: String,
        #[serde(default)]
        root: String,
        user: Option<String>,
        #[serde(default)]
        key: Option<String>,
        key_env: Option<String>,
        known_hosts_strategy: Option<String>,
    },
    Webdav {
        id: String,
        name: String,
        endpoint: String,
        #[serde(default)]
        root: String,
        username: Option<String>,
        #[serde(default)]
        password: Option<String>,
        password_env: Option<String>,
    },
    S3 {
        id: String,
        name: String,
        bucket: String,
        #[serde(default)]
        root: String,
        region: Option<String>,
        endpoint: Option<String>,
        #[serde(default)]
        access_key_id: Option<String>,
        access_key_id_env: Option<String>,
        #[serde(default)]
        secret_access_key: Option<String>,
        secret_access_key_env: Option<String>,
    },
}

impl Config {
    pub async fn load(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let path = path.as_ref();
        let mut config = match tokio::fs::read_to_string(path).await {
            Ok(contents) => toml::from_str(&contents).context("invalid configuration")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self::default(),
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to read configuration from {}", path.display())
                });
            }
        };
        config.apply_environment();
        config.validate()?;
        Ok(config)
    }

    fn apply_environment(&mut self) {
        if let Ok(value) = env::var("LUME_ADDRESS") {
            self.server.address = value;
        }
        if let Ok(value) = env::var("LUME_FRONTEND_DIST") {
            self.server.frontend_dist = value;
        }
        if let Ok(value) = env::var("LUME_DATABASE_URL") {
            self.database.url = value;
        }
        if let Ok(value) = env::var("LUME_ADMIN_USERNAME") {
            self.auth.bootstrap_admin_username = value;
        }
    }

    fn validate(&self) -> anyhow::Result<()> {
        for storage in &self.storages {
            let id = storage.id();
            if id.is_empty()
                || !id.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-' || character == '_'
                })
            {
                bail!("storage id {id:?} must contain only ASCII letters, digits, '-' or '_'");
            }
        }
        for rule in &self.auth.bypass_rules {
            if rule.cidrs.is_empty() && rule.domains.is_empty() {
                bail!("bypass rule for {} has no matcher", rule.user);
            }
        }
        Ok(())
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                address: default_address(),
                frontend_dist: default_frontend_dist(),
                max_upload_bytes: default_upload_limit(),
            },
            database: DatabaseConfig {
                url: "sqlite://data/lume.db".into(),
            },
            auth: AuthConfig {
                session_hours: default_session_hours(),
                secure_cookies: false,
                bootstrap_admin_username: default_admin_username(),
                bootstrap_admin_password_env: default_admin_password_env(),
                trusted_proxy_cidrs: Vec::new(),
                bypass_rules: Vec::new(),
            },
            storages: Vec::new(),
        }
    }
}

impl StorageConfig {
    pub fn id(&self) -> &str {
        match self {
            Self::Fs { id, .. }
            | Self::Smb { id, .. }
            | Self::Ftp { id, .. }
            | Self::Sftp { id, .. }
            | Self::Webdav { id, .. }
            | Self::S3 { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Fs { name, .. }
            | Self::Smb { name, .. }
            | Self::Ftp { name, .. }
            | Self::Sftp { name, .. }
            | Self::Webdav { name, .. }
            | Self::S3 { name, .. } => name,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Fs { .. } => "fs",
            Self::Smb { .. } => "smb",
            Self::Ftp { .. } => "ftp",
            Self::Sftp { .. } => "sftp",
            Self::Webdav { .. } => "webdav",
            Self::S3 { .. } => "s3",
        }
    }
}

pub fn secret_from_env(variable: &Option<String>) -> anyhow::Result<Option<String>> {
    variable
        .as_ref()
        .map(|name| {
            env::var(name).with_context(|| format!("environment variable {name} is required"))
        })
        .transpose()
}

fn default_address() -> String {
    "0.0.0.0:8080".into()
}

fn default_frontend_dist() -> String {
    "frontend/dist".into()
}

fn default_upload_limit() -> usize {
    256 * 1024 * 1024
}

fn default_session_hours() -> i64 {
    24 * 7
}

fn default_admin_username() -> String {
    "admin".into()
}

fn default_admin_password_env() -> String {
    "LUME_ADMIN_PASSWORD".into()
}
