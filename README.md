# Lume

Lume is a multi-storage file browser built with Rust and React. Its backend uses Apache OpenDAL to provide a unified interface for local files, WebDAV, FTP, SFTP, S3, and mounted Samba/CIFS shares. The frontend is built with React, TypeScript, Tailwind CSS, and shadcn/ui-style Radix components.

## Features

- Browse multiple storage backends, search recursively, upload and download files, create directories, and delete directory trees.
- Use the `All connections` aggregate view to browse every connection root and search across connections.
- Keep browser paths in deep-linkable URLs, with native browser history and ACL-aware parent navigation.
- Manage multiple SQLite-backed users with Argon2id password hashing, opaque random sessions, and `admin` or `member` roles.
- Let users change their own username and password, while administrators can edit or reset any account.
- Grant `read`, `write`, and `manage` permissions by storage connection and path prefix. Administrators have implicit global access.
- Bind trusted-access rules to individual users, matching source IP/CIDR ranges and domains validated through trusted reverse proxies.
- Manage users, path permissions, trusted-access rules, OpenDAL storage connections, and runtime settings dynamically from the Web UI, with state persisted in SQLite.
- Connect natively to local filesystems, WebDAV, FTP, SFTP, and S3 through OpenDAL. Access Samba/CIFS shares through an operating-system mount and OpenDAL's `fs` service.
- Stream large downloads and bound recursive searches to 50,000 scanned entries and 500 returned results per request.

## Getting started

Lume requires Rust 1.95 or later and Node.js 24 or later. On the first launch, provide a non-empty administrator password through an environment variable. The password is used only to initialize the administrator account and is not written to the configuration file.

```bash
npm --prefix frontend install
npm --prefix frontend run build
LUME_ADMIN_PASSWORD='replace-this-password' cargo run -p lume-server
```

Open `http://127.0.0.1:8080` and sign in as `admin` with the password supplied above. Users, permissions, storage connections, and runtime settings are managed from the Administration page.

`config.toml` is an optional bootstrap configuration file. It contains only values that must be known before the application starts: the listen address, frontend distribution directory, SQLite URL, and initial administrator settings. Without this file, Lume defaults to `0.0.0.0:8080`, `frontend/dist`, and `sqlite://data/lume.db`. The `LUME_ADDRESS`, `LUME_FRONTEND_DIST`, `LUME_DATABASE_URL`, and `LUME_ADMIN_USERNAME` environment variables override these values.

The following settings are stored in SQLite and can be updated dynamically from the Web UI:

- Session lifetime, Secure Cookie behavior, upload size limits, and trusted reverse-proxy CIDRs.
- Per-user trusted-access rules.
- OpenDAL storage connections and their enabled state.
- Users, roles, and path permissions.

Storage credentials are never stored as plaintext in SQLite. Lume encrypts each complete connection definition with XChaCha20-Poly1305. By default, the master key is stored in `data/lume.key` with `0600` permissions. Production deployments can inject and manage the master key through `LUME_SECRET_KEY` or `LUME_SECRET_KEY_FILE`. Back up the database and master key together.

For frontend development, run the backend and development server concurrently:

```bash
LUME_ADMIN_PASSWORD='replace-this-password' cargo run -p lume-server
npm --prefix frontend run dev
```

Vite proxies `/api` requests to `127.0.0.1:8080`.

## Samba/CIFS

OpenDAL does not currently provide a native SMB service. Lume does not perform privileged mounts inside the application process. Instead, mount the share through the operating system or container orchestration layer, then create a `kind = "smb"` connection that points to the mounted directory. This keeps all file operations behind OpenDAL without granting `CAP_SYS_ADMIN` to the web service.

Example for Linux:

```bash
sudo mount -t cifs //nas.example.com/team /mnt/team-share \
  -o credentials=/etc/lume/smb-credentials,uid=lume,gid=lume,vers=3.1.1
```

After mounting the share, open Administration → Storage connections, add a `Samba mount`, and set its mounted directory to `/mnt/team-share`.

## Trusted-access security model

CIDR rules use the TCP peer address by default. Lume reads `X-Forwarded-For` only when the peer matches a trusted reverse-proxy CIDR configured in the Web UI. Domain rules can match `Host` only under the same condition. The reverse proxy must overwrite client-supplied `Host` and `X-Forwarded-For` headers instead of forwarding them unchanged.

Each trusted-access rule is bound to a user through a stable `user_id`. Non-empty CIDR and domain matchers within one rule use AND semantics; multiple rules for the same user use OR semantics. Trusted access replaces only password verification. Every subsequent authorization decision still uses the user's role and path ACL.

After the username changes on the sign-in page, Lume checks whether the current network matches that user's rules. A match hides the password field and creates a `bypass` session; otherwise, a password remains mandatory. The backend reevaluates the current network and database rules whenever a bypass session is used. Leaving the trusted network, disabling a rule, or disabling the user invalidates the session immediately.

## Validation

```bash
cargo fmt --all -- --check
cargo test --workspace
npm --prefix frontend run build
```

## Current limitations and roadmap

The current real-time recursive search is designed for small and medium-sized directory trees and provides consistent behavior across OpenDAL backends. For object stores with millions of entries, a future release should add a dedicated indexer and full-text search tables, updated incrementally through OpenDAL scans. The API already separates search from directory browsing, so this change would not require a new frontend contract.
