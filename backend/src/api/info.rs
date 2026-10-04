use std::{
    ops::Range,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use axum::{
    Router,
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::TryStreamExt;
use serde::Serialize;
use serde_json::Value;
use tokio::{io::AsyncReadExt, net::TcpListener, process::Command, sync::Semaphore};
use uuid::Uuid;

use super::{
    PathQuery, bad_request,
    extract::{Json, Query},
    file_entry, get_storage,
};
use crate::{
    auth::{AuthContext, require_access},
    error::AppResult,
    models::{Access, FileEntry},
    state::AppState,
    storage::normalize_path,
};

static PROBE_SLOTS: Semaphore = Semaphore::const_new(2);
const MAX_PROBE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub(super) struct FileInfo {
    #[serde(flatten)]
    entry: FileEntry,
    content_type: String,
    media: Option<Value>,
    media_error: Option<String>,
}

pub(super) async fn file_info(
    State(state): State<AppState>,
    auth: AuthContext,
    Path(storage_id): Path<String>,
    Query(query): Query<PathQuery>,
) -> AppResult<Json<FileInfo>> {
    let storage = get_storage(&state, &storage_id)?;
    let path = normalize_path(&query.path, query.path.ends_with('/')).map_err(bad_request)?;
    require_access(&state, &auth, &storage_id, &path, Access::Read).await?;
    let metadata = storage.operator.stat(&path).await?;
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();
    let mut info = FileInfo {
        entry: file_entry(&path, &metadata),
        content_type,
        media: None,
        media_error: None,
    };
    if !metadata.is_dir() && is_media(&path, &info.content_type) {
        match probe(storage.operator.clone(), path, metadata.content_length()).await {
            Ok(media) => info.media = Some(media),
            Err(message) => info.media_error = Some(message),
        }
    }
    Ok(Json(info))
}

fn is_media(path: &str, content_type: &str) -> bool {
    content_type.starts_with("video/")
        || content_type.starts_with("audio/")
        || path.rsplit('.').next().is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "mkv" | "m4v" | "ts" | "mts" | "m2ts" | "vob" | "ogv"
            )
        })
}

#[derive(Clone)]
struct ProbeSource {
    operator: opendal::Operator,
    path: String,
    size: u64,
    remaining: Arc<AtomicU64>,
}

// Dropping the request (including timeout/cancellation) closes its private server.
struct ProbeServer(tokio::task::JoinHandle<()>);
impl Drop for ProbeServer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn probe(operator: opendal::Operator, path: String, size: u64) -> Result<Value, String> {
    let _permit = PROBE_SLOTS
        .try_acquire()
        .map_err(|_| "Media inspection is busy. Try again shortly.".to_string())?;
    tokio::time::timeout(Duration::from_secs(30), probe_inner(operator, path, size))
        .await
        .map_err(|_| "Media inspection timed out. Try again later.".to_string())?
}

async fn probe_inner(
    operator: opendal::Operator,
    path: String,
    size: u64,
) -> Result<Value, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| "Unable to start media inspection.".to_string())?;
    let address = listener
        .local_addr()
        .map_err(|_| "Unable to start media inspection.".to_string())?;
    // Only this authorized object is exposed; no storage credentials reach ffprobe.
    let route = format!("/{}", Uuid::now_v7());
    let app = Router::new()
        .route(&route, get(probe_bytes))
        .with_state(ProbeSource {
            operator,
            path,
            size,
            remaining: Arc::new(AtomicU64::new(MAX_PROBE_BYTES)),
        });
    let _server = ProbeServer(tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    }));
    let mut child = Command::new("ffprobe")
        .args(["-v", "error", "-protocol_whitelist", "http,tcp", "-format_whitelist",
            "mov,matroska,webm,avi,mpegts,mpeg,flv,ogg,asf,mp3,flac,wav,aac",
            "-probesize", "10000000", "-analyzeduration", "10000000",
            "-show_entries", "format=format_name,duration,bit_rate:stream=index,codec_type,codec_name,profile,width,height,pix_fmt,avg_frame_rate,r_frame_rate,duration,bit_rate,sample_rate,channels,channel_layout:stream_tags=language,title:stream_disposition=default,forced",
            "-of", "json"])
        .arg(format!("http://{address}{route}"))
        .env_remove("http_proxy")
        .env_remove("HTTP_PROXY")
        .env_remove("https_proxy")
        .env_remove("HTTPS_PROXY")
        .env_remove("all_proxy")
        .env_remove("ALL_PROXY")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().map_err(|error| if error.kind() == std::io::ErrorKind::NotFound {
            "Media inspection requires ffprobe on the server.".to_string()
        } else { "Unable to start ffprobe.".to_string() })?;
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .unwrap()
        .take(MAX_OUTPUT_BYTES + 1)
        .read_to_end(&mut output)
        .await
        .map_err(|_| "Unable to read media information.".to_string())?;
    if output.len() as u64 > MAX_OUTPUT_BYTES {
        return Err("Media information exceeds the inspection limit.".into());
    }
    let status = child
        .wait()
        .await
        .map_err(|_| "Media inspection failed.".to_string())?;
    if !status.success() {
        return Err("Unable to inspect this media file. It may be unsupported, damaged, or exceed the inspection limit.".into());
    }
    serde_json::from_slice(&output)
        .map_err(|_| "Invalid media information returned by ffprobe.".into())
}

