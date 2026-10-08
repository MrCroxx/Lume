# Uploads, API errors, and consistency

## Upload limits and storage behavior

The default per-file limit is 4 GiB (4096 MiB, 4,294,967,296 bytes). Set Maximum upload (MiB) to `0` in Runtime settings to disable the application limit. Changes apply to new requests; uploads already in progress retain their initial limit. The database migration allows zero while preserving existing installations' saved settings.

Uploads send raw binary data to `PUT /api/files/{storage_id}?path=...`. They do not use the JSON body extractor and are not subject to its 2 MiB limit. Successful uploads return an empty `201 Created` response, which must not be parsed as JSON.

The server first receives the body into an anonymous temporary file and counts the actual bytes received. When a nonzero limit is configured, it also checks Content-Length before receiving the body. Exceeding the limit returns a JSON `413` with the configured byte limit; interrupted or mismatched bodies return JSON `400`. The destination is not opened until the entire body has been received, protecting existing files from failed transfers.

Temporary files use the system temporary directory. Set `TMPDIR` to a directory with sufficient disk space if needed. Each active upload can temporarily occupy one complete file's worth of space while receiving or writing to storage. That temporary space is released when the operation finishes or fails. A temporary directory backed by tmpfs still consumes memory.

After receiving the body, the server passes it to the OpenDAL writer in 8 MiB chunks. OpenDAL 0.58.1's WebDAV driver uses OneShotWriter and buffers the complete file internally, so large WebDAV uploads still require corresponding memory. Atomicity when committing to the destination depends on the storage driver; staging the request body does not guarantee transactional rollback for remote writes.

Reverse proxies have independent size, timeout, and buffering limits that the application cannot override. Proxy HTML error pages are converted into readable errors containing the HTTP status.

## Drag and drop and upload progress

Drop files and folders anywhere in the file explorer to upload into the current directory. The overlay shows the destination without changing its case. Folder traversal preserves nested paths and empty directories and reads every batch returned by the browser's directory reader.

The collapsible upload panel shows per-file bytes sent, queued/uploading/saving/completed/failed states, and overall progress. The queue runs up to three requests concurrently, supports adding batches and navigating between directories, and offers retrying failed items or cancelling remaining work. Its virtualized list keeps large batches bounded in the DOM. Files wait for their parent directories to be created, and overlapping destinations are serialized.

A 100% transfer enters the saving state until the server confirms success. The panel automatically collapses when every task succeeds; failed or cancelled tasks prevent automatic collapse. Users can expand it again to inspect completed work. Clear removes completed and cancelled entries; Cancel stops pending and active requests.

The queue lives in the current page and does not survive a refresh or browser closure. A leave-page warning is requested while tasks are unfinished. Already completed files and created directories remain in storage. Temporary receive files are cleaned up after an interrupted transfer; a request already writing to destination storage may still complete, and cleanup of partial destination writes depends on the storage backend.

## API and consistency behavior

- JSON validation, query validation, unknown API routes, and unsupported HTTP methods use consistent JSON errors.
- The frontend distinguishes empty success responses, JSON responses, and text or HTML errors so secondary parsing failures do not hide the original error.
- Directory navigation isolates listing state and discards stale listing and search responses.
- Downloads use an ASCII fallback filename and UTF-8 `filename*` for Unicode names.
- OpenDAL trims whitespace at the ends of the entire path. The application rejects paths that would alias another file rather than silently renaming or overwriting it; ordinary internal spaces remain valid.
- Upload limits are checked against SQLite's integer range before persistence. The settings form preserves fractional MiB values rather than rounding existing limits.
- Administrator demotion checks and updates share a SQLite write transaction to prevent concurrent changes from removing all active administrators.
- Password changes and session revocation share a transaction and roll back together if revocation fails.
- Runtime configuration reloads are serialized to prevent older asynchronous reloads from overwriting newer state.
- ZIP downloads revalidate permissions and storage configuration when consuming a ticket.
- File and storage-connection deletion use in-app confirmation dialogs. File deletion shows a selection preview and warns when folder contents are included; deleting a storage connection removes its path permissions without deleting stored files.

## Validation

Backend tests cover upload boundaries, interrupted bodies, existing-file protection, dynamic limits including zero, database migration, permissions, response formats, Unicode filenames, concurrent administrator demotions, session-revocation rollback, and archive authorization revocation. Frontend tests use Node.js's test runner and cover API responses, dropped directories, upload progress, cancellation, queue concurrency, retries, and destination ordering. These checks run in CI.

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --all-features --locked
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

Route tests use temporary local storage and SQLite, not production data. FTP, SFTP, WebDAV, and S3 deployments require integration validation against their respective servers.
