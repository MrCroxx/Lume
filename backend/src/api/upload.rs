use axum::{
    body::Body,
    http::{HeaderMap, header},
};
use futures_util::TryStreamExt;
use opendal::Operator;
use tokio::{
    fs::File,
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_util::io::ReaderStream;

use crate::error::{AppError, AppResult};

const WRITE_CHUNK_BYTES: usize = 8 * 1024 * 1024;

pub async fn upload(
    operator: &Operator,
    path: &str,
    headers: &HeaderMap,
    body: Body,
    limit: usize,
) -> AppResult<()> {
    let expected_length = headers
        .get(header::CONTENT_LENGTH)
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| AppError::BadRequest("invalid Content-Length".into()))
        })
        .transpose()?;
    if expected_length.is_some_and(|length| length > limit as u64) {
        return Err(AppError::PayloadTooLarge { limit });
    }

    // Finish receiving before opening the destination: a rejected or interrupted
    // request must not truncate an existing file. The anonymous file is removed
    // on drop, including cancellation and errors.
    let file = tokio::task::spawn_blocking(tempfile::tempfile)
        .await
        .map_err(|error| AppError::Internal(error.into()))?
        .map_err(|error| AppError::Internal(error.into()))?;
    let mut file = File::from_std(file);
    let mut stream = body.into_data_stream();
    let mut received = 0_usize;
    while let Some(bytes) = stream.try_next().await.map_err(|error| {
        tracing::debug!(%error, "upload request body failed");
        AppError::BadRequest("upload body was interrupted or malformed".into())
    })? {
        if bytes.len() > limit - received {
            return Err(AppError::PayloadTooLarge { limit });
        }
        received += bytes.len();
        file.write_all(&bytes)
            .await
            .map_err(|error| AppError::Internal(error.into()))?;
    }
    if expected_length.is_some_and(|length| length != received as u64) {
        return Err(AppError::BadRequest(
            "upload size does not match Content-Length".into(),
        ));
    }
    file.rewind()
        .await
        .map_err(|error| AppError::Internal(error.into()))?;

    let mut writer = operator.writer_with(path).chunk(WRITE_CHUNK_BYTES).await?;
    let result = async {
        let mut stream = ReaderStream::with_capacity(file, WRITE_CHUNK_BYTES);
        while let Some(bytes) = stream
            .try_next()
            .await
            .map_err(|error| AppError::Internal(error.into()))?
        {
            writer.write(bytes).await?;
        }
        writer.close().await?;
        AppResult::Ok(())
    }
    .await;
    if result.is_err()
        && let Err(error) = writer.abort().await
        && error.kind() != opendal::ErrorKind::Unsupported
    {
        tracing::warn!(%error, "failed to abort storage upload");
    }
    result
}
