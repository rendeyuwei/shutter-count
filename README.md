# ShutterCount

[English](README.md) | [简体中文](README.zh-CN.md)

Upload a camera-original JPG/JPEG to read its shutter count from EXIF and manufacturer MakerNotes, parsed with ExifTool.

- Project URL: <https://rende.fun/shutter>
- Vite-built TypeScript browser entrypoint and one Fastify backend.
- Photos are written to a temporary directory during parsing. The application attempts to remove that directory before sending the response; it does not archive photos or store them in a database.
- Failed results include copyable diagnostics so operators can find the corresponding server log without asking for the photo.

## Stack and layout

| Component | Purpose |
| --- | --- |
| Node.js ≥ 22.12 | ESM runtime |
| TypeScript / Vite | Strict checks across all code and browser builds |
| Fastify 5 | HTTP server |
| `exiftool-vendored` | Bundled ExifTool for EXIF and MakerNotes |
| `@fastify/multipart` | Stream uploads to temporary files |
| `@fastify/static` | Serve compiled `dist/public/` assets |
| `@fastify/rate-limit` | Parse endpoint limit: 30 requests/minute/IP by default |

- `web/`: browser TypeScript and HTML; `public/`: styles and static assets
- `shared/`: typed result contracts
- `src/app.ts`: routes, upload validation, request IDs, logs, and temporary-file cleanup
- `src/parse.ts`: ExifTool lifecycle and parsing
- `src/mapping.ts`: camera-brand recognition and shutter-tag priorities
- `test/`: server, parser, mapping, and diagnostics regression tests; sample JPEGs are described in [test/fixtures/README.md](test/fixtures/README.md)
- `scripts/smoke.ts`: checks against a running instance
- `ecosystem.config.cjs` / `bin/start.mjs`: PM2 configuration and explicit process-manager entrypoint
- `docs/`: [product requirements](docs/PRD-shutter.md) and [UI design](docs/DESIGN.md)
- `tools/build.ts` / `dist/`: build orchestration and ignored runtime artifacts

The [whole-project modernization plan](docs/MODERNIZATION.md) covers browser/server code, shared protocols, Node tools, startup, and every test. All four phases are implemented locally with strict TypeScript source and compiled runtime artifacts under `dist/`.

## Run locally

Requires Node.js ≥ 22.12.

```bash
npm ci
npm run build
npm start
```

Open <http://127.0.0.1:3020/shutter/>. `GET /shutter` redirects to `/shutter/` with HTTP 308.

`npm run dev:server` watches backend source with tsx. In a second terminal, `npm run dev:web` starts Vite and proxies `/api` to the default local backend at `/shutter/api`. Production startup uses compiled files and needs no development dependencies.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3020` | Listening port |
| `HOST` | `127.0.0.1` | Bind address; the default expects a local reverse proxy for public access |
| `BASE_PATH` | `/shutter` | Application path prefix; `/` mounts at the root |
| `MAX_UPLOAD_MB` | `50` | Server upload limit, in units of 1,048,576 bytes; oversized uploads return `file_too_large` |
| `MAX_ACTIVE_UPLOADS` | `2` | Concurrent upload/parse/cleanup lifetimes |
| `MAX_WAITING_UPLOADS` | `8` | Maximum queued uploads |
| `QUEUE_WAIT_MS` | `5000` | Queue timeout in milliseconds; returns 503 / `busy` |
| `REQUEST_TIMEOUT_MS` | `60000` | HTTP request receipt timeout in milliseconds |
| `TRUST_PROXY` | `127.0.0.1,::1` | Fastify `trustProxy`: `true`, `false`, or comma-separated IPs/CIDRs |

The default trusts only a loopback proxy, such as nginx on the same host. Set `TRUST_PROXY` for the actual proxy topology; trusting arbitrary clients can let them spoof `X-Forwarded-For` and bypass per-IP rate limits.

The browser reads the effective byte limit through `GET /api/config`. Failed settings retrieval can be retried; uploads wait for valid settings. Invalid ports, paths, limits and proxy settings prevent startup.

## Tests

```bash
npm test
npm run typecheck
npm run format:check
npm run test:browser
```

Uses Node's built-in test runner on compiled tests under `dist/test/`. `npm test` builds first; `npm run test:built` reuses a completed build. After building, a focused mapping check is `node --test dist/test/mapping.test.js`. Coverage includes routes and static files, upload validation, rate limits, temporary-file cleanup, symlinked startup, real JPEG parsing, brand-specific tag priorities and plausible-count limits. Diagnostics regression tests cover request-ID correlation, safe failure classifications, and excluding photo content and private metadata from diagnostic output.

Browser tests use installed Chrome (or `CHROME_PATH`) in an isolated session, covering real uploads, cancellation, retries, diagnostics, keyboard interaction and mobile layout. All external requests, including Baidu analytics, are blocked during these tests. They do not download a browser.

CI records `REVISION` before building and runs `npm run test:production`. This check creates a temporary installation with only production dependencies and verifies the copied revision, stable bootstrap, assets, effective upload settings, Nikon count 526 and graceful shutdown. To run it locally:

```bash
git rev-parse HEAD > REVISION
npm run build
npm run test:production
```

### Smoke test a running instance

Start the service separately, then run:

```bash
npm run smoke -- [baseUrl] file1.jpg [file2.jpg ...]
# Example using the included fixture and the default local URL:
npm run smoke -- test/fixtures/NikonD70.jpg
```

- Optional `baseUrl` defaults to `http://127.0.0.1:3020/shutter`.
- Checks that the page returns HTTP 200 HTML and health returns HTTP 200, then uploads each JPEG and prints `status / model / shutterCount / capturedAt`.
- Exits nonzero for page or health failures, file/network errors, or a parse response with HTTP 5xx. A 4xx parse response is printed but does not itself fail this smoke script; use `npm test` for assertions about error handling.
- The smoke script prints filenames and parsed metadata to its own console. That output is separate from the server's privacy-limited diagnostics; do not publish it with private photos.

