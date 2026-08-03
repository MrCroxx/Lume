use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

use async_zip::{Compression, ZipEntryBuilder, base::write::ZipFileWriter};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{TryStreamExt, io::AsyncWriteExt};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    auth::{AuthContext, permissions_allow, permissions_allow_traversal, user_permissions},
    error::{AppError, AppResult},
    models::{Access, PermissionRecord},
    state::AppState,
    storage::{Storage, normalize_path, path_is_within, paths_equal},
};

const MAX_ARCHIVE_ROOTS: usize = 1_000;
const MAX_ARCHIVE_ENTRIES: usize = 50_000;
const MAX_PENDING_ARCHIVES: usize = 64;
const MAX_CONCURRENT_ARCHIVES: usize = 2;
const ARCHIVE_TICKET_TTL: Duration = Duration::from_secs(120);
const ZIP_BUFFER_SIZE: usize = 256 * 1024;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/archives", post(create_archive))
        .route("/api/archives/{ticket_id}", get(download_archive))
}

#[derive(Debug, Deserialize)]
struct CreateArchiveRequest {
    #[serde(default)]
    base_path: String,
    entries: Vec<ArchiveRequestEntry>,
}

#[derive(Debug, Deserialize)]
struct ArchiveRequestEntry {
    storage_id: String,
    path: String,
    kind: ArchiveEntryKind,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ArchiveEntryKind {
    File,
    Directory,
}

#[derive(Debug, Serialize)]
struct CreateArchiveResponse {
    download_url: String,
    filename: String,
}

#[derive(Clone)]
struct ArchiveManifestEntry {
    storage: Arc<Storage>,
    source_path: String,
    archive_path: String,
    directory: bool,
    size: u64,
}

struct ArchiveTicket {
    user_id: String,
    filename: String,
    created_at: Instant,
    entries: Vec<ArchiveManifestEntry>,
}

#[derive(Clone)]
pub struct ArchiveTickets {
    entries: Arc<Mutex<HashMap<String, ArchiveTicket>>>,
    permits: Arc<Semaphore>,
}

impl ArchiveTickets {
    pub fn new() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_ARCHIVES)),
        }
    }

    async fn insert(&self, ticket: ArchiveTicket) -> AppResult<String> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, existing| existing.created_at.elapsed() < ARCHIVE_TICKET_TTL);
        if entries.len() >= MAX_PENDING_ARCHIVES {
            return Err(AppError::Conflict(
                "too many archive downloads are waiting".into(),
            ));
        }
        let id = Uuid::now_v7().to_string();
        entries.insert(id.clone(), ticket);
        Ok(id)
    }

    async fn take(&self, id: &str, user_id: &str) -> AppResult<ArchiveTicket> {
        let mut entries = self.entries.lock().await;
        entries.retain(|_, existing| existing.created_at.elapsed() < ARCHIVE_TICKET_TTL);
        if entries
            .get(id)
            .is_none_or(|ticket| ticket.user_id != user_id)
        {
            return Err(AppError::NotFound("archive download not found".into()));
        }
        entries
            .remove(id)
            .ok_or_else(|| AppError::NotFound("archive download not found".into()))
    }

    fn acquire(&self) -> AppResult<OwnedSemaphorePermit> {
        self.permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| AppError::Conflict("too many archives are downloading".into()))
    }
}

async fn create_archive(
    State(state): State<AppState>,
    auth: AuthContext,
    Json(request): Json<CreateArchiveRequest>,
) -> AppResult<Json<CreateArchiveResponse>> {
    if request.entries.is_empty() {
        return Err(AppError::BadRequest(
            "at least one archive entry is required".into(),
        ));
    }
    if request.entries.len() > MAX_ARCHIVE_ROOTS {
        return Err(AppError::BadRequest(format!(
            "an archive can contain at most {MAX_ARCHIVE_ROOTS} selected entries"
        )));
    }

    let filename = archive_filename(&request);
    let entries = build_manifest(&state, &auth, request).await?;
    let ticket_id = state
        .archive_tickets
        .insert(ArchiveTicket {
            user_id: auth.user.id,
            filename: filename.clone(),
            created_at: Instant::now(),
            entries,
        })
        .await?;

    Ok(Json(CreateArchiveResponse {
        download_url: format!("/api/archives/{ticket_id}"),
        filename,
    }))
}

