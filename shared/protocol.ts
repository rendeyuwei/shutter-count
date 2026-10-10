import type { MappedResult } from "./result.js";

export const MAX_SHUTTER_COUNT = 5_000_000;
export const REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ParseResult =
  | (MappedResult & { fileName: string | null })
  | {
      status: "unsupported_or_corrupt";
      reason: "not_jpeg" | "corrupt";
      fileName: string | null;
      message?: string;
    }
  | { status: "file_too_large"; maxMb: number }
  | { status: "bad_request" | "rate_limited"; message?: string }
  | {
      status: "error";
      reason?: "timeout" | "parser_unavailable" | "busy";
      fileName?: string | null;
      message?: string;
    };

export type ParseResponse = ParseResult & { requestId: string };
export interface UploadSettings {
  maxUploadMb: number;
  maxUploadBytes: number;
}
export interface HealthResponse {
  status: "ok";
  exiftool: string;
  revision: string | null;
  requestId: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    REQUEST_ID_PATTERN.test(value)
  );
}

function nullableText(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Decode only documented fields; neither raw EXIF nor unknown fields escape. */
export function decodeParseResult(value: unknown): ParseResult | null {
  if (!isRecord(value)) return null;
  const message =
    typeof value.message === "string" ? { message: value.message } : {};
  switch (value.status) {
    case "ok":
    case "no_shutter_field": {
      if (
        !["make", "model", "capturedAt", "fileName", "note"].every((key) =>
          nullableText(value[key])
        ) ||
        typeof value.approximate !== "boolean"
      )
        return null;
      // The checks above validate all fields; explicit narrowing keeps the
      // constructor tied to the same interface without unsafe assertions.
      const { make, model, capturedAt, fileName, note } = value;
      if (
        !nullableText(make) ||
        !nullableText(model) ||
        !nullableText(capturedAt) ||
        !nullableText(fileName) ||
        !nullableText(note)
      )
        return null;
      const metadata = { make, model, capturedAt, fileName };
      if (value.status === "no_shutter_field") {
        if (
          value.shutterCount !== null ||
          value.shutterSource !== null ||
          value.approximate !== false ||
          note !== null
        )
          return null;
        return {
          ...metadata,
          status: "no_shutter_field",
          shutterCount: null,
          shutterSource: null,
          approximate: false,
          note: null,
        };
      }
      if (
        typeof value.shutterCount !== "number" ||
        !Number.isSafeInteger(value.shutterCount) ||
        value.shutterCount <= 0 ||
        value.shutterCount > MAX_SHUTTER_COUNT ||
        typeof value.shutterSource !== "string" ||
        !value.shutterSource
      )
        return null;
      return {
        ...metadata,
        status: "ok",
        shutterCount: value.shutterCount,
        shutterSource: value.shutterSource,
        approximate: value.approximate,
        note,
      };
    }
    case "unsupported_or_corrupt":
      if (
        (value.reason !== "not_jpeg" && value.reason !== "corrupt") ||
        !nullableText(value.fileName)
      )
        return null;
      return {
        status: value.status,
        reason: value.reason,
        fileName: value.fileName,
        ...message,
      };
    case "file_too_large":
      return typeof value.maxMb === "number" &&
        Number.isFinite(value.maxMb) &&
        value.maxMb > 0
        ? { status: value.status, maxMb: value.maxMb }
        : null;
    case "bad_request":
    case "rate_limited":
      return { status: value.status, ...message };
    case "error": {
      if (
        value.reason !== undefined &&
        value.reason !== "timeout" &&
        value.reason !== "parser_unavailable" &&
        value.reason !== "busy"
      )
        return null;
      if (value.fileName !== undefined && !nullableText(value.fileName))
        return null;
      const result: Extract<ParseResult, { status: "error" }> = {
        status: "error",
        ...message,
      };
      if (
        value.reason === "timeout" ||
        value.reason === "parser_unavailable" ||
        value.reason === "busy"
      )
        result.reason = value.reason;
      if (nullableText(value.fileName)) result.fileName = value.fileName;
      return result;
    }
    default:
      return null;
  }
}

export function decodeParseResponse(value: unknown): ParseResponse | null {
  if (!isRecord(value) || !isRequestId(value.requestId)) return null;
  const result = decodeParseResult(value);
  return result ? { ...result, requestId: value.requestId } : null;
}

export function decodeUploadSettings(value: unknown): UploadSettings | null {
  if (
    !isRecord(value) ||
    typeof value.maxUploadMb !== "number" ||
    typeof value.maxUploadBytes !== "number" ||
    !Number.isFinite(value.maxUploadMb) ||
    value.maxUploadMb <= 0 ||
    !Number.isSafeInteger(value.maxUploadBytes) ||
    value.maxUploadBytes <= 0 ||
    value.maxUploadBytes !==
      Math.max(1, Math.round(value.maxUploadMb * 1024 * 1024))
  )
    return null;
  return {
    maxUploadMb: value.maxUploadMb,
    maxUploadBytes: value.maxUploadBytes,
  };
}

export function errorField(error: unknown, field: string): unknown {
  return isRecord(error) ? error[field] : undefined;
}
