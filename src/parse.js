// ExifTool I/O: a single shared ExifTool instance, ended on app close.
import { ExifTool } from "exiftool-vendored";
import { mapTags, summarizeMapping } from "./mapping.js";

let exiftool = null;

/** Lazily create (and share) one ExifTool instance. */
export function getExifTool() {
  if (!exiftool) {
    exiftool = new ExifTool({ taskTimeoutMillis: 15000, maxProcs: 2 });
  }
  return exiftool;
}

/** End the shared ExifTool instance (called from fastify onClose). */
export async function closeExifTool() {
  const et = exiftool;
  exiftool = null;
  if (et) {
    try {
      await et.end();
    } catch {
      // best effort
    }
  }
}

/** ExifTool version string, e.g. "13.00". */
export async function exiftoolVersion() {
  return String(await getExifTool().version());
}

/**
 * Parse a JPEG on disk and map its tags to the API result shape.
 * Never throws for bad input: corrupt / non-JPEG files come back as
 * unsupported_or_corrupt. Tool failures return error, not a claim of corrupt input.
 * `fileName` is echoed through unchanged (the caller
 * is responsible for sanitizing it).
 */
export async function parseFile(filePath, fileName = null, options = {}) {
  // Diagnostics are fixed codes / allowlisted summaries, never raw errors or
  // EXIF values. The callback is server-internal and is not part of the API.
  const report = options.onDiagnostic ?? (() => {});
  const readRaw = options.readRaw ?? ((...args) => getExifTool().readRaw(...args));
  let raw;
  try {
    raw = await readRaw(filePath, ["-G1", "-n", "-json"]);
  } catch (err) {
    const timeout = /timeout|timed?\s*out/i.test(String(err?.message ?? "")) ||
      err?.code === "ETIMEDOUT";
    report({ stage: "exiftool", diagnosticCode: timeout ? "exiftool_timeout" : "exiftool_read_failed" });
    return parserError(fileName, timeout ? "timeout" : "parser_unavailable");
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    report({ stage: "exiftool", diagnosticCode: "exiftool_read_failed" });
    return parserError(fileName, "parser_unavailable");
  }

  if (raw["ExifTool:Error"]) {
    report({ stage: "exiftool", diagnosticCode: "exiftool_reported_error" });
    return corrupt(fileName);
  }

  if (raw["File:FileType"] !== "JPEG") {
    report({ stage: "validation", diagnosticCode: "upload_invalid_magic" });
    return {
      status: "unsupported_or_corrupt",
      reason: "not_jpeg",
      fileName,
      message: "仅支持 JPG/JPEG 格式的相机原图。",
    };
  }

  // Truncated/garbage JPEGs often parse "successfully" with FileType JPEG but a
  // structural warning (e.g. "JPEG format error"). Treat those as corrupt.
  if (hasFormatErrorWarning(raw)) {
    report({ stage: "exiftool", diagnosticCode: "jpeg_format_error" });
    return corrupt(fileName);
  }

  const mapped = mapTags(raw);
  report({
    stage: mapped.status === "ok" ? "complete" : "mapping",
    diagnosticCode: mapped.status === "ok" ? "parse_ok" : "no_shutter_field",
    mapping: summarizeMapping(raw),
  });
  return {
    status: mapped.status,
    fileName,
    make: mapped.make,
    model: mapped.model,
    shutterCount: mapped.shutterCount,
    shutterSource: mapped.shutterSource,
    approximate: mapped.approximate,
    note: mapped.note,
    capturedAt: mapped.capturedAt,
  };
}

function parserError(fileName, reason) {
  return {
    status: "error", reason, fileName,
    message: "解析服务暂时不可用，请稍后重试。",
  };
}

function corrupt(fileName) {
  return {
    status: "unsupported_or_corrupt",
    reason: "corrupt",
    fileName,
    message: "无法解析该文件，图片可能已损坏。",
  };
}

function hasFormatErrorWarning(raw) {
  const w = raw["ExifTool:Warning"];
  if (w === undefined || w === null) return false;
  const list = Array.isArray(w) ? w : [w];
  return list.some((item) => /format error/i.test(String(item)));
}