async fn download_archive(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(ticket_id): Path<String>,
) -> AppResult<Response> {
    let permit = state.archive_tickets.acquire()?;
    let ticket = state
        .archive_tickets
        .take(&ticket_id, &auth.user.id)
        .await?;
    let filename = ticket.filename.clone();
    let (writer, reader) = tokio::io::duplex(ZIP_BUFFER_SIZE);

    tokio::spawn(async move {
        let _permit = permit;
        if let Err(error) = write_archive(writer, ticket.entries).await {
            tracing::error!(error = ?error, "archive stream failed");
        }
    });

    let mut response = Body::from_stream(ReaderStream::new(reader)).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        archive_content_disposition(&filename)?,
    );
    Ok(response)
}

async fn build_manifest(
    state: &AppState,
    auth: &AuthContext,
    request: CreateArchiveRequest,
) -> AppResult<Vec<ArchiveManifestEntry>> {
    let base_path = normalize_path(&request.base_path, true).map_err(bad_request)?;
    let mut roots = normalize_roots(request.entries)?;
    let storage_ids = roots
        .iter()
        .map(|entry| entry.storage_id.clone())
        .collect::<HashSet<_>>();
    if storage_ids.len() != 1 {
        return Err(AppError::BadRequest(
            "an archive must contain entries from exactly one storage".into(),
        ));
    }

    let storages = state.storages.load();
    let mut selected_storages = HashMap::<String, Arc<Storage>>::new();
    for storage_id in storage_ids {
        let storage = storages
            .get(&storage_id)
            .cloned()
            .ok_or_else(|| AppError::NotFound("storage not found".into()))?;
        selected_storages.insert(storage_id, storage);
    }
    drop(storages);

    let mut permissions = HashMap::<String, Vec<PermissionRecord>>::new();
    for storage_id in selected_storages.keys() {
        permissions.insert(
            storage_id.clone(),
            user_permissions(state, auth, storage_id).await?,
        );
    }

    roots.sort_by(|left, right| {
        left.storage_id
            .cmp(&right.storage_id)
            .then_with(|| left.path.len().cmp(&right.path.len()))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut manifest = Vec::new();
    let mut archive_paths = HashSet::new();
    for root in roots {
        let storage = selected_storages
            .get(&root.storage_id)
            .expect("selected storage must exist")
            .clone();
        let storage_permissions = permissions
            .get(&root.storage_id)
            .expect("selected storage permissions must exist");
        if !path_is_within(&root.path, &base_path) {
            return Err(AppError::BadRequest(
                "archive entry is outside the requested base path".into(),
            ));
        }

        let metadata = storage.operator.stat(&root.path).await?;
        let directory = metadata.is_dir();
        if directory != matches!(root.kind, ArchiveEntryKind::Directory) {
            return Err(AppError::Conflict(format!(
                "{} changed while preparing the archive",
                root.path
            )));
        }
        require_archive_access(auth, storage_permissions, &root.path, directory)?;
        push_manifest_entry(
            &mut manifest,
            &mut archive_paths,
            storage.clone(),
            &root.path,
            directory,
            metadata.content_length(),
            &base_path,
        )?;

        if directory {
            let mut lister = storage
                .operator
                .lister_with(&root.path)
                .recursive(true)
                .await?;
            while let Some(entry) = lister.try_next().await? {
                if paths_equal(entry.path(), &root.path) {
                    continue;
                }
                let child_directory = entry.metadata().is_dir();
                if !archive_access_allowed(auth, storage_permissions, entry.path(), child_directory)
                {
                    continue;
                }
                push_manifest_entry(
                    &mut manifest,
                    &mut archive_paths,
                    storage.clone(),
                    entry.path(),
                    child_directory,
                    entry.metadata().content_length(),
                    &base_path,
                )?;
            }
        }
    }

    manifest.sort_by(|left, right| left.archive_path.cmp(&right.archive_path));
    Ok(manifest)
}

#[derive(Debug)]
struct NormalizedArchiveRoot {
    storage_id: String,
    path: String,
    kind: ArchiveEntryKind,
}

fn normalize_roots(entries: Vec<ArchiveRequestEntry>) -> AppResult<Vec<NormalizedArchiveRoot>> {
    let mut entries = entries
        .into_iter()
        .map(|entry| {
            if entry.storage_id.is_empty() {
                return Err(AppError::BadRequest("storage id is required".into()));
            }
            let directory = matches!(entry.kind, ArchiveEntryKind::Directory);
            let path = normalize_path(&entry.path, directory).map_err(bad_request)?;
            if path.is_empty() {
                return Err(AppError::BadRequest(
                    "archiving a storage root is not allowed".into(),
                ));
            }
            Ok(NormalizedArchiveRoot {
                storage_id: entry.storage_id,
                path,
                kind: entry.kind,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;

    entries.sort_by(|left, right| {
        left.storage_id
            .cmp(&right.storage_id)
            .then_with(|| left.path.len().cmp(&right.path.len()))
            .then_with(|| left.path.cmp(&right.path))
    });
    let mut normalized = Vec::<NormalizedArchiveRoot>::with_capacity(entries.len());
    for entry in entries {
        if normalized.iter().any(|parent| {
            parent.storage_id == entry.storage_id
                && (paths_equal(&parent.path, &entry.path)
                    || (matches!(parent.kind, ArchiveEntryKind::Directory)
                        && path_is_within(&entry.path, &parent.path)))
        }) {
            continue;
        }
        normalized.push(entry);
    }
    Ok(normalized)
}

fn push_manifest_entry(
    manifest: &mut Vec<ArchiveManifestEntry>,
    archive_paths: &mut HashSet<String>,
    storage: Arc<Storage>,
    source_path: &str,
    directory: bool,
    size: u64,
    base_path: &str,
) -> AppResult<()> {
    if manifest.len() >= MAX_ARCHIVE_ENTRIES {
        return Err(AppError::BadRequest(format!(
            "an archive can contain at most {MAX_ARCHIVE_ENTRIES} entries"
        )));
    }
    let archive_path = archive_path(source_path, directory, base_path)?;
    if !archive_paths.insert(archive_path.clone()) {
        return Err(AppError::Conflict(format!(
            "multiple selected entries map to {archive_path}"
        )));
    }
    manifest.push(ArchiveManifestEntry {
        storage,
        source_path: source_path.into(),
        archive_path,
        directory,
        size,
    });
    Ok(())
}

fn archive_path(source_path: &str, directory: bool, base_path: &str) -> AppResult<String> {
    let normalized_source = sanitize_zip_path(source_path)?;
    let normalized_base = base_path.trim_matches('/');
    let relative = if normalized_base.is_empty() {
        normalized_source.clone()
    } else {
        normalized_source
            .strip_prefix(normalized_base)
            .and_then(|suffix| suffix.strip_prefix('/').or(Some(suffix)))
            .filter(|suffix| !suffix.is_empty())
            .unwrap_or_else(|| {
                normalized_source
                    .rsplit('/')
                    .next()
                    .unwrap_or(&normalized_source)
            })
            .to_string()
    };
    let relative = relative.trim_matches('/');
    if relative.is_empty() {
        return Err(AppError::BadRequest("archive path is empty".into()));
    }
    Ok(if directory {
        format!("{relative}/")
    } else {
        relative.into()
    })
}

fn sanitize_zip_path(path: &str) -> AppResult<String> {
    if path.contains(['\\', '\0']) {
        return Err(AppError::BadRequest(
            "archive path contains an invalid character".into(),
        ));
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(AppError::BadRequest(
                    "archive path traversal is not allowed".into(),
                ));
            }
            value => parts.push(value),
        }
    }
    Ok(parts.join("/"))
}

fn sanitize_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':' | '"') {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    if sanitized.is_empty() {
        "connection".into()
    } else {
        sanitized
    }
}

fn require_archive_access(
    auth: &AuthContext,
    permissions: &[PermissionRecord],
    path: &str,
    directory: bool,
) -> AppResult<()> {
    if archive_access_allowed(auth, permissions, path, directory) {
        Ok(())
    } else {
        Err(AppError::Forbidden)
    }
}

fn archive_access_allowed(
    auth: &AuthContext,
    permissions: &[PermissionRecord],
    path: &str,
    directory: bool,
) -> bool {
    auth.user.role == "admin"
        || if directory {
            permissions_allow_traversal(permissions, path)
        } else {
            permissions_allow(permissions, path, Access::Read)
        }
}

async fn write_archive(
    writer: tokio::io::DuplexStream,
    entries: Vec<ArchiveManifestEntry>,
) -> anyhow::Result<()> {
    let mut archive = ZipFileWriter::with_tokio(writer).force_zip64();
    for entry in entries {
        let builder = ZipEntryBuilder::new(entry.archive_path.into(), Compression::Stored)
            .uncompressed_size(entry.size);
        if entry.directory {
            archive.write_entry_whole(builder, &[]).await?;
            continue;
        }

        let mut entry_writer = archive.write_entry_stream(builder).await?;
        let reader = entry.storage.operator.reader(&entry.source_path).await?;
        let mut stream = reader.into_bytes_stream(..).await?;
        while let Some(bytes) = stream.try_next().await? {
            entry_writer.write_all(&bytes).await?;
        }
        entry_writer.close().await?;
    }
    archive.close().await?;
    Ok(())
}

fn archive_filename(request: &CreateArchiveRequest) -> String {
    if request.entries.len() == 1 {
        let name = request.entries[0]
            .path
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .map(sanitize_component)
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "lume-download".into());
        return format!("{name}.zip");
    }
    format!(
        "lume-download-{}.zip",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    )
}

fn archive_content_disposition(filename: &str) -> AppResult<HeaderValue> {
    let fallback = filename
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    let encoded = utf8_percent_encode(filename, NON_ALPHANUMERIC);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}"
    ))
    .map_err(|error| AppError::Internal(error.into()))
}

