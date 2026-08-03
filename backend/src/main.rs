mod api;
mod auth;
mod config;
mod db;
mod error;
mod models;
mod secrets;
mod state;
mod storage;

use std::{net::SocketAddr, path::Path};

use anyhow::Context;
use state::AppState;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "lume_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config_path = std::env::var("LUME_CONFIG").unwrap_or_else(|_| "config.toml".into());
    let config = config::Config::load(&config_path).await?;
    let address = config.server.address.parse::<SocketAddr>()?;
    let frontend_dist = config.server.frontend_dist.clone();
    let state = AppState::new(config).await?;

    let app = api::router(state)
        .fallback_service(
            ServeDir::new(&frontend_dist)
                .fallback(ServeFile::new(Path::new(&frontend_dist).join("index.html"))),
        )
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("failed to bind {address}"))?;
    info!(%address, "Lume is listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}