## API

All routes are under `BASE_PATH`, which defaults to `/shutter`.

Every API response produced by the application, including errors and health checks, carries an `X-Request-ID` header. IDs are UUIDs generated by the server; a caller-supplied `X-Request-ID` cannot choose or replace them. Parse and health JSON responses also include the same ID as `requestId`.

### `GET /shutter/api/health`

Returns HTTP 200 with `{ "status": "ok", "exiftool": "<version>", "revision": "<commit-sha-or-null>", "requestId": "<uuid>" }`. `revision` is a commit SHA string when the release contains a valid `REVISION` file, or JSON `null` in a normal local checkout. It is captured at process startup so an old process cannot claim a new release after a symlink switch. If ExifTool is unavailable, returns HTTP 500 with `{ "status": "error", "requestId": "<uuid>" }`. The same request ID is in the response header.

```bash
curl -i http://127.0.0.1:3020/shutter/api/health
```

### `POST /shutter/api/parse`

- Request: `multipart/form-data` with one file in the field named **`file`**.
- JPG/JPEG only: the server checks the extension and `FF D8 FF` magic bytes, then validates the file with ExifTool.
- Default rate limit: 30 requests/minute/IP. This limit applies to the parse endpoint.

```bash
curl -i \
  -F 'file=@test/fixtures/NikonD70.jpg' \
  http://127.0.0.1:3020/shutter/api/parse
```

| `status` | HTTP | Meaning |
| --- | --- | --- |
| `ok` | 200 | A usable shutter count was found |
| `no_shutter_field` | 200 | Valid JPEG, but no usable supported shutter-count field |
| `unsupported_or_corrupt` | 422 | Not a JPEG, or ExifTool reported a damaged/invalid image; `reason` is `not_jpeg` or `corrupt` |
| `file_too_large` | 413 | Exceeds the upload limit; includes `maxMb` |
| `bad_request` | 400 | Missing file, incorrect file field, or malformed upload |
| `rate_limited` | 429 | Too many parse requests; wait before retrying |
| `error` | 500 | Unexpected server error |
| `error` | 503 | ExifTool timed out or could not complete a read; `reason` is `timeout` or `parser_unavailable` |

Success example (illustrative ID and photo data):

```json
{
  "status": "ok",
  "requestId": "eb4d7287-0bd3-461e-8a8e-d978d46c8407",
  "fileName": "photo.jpg",
  "make": "NIKON CORPORATION",
  "model": "Nikon D750",
  "shutterCount": 12345,
  "shutterSource": "Nikon:ShutterCount",
  "approximate": false,
  "note": null,
  "capturedAt": "2024-05-01 12:34:56"
}
```

`fileName` is a sanitized display name, not a storage path. `approximate` and `note` explain counts that may differ from mechanical shutter actuations. Unavailable metadata is `null`; `no_shutter_field` retains available make/model/capture-time fields and has a null shutter count.

Failure example, with the same ID in `X-Request-ID`:

```json
{
  "status": "unsupported_or_corrupt",
  "requestId": "edaa18de-1f94-4b81-9b95-e6c721aa04be",
  "reason": "corrupt",
  "fileName": "photo.jpg",
  "message": "无法解析该文件，图片可能已损坏。"
}
```

