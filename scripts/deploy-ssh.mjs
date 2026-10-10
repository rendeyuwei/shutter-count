#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { checkDeployment } from "./check-deploy.mjs";

const SIGNALS = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
const SSH_FAILURE = "SSH deployment was not confirmed and was not retried. Remote work may still be running; inspect the server before rerunning. Diagnostic output was withheld.";
const KEY_TYPES = new Set(["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"]);

// Never expose child-process errors, server output, or rejected setting values.
class DeploymentError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
const fail = message => new DeploymentError(message);
const invalid = name => fail(`Missing or invalid deployment setting: ${name}`);

export function safeErrorMessage(error) {
  return error instanceof DeploymentError ? error.message : "Deployment failed; diagnostic output was withheld to protect credentials.";
}

function isHost(value) {
  if (typeof value !== "string" || value.length > 253 || !value.length) return false;
  if (/^[0-9.]+$/.test(value)) {
    const octets = value.split(".");
    return octets.length === 4 && octets.every(octet => /^(?:0|[1-9][0-9]{0,2})$/.test(octet) && Number(octet) <= 255);
  }
  return value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function scalar(env, name, pattern) {
  const value = env[name];
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value) || !pattern.test(value)) throw invalid(name);
  return value;
}

function decodeBase64(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

function knownHostMatches(token, target) {
  if (token.startsWith("|")) {
    const match = /^\|1\|([^|]+)\|([^|]+)$/.exec(token);
    const salt = match && decodeBase64(match[1]);
    const digest = match && decodeBase64(match[2]);
    if (!salt || salt.length !== 20 || !digest || digest.length !== 20) throw invalid("DEPLOY_KNOWN_HOSTS");
    return timingSafeEqual(createHmac("sha1", salt).update(target).digest(), digest);
  }
  const bracketed = /^\[([^\]]+)\]:([1-9][0-9]{0,4})$/.exec(token);
  if (bracketed ? !isHost(bracketed[1]) || Number(bracketed[2]) > 65535 : !isHost(token)) throw invalid("DEPLOY_KNOWN_HOSTS");
  return token.toLowerCase() === target.toLowerCase();
}

export function parseKnownHosts(value, host, port) {
  if (typeof value !== "string" || !value.length || value.length > 128 * 1024) throw invalid("DEPLOY_KNOWN_HOSTS");
  const text = value.replace(/\r\n/g, "\n");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw invalid("DEPLOY_KNOWN_HOSTS");
  const target = port === "22" ? host : `[${host}]:${port}`;
  let matched = false;
  let entries = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hosts, type, encoded] = trimmed.split(/[ \t]+/);
    const key = typeof encoded === "string" ? decodeBase64(encoded) : null;
    if (!KEY_TYPES.has(type) || !key || key.length < 5 || key.readUInt32BE(0) !== Buffer.byteLength(type) || key.subarray(4, 4 + Buffer.byteLength(type)).toString("ascii") !== type) throw invalid("DEPLOY_KNOWN_HOSTS");
    // Accept exact host aliases or OpenSSH's hashed hostnames. Wildcards,
    // negations, certificate authorities and directives are deliberately absent.
    for (const token of hosts.split(",")) matched = knownHostMatches(token, target) || matched;
    entries++;
  }
  if (!entries || !matched) throw invalid("DEPLOY_KNOWN_HOSTS");
  return `${text.trimEnd()}\n`;
}

export function readDeployConfig(env) {
  const host = scalar(env, "DEPLOY_HOST", /^[A-Za-z0-9.-]+$/).toLowerCase();
  if (!isHost(host)) throw invalid("DEPLOY_HOST");
  const port = env.DEPLOY_PORT === undefined || env.DEPLOY_PORT === "" ? "22" : scalar(env, "DEPLOY_PORT", /^[1-9][0-9]{0,4}$/);
  if (Number(port) > 65535) throw invalid("DEPLOY_PORT");
  const commit = scalar(env, "GITHUB_SHA", /^[a-f0-9]{40}$/);
  const runId = scalar(env, "GITHUB_RUN_ID", /^[1-9][0-9]{0,19}$/);
  const runAttempt = scalar(env, "GITHUB_RUN_ATTEMPT", /^[1-9][0-9]{0,19}$/);
  const publicUrl = scalar(env, "DEPLOY_PUBLIC_URL", /^https:\/\/[A-Za-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9_.~-]*)*$/);
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== "https:" || !isHost(url.hostname) || url.username || url.password || url.search || url.hash || publicUrl.split("/").some(segment => segment === "." || segment === "..")) throw new Error();
  } catch {
    throw invalid("DEPLOY_PUBLIC_URL");
  }
  const rawKey = env.DEPLOY_SSH_KEY;
  const privateKey = typeof rawKey === "string" ? rawKey.replace(/\r\n/g, "\n") : "";
  // Check framing only. SSH performs actual cryptographic key validation; this
  // client never prints, parses, derives or discovers private credentials.
  if (privateKey.length > 64 * 1024 || !/^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END OPENSSH PRIVATE KEY-----\n?$/.test(privateKey)) throw invalid("DEPLOY_SSH_KEY");
  const knownHosts = parseKnownHosts(env.DEPLOY_KNOWN_HOSTS, host, port);
  const config = { host, port, commit, runId, runAttempt, publicUrl };
  // Keep key material out of accidental JSON or object-enumeration diagnostics.
  Object.defineProperties(config, {
    privateKey: { value: privateKey.endsWith("\n") ? privateKey : `${privateKey}\n` },
    knownHosts: { value: knownHosts },
  });
  return Object.freeze(config);
}

