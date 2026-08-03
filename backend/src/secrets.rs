use std::{fs::OpenOptions, io::Write, path::PathBuf};

use anyhow::{Context, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chacha20poly1305::{
    KeyInit, XChaCha20Poly1305, XNonce,
    aead::{Aead, OsRng, rand_core::RngCore},
};
use serde::{Serialize, de::DeserializeOwned};

#[derive(Clone)]
pub struct SecretCipher {
    cipher: XChaCha20Poly1305,
}

impl SecretCipher {
    pub fn load() -> anyhow::Result<Self> {
        let key = if let Ok(encoded) = std::env::var("LUME_SECRET_KEY") {
            decode_key(encoded.trim()).context("invalid LUME_SECRET_KEY")?
        } else {
            load_or_create_key_file()?
        };
        Ok(Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        })
    }

    pub fn encrypt<T: Serialize>(&self, value: &T) -> anyhow::Result<String> {
        let plaintext = serde_json::to_vec(value)?;
        let mut nonce = [0_u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let ciphertext = self
            .cipher
            .encrypt(XNonce::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| anyhow::anyhow!("failed to encrypt configuration"))?;
        let mut payload = Vec::with_capacity(nonce.len() + ciphertext.len());
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&ciphertext);
        Ok(URL_SAFE_NO_PAD.encode(payload))
    }

    pub fn decrypt<T: DeserializeOwned>(&self, encoded: &str) -> anyhow::Result<T> {
        let payload = URL_SAFE_NO_PAD
            .decode(encoded)
            .context("invalid encrypted configuration")?;
        if payload.len() <= 24 {
            bail!("encrypted configuration is truncated");
        }
        let plaintext = self
            .cipher
            .decrypt(XNonce::from_slice(&payload[..24]), &payload[24..])
            .map_err(|_| anyhow::anyhow!("failed to decrypt configuration"))?;
        serde_json::from_slice(&plaintext).context("invalid decrypted configuration")
    }

    #[cfg(test)]
    fn from_key(key: [u8; 32]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new((&key).into()),
        }
    }
}

fn load_or_create_key_file() -> anyhow::Result<[u8; 32]> {
    let path = std::env::var("LUME_SECRET_KEY_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("data/lume.key"));
    if path.exists() {
        let encoded = std::fs::read_to_string(&path)
            .with_context(|| format!("failed to read secret key from {}", path.display()))?;
        return decode_key(encoded.trim())
            .with_context(|| format!("invalid secret key in {}", path.display()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut key = [0_u8; 32];
    OsRng.fill_bytes(&mut key);
    let encoded = URL_SAFE_NO_PAD.encode(key);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .with_context(|| format!("failed to create secret key at {}", path.display()))?;
    file.write_all(encoded.as_bytes())?;
    file.write_all(b"\n")?;
    Ok(key)
}

fn decode_key(encoded: &str) -> anyhow::Result<[u8; 32]> {
    let bytes = URL_SAFE_NO_PAD.decode(encoded)?;
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("secret key must contain exactly 32 bytes"))
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::*;

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct SecretPayload {
        endpoint: String,
        password: String,
    }

    #[test]
    fn encrypted_payload_round_trips_and_rejects_tampering() {
        let cipher = SecretCipher::from_key([7; 32]);
        let payload = SecretPayload {
            endpoint: "https://dav.example.com".into(),
            password: "secret".into(),
        };
        let encrypted = cipher.encrypt(&payload).unwrap();
        assert_ne!(encrypted, serde_json::to_string(&payload).unwrap());
        assert_eq!(
            cipher.decrypt::<SecretPayload>(&encrypted).unwrap(),
            payload
        );

        let mut bytes = URL_SAFE_NO_PAD.decode(encrypted).unwrap();
        let last = bytes.last_mut().unwrap();
        *last ^= 1;
        assert!(
            cipher
                .decrypt::<SecretPayload>(&URL_SAFE_NO_PAD.encode(bytes))
                .is_err()
        );
    }
}
