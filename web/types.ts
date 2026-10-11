import type { MappedResult } from "../shared/result.js";
export type ErrorKind =
  "unsupported" | "too_large" | "rate_limited" | "busy" | "network";
export type MetadataView = Pick<MappedResult, "model" | "capturedAt"> & {
  fileName: string | null;
};
export type SuccessView = MetadataView &
  Pick<
    Extract<MappedResult, { status: "ok" }>,
    "shutterCount" | "approximate" | "note"
  >;
export type ParseOutcome =
  | { kind: "success"; data: SuccessView }
  | { kind: "fail"; data: MetadataView }
  | { kind: "error"; error: ErrorKind };

export interface Diagnostics {
  requestId: string | null;
  status: string;
  reason: string;
  clientOccurredAt: string;
}

export interface ResultRow {
  label: string;
  value: string;
  shutter?: boolean;
  note?: string | null;
}