fn bad_request(error: anyhow::Error) -> AppError {
    AppError::BadRequest(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::StorageConfig;
    use tokio::io::AsyncReadExt;

    #[test]
    fn archive_roots_collapse_directories_and_descendants_per_storage() {
        let roots = normalize_roots(vec![
            ArchiveRequestEntry {
                storage_id: "one".into(),
                path: "photos/2026/image.jpg".into(),
                kind: ArchiveEntryKind::File,
            },
            ArchiveRequestEntry {
                storage_id: "one".into(),
                path: "photos".into(),
                kind: ArchiveEntryKind::Directory,
            },
            ArchiveRequestEntry {
                storage_id: "two".into(),
                path: "photos/2026/image.jpg".into(),
                kind: ArchiveEntryKind::File,
            },
        ])
        .unwrap();

        assert_eq!(roots.len(), 2);
        assert_eq!(roots[0].storage_id, "one");
        assert_eq!(roots[0].path, "photos/");
        assert_eq!(roots[1].storage_id, "two");
    }

    #[test]
    fn archive_paths_are_relative_to_the_current_directory() {
        assert_eq!(
            archive_path("media/photos/a.jpg", false, "media/").unwrap(),
            "photos/a.jpg"
        );
        assert_eq!(
            archive_path("media/photos/", true, "media/").unwrap(),
            "photos/"
        );
    }

    #[test]
    fn archive_content_disposition_supports_unicode_filenames() {
        let value = archive_content_disposition("照片.zip").unwrap();

        assert_eq!(
            value.to_str().unwrap(),
            "attachment; filename=\"__.zip\"; filename*=UTF-8''%E7%85%A7%E7%89%87%2Ezip"
        );
    }

    #[tokio::test]
    async fn writes_streaming_zip_entries() {
        let directory = tempfile::tempdir().unwrap();
        let storage = Arc::new(
            crate::storage::build_storage(&StorageConfig::Fs {
                id: "test".into(),
                name: "Test".into(),
                root: directory.path().to_string_lossy().into_owned(),
            })
            .await
            .unwrap(),
        );
        storage
            .operator
            .write("hello.txt", "hello from Lume")
            .await
            .unwrap();
        let manifest = vec![ArchiveManifestEntry {
            storage,
            source_path: "hello.txt".into(),
            archive_path: "Test/hello.txt".into(),
            directory: false,
            size: 15,
        }];
        let (writer, mut reader) = tokio::io::duplex(4096);
        let task = tokio::spawn(write_archive(writer, manifest));
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        task.await.unwrap().unwrap();

        let zip = async_zip::base::read::mem::ZipFileReader::new(bytes)
            .await
            .unwrap();
        assert_eq!(zip.file().entries().len(), 1);
        assert_eq!(
            zip.file().entries()[0].filename().as_str().unwrap(),
            "Test/hello.txt"
        );
    }
}