export function buildSshArgs(config, { keyPath, knownHostsPath }) {
  for (const value of [keyPath, knownHostsPath]) {
    if (typeof value !== "string" || !path.isAbsolute(value) || /[\x00-\x1f\x7f%"\\]/.test(value)) throw fail("Invalid SSH temporary-file path.");
  }
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
    "-o", "PreferredAuthentications=publickey", "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no", "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile="${knownHostsPath}"`, "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "UpdateHostKeys=no", "-o", "VerifyHostKeyDNS=no",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ClearAllForwardings=yes",
    "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
    "-o", "ConnectionAttempts=1", "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "LogLevel=ERROR",
    "-i", keyPath, "-p", config.port, "-n", "-T", "-l", "shutter-deploy", "--", config.host,
    `deploy ${config.commit} ${config.runId} ${config.runAttempt}`,
  ];
}

export async function runSsh(args, { signal, timeoutMs = 20 * 60 * 1000, spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw fail("Invalid SSH timeout.");
  return new Promise((resolve, reject) => {
    let child;
    try {
      // Use the runner's system OpenSSH, not a marketplace action, shell, agent,
      // PATH override or user ssh config. No stdin, script or archive is sent.
      child = spawnProcess("/usr/bin/ssh", args, {
        shell: false, stdio: "ignore", windowsHide: true,
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        signal, timeout: timeoutMs, killSignal: "SIGKILL",
      });
      child.once("error", () => reject(fail(SSH_FAILURE)));
      child.once("close", (code, endedBySignal) => {
        if (code === 0 && !endedBySignal) resolve();
        else reject(fail(SSH_FAILURE));
      });
    } catch {
      reject(fail(SSH_FAILURE));
    }
  });
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation();
    }).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

export async function deploySsh(env = process.env, {
  run = runSsh, verify = checkDeployment, request = fetch,
  log = message => console.log(message), temporaryRoot = tmpdir(), signals = process,
  timeoutMs = 20 * 60 * 1000, healthAttempts = 15, healthDelayMs = 2000,
} = {}) {
  const config = readDeployConfig(env);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(healthAttempts) || healthAttempts <= 0 || !Number.isSafeInteger(healthDelayMs) || healthDelayMs < 0) throw fail("Invalid deployment timing configuration.");
  const controller = new AbortController();
  const handlers = new Map();
  let directory;
  const cleanup = () => {
    if (directory) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  };
  for (const [name, code] of Object.entries(SIGNALS)) {
    const handler = () => controller.abort(new DeploymentError(`Deployment interrupted by ${name}. Remote work may still be running; inspect the server before rerunning.`, code));
    handlers.set(name, handler);
    signals.on(name, handler);
  }
  // Synchronous cleanup also covers process.exit; SIGKILL cannot be trapped.
  const onExit = () => { try { cleanup(); } catch {} };
  signals.on("exit", onExit);
  try {
    const previousMask = process.umask(0o077);
    let paths;
    try {
      directory = mkdtempSync(path.join(temporaryRoot, "shutter-ssh-"));
      chmodSync(directory, 0o700);
      paths = { keyPath: path.join(directory, "identity"), knownHostsPath: path.join(directory, "known_hosts") };
      writeFileSync(paths.keyPath, config.privateKey, { mode: 0o600, flag: "wx" });
      writeFileSync(paths.knownHostsPath, config.knownHosts, { mode: 0o600, flag: "wx" });
    } finally {
      process.umask(previousMask);
    }
    try {
      // One dispatch only. Timeout, lost connection or uncertain acknowledgement
      // must never cause a duplicate deployment or client-initiated rollback.
      await abortable(() => run(buildSshArgs(config, paths), { signal: controller.signal, timeoutMs }), controller.signal);
    } catch {
      if (controller.signal.aborted) throw controller.signal.reason;
      throw fail(SSH_FAILURE);
    }
    cleanup();
    log("SSH deployment completed; verifying public application health and exact revision.");
    let verified = false;
    for (let attempt = 0; attempt < healthAttempts; attempt++) {
      try {
        await abortable(() => verify(config.publicUrl, config.commit, {
          attempts: 1,
          request: (url, options = {}) => request(url, {
            ...options,
            signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
          }),
        }), controller.signal);
        verified = true;
        break;
      } catch {
        if (controller.signal.aborted) throw controller.signal.reason;
        if (attempt + 1 < healthAttempts) {
          // Keep retry waits abortable, too; the checker must not continue its
          // own retry loop in the background after the runner is cancelled.
          try { await delay(healthDelayMs, undefined, { signal: controller.signal }); }
          catch { throw controller.signal.reason; }
        }
      }
    }
    if (!verified) throw fail("SSH succeeded, but public application health or the exact commit revision could not be verified. No additional remote command was sent; inspect the deployment before rerunning.");
    log("Deployment verified: public application page, ExifTool health, and exact commit revision.");
    return { commit: config.commit, status: "Success" };
  } catch (error) {
    if (error instanceof DeploymentError) throw error;
    throw fail("Deployment failed; diagnostic output was withheld to protect credentials.");
  } finally {
    try {
      cleanup();
    } catch {
      throw fail("Could not remove SSH temporary files; clean the ephemeral runner before reuse. Diagnostic output was withheld.");
    } finally {
      for (const [name, handler] of handlers) signals.removeListener(name, handler);
      signals.removeListener("exit", onExit);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deploySsh();
  } catch (error) {
    console.error(safeErrorMessage(error));
    process.exitCode = error instanceof DeploymentError ? error.exitCode : 1;
  }
}
