// ExifTool I/O: a single shared ExifTool instance, ended on app close.
import { ExifTool } from "exiftool-vendored";
import { mapTags } from "./mapping.js";

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
 * unsupported_or_corrupt. `fileName` is echoed through unchanged (the caller
 * is responsible for sanitizing it).
 */
export async function parseFile(filePath, fileName = null) {
  let raw;
  try {
    raw = await getExifTool().readRaw(filePath, ["-G1", "-n", "-json"]);
  } catch {
    return {
      status: "unsupported_or_corrupt",
      reason: "corrupt",
      fileName,
      message: "无法解析该文件，图片可能已损坏。",
    };
  }

  if (raw["ExifTool:Error"]) {
    return corrupt(fileName);
  }

  if (raw["File:FileType"] !== "JPEG") {
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
    return corrupt(fileName);
  }

  const mapped = mapTags(raw);
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
