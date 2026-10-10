import fs from "node:fs";
import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import Fastify, { LogController } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";

import { parseFile, exiftoolVersion, closeExifTool } from "./parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Captured once at startup: a symlink switch must not make an old process
// report the new release. Local checkouts do not need a REVISION file.
let releaseRevision = null;
try {
  const value = fs.readFileSync(path.join(__dirname, "..", "REVISION"), "utf8").trim();
  if (/^[a-f0-9]{40}$/.test(value)) releaseRevision = value;
} catch {}

const TMP_PREFIX = "shuttercount-";
const STALE_TMP_AGE_MS = 10 * 60 * 1000; // 10 minutes
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

const DEFAULT_TRUST_PROXY = ["127.0.0.1", "::1"];

/**
 * Parse the TRUST_PROXY setting into a Fastify `trustProxy` value:
 * - "true" -> true, "false" -> false
 * - comma-separated IPs/CIDRs -> array (only those hops are trusted, so
 *   remote clients cannot spoof X-Forwarded-For to dodge the rate limit)
 * - unset/empty -> loopback-only default (nginx runs on the same host)
 */
export function parseTrustProxy(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_TRUST_PROXY;
  }
  const s = String(value).trim();
  const lower = s.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  const list = s
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x !== "");
  return list.length > 0 ? list : DEFAULT_TRUST_PROXY;
}

/** Normalize a base path: leading slash, no trailing slash ("" for "/"). */
function normalizeBasePath(basePath) {
  let bp = String(basePath || "/");
  if (!bp.startsWith("/")) bp = "/" + bp;
  bp = bp.replace(/\/+$/, "");
  return bp;
}

/** Client filename -> safe display name: basename only, max 120 chars. */
export function sanitizeFileName(name) {
  if (typeof name !== "string" || name.trim() === "") return "upload";
  const base = path.win32.basename(path.posix.basename(name)).trim();
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").slice(0, 120);
  return cleaned === "" ? "upload" : cleaned;
}

/**
 * Best-effort removal of stale shuttercount-* temp dirs (older than 10 min)
 * left behind by crashed runs. Never throws.
 */
export async function cleanupStaleTmpDirs(
  tmpRoot = os.tmpdir(),
  maxAgeMs = STALE_TMP_AGE_MS
) {
  let entries;
  try {
    entries = await fsp.readdir(tmpRoot);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((e) => e.startsWith(TMP_PREFIX))
      .map(async (e) => {
        const p = path.join(tmpRoot, e);
        try {
          const st = await fsp.stat(p);
          if (Date.now() - st.mtimeMs > maxAgeMs) {
            await fsp.rm(p, { recursive: true, force: true });
          }
        } catch {
          // best effort
        }
      })
  );
}

function isFileTooLarge(err) {
  return (
    err &&
    (err.code === "FST_REQ_FILE_TOO_LARGE" ||
      /too large/i.test(String(err.message)))
  );
}

// Restrict diagnostics to a fixed vocabulary; OS error messages contain paths.
function safeErrorCode(err) {
  const allowed = ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EMFILE", "ENFILE", "EROFS", "EPIPE", "ECONNRESET", "ETIMEDOUT"];
  return allowed.includes(err?.code) ? err.code : "UNKNOWN";
}

function isInvalidMultipart(err) {
  return Boolean(err && (
    ["FST_INVALID_MULTIPART_CONTENT_TYPE", "FST_FILES_LIMIT", "FST_FIELDS_LIMIT", "FST_PARTS_LIMIT",
      "FST_INVALID_JSON_FIELD_ERROR", "FST_PROTO_VIOLATION", "FST_INVALID_MULTIPART", "FST_ERR_CTP_INVALID_MEDIA_TYPE", "FST_ERR_CTP_EMPTY_JSON_BODY", "FST_ERR_CTP_INVALID_JSON_BODY"].includes(err.code) ||
    /^(Multipart: Boundary not found|Unexpected end of (form|multipart data|file)|Malformed part header|Part terminated early|Premature close)$/.test(String(err.message))
  ));
}

function assertReadableUpload(stream) {
  if (stream.errored) throw stream.errored;
  if (stream.destroyed) {
    throw Object.assign(new Error("Invalid multipart stream"), { code: "FST_INVALID_MULTIPART" });
  }
}