async fn probe_bytes(State(source): State<ProbeSource>, headers: HeaderMap) -> AppResult<Response> {
    let range = match headers.get(header::RANGE) {
        Some(value) => match value
            .to_str()
            .ok()
            .and_then(|value| byte_range(value, source.size))
        {
            Some(range) => Some(range),
            None => {
                return Ok((
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    [(header::CONTENT_RANGE, format!("bytes */{}", source.size))],
                )
                    .into_response());
            }
        },
        None => None,
    };
    let selected = range.clone().unwrap_or(0..source.size);
    let reader = source.operator.reader(&source.path).await?;
    let remaining = source.remaining;
    let stream = reader
        .into_bytes_stream(selected.clone())
        .await?
        .map_err(std::io::Error::other)
        .and_then(move |bytes| {
            let allowed = remaining
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| {
                    left.checked_sub(bytes.len() as u64)
                })
                .is_ok();
            async move {
                if allowed {
                    Ok(bytes)
                } else {
                    Err(std::io::Error::other(
                        "media inspection read limit exceeded",
                    ))
                }
            }
        });
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    headers.insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    headers.insert(
        header::CONTENT_LENGTH,
        (selected.end - selected.start).into(),
    );
    if range.is_some() {
        headers.insert(
            header::CONTENT_RANGE,
            format!(
                "bytes {}-{}/{}",
                selected.start,
                selected.end - 1,
                source.size
            )
            .parse()
            .unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

fn byte_range(value: &str, size: u64) -> Option<Range<u64>> {
    let (start, end) = value.strip_prefix("bytes=")?.split_once('-')?;
    if size == 0 {
        return None;
    }
    if start.is_empty() {
        let suffix = end.parse::<u64>().ok()?;
        return (suffix > 0).then(|| size.saturating_sub(suffix)..size);
    }
    let start = start.parse::<u64>().ok()?;
    let end = if end.is_empty() {
        size
    } else {
        end.parse::<u64>().ok()?.saturating_add(1).min(size)
    };
    (start < end).then_some(start..end)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_single_ranges_and_rejects_invalid_ranges() {
        assert_eq!(byte_range("bytes=0-", 100), Some(0..100));
        assert_eq!(byte_range("bytes=50-999", 100), Some(50..100));
        assert_eq!(byte_range("bytes=-10", 100), Some(90..100));
        assert_eq!(byte_range("bytes=-200", 100), Some(0..100));
        for value in [
            "bytes=100-",
            "bytes=9-2",
            "bytes=-0",
            "bytes=0-2,4-6",
            "invalid",
        ] {
            assert_eq!(byte_range(value, 100), None);
        }
        assert_eq!(byte_range("bytes=0-", 0), None);
    }

    #[tokio::test]
    async fn probe_source_serves_seek_ranges_and_enforces_read_budget() {
        let root = tempfile::tempdir().unwrap();
        tokio::fs::write(root.path().join("sample.bin"), b"0123456789")
            .await
            .unwrap();
        let storage = crate::storage::build_storage(&crate::config::StorageConfig::Fs {
            id: "local".into(),
            name: "Local".into(),
            root: root.path().to_str().unwrap().into(),
        })
        .await
        .unwrap();
        let source = ProbeSource {
            operator: storage.operator,
            path: "sample.bin".into(),
            size: 10,
            remaining: Arc::new(AtomicU64::new(4)),
        };
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=6-9".parse().unwrap());
        let response = probe_bytes(State(source.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 6-9/10");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "4");
        assert_eq!(
            &axum::body::to_bytes(response.into_body(), 100)
                .await
                .unwrap()[..],
            b"6789"
        );
        let response = probe_bytes(State(source.clone()), headers.clone())
            .await
            .unwrap();
        assert!(
            axum::body::to_bytes(response.into_body(), 100)
                .await
                .is_err()
        );
        headers.insert(header::RANGE, "bytes=10-".parse().unwrap());
        let response = probe_bytes(State(source), headers).await.unwrap();
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
    }
}
