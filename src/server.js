import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";

import { parseFile, exiftoolVersion, closeExifTool } from "./parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");

const TMP_PREFIX = "shuttercount-";
const STALE_TMP_AGE_MS = 10 * 60 * 1000; // 10 minutes
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function envBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
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

export function buildApp(opts = {}) {
  const port = Number(opts.port ?? process.env.PORT ?? 3020);
  const host = opts.host ?? process.env.HOST ?? "127.0.0.1";
  const basePath = normalizeBasePath(
    opts.basePath ?? process.env.BASE_PATH ?? "/shutter"
  );
  const maxUploadMb = Number(
    opts.maxUploadMb ?? process.env.MAX_UPLOAD_MB ?? 50
  );
  const trustProxy = envBool(
    opts.trustProxy ?? process.env.TRUST_PROXY,
    true
  );
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();
  const rateLimitMax = opts.rateLimitMax ?? 30;

  const app = Fastify({ logger: opts.logger ?? false, trustProxy });

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

    instance.get(basePath + "/api/health", async (_req, reply) => {
      try {
        const version = await exiftoolVersion();
        return reply.send({ status: "ok", exiftool: version });
      } catch {
        return reply.code(500).send({ status: "error" });
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
        const startedAt = Date.now();
        let tmpDir = null;

        // Inner worker: resolves to {code, body}. The temp dir is removed in
        // the finally block below BEFORE the response is sent (privacy), and
        // only status + timing are ever logged — never file contents.
        const processUpload = async () => {
          let part;
          try {
            part = await req.file();
          } catch (err) {
            if (isFileTooLarge(err)) {
              return { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
            }
            throw err;
          }

          if (!part || !part.file) {
            return {
              code: 400,
              body: {
                status: "bad_request",
                message: '缺少上传文件（表单字段 "file"）。',
              },
            };
          }

          const fileName = sanitizeFileName(part.filename);

          // Extension check (client filename is display-only; never used on disk).
          if (!/\.jpe?g$/i.test(part.filename || "")) {
            await part.toBuffer().catch(() => {}); // drain so the connection stays clean
            return {
              code: 422,
              body: {
                status: "unsupported_or_corrupt",
                reason: "not_jpeg",
                fileName,
                message: "仅支持 JPG/JPEG 格式的相机原图。",
              },
            };
          }

          tmpDir = await fsp.mkdtemp(path.join(tmpRoot, TMP_PREFIX));
          const tmpFile = path.join(tmpDir, "upload.jpg");

          try {
            await pipeline(part.file, fs.createWriteStream(tmpFile));
          } catch (err) {
            if (isFileTooLarge(err) || part.file.truncated) {
              return { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
            }
            throw err;
          }
          if (part.file.truncated) {
            return { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
          }

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

          const result = await parseFile(tmpFile, fileName);
          return {
            code: result.status === "unsupported_or_corrupt" ? 422 : 200,
            body: result,
          };
        };

        let out;
        try {
          out = await processUpload();
        } catch (err) {
          if (isFileTooLarge(err)) {
            out = { code: 413, body: { status: "file_too_large", maxMb: maxUploadMb } };
          } else {
            // Privacy: no stack traces, file contents, or metadata in responses.
            req.log.error({ err: String(err && err.message) }, "parse failed");
            out = { code: 500, body: { status: "error" } };
          }
        } finally {
          if (tmpDir) {
            await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          }
        }

        req.log.info(
          { status: out.body && out.body.status, httpCode: out.code, ms: Date.now() - startedAt },
          "parse upload"
        );
        return reply.code(out.code).send(out.body);
      }
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (isFileTooLarge(err)) {
      return reply.code(413).send({ status: "file_too_large", maxMb: maxUploadMb });
    }
    if (err.statusCode === 429) {
      return reply
        .code(429)
        .send({ status: "rate_limited", message: err.message });
    }
    req.log.error({ err: String(err && err.message) }, "request error");
    reply.code(500).send({ status: "error" });
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

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main();
}
