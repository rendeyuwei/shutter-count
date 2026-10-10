import os from "node:os";
import { isIP } from "node:net";

export interface AppConfig {
  port: number;
  host: string;
  basePath: string;
  maxUploadMb: number;
  maxUploadBytes: number;
  trustProxy: boolean | string[];
  tmpRoot: string;
  rateLimitMax: number;
  maxActiveUploads: number;
  maxWaitingUploads: number;
  queueWaitMs: number;
  requestTimeoutMs: number;
}
export interface ConfigOptions {
  port?: string | number;
  host?: string;
  basePath?: string;
  maxUploadMb?: string | number;
  trustProxy?: boolean | string | string[];
  tmpRoot?: string;
  rateLimitMax?: number;
  maxActiveUploads?: number;
  maxWaitingUploads?: number;
  queueWaitMs?: number;
  requestTimeoutMs?: number;
}

function numberSetting(
  name: string,
  value: unknown,
  min: number,
  max = Number.MAX_SAFE_INTEGER,
  integer = true
): number {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  )
    throw new Error(`Invalid ${name}`);
  return parsed;
}

export function parseTrustProxy(value: unknown): boolean | string[] {
  if (value === undefined || value === null || String(value).trim() === "")
    return ["127.0.0.1", "::1"];
  const setting = String(value).trim();
  if (setting.toLowerCase() === "true") return true;
  if (setting.toLowerCase() === "false") return false;
  const list = setting
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!list.length) return ["127.0.0.1", "::1"];
  for (const entry of list) {
    const [address, mask, extra] = entry.split("/");
    const version = address ? isIP(address) : 0;
    if (
      !version ||
      extra !== undefined ||
      (mask !== undefined &&
        (!/^\d+$/.test(mask) || Number(mask) > (version === 4 ? 32 : 128)))
    )
      throw new Error("Invalid TRUST_PROXY");
  }
  return list;
}

export function readConfig(
  options: ConfigOptions = {},
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  const maxUploadMb = numberSetting(
    "MAX_UPLOAD_MB",
    options.maxUploadMb ?? env.MAX_UPLOAD_MB ?? 50,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER / 1048576,
    false
  );
  let basePath = options.basePath ?? env.BASE_PATH ?? "/shutter";
  if (!basePath.startsWith("/")) basePath = "/" + basePath;
  basePath = basePath.replace(/\/+$/, "");
  if (
    /[?#%\\\u0000-\u0020]/.test(basePath) ||
    basePath.split("/").some((part) => part === "." || part === "..") ||
    /\/\//.test(basePath)
  )
    throw new Error("Invalid BASE_PATH");
  const host = options.host ?? env.HOST ?? "127.0.0.1";
  if (!host || /[\s/\\]/.test(host)) throw new Error("Invalid HOST");
  return {
    port: numberSetting("PORT", options.port ?? env.PORT ?? 3020, 0, 65535),
    host,
    basePath,
    maxUploadMb,
    maxUploadBytes: Math.max(1, Math.round(maxUploadMb * 1048576)),
    trustProxy: parseTrustProxy(options.trustProxy ?? env.TRUST_PROXY),
    tmpRoot: options.tmpRoot ?? os.tmpdir(),
    rateLimitMax: numberSetting("rateLimitMax", options.rateLimitMax ?? 30, 1),
    maxActiveUploads: numberSetting(
      "MAX_ACTIVE_UPLOADS",
      options.maxActiveUploads ?? env.MAX_ACTIVE_UPLOADS ?? 2,
      1,
      32
    ),
    maxWaitingUploads: numberSetting(
      "MAX_WAITING_UPLOADS",
      options.maxWaitingUploads ?? env.MAX_WAITING_UPLOADS ?? 8,
      0,
      1000
    ),
    queueWaitMs: numberSetting(
      "QUEUE_WAIT_MS",
      options.queueWaitMs ?? env.QUEUE_WAIT_MS ?? 5000,
      1,
      60000
    ),
    requestTimeoutMs: numberSetting(
      "REQUEST_TIMEOUT_MS",
      options.requestTimeoutMs ?? env.REQUEST_TIMEOUT_MS ?? 60000,
      1,
      300000
    ),
  };
}