export function buildApp(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3020);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const basePath = normalizeBasePath(
    opts.basePath ?? process.env.BASE_PATH ?? "/shutter"
  );
  const maxUploadMb = Number(
    opts.maxUploadMb ?? process.env.MAX_UPLOAD_MB ?? 50
  );
  const trustProxy = parseTrustProxy(
    opts.trustProxy ?? process.env.TRUST_PROXY
  );
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const rateLimitMax = opts.rateLimitMax ?? 30;

  const parse = opts.parseFile ?? parseFile;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy,
    // Never trust an uploaded request ID; UUIDs stay unique across restarts.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // The explicit allowlisted event below replaces automatic request logs,
    // which otherwise include client IP addresses and arbitrary query strings.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.decorateRequest("diagnostic", null);
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-ID", req.id);
    req.diagnostic = {
      startedAt: Date.now(), stage: "upload", diagnosticCode: "internal_error",
    };
  });

  function finish(req, reply, code, body) {
    req.diagnostic.status = body.status;
    return reply.code(code).send({ ...body, requestId: req.id });
  }

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route !== basePath + "/api/parse" && route !== basePath + "/api/health") return;
    const { startedAt, ...diagnostic } = req.diagnostic;
    const event = route.endsWith("/parse") ? "parse_result" : "health_result";
    const level = reply.statusCode >= 500 ? "error" : diagnostic.status === "ok" ? "info" : "warn";
    req.log[level]({
      event, requestId: req.id, ...diagnostic,
      httpCode: reply.statusCode, durationMs: Date.now() - startedAt,
    }, event);
  });

  app.register(rateLimit, { global: false });

  app.register(multipart, {
    limits: {
      fileSize: Math.max(1, Math.round(maxUploadMb * 1024 * 1024)),
      files: 1,
    },
    throwFileSizeLimit: true,
  });

  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: basePath + "/",
    index: ["index.html"],
  });

  // Routes are registered inside a plugin so that @fastify/rate-limit's
  // onRoute hook (installed when the plugin above loads) sees them.
  app.register(async (instance) => {
    // GET /shutter (no trailing slash) -> 308 to /shutter/
    if (basePath !== "") {
      instance.get(basePath, (_req, reply) => {
        reply.redirect(basePath + "/", 308);
      });
    }

    instance.get(basePath + "/api/health", async (req, reply) => {
      try {
        const version = await exiftoolVersion();
        Object.assign(req.diagnostic, { stage: "complete", diagnosticCode: "health_ok" });
        return finish(req, reply, 200, { status: "ok", exiftool: version, revision: releaseRevision });
      } catch {
        Object.assign(req.diagnostic, { stage: "exiftool", diagnosticCode: "exiftool_unavailable" });
        return finish(req, reply, 500, { status: "error" });
      }
    });

    instance.post(
      basePath + "/api/parse",
      {
        config: {
          rateLimit: {
            max: rateLimitMax,
            timeWindow: "1 minute",
          },
        },
      },
      async (req, reply) => {
        let tmpDir = null;
        const mark = (stage, diagnosticCode) => Object.assign(req.diagnostic, { stage, diagnosticCode });

        // Inner worker: resolves to {code, body}. The temp dir is removed in
        // the finally block below BEFORE the response is sent (privacy), and
        // only allowlisted diagnostics are logged — never raw errors or metadata.
        const processUpload = async () => {
          let fileName = null;
          let tmpFile = null;
          let rejection = null;
          // Consume every part before parsing, so trailing malformed fields and
          // the files:1 limit cannot be silently ignored after the first file.
          for await (const part of req.parts()) {
            if (part.type !== "file") continue;
            assertReadableUpload(part.file);
            if (part.fieldname !== "file") {
              for await (const _chunk of part.file) { /* discard */ }
              mark("upload", "upload_invalid_field");
              rejection = { code: 400, body: { status: "bad_request", message: '请使用表单字段 "file" 上传。' } };
              continue;
            }
            fileName = sanitizeFileName(part.filename);
            // Filename is display-only; it is never used on disk or in logs.
            if (!/\.jpe?g$/i.test(part.filename || "")) {
              for await (const _chunk of part.file) { /* discard */ }
              mark("validation", "upload_invalid_extension");
              rejection = {
                code: 422,
                body: { status: "unsupported_or_corrupt", reason: "not_jpeg", fileName,
                  message: "仅支持 JPG/JPEG 格式的相机原图。" },
              };
              continue;
            }
            mark("upload", "internal_error");
            tmpDir = await fsp.mkdtemp(path.join(tmpRoot, TMP_PREFIX));
            tmpFile = path.join(tmpDir, "upload.jpg");
            // A malformed stream can close during mkdtemp. Passing an already
            // destroyed stream to pipeline may otherwise wait forever.
            assertReadableUpload(part.file);
            await pipeline(part.file, fs.createWriteStream(tmpFile));
            if (part.file.truncated) {
              mark("upload", "upload_too_large");
              rejection = { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
            }
          }
          if (rejection) return rejection;
          if (!tmpFile) {
            mark("upload", "upload_missing_file");
            return {
              code: 400,
              body: { status: "bad_request", message: '缺少上传文件（表单字段 "file"）。' },
            };
          }

          mark("validation", "internal_error");
          // Magic-byte check: first 3 bytes must be FF D8 FF.
          const head = Buffer.alloc(3);
          let bytesRead = 0;
          const fh = await fsp.open(tmpFile, "r");
          try {
            const r = await fh.read(head, 0, 3, 0);
            bytesRead = r.bytesRead;
          } finally {
            await fh.close();
          }
          if (bytesRead < 3 || !head.equals(JPEG_MAGIC)) {
            mark("validation", "upload_invalid_magic");
            return {
              code: 422,
              body: {
                status: "unsupported_or_corrupt",
                reason: "not_jpeg",
                fileName,
                message: "文件内容不是有效的 JPEG。",
              },
            };
          }

          mark("exiftool", "internal_error");
          const result = await parse(tmpFile, fileName, {
            onDiagnostic: (details) => Object.assign(req.diagnostic, details),
          });
          return {
            code: result.status === "error" ? 503 : result.status === "unsupported_or_corrupt" ? 422 : 200,
            body: result,
          };
        };

        let out;
        try {
          out = await processUpload();
        } catch (err) {
          if (isFileTooLarge(err)) {
            mark("upload", "upload_too_large");
            out = { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
          } else if (isInvalidMultipart(err)) {
            mark("upload", "upload_invalid_multipart");
            out = { code: 400, body: { status: "bad_request" } };
          } else {
            // Error messages may contain upload paths or metadata. Never log them.
            req.diagnostic.diagnosticCode = "internal_error";
            req.diagnostic.errorCode = safeErrorCode(err);
            out = { code: 500, body: { status: "error" } };
          }
        } finally {
          if (tmpDir) {
            try {
              await fsp.rm(tmpDir, { recursive: true, force: true });
            } catch {
              // Preserve parse result but surface a privacy-relevant cleanup failure.
              req.diagnostic.cleanupFailed = true;
              req.log.error({ event: "temp_cleanup_failed", requestId: req.id }, "temp_cleanup_failed");
            }
          }
        }

        return finish(req, reply, out.code, out.body);
      }
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (isFileTooLarge(err)) {
      Object.assign(req.diagnostic, { stage: "upload", diagnosticCode: "upload_too_large" });
      return finish(req, reply, 413, { status: "file_too_large", maxMb: maxUploadMb });
    }
    if (err.statusCode === 429) {
      Object.assign(req.diagnostic, { stage: "upload", diagnosticCode: "rate_limited" });
      return finish(req, reply, 429, { status: "rate_limited", message: "请求过于频繁，请稍后重试。" });
    }
    if (isInvalidMultipart(err)) {
      Object.assign(req.diagnostic, { stage: "upload", diagnosticCode: "upload_invalid_multipart" });
      return finish(req, reply, 400, { status: "bad_request" });
    }
    req.diagnostic.diagnosticCode = "internal_error";
    req.diagnostic.errorCode = safeErrorCode(err);
    return finish(req, reply, 500, { status: "error" });
  });

  app.addHook("onClose", async () => {
    await closeExifTool();
  });

  // Best-effort startup cleanup of stale temp dirs (fire and forget).
  cleanupStaleTmpDirs(tmpRoot).catch(() => {});

  app.decorate("appConfig", { port, host, basePath, maxUploadMb, tmpRoot });
  return app;
}

async function main() {
  const app = buildApp({ logger: true });
  const { port, host } = app.appConfig;
  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Node resolves the main module's realpath, so when started through a symlink
// (e.g. /opt/shutter-count/current -> releases/<id>), process.argv[1] may be
// the symlink path while import.meta.url is the realpath. Compare realpaths.
function isInvokedDirectly() {
  if (!process.argv[1]) return false;
  let entry;
  try {
    entry = pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
  return import.meta.url === entry;
}

// PM2 / some launchers may not satisfy the argv[1] realpath equality check
// (e.g. when the script is loaded through a wrapper). Treat known process
// managers as a direct start, and always allow an explicit override.
function shouldListen() {
  if (process.env.SHUTTER_NO_LISTEN === "1") return false;
  if (process.env.SHUTTER_FORCE_LISTEN === "1") return true;
  if (process.env.pm_id !== undefined || process.env.PM2_HOME) return true;
  return isInvokedDirectly();
}

if (shouldListen()) {
  main();
}
