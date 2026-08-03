use std::path::PathBuf;

use anyhow::{Context, bail};
use opendal::Operator;

use crate::config::{StorageConfig, secret_from_env};

#[derive(Clone)]
pub struct Storage {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub operator: Operator,
}

pub fn materialize_secrets(config: &StorageConfig) -> anyhow::Result<StorageConfig> {
    let config = match config {
        StorageConfig::Ftp {
            id,
            name,
            endpoint,
            root,
            user,
            password,
            password_env,
        } => StorageConfig::Ftp {
            id: id.clone(),
            name: name.clone(),
            endpoint: endpoint.clone(),
            root: root.clone(),
            user: user.clone(),
            password: password.clone().or(secret_from_env(password_env)?),
            password_env: None,
        },
        StorageConfig::Sftp {
            id,
            name,
            endpoint,
            root,
            user,
            key,
            key_env,
            known_hosts_strategy,
        } => StorageConfig::Sftp {
            id: id.clone(),
            name: name.clone(),
            endpoint: endpoint.clone(),
            root: root.clone(),
            user: user.clone(),
            key: key.clone().or(secret_from_env(key_env)?),
            key_env: None,
            known_hosts_strategy: known_hosts_strategy.clone(),
        },
        StorageConfig::Webdav {
            id,
            name,
            endpoint,
            root,
            username,
            password,
            password_env,
        } => StorageConfig::Webdav {
            id: id.clone(),
            name: name.clone(),
            endpoint: endpoint.clone(),
            root: root.clone(),
            username: username.clone(),
            password: password.clone().or(secret_from_env(password_env)?),
            password_env: None,
        },
        StorageConfig::S3 {
            id,
            name,
            bucket,
            root,
            region,
            endpoint,
            access_key_id,
            access_key_id_env,
            secret_access_key,
            secret_access_key_env,
        } => StorageConfig::S3 {
            id: id.clone(),
            name: name.clone(),
            bucket: bucket.clone(),
            root: root.clone(),
            region: region.clone(),
            endpoint: endpoint.clone(),
            access_key_id: access_key_id
                .clone()
                .or(secret_from_env(access_key_id_env)?),
            access_key_id_env: None,
            secret_access_key: secret_access_key
                .clone()
                .or(secret_from_env(secret_access_key_env)?),
            secret_access_key_env: None,
        },
        other => other.clone(),
    };
    Ok(config)
}

pub async fn build_storage(config: &StorageConfig) -> anyhow::Result<Storage> {
    let mut options = Vec::<(String, String)>::new();
    let (scheme, kind) = match config {
        StorageConfig::Fs { root, .. } => {
            let root = absolute_path(root)?;
            tokio::fs::create_dir_all(&root).await?;
            options.push(("root".into(), root.to_string_lossy().into_owned()));
            ("fs", "fs")
        }
        StorageConfig::Smb { mount_path, .. } => {
            let root = absolute_path(mount_path)?;
            if !root.is_dir() {
                bail!("SMB mount path {} is not a directory", root.display());
            }
            options.push(("root".into(), root.to_string_lossy().into_owned()));
            ("fs", "smb")
        }
        StorageConfig::Ftp {
            endpoint,
            root,
            user,
            password,
            password_env,
            ..
        } => {
            options.push(("endpoint".into(), endpoint.clone()));
            options.push(("root".into(), root.clone()));
            if let Some(user) = user {
                options.push(("user".into(), user.clone()));
            }
            if let Some(password) = password.clone().or(secret_from_env(password_env)?) {
                options.push(("password".into(), password));
            }
            ("ftp", "ftp")
        }
        StorageConfig::Sftp {
            endpoint,
            root,
            user,
            key,
            key_env,
            known_hosts_strategy,
            ..
        } => {
            options.push(("endpoint".into(), endpoint.clone()));
            options.push(("root".into(), root.clone()));
            if let Some(user) = user {
                options.push(("user".into(), user.clone()));
            }
            if let Some(key) = key.clone().or(secret_from_env(key_env)?) {
                options.push(("key".into(), key));
            }
            if let Some(strategy) = known_hosts_strategy {
                options.push(("known_hosts_strategy".into(), strategy.clone()));
            }
            ("sftp", "sftp")
        }
        StorageConfig::Webdav {
            endpoint,
            root,
            username,
            password,
            password_env,
            ..
        } => {
            options.push(("endpoint".into(), endpoint.clone()));
            options.push(("root".into(), root.clone()));
            if let Some(username) = username {
                options.push(("username".into(), username.clone()));
            }
            if let Some(password) = password.clone().or(secret_from_env(password_env)?) {
                options.push(("password".into(), password));
            }
            ("webdav", "webdav")
        }
        StorageConfig::S3 {
            bucket,
            root,
            region,
            endpoint,
            access_key_id,
            access_key_id_env,
            secret_access_key,
            secret_access_key_env,
            ..
        } => {
            options.push(("bucket".into(), bucket.clone()));
            options.push(("root".into(), root.clone()));
            if let Some(region) = region {
                options.push(("region".into(), region.clone()));
            }
            if let Some(endpoint) = endpoint {
                options.push(("endpoint".into(), endpoint.clone()));
            }
            if let Some(access_key_id) = access_key_id
                .clone()
                .or(secret_from_env(access_key_id_env)?)
            {
                options.push(("access_key_id".into(), access_key_id));
            }
            if let Some(secret_access_key) = secret_access_key
                .clone()
                .or(secret_from_env(secret_access_key_env)?)
            {
                options.push(("secret_access_key".into(), secret_access_key));
            }
            ("s3", "s3")
        }
    };
    let operator = Operator::via_iter(scheme, options)
        .with_context(|| format!("failed to initialize {} storage {}", kind, config.id()))?;
    Ok(Storage {
        id: config.id().into(),
        name: config.name().into(),
        kind: kind.into(),
        operator,
    })
}

fn absolute_path(path: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(path);
    if path.is_absolute() {
        return Ok(path);
    }
    Ok(std::env::current_dir()?.join(path))
}

pub fn normalize_path(raw: &str, directory: bool) -> anyhow::Result<String> {
    let raw = raw.trim().trim_start_matches('/');
    if raw.contains('\0') || raw.contains('\\') {
        bail!("path contains an invalid character");
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => {}
            ".." => bail!("parent path traversal is not allowed"),
            value => parts.push(value),
        }
    }
    let mut path = parts.join("/");
    if directory && !path.is_empty() {
        path.push('/');
    }
    Ok(path)
}

pub fn path_is_within(path: &str, prefix: &str) -> bool {
    let prefix = prefix.trim_matches('/');
    if prefix.is_empty() {
        return true;
    }
    let path = path.trim_matches('/');
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

pub fn paths_equal(left: &str, right: &str) -> bool {
    left.trim_matches('/') == right.trim_matches('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_safe_paths() {
        assert_eq!(
            normalize_path("/docs/./report.pdf", false).unwrap(),
            "docs/report.pdf"
        );
        assert_eq!(normalize_path("docs", true).unwrap(), "docs/");
        assert!(normalize_path("../secret", false).is_err());
    }

    #[test]
    fn checks_prefix_boundaries() {
        assert!(path_is_within("team/docs/a.txt", "team/docs"));
        assert!(path_is_within("team/docs", "team/docs"));
        assert!(!path_is_within("team/docs-old/a.txt", "team/docs"));
    }

    #[test]
    fn compares_root_path_representations() {
        assert!(paths_equal("", "/"));
        assert!(paths_equal("team/docs", "/team/docs/"));
        assert!(!paths_equal("team/docs", "team/docs-old"));
    }
}
