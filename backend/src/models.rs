use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct UserRecord {
    pub id: String,
    pub username: String,
    pub password_hash: Option<String>,
    pub role: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserView {
    pub id: String,
    pub username: String,
    pub role: String,
    pub is_active: bool,
    pub created_at: DateTime<Utc>,
}

impl From<UserRecord> for UserView {
    fn from(value: UserRecord) -> Self {
        Self {
            id: value.id,
            username: value.username,
            role: value.role,
            is_active: value.is_active,
            created_at: value.created_at,
        }
    }
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct PermissionRecord {
    pub id: String,
    pub user_id: String,
    pub storage_id: String,
    pub path_prefix: String,
    pub can_read: bool,
    pub can_write: bool,
    pub can_manage: bool,
}

#[derive(Debug, Clone, Copy)]
pub enum Access {
    Read,
    Write,
    Manage,
}

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
    pub modified_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct StorageView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub can_read: bool,
    pub can_write: bool,
    pub can_manage: bool,
    pub roots: Vec<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct StorageConnectionRecord {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub config_ciphertext: String,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageConnectionView {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub enabled: bool,
    pub root: String,
    pub endpoint: Option<String>,
    pub mount_path: Option<String>,
    pub username: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub known_hosts_strategy: Option<String>,
    pub has_password: bool,
    pub has_key: bool,
    pub has_access_key_id: bool,
    pub has_secret_access_key: bool,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct SaveStorageConnectionRequest {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub root: String,
    pub endpoint: Option<String>,
    pub mount_path: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    pub key: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub known_hosts_strategy: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct LoginOptionsRequest {
    pub username: String,
}

#[derive(Debug, Serialize)]
pub struct LoginOptionsView {
    pub password_required: bool,
}

#[derive(Debug, Serialize)]
pub struct SessionView {
    pub user: UserView,
    pub auth_method: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateUserRequest {
    pub username: String,
    pub password: String,
    #[serde(default = "default_role")]
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAccountRequest {
    pub username: String,
    pub current_password: String,
    pub new_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateUserRequest {
    pub username: String,
    pub password: Option<String>,
    pub role: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, FromRow)]
pub struct TrustedAccessRuleRecord {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub enabled: bool,
    pub cidrs_json: String,
    pub domains_json: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrustedAccessRuleView {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub enabled: bool,
    pub cidrs: Vec<String>,
    pub domains: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct SaveTrustedAccessRuleRequest {
    pub user_id: String,
    pub name: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub cidrs: Vec<String>,
    #[serde(default)]
    pub domains: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeSettingsView {
    pub session_hours: i64,
    pub secure_cookies: bool,
    pub max_upload_bytes: usize,
    pub trusted_proxy_cidrs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRuntimeSettingsRequest {
    pub session_hours: i64,
    pub secure_cookies: bool,
    pub max_upload_bytes: usize,
    #[serde(default)]
    pub trusted_proxy_cidrs: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct GrantPermissionRequest {
    pub user_id: String,
    pub storage_id: String,
    #[serde(default)]
    pub path_prefix: String,
    #[serde(default)]
    pub can_read: bool,
    #[serde(default)]
    pub can_write: bool,
    #[serde(default)]
    pub can_manage: bool,
}

#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct MoveRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct BatchDeleteRequest {
    pub entries: Vec<BatchDeleteEntryRequest>,
}

#[derive(Debug, Deserialize)]
pub struct BatchDeleteEntryRequest {
    pub path: String,
    #[serde(default)]
    pub recursive: bool,
}

#[derive(Debug, Serialize)]
pub struct BatchDeleteResult {
    pub deleted: Vec<String>,
    pub failed: Vec<BatchDeleteFailure>,
}

#[derive(Debug, Serialize)]
pub struct BatchDeleteFailure {
    pub path: String,
    pub error: String,
}

fn default_role() -> String {
    "member".into()
}

fn default_enabled() -> bool {
    true
}
