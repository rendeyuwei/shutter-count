import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";
import type { ParseFile } from "../parse.js";
import { decodeParseResult } from "../../shared/protocol.js";
import type { ParseResult } from "../../shared/protocol.js";
import {
  isFileTooLarge,
  isInvalidMultipart,
  safeErrorCode,
} from "../diagnostics.js";
import type { Stage, DiagnosticCode } from "../diagnostics.js";
const TMP_PREFIX = "shuttercount-";
const STALE_TMP_AGE_MS = 10 * 60 * 1000;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
export interface UploadOutcome {
  code: number;
  body: ParseResult;
}

/** Client filename -> safe display name: basename only, max 120 chars. */
export function sanitizeFileName(name: unknown) {
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

function assertReadableUpload(stream: Readable) {
  if (stream.errored) throw stream.errored;
  if (stream.destroyed) {
    throw Object.assign(new Error("Invalid multipart stream"), {
      code: "FST_INVALID_MULTIPART",
    });
  }
}

export async function processUpload(
  req: FastifyRequest,
  config: AppConfig,
  parse: ParseFile
): Promise<UploadOutcome> {
  const { tmpRoot, maxUploadMb } = config;
  let tmpDir: string | null = null;
  const mark = (stage: Stage, diagnosticCode: DiagnosticCode) =>
    Object.assign(req.diagnostic, { stage, diagnosticCode });

  // Inner worker: resolves to {code, body}. The temp dir is removed in
  // the finally block below BEFORE the response is sent (privacy), and
  // only allowlisted diagnostics are logged — never raw errors or metadata.
  const processUpload = async (): Promise<UploadOutcome> => {
    let fileName: string | null = null;
    let tmpFile: string | null = null;
    let rejection: UploadOutcome | null = null;
    // Consume every part before parsing, so trailing malformed fields and
    // the files:1 limit cannot be silently ignored after the first file.
    for await (const part of req.parts()) {
      if (part.type !== "file") continue;
      assertReadableUpload(part.file);
      if (part.fieldname !== "file") {
        for await (const _chunk of part.file) {
          /* discard */
        }
        mark("upload", "upload_invalid_field");
        rejection = {
          code: 400,
          body: {
            status: "bad_request",
            message: '请使用表单字段 "file" 上传。',
          },
        };
        continue;
      }
      fileName = sanitizeFileName(part.filename);
      // Filename is display-only; it is never used on disk or in logs.
      if (!/\.jpe?g$/i.test(part.filename || "")) {
        for await (const _chunk of part.file) {
          /* discard */
        }
        mark("validation", "upload_invalid_extension");
        rejection = {
          code: 422,
          body: {
            status: "unsupported_or_corrupt",
            reason: "not_jpeg",
            fileName,
            message: "仅支持 JPG/JPEG 格式的相机原图。",
          },
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
        rejection = {
          code: 413,
          body: { status: "file_too_large", maxMb: maxUploadMb },
        };
      }
    }
    if (rejection) return rejection;
    if (!tmpFile) {
      mark("upload", "upload_missing_file");
      return {
        code: 400,
        body: {
          status: "bad_request",
          message: '缺少上传文件（表单字段 "file"）。',
        },
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
    const rawResult = await parse(tmpFile, fileName, {
      onDiagnostic: (details) => Object.assign(req.diagnostic, details),
    });
    const result = decodeParseResult(rawResult);
    if (!result) throw new Error("Invalid parser result");
    return {
      code:
        result.status === "error"
          ? 503
          : result.status === "unsupported_or_corrupt"
            ? 422
            : 200,
      body: result,
    };
  };

  let out: UploadOutcome;
  try {
    out = await processUpload();
  } catch (err) {
    if (isFileTooLarge(err)) {
      mark("upload", "upload_too_large");
      out = {
        code: 413,
        body: { status: "file_too_large", maxMb: maxUploadMb },
      };
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
        req.log.error(
          { event: "temp_cleanup_failed", requestId: req.id },
          "temp_cleanup_failed"
        );
      }
    }
  }

  return out;
}
