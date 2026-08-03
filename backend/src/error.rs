use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("authentication required")]
    Unauthorized,
    #[error("permission denied")]
    Forbidden,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error(transparent)]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::Forbidden => StatusCode::FORBIDDEN,
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        if let Self::Internal(ref error) = self {
            tracing::error!(error = ?error, "request failed");
        }
        let message = if status == StatusCode::INTERNAL_SERVER_ERROR {
            "internal server error".to_string()
        } else {
            self.to_string()
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

impl From<sqlx::Error> for AppError {
    fn from(value: sqlx::Error) -> Self {
        Self::Internal(value.into())
    }
}

impl From<opendal::Error> for AppError {
    fn from(value: opendal::Error) -> Self {
        use opendal::ErrorKind;

        match value.kind() {
            ErrorKind::NotFound => Self::NotFound("file or directory not found".into()),
            ErrorKind::AlreadyExists => Self::Conflict("file or directory already exists".into()),
            ErrorKind::PermissionDenied => Self::Forbidden,
            ErrorKind::IsADirectory | ErrorKind::NotADirectory => {
                Self::BadRequest(value.to_string())
            }
            _ => Self::Internal(value.into()),
        }
    }
}

pub type AppResult<T> = Result<T, AppError>;