`requestId` is for correlation, not a way to retrieve an uploaded photo. `stage` and `diagnosticCode` are server-log fields, not public API fields. ExifTool timeouts and read failures return HTTP 503 with `status: "error"` and `reason: "timeout"` or `"parser_unavailable"`. These indicate a tool/service failure, not a verdict that the photo is corrupt. An explicit ExifTool image error or JPEG format warning still returns HTTP 422 with `unsupported_or_corrupt` / `corrupt`.

## Supported brands and tag priorities

For recognized brands, counts come only from that manufacturer's own MakerNotes group, in the order below. Candidate values must be integers with `0 < n ≤ 5,000,000`; invalid values are skipped so the next candidate can be tried.

| Brand | Tag priority | Notes |
| --- | --- | --- |
| Nikon | `ShutterCount` → `MechanicalShutterCount` | |
| Canon | `ShutterCount` → `ImageCount` | `ImageCount` is approximate and may reset after card formatting |
| Sony | `ShutterCount` → `ShutterCount2` → `ShutterCount3` | |
| FUJIFILM | `ImageCount` | Approximate shooting count, including electronic shutter; may reset after firmware updates |
| PENTAX | `ShutterCount` | Includes Ricoh Imaging / Asahi identification |
| OLYMPUS | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | Includes OM Digital / OM System identification; reads available fields |
| Panasonic | `ShutterCount` → `MechanicalShutterCount` → `ImageCount` | Reads available fields |

Unknown brands use a generic fallback for a group-qualified `ShutterCount` tag. Brand recognition does not guarantee that every model or JPEG contains a count. Edited, exported, or messaging-app copies may have lost MakerNotes; try a camera-original JPEG.

## Diagnostics and troubleshooting

### Copy a failure report

When no shutter count can be read or an error occurs, use **复制诊断信息** (“Copy diagnostics”) in the result view. The copied report contains the request ID when available, status, reason, and browser time in UTC. If automatic copying is unavailable, the read-only report can be selected and copied manually. It excludes photos, filenames, camera model/serial number, GPS, and EXIF values.

Browser-side validation does not send an upload and has no server request ID. A network failure or browser timeout may also leave the browser without an ID; the report explicitly marks it as unavailable rather than inventing one. A missing ID after a network failure does not prove the server never received the upload.

### Find the matching server event

With logging enabled, each completed parse response emits one structured `parse_result` event for success or failure, including rejected uploads and rate limits:

| Field | Meaning |
| --- | --- |
| `requestId` | Same server-generated UUID as the response |
| `status` | Public result status |
| `httpCode` | HTTP response code |
| `durationMs` | Elapsed request-processing time in milliseconds |
| `stage` | `upload`, `validation`, `exiftool`, `mapping`, or `complete` |
| `diagnosticCode` | Stable, more specific failure or success classification |

Illustrative event payload (the logger also adds its standard envelope):

```json
{
  "event": "parse_result",
  "requestId": "65d39e92-207c-46aa-9051-c86e6a0b5b7e",
  "status": "error",
  "httpCode": 503,
  "durationMs": 15102,
  "stage": "exiftool",
  "diagnosticCode": "exiftool_timeout"
}
```

| `diagnosticCode` | What to check |
| --- | --- |
| `upload_missing_file` | Submit one file in the `file` field |
| `upload_invalid_field` | Correct the multipart file-field name to `file` |
| `upload_invalid_extension` | Use an original `.jpg` or `.jpeg` file |
| `upload_invalid_magic` | Signature or parsed file type is not JPEG; renaming an extension does not convert a file |
| `upload_too_large` | Check server, browser, and reverse-proxy size limits |
| `upload_invalid_multipart` | Check the multipart boundary and body; let the browser or `curl -F` set the content type |
| `exiftool_timeout` | HTTP 503 tool timeout, not an image-corruption verdict; check load and ExifTool health, then retry with a known-good fixture |
| `exiftool_read_failed` | HTTP 503 tool/read failure, including an invalid parser return; check health and a known-good fixture before blaming the image |
| `exiftool_reported_error` | ExifTool reported an error in the image |
| `jpeg_format_error` | JPEG structure is invalid or inconsistent |
| `no_shutter_field` | Use the camera-original file; the model may not provide a supported usable count |
| `parse_ok` | Count successfully mapped |
| `internal_error` | Check service health and operational conditions, such as temporary-directory access |
| `rate_limited` | Wait for the rate-limit window; check proxy trust configuration if unrelated users share a limit |

When mapping runs, an optional `mapping` summary contains `brand` (a canonical known label or `unknown`), `hasExif`, `candidateCount`, `presentCandidateCount`, and `invalidCandidateCount`. These are safe classifications, booleans, and counts; they do not expose tag values. Additional diagnostics are limited to similarly predefined field states. Raw errors, arbitrary EXIF values, filenames, camera models, serial numbers, and GPS are not written to these events. Do not enable raw payload/EXIF logging to investigate a failure.

