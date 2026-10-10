import { isRecord, isRequestId } from "../shared/protocol.js";
import type { Diagnostics } from "./types.js";
// Only these bounded codes can enter a report. Never copy the API response,
// error message, filename, or EXIF into diagnostics, even for unexpected errors.
const REPORT_STATUSES = new Set([
  "ok",
  "no_shutter_field",
  "unsupported_or_corrupt",
  "file_too_large",
  "rate_limited",
  "bad_request",
  "error",
  "unexpected_response",
  "client_validation_failed",
  "network_error",
  "client_timeout",
]);
const REPORT_REASONS = new Set([
  "corrupt",
  "not_jpeg",
  "file_too_large",
  "missing_file",
  "invalid_multipart",
  "rate_limited",
  "parser_unavailable",
  "busy",
  "timeout",
  "internal_error",
  "no_shutter_field",
  "network_error",
  "invalid_response",
  "not_provided",
  "unknown",
]);
function safeRequestId(value: unknown): string | null {
  return isRequestId(value) ? value : null;
}

export function makeDiagnostics({
  requestId = null,
  status,
  reason = "not_provided",
}: {
  requestId?: unknown;
  status: unknown;
  reason?: unknown;
}): Diagnostics {
  return {
    requestId: safeRequestId(requestId),
    status:
      typeof status === "string" && REPORT_STATUSES.has(status)
        ? status
        : "unexpected_response",
    reason:
      typeof reason === "string" && REPORT_REASONS.has(reason)
        ? reason
        : "unknown",
    clientOccurredAt: new Date().toISOString(),
  };
}

function statusFromResponse(res: Pick<Response, "status">): string {
  const statuses: Record<number, string> = {
    400: "bad_request",
    413: "file_too_large",
    422: "unsupported_or_corrupt",
    429: "rate_limited",
    500: "error",
    502: "error",
    503: "error",
    504: "error",
  };
  return statuses[res.status] || "unexpected_response";
}

export function responseDiagnostics(
  res: Response,
  raw: unknown,
  fallbackReason = "not_provided"
): Diagnostics {
  const data = isRecord(raw) ? raw : null;
  return makeDiagnostics({
    requestId:
      safeRequestId(data && data.requestId) ||
      safeRequestId(res.headers.get("X-Request-ID")),
    status:
      data &&
      typeof data.status === "string" &&
      REPORT_STATUSES.has(data.status)
        ? data.status
        : statusFromResponse(res),
    reason: data && data.reason !== undefined ? data.reason : fallbackReason,
  });
}
