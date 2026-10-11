import { decodeParseResult, decodeUploadSettings } from "../shared/protocol.js";
import type { UploadSettings } from "../shared/protocol.js";
import type { ParseOutcome } from "./types.js";

export async function loadUploadSettings(): Promise<UploadSettings | null> {
  try {
    const response = await fetch("./api/config", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    return response.ok ? decodeUploadSettings(await response.json()) : null;
  } catch {
    return null;
  }
}

export function classifyResponse(
  res: Pick<Response, "ok" | "status">,
  raw: unknown
): ParseOutcome {
  const data = decodeParseResult(raw);
  if (res.ok && data?.status === "ok") return { kind: "success", data };
  if (res.ok && data?.status === "no_shutter_field")
    return { kind: "fail", data };
  if (res.status === 429 || data?.status === "rate_limited")
    return { kind: "error", error: "rate_limited" };
  if (res.status === 413 || data?.status === "file_too_large")
    return { kind: "error", error: "too_large" };
  if (res.status === 422 || data?.status === "unsupported_or_corrupt")
    return { kind: "error", error: "unsupported" };
  if (data?.status === "error" && data.reason === "busy")
    return { kind: "error", error: "busy" };
  return { kind: "error", error: "network" };
}