Unexpected internal failures also include an allowlisted `errorCode` (for example `ENOENT`, `EACCES`, `ENOSPC`, or `UNKNOWN`) to help distinguish storage/OS failures without exposing error messages or paths.

Health checks emit a separate `health_result` event with `health_ok` or `exiftool_unavailable`. A failed temporary-directory cleanup emits `temp_cleanup_failed`; operators should investigate temporary storage rather than assume the file was deleted.

### Log location, restarts, and retention

`npm start` and the PM2 entrypoint enable structured logging to the process output. `buildApp()` defaults to logging off for tests/embedding unless a logger is supplied. The app adds no database or separate log-storage service.

With the supplied PM2 configuration:

```bash
pm2 logs shutter-count --lines 100
pm2 describe shutter-count   # inspect the actual output/error log paths

# Search both default files using the ID copied from the UI or API:
REQUEST_ID='65d39e92-207c-46aa-9051-c86e6a0b5b7e'
grep -F -- "$REQUEST_ID" \
  "${PM2_HOME:-$HOME/.pm2}/logs/shutter-count-out.log" \
  "${PM2_HOME:-$HOME/.pm2}/logs/shutter-count-error.log"
```

PM2 defaults to `~/.pm2/logs/` (or `$PM2_HOME/logs/`). This configuration enables timestamp prefixes, so PM2 log-file lines may have text before the JSON; a plain `grep` works without stripping the prefix. Use the paths shown by `pm2 describe` if the installation differs.

PM2 log files normally survive an application restart, but that is not a backup or a retention guarantee. Rotation, disk limits, access controls, and backups are the operator's responsibility. Plain stdout, especially in a container, is not necessarily durable after a restart or replacement; configure the supervisor/platform's log collection and retention. Search rotated/archived files as well if the current files no longer contain the request.

If there is no matching event, check the instance and log destination, whether logging was enabled, and whether a proxy rejected the request before it reached Fastify. Browser-only validation creates no server event. Correlate browser time with server time carefully; clocks and time zones can differ.

## Deployment conventions

For tested-commit releases and GitHub Actions setup, see [automatic deployment](docs/DEPLOYMENT.md) ([简体中文](docs/DEPLOYMENT.zh-CN.md)). Automatic deployment is off until an operator verifies the host and explicitly enables its configuration; adding the workflow alone does not deploy or grant access.

The repository documents this deployment layout for `rende.fun`; these settings do not verify the state or version of a running deployment.

- Runtime: Node.js ≥ 22, required by the locked `exiftool-vendored` 39 dependency. Updating the declared runtime requirement does not upgrade dependencies.
- Releases: `/opt/shutter-count/releases/<id>/`, with `/opt/shutter-count/current` pointing to the active release. Startup handles symlinked entrypoints.
- Process manager: PM2, app name **`shutter-count`**, configured by `ecosystem.config.cjs`. `SHUTTER_APP_DIR` can select the release directory.
- Bind address: `127.0.0.1:3020` by default.
- Reverse proxy: the host's `snippets/shutter-locations.conf` can be included in the nginx site to proxy `/shutter` to port 3020. This host-side snippet is not bundled in the repository. Preserve unrelated `easypic` configuration.

```bash
pm2 start ecosystem.config.cjs   # initial start
pm2 reload shutter-count        # reload after switching the release symlink
pm2 logs shutter-count
```

## Privacy and data handling

- Uploads are temporarily written to a separate `shuttercount-*` directory under the system temporary directory. The client filename is never used as the on-disk storage path.
- Cleanup is attempted and awaited before the parse response is sent. It is best-effort: filesystem errors or crashes can leave temporary files behind.
- At startup, the service attempts to remove `shuttercount-*` directories older than 10 minutes. This is not a continuous cleanup service or a guarantee of deletion after a crash; operators should account for temporary storage and filesystem backups.
- There is no photo database or intentional long-term photo archive. Parse results sent to the uploader may include the sanitized filename and selected camera metadata; server diagnostic events and the UI's copied diagnostic report omit those values.
- Diagnostics use allowlisted classifications and summaries rather than photo bytes, full EXIF, raw exception messages, or stack traces. Request IDs correlate events only; no photo-download/history API is added.
- Proxy, supervisor, hosting, and backup logs/storage have their own policies. Review those separately when operating the service.

Capacity exhaustion or queue timeout returns HTTP 503 / `error` / `busy`, with `parser_queue_full`, `parser_queue_timeout` or `parser_closed` in diagnostic logs. Each application closes its own ExifTool pool. SIGINT/SIGTERM starts a bounded 20-second shutdown; PM2 requires `kill_timeout: 25000`, as described in the deployment guide.
