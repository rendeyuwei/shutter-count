import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { LogController } from "fastify";
import type {
  FastifyRequest,
  FastifyReply,
  FastifyServerOptions,
} from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { createParser } from "./parse.js";
import type { Parser, ParseFile } from "./parse.js";
import { readConfig } from "./config.js";
import type { ConfigOptions, AppConfig } from "./config.js";
import { errorField } from "../shared/protocol.js";
import type { ParseResult, HealthResponse } from "../shared/protocol.js";
import {
  isFileTooLarge,
  isInvalidMultipart,
  safeErrorCode,
} from "./diagnostics.js";
import type { RequestDiagnostic } from "./diagnostics.js";
import { processUpload, cleanupStaleTmpDirs } from "./photo/upload.js";
import { Admission, AdmissionError } from "./photo/admission.js";
export { cleanupStaleTmpDirs, sanitizeFileName } from "./photo/upload.js";
export { parseTrustProxy } from "./config.js";

declare module "fastify" {
  interface FastifyRequest {
    diagnostic: RequestDiagnostic;
  }
  interface FastifyInstance {
    appConfig: AppConfig;
  }
}
export interface AppOptions extends ConfigOptions {
  logger?: FastifyServerOptions["logger"];
  parseFile?: ParseFile;
  parser?: Parser;
}
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// Captured once at startup: a symlink switch must not make an old process
// report the new release. Local checkouts do not need a REVISION file.
let releaseRevision: string | null = null;
try {
  const value = fs
    .readFileSync(path.join(__dirname, "..", "REVISION"), "utf8")
    .trim();
  if (/^[a-f0-9]{40}$/.test(value)) releaseRevision = value;
} catch {}

export function buildApp(opts: AppOptions = {}) {
  const config = readConfig(opts);
  const { basePath, maxUploadMb, trustProxy, tmpRoot, rateLimitMax } = config;
  const parser = opts.parser ?? createParser();
  const parse = opts.parseFile ?? parser.parse;
  const admission = new Admission(
    config.maxActiveUploads,
    config.maxWaitingUploads,
    config.queueWaitMs
  );
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy,
    requestTimeout: config.requestTimeoutMs,
    // Never trust an uploaded request ID; UUIDs stay unique across restarts.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    // The explicit allowlisted event below replaces automatic request logs,
    // which otherwise include client IP addresses and arbitrary query strings.
    logController: new LogController({ disableRequestLogging: true }),
  });

  app.decorateRequest("diagnostic");
  app.addHook("onRequest", async (req, reply) => {
    reply.header("X-Request-ID", req.id);
    req.diagnostic = {
      startedAt: Date.now(),
      stage: "upload",
      diagnosticCode: "internal_error",
    };
  });

  function finish(
    req: FastifyRequest,
    reply: FastifyReply,
    code: number,
    body: ParseResult | Omit<HealthResponse, "requestId">
  ) {
    req.diagnostic.status = body.status;
    return reply.code(code).send({ ...body, requestId: req.id });
  }

  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route !== basePath + "/api/parse" && route !== basePath + "/api/health")
      return;
    const { startedAt, ...diagnostic } = req.diagnostic;
    const event = route.endsWith("/parse") ? "parse_result" : "health_result";
    const level =
      reply.statusCode >= 500
        ? "error"
        : diagnostic.status === "ok"
          ? "info"
          : "warn";
    req.log[level](
      {
        event,
        requestId: req.id,
        ...diagnostic,
        httpCode: reply.statusCode,
        durationMs: Date.now() - startedAt,
      },
      event
    );
  });

  app.register(rateLimit, { global: false });

  app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
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

    instance.get(basePath + "/api/config", async (req) => ({
      maxUploadMb,
      maxUploadBytes: config.maxUploadBytes,
      requestId: req.id,
    }));

    instance.get(basePath + "/api/health", async (req, reply) => {
      try {
        const version = await parser.version();
        Object.assign(req.diagnostic, {
          stage: "complete",
          diagnosticCode: "health_ok",
        });
        return finish(req, reply, 200, {
          status: "ok",
          exiftool: version,
          revision: releaseRevision,
        });
      } catch {
        Object.assign(req.diagnostic, {
          stage: "exiftool",
          diagnosticCode: "exiftool_unavailable",
        });
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
        let release: (() => void) | undefined;
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.raw.once("aborted", abort);
        try {
          release = await admission.acquire(controller.signal);
          const out = await processUpload(req, config, parse);
          return finish(req, reply, out.code, out.body);
        } catch (error) {
          if (!(error instanceof AdmissionError)) throw error;
          req.diagnostic.diagnosticCode = error.code;
          return finish(req, reply, 503, { status: "error", reason: "busy" });
        } finally {
          req.raw.off("aborted", abort);
          release?.();
        }
      }
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (isFileTooLarge(err)) {
      Object.assign(req.diagnostic, {
        stage: "upload",
        diagnosticCode: "upload_too_large",
      });
      return finish(req, reply, 413, {
        status: "file_too_large",
        maxMb: maxUploadMb,
      });
    }
    if (errorField(err, "statusCode") === 429) {
      Object.assign(req.diagnostic, {
        stage: "upload",
        diagnosticCode: "rate_limited",
      });
      return finish(req, reply, 429, {
        status: "rate_limited",
        message: "请求过于频繁，请稍后重试。",
      });
    }
    if (isInvalidMultipart(err)) {
      Object.assign(req.diagnostic, {
        stage: "upload",
        diagnosticCode: "upload_invalid_multipart",
      });
      return finish(req, reply, 400, { status: "bad_request" });
    }
    req.diagnostic.diagnosticCode = "internal_error";
    req.diagnostic.errorCode = safeErrorCode(err);
    return finish(req, reply, 500, { status: "error" });
  });

  app.addHook("preClose", async () => admission.close());
  app.addHook("onClose", async () => {
    await parser.close();
  });

  // Best-effort startup cleanup of stale temp dirs (fire and forget).
  cleanupStaleTmpDirs(tmpRoot).catch(() => {});

  app.decorate("appConfig", config);
  return app;
}
