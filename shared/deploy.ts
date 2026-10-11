import { isRecord } from "./protocol.js";

export function decodeMainRef(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.object)) return null;
  const { sha, type } = body.object;
  return body.ref === "refs/heads/main" &&
    type === "commit" &&
    typeof sha === "string" &&
    /^[a-f0-9]{40}(?![\s\S])/.test(sha)
    ? sha
    : null;
}
