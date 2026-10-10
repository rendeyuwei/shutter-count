import type { MappingSummary } from "../shared/result.js";
import { errorField } from "../shared/protocol.js";

export type Stage =
  "upload" | "validation" | "exiftool" | "mapping" | "complete";
export type DiagnosticCode =
  | "internal_error"
  | "upload_invalid_field"
  | "upload_invalid_extension"
  | "upload_too_large"
  | "upload_missing_file"
  | "upload_invalid_magic"
  | "upload_invalid_multipart"
  | "exiftool_timeout"
  | "exiftool_read_failed"
  | "exiftool_reported_error"
  | "jpeg_format_error"
  | "parse_ok"
  | "no_shutter_field"
  | "health_ok"
  | "exiftool_unavailable"
  | "rate_limited"
  | "parser_queue_full"
  | "parser_queue_timeout"
  | "parser_closed";
export interface ParseDiagnostic {
  stage: Stage;
  diagnosticCode: DiagnosticCode;
  mapping?: MappingSummary;
}
export interface RequestDiagnostic extends ParseDiagnostic {
  startedAt: number;
  status?: string;
  errorCode?: string;
  cleanupFailed?: boolean;
}

export function safeErrorCode(error: unknown): string {
  const code = errorField(error, "code");
  const allowed = [
    "ENOENT",
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EIO",
    "EMFILE",
    "ENFILE",
    "EROFS",
    "EPIPE",
    "ECONNRESET",
    "ETIMEDOUT",
  ];
  return typeof code === "string" && allowed.includes(code) ? code : "UNKNOWN";
}

export function isFileTooLarge(error: unknown): boolean {
  return (
    errorField(error, "code") === "FST_REQ_FILE_TOO_LARGE" ||
    /too large/i.test(String(errorField(error, "message")))
  );
}

export function isInvalidMultipart(error: unknown): boolean {
  return (
    [
      "FST_INVALID_MULTIPART_CONTENT_TYPE",
      "FST_FILES_LIMIT",
      "FST_FIELDS_LIMIT",
      "FST_PARTS_LIMIT",
      "FST_INVALID_JSON_FIELD_ERROR",
      "FST_PROTO_VIOLATION",
      "FST_INVALID_MULTIPART",
      "FST_ERR_CTP_INVALID_MEDIA_TYPE",
      "FST_ERR_CTP_EMPTY_JSON_BODY",
      "FST_ERR_CTP_INVALID_JSON_BODY",
    ].includes(String(errorField(error, "code"))) ||
    /^(Multipart: Boundary not found|Unexpected end of (form|multipart data|file)|Malformed part header|Part terminated early|Premature close)$/.test(
      String(errorField(error, "message"))
    )
  );
}
