import { ExifTool } from "exiftool-vendored";
import { mapTags, summarizeMapping } from "./mapping.js";
import { errorField, isRecord } from "../shared/protocol.js";
import type { ParseResult } from "../shared/protocol.js";
import type { ParseDiagnostic } from "./diagnostics.js";

export type ReadRaw = (filePath: string, args: string[]) => Promise<unknown>;
export interface ParseOptions {
  onDiagnostic?: (details: ParseDiagnostic) => void;
}
export type ParseFile = (
  filePath: string,
  fileName: string | null,
  options: ParseOptions
) => Promise<unknown>;
export interface Parser {
  parse: (
    filePath: string,
    fileName: string | null,
    options: ParseOptions
  ) => Promise<ParseResult>;
  version: () => Promise<string>;
  close: () => Promise<void>;
}

/** Each application owns its lazily started worker pool. Closing one never
 * affects another application, and a closed pool cannot be reopened. */
export function createParser(): Parser {
  let worker: ExifTool | null = null;
  let closed = false;
  const getWorker = () => {
    if (closed) throw new Error("Parser closed");
    return (worker ??= new ExifTool({ taskTimeoutMillis: 15000, maxProcs: 2 }));
  };
  return {
    parse: (filePath, fileName, options) =>
      parseFile(filePath, fileName, {
        ...options,
        readRaw: (file, args) => getWorker().readRaw(file, args),
      }),
    version: async () => String(await getWorker().version()),
    close: async () => {
      closed = true;
      const current = worker;
      worker = null;
      if (current) await current.end();
    },
  };
}

/**
 * Parse a JPEG on disk and map its tags to the API result shape.
 * Never throws for bad input: corrupt / non-JPEG files come back as
 * unsupported_or_corrupt. Tool failures return error, not a claim of corrupt input.
 * `fileName` is echoed through unchanged (the caller
 * is responsible for sanitizing it).
 */
export async function parseFile(
  filePath: string,
  fileName: string | null,
  options: ParseOptions & { readRaw: ReadRaw }
): Promise<ParseResult> {
  // Diagnostics are fixed codes / allowlisted summaries, never raw errors or
  // EXIF values. The callback is server-internal and is not part of the API.
  const report = options.onDiagnostic ?? (() => {});
  const readRaw = options.readRaw;
  let raw;
  try {
    raw = await readRaw(filePath, ["-G1", "-n", "-json"]);
  } catch (err) {
    const timeout =
      /timeout|timed?\s*out/i.test(String(errorField(err, "message") ?? "")) ||
      errorField(err, "code") === "ETIMEDOUT";
    report({
      stage: "exiftool",
      diagnosticCode: timeout ? "exiftool_timeout" : "exiftool_read_failed",
    });
    return parserError(fileName, timeout ? "timeout" : "parser_unavailable");
  }

  if (!isRecord(raw)) {
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
  return { ...mapped, fileName };
}

function parserError(
  fileName: string | null,
  reason: "timeout" | "parser_unavailable"
): ParseResult {
  return {
    status: "error",
    reason,
    fileName,
    message: "解析服务暂时不可用，请稍后重试。",
  };
}

function corrupt(fileName: string | null): ParseResult {
  return {
    status: "unsupported_or_corrupt",
    reason: "corrupt",
    fileName,
    message: "无法解析该文件，图片可能已损坏。",
  };
}

function hasFormatErrorWarning(raw: Record<string, unknown>) {
  const w = raw["ExifTool:Warning"];
  if (w === undefined || w === null) return false;
  const list = Array.isArray(w) ? w : [w];
  return list.some((item) => /format error/i.test(String(item)));
}
