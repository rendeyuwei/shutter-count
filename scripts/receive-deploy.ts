#!/usr/bin/env node
// Install this file and its helpers outside the checkout, owned by root.
// SSH supplies only a commit/run/attempt tuple, never code, paths or settings.
import { execFile, spawn } from "node:child_process";
import { isRecord, errorField } from "../shared/protocol.js";
import { decodeMainRef } from "../shared/deploy.js";
import type { EventEmitter } from "node:events";
import type { ChildPort, SpawnProcess } from "./deploy-ssh.js";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CONFIG_PATH = "/etc/shutter-count/deploy.json";
export const TRUSTED_DIRECTORY = "/usr/local/libexec/shutter-count";
export const RECEIVER_NODE = `${TRUSTED_DIRECTORY}/receive-node`;
export const DEPLOY_SCRIPT = `${TRUSTED_DIRECTORY}/deploy-release.sh`;
export const EXPECTED_CONFIG = Object.freeze({
  repository: "rendeyuwei/shutter-count",
  repositoryId: 1412053352,
  root: "/opt/shutter-count",
  home: "/var/lib/shutter-deploy",
  pm2Home: "/var/lib/shutter-deploy/.pm2",
  runtimeBin: "/opt/node-v22.23.2-linux-x64/bin",
  localUrl: "http://127.0.0.1:3020/shutter",
  publicUrl: "https://rende.fun/shutter",
});
export interface Command {
  sha: string;
  runId: string;
  attempt: string;
  releaseId: string;
}
export type HostConfig = typeof EXPECTED_CONFIG;
export interface CommandOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeout?: number;
}
export type RunCommand = (
  executable: string,
  args: string[],
  options: CommandOptions
) => Promise<string>;
export interface SourceFileSystem extends FailureLogFileSystem {
  mkdtemp: (prefix: string) => Promise<string>;
  chmod: (filename: string, mode: number) => Promise<void>;
  mkdir: (filename: string, options: { mode: number }) => Promise<unknown>;
  lstat: (filename: string) => Promise<unknown>;
  rm: (
    filename: string,
    options: { recursive: boolean; force: boolean }
  ) => Promise<void>;
}
export interface FailureEntry {
  releaseId: string;
  stage: string;
  error: unknown;
}
export interface FailureLogFileSystem {
  appendFile?: (
    filename: string,
    line: string,
    options: { encoding: "utf8"; mode: number; flag: "a" }
  ) => Promise<unknown>;
  open?: (
    filename: string,
    flags: number,
    mode: number
  ) => Promise<{
    writeFile: (line: string) => Promise<unknown>;
    close: () => Promise<void>;
  }>;
}
export interface RetryOptions {
  attempts?: number;
  delaysMs?: readonly number[];
  wait?: (ms: number) => Promise<void>;
  shouldRetry?: (error: unknown) => boolean;
}
export type Retry = <T>(
  operation: (attempt: number) => Promise<T>,
  options?: RetryOptions
) => Promise<T>;
export interface TrustFileSystem {
  lstat: (filename: string) => Promise<{
    uid: number;
    mode: number;
    isSymbolicLink: () => boolean;
    isFile: () => boolean;
    isDirectory: () => boolean;
  }>;
}
export interface LogFileSystem {
  open: (
    filename: string,
    flags: number,
    mode: number
  ) => Promise<{ fd: number; close: () => Promise<void> }>;
}
export type PublicRequest = (
  url: string,
  options: RequestInit
) => Promise<{
  status: number;
  redirected?: boolean;
  url?: string;
  text: () => Promise<string>;
}>;
export interface DeploymentOptions {
  env: NodeJS.ProcessEnv;
  signals: SignalGuard;
  spawnProcess?: SpawnProcess;
  fileSystem?: LogFileSystem;
}
export interface ReceiverDependencies {
  identity?: unknown;
  config?: unknown;
  checkInstallation?: () => Promise<void>;
  fileSystem?: SourceFileSystem;
  runCommand?: RunCommand;
  deploy?: (args: string[], options: DeploymentOptions) => Promise<void>;
  signalSource?: EventEmitter;
  request?: PublicRequest;
  retry?: Retry;
  recordFailure?: (entry: FailureEntry) => Promise<unknown>;
}
export interface SignalGuard {
  assertActive: () => void;
  watch: (child: ChildPort) => void;
  stopWatching: () => void;
  remove: () => void;
}

const REPOSITORY_URL = `https://github.com/${EXPECTED_CONFIG.repository}.git`;
const API_BASE = `https://api.github.com/repos/${EXPECTED_CONFIG.repository}/actions/runs`;
export const MAIN_REF_URL = `https://api.github.com/repos/${EXPECTED_CONFIG.repository}/git/ref/heads/main`;
const TRANSIENT_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const PERMANENT_COMMAND_CODES = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);
export const GIT_COMMAND_TIMEOUT_MS = 180_000;
export const GIT_RETRY_ATTEMPTS = 3;
export const GIT_RETRY_DELAYS_MS = Object.freeze([2_000, 5_000]);
export const FAILURE_LOG_PATH = `${EXPECTED_CONFIG.root}/receive-failures.log`;
const SIGNALS: NodeJS.Signals[] = ["SIGHUP", "SIGINT", "SIGTERM"];
const GIT_OPTIONS = [
  "-c",
  "credential.helper=",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.attributesFile=/dev/null",
  "-c",
  "http.followRedirects=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "protocol.https.allow=always",
  "-c",
  "http.connectTimeout=30",
  "-c",
  "http.lowSpeedLimit=1000",
  "-c",
  "http.lowSpeedTime=20",
];

export function parseCommand(command: unknown): Command {
  // A dollar anchor alone accepts a final newline. This anchor accepts nothing.
  const match =
    typeof command === "string" &&
    command.length <= 256 &&
    /^deploy ([a-f0-9]{40}) ([1-9][0-9]*) ([1-9][0-9]*)(?![\s\S])/.exec(
      command
    );
  if (!match) throw new Error("Invalid deployment command");
  const [, sha, runId, attempt] = match;
  return Object.freeze({
    sha: sha!,
    runId: runId!,
    attempt: attempt!,
    releaseId: `${sha}-${runId}-${attempt}`,
  });
}

export function validateConfig(config: unknown) {
  if (
    !isRecord(config) ||
    Object.keys(config).length !== Object.keys(EXPECTED_CONFIG).length ||
    Object.entries(EXPECTED_CONFIG).some(
      ([key, value]) => !Object.hasOwn(config, key) || config[key] !== value
    )
  ) {
    throw new Error("Invalid host deployment configuration");
  }
  return EXPECTED_CONFIG;
}

export function validateIdentity(identity: unknown) {
  if (
    !isRecord(identity) ||
    typeof identity.uid !== "number" ||
    !Number.isSafeInteger(identity.uid) ||
    identity.uid <= 0 ||
    identity.username !== "shutter-deploy" ||
    !/^22\./.test(String(identity.nodeVersion ?? "")) ||
    identity.execPath !== RECEIVER_NODE
  ) {
    throw new Error(
      "The receiver requires shutter-deploy and the fixed Node.js 22 runtime"
    );
  }
}

function canonicalId(value: unknown) {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9][0-9]*(?![\s\S])/.test(value)
    ? value
    : null;
}

function expectedRepository(repository: unknown) {
  return (
    isRecord(repository) &&
    repository.full_name === EXPECTED_CONFIG.repository &&
    canonicalId(repository.id) === String(EXPECTED_CONFIG.repositoryId)
  );
}

export function validateRun(run: unknown, command: Command) {
  if (
    !isRecord(run) ||
    canonicalId(run.id) !== command.runId ||
    run.head_sha !== command.sha ||
    run.head_branch !== "main" ||
    !["push", "workflow_dispatch"].includes(String(run.event)) ||
    run.path !== ".github/workflows/ci-deploy.yml" ||
    canonicalId(run.run_attempt) !== command.attempt ||
    !expectedRepository(run.repository) ||
    !expectedRepository(run.head_repository)
  ) {
    throw new Error("GitHub run does not authorize this deployment");
  }
  // The overall run can still be in progress: its deploy job is this caller.
}

export function validateJobs(body: unknown, command: Command) {
  if (
    !isRecord(body) ||
    typeof body.total_count !== "number" ||
    !Number.isSafeInteger(body.total_count) ||
    !Array.isArray(body.jobs) ||
    body.total_count !== body.jobs.length ||
    body.total_count > 100 ||
    body.total_count < 1
  ) {
    throw new Error("GitHub jobs response is incomplete");
  }
  const tests = body.jobs.filter(isRecord).filter((job) => job.name === "test");
  if (
    tests.length !== 1 ||
    !tests[0] ||
    tests[0].status !== "completed" ||
    tests[0].conclusion !== "success" ||
    tests[0].head_sha !== command.sha ||
    canonicalId(tests[0].run_id) !== command.runId ||
    (Object.hasOwn(tests[0], "run_attempt") &&
      canonicalId(tests[0].run_attempt) !== command.attempt)
  ) {
    throw new Error("The exact run attempt has no unique successful test job");
  }
}

export function validateAuthorization(
  run: unknown,
  jobs: unknown,
  command: Command
) {
  validateRun(run, command);
  validateJobs(jobs, command);
}

class PublicGithubError extends Error {
  constructor(readonly transient: boolean) {
    super(
      transient
        ? "Public GitHub deployment verification timed out"
        : "Public GitHub deployment verification failed"
    );
  }
}

export class HostCommandError extends Error {
  readonly retryable: boolean;

  constructor(kind: "timeout" | "transport" | "permanent") {
    super(
      kind === "timeout"
        ? "Host source verification timed out"
        : "Host source verification failed"
    );
    this.retryable = kind !== "permanent";
  }
}

function isTransientGitDiagnostic(stderr: string): boolean {
  // Inspect bounded transport signatures, then discard the original output.
  const diagnostic = stderr.slice(0, 16_384);
  return (
    /^fatal: unable to access '[^\r\n]*': (?:Could not resolve host:|Failed to connect to |Connection timed out|Operation timed out|Recv failure: Connection reset by peer|Send failure: Connection reset by peer|Empty reply from server|The requested URL returned error: (?:408|429|500|502|503|504)(?:\s|$)|(?:OpenSSL|LibreSSL) SSL_connect: SSL_ERROR_SYSCALL|GnuTLS recv error \(-(54|110)\):)/im.test(
      diagnostic
    ) ||
    /^error: RPC failed; curl (?:5|6|7|18|28|35|52|55|56|92) [^\r\n]*$/im.test(
      diagnostic
    )
  );
}

function isTransientTransport(error: unknown): boolean {
  const name = String(errorField(error, "name") ?? "");
  if (name === "TimeoutError" || name === "AbortError") return true;
  const code = String(
    errorField(error, "code") ??
      errorField(errorField(error, "cause"), "code") ??
      ""
  );
  return /ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|ECONNABORTED/i.test(
    code
  );
}

async function fetchPublicJson(
  url: string,
  request: PublicRequest
): Promise<unknown> {
  try {
    const response = await request(url, {
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shutter-count-deploy-receiver",
      },
    });
    if (TRANSIENT_HTTP_STATUS.has(response?.status))
      throw new PublicGithubError(true);
    if (
      !response ||
      response.status !== 200 ||
      response.redirected ||
      (response.url && response.url !== url)
    )
      throw new PublicGithubError(false);
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new PublicGithubError(false);
    return JSON.parse(text);
  } catch (error) {
    // Never echo API response bodies, request errors or ambient credentials.
    if (error instanceof PublicGithubError) throw error;
    throw new PublicGithubError(isTransientTransport(error));
  }
}

export function mainShaFromRef(body: unknown): string {
  const sha = decodeMainRef(body);
  if (sha === null) throw new PublicGithubError(false);
  return sha;
}

export async function authorizeDeployment(
  command: Command,
  request: PublicRequest = globalThis.fetch
) {
  const run = await fetchPublicJson(`${API_BASE}/${command.runId}`, request);
  validateRun(run, command);
  const jobs = await fetchPublicJson(
    `${API_BASE}/${command.runId}/attempts/${command.attempt}/jobs?per_page=100`,
    request
  );
  validateJobs(jobs, command);
}

export function deploymentEnvironment(config = EXPECTED_CONFIG) {
  validateConfig(config);
  // Deliberately do not spread process.env: no agent, token, proxy, loader,
  // shell startup file, alternate Git config or client-supplied PATH survives.
  return {
    PATH: `${config.runtimeBin}:/usr/bin:/bin`,
    HOME: config.home,
    PM2_HOME: config.pm2Home,
    USER: "shutter-deploy",
    LOGNAME: "shutter-deploy",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GIT_SSH_COMMAND: "/usr/bin/false",
    GIT_HTTP_CONNECTTIMEOUT: "30",
    GIT_HTTP_LOW_SPEED_LIMIT: "1000",
    GIT_HTTP_LOW_SPEED_TIME: "20",
  };
}

export function verificationEnvironment(config = EXPECTED_CONFIG) {
  // The root-managed gate must not depend on the application runtime's PATH.
  return { ...deploymentEnvironment(config), PATH: "/usr/bin:/bin" };
}

export async function assertRootOwnedPath(
  filename: string,
  fileSystem: TrustFileSystem = fs
) {
  // No symlink or group/other-writable ancestor may replace a trusted file.
  const absolute = path.resolve(filename);
  let current = "/";
  for (const component of ["", ...absolute.split("/").filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await fileSystem.lstat(current);
    if (
      stat.uid !== 0 ||
      (stat.mode & 0o022) !== 0 ||
      stat.isSymbolicLink() ||
      (current === absolute ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(
        "Host deployment trust boundary is not root-owned and protected"
      );
    }
  }
}

async function readHostConfig() {
  await assertRootOwnedPath(CONFIG_PATH);
  const text = await fs.readFile(CONFIG_PATH, "utf8");
  if (text.length > 8192)
    throw new Error("Invalid host deployment configuration");
  try {
    return validateConfig(JSON.parse(text));
  } catch {
    throw new Error("Invalid host deployment configuration");
  }
}

async function checkHostInstallation() {
  if (
    fileURLToPath(import.meta.url) !== `${TRUSTED_DIRECTORY}/receive-deploy.mjs`
  ) {
    throw new Error(
      "The receiver must be installed in the trusted host directory"
    );
  }
  for (const filename of [
    `${TRUSTED_DIRECTORY}/receive-deploy.mjs`,
    DEPLOY_SCRIPT,
    `${TRUSTED_DIRECTORY}/check-deploy.mjs`,
    `${TRUSTED_DIRECTORY}/deploy-guard.mjs`,
    RECEIVER_NODE,
  ]) {
    await assertRootOwnedPath(filename);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isTransientGitFailure(error: unknown): boolean {
  if (error instanceof PublicGithubError) return error.transient;
  if (error instanceof HostCommandError) return error.retryable;
  // Retain transport-shaped injected failures; a generic failure is permanent.
  const message = String(errorField(error, "message") ?? error ?? "");
  return (
    isTransientTransport(error) ||
    /timed out|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|ECONNREFUSED/i.test(
      message
    )
  );
}

/** Best-effort host breadcrumb; command/API adapters redact external output. */
export async function appendFailureLog(
  entry: FailureEntry,
  {
    fileSystem = fs,
    logPath = FAILURE_LOG_PATH,
  }: {
    fileSystem?: FailureLogFileSystem;
    logPath?: string;
  } = {}
) {
  const releaseId =
    typeof entry.releaseId === "string" &&
    /^[a-f0-9]{40}-[1-9][0-9]*-[1-9][0-9]*(?![\s\S])/.test(entry.releaseId)
      ? entry.releaseId
      : "unknown";
  const stage =
    typeof entry.stage === "string" && /^[a-z0-9._-]{1,64}$/i.test(entry.stage)
      ? entry.stage
      : "unknown";
  const error = String(
    errorField(entry.error, "message") ?? entry.error ?? "unknown"
  )
    .replace(/[\r\n\0]/g, " ")
    .slice(0, 500);
  const line = `${new Date().toISOString()}\treleaseId=${releaseId}\tstage=${stage}\terror=${error}\n`;
  try {
    if (fileSystem.appendFile) {
      await fileSystem.appendFile(logPath, line, {
        encoding: "utf8",
        mode: 0o600,
        flag: "a",
      });
      return;
    }
    if (!fileSystem.open) return;
    const handle = await fileSystem.open(
      logPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600
    );
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  } catch {
    // Logging must never mask the original deployment failure.
  }
}

export async function runWithRetries<T>(
  operation: (attempt: number) => Promise<T>,
  {
    attempts = GIT_RETRY_ATTEMPTS,
    delaysMs = GIT_RETRY_DELAYS_MS,
    wait = sleep,
    shouldRetry = isTransientGitFailure,
  }: RetryOptions = {}
): Promise<T> {
  if (!Number.isSafeInteger(attempts) || attempts < 1)
    throw new Error("Invalid retry configuration");
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !shouldRetry(error)) throw error;
      await wait(
        delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? delaysMs.at(-1) ?? 0
      );
    }
  }
  throw lastError;
}

export function executeCommand(
  executable: string,
  args: string[],
  options: CommandOptions
): Promise<string> {
  const timeout =
    typeof options.timeout === "number" &&
    Number.isSafeInteger(options.timeout) &&
    options.timeout > 0
      ? options.timeout
      : GIT_COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { ...options, encoding: "utf8", timeout, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const timedOut =
          error.code === "ETIMEDOUT" ||
          (error.killed &&
            error.signal === "SIGTERM" &&
            error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        const permanentCode = PERMANENT_COMMAND_CODES.has(String(error.code));
        const transient =
          !permanentCode &&
          (isTransientTransport(error) || isTransientGitDiagnostic(stderr));
        reject(
          new HostCommandError(
            timedOut ? "timeout" : transient ? "transport" : "permanent"
          )
        );
      }
    );
  });
}

export async function verifyCurrentMain(
  command: Command,
  runCommand: RunCommand,
  env: NodeJS.ProcessEnv,
  {
    retry = runWithRetries,
    request = globalThis.fetch,
    recordFallback = async () => {},
  }: {
    retry?: Retry;
    request?: PublicRequest;
    recordFallback?: (entry: FailureEntry) => Promise<unknown>;
  } = {}
) {
  let current: string | undefined;
  try {
    current = mainShaFromRef(
      await retry(() => fetchPublicJson(MAIN_REF_URL, request))
    );
  } catch (error) {
    try {
      const detail =
        error instanceof Error
          ? error.message
          : "Public GitHub deployment verification failed";
      await recordFallback({
        releaseId: command.releaseId,
        stage: "main-sha-api",
        error: new Error(`${detail}; falling back to git ls-remote`),
      });
    } catch {
      /* A breadcrumb failure must not skip the fallback. */
    }
  }
  if (current !== undefined) {
    if (current !== command.sha)
      throw new Error("Requested commit is no longer current main");
    return;
  }
  const output = await retry(() =>
    runCommand(
      "/usr/bin/git",
      [
        ...GIT_OPTIONS,
        "ls-remote",
        "--exit-code",
        REPOSITORY_URL,
        "refs/heads/main",
      ],
      { env, cwd: "/" }
    )
  );
  if (output !== `${command.sha}\trefs/heads/main\n`)
    throw new Error("Requested commit is no longer current main");
}

function installSignalGuard(signalSource: EventEmitter): SignalGuard {
  let signal: NodeJS.Signals | undefined;
  let child: ChildPort | undefined;
  let forwarded = false;
  const handlers = new Map(
    SIGNALS.map((name) => [
      name,
      () => {
        signal ??= name;
        if (child && !forwarded) {
          forwarded = true;
          // Only the deployment shell receives this once. A second signal must
          // never interrupt its rollback or make us remove its source early.
          try {
            child.kill(signal);
          } catch {
            /* Still wait for the child's close. */
          }
        }
      },
    ])
  );
  for (const [name, handler] of handlers) signalSource.on(name, handler);
  return {
    assertActive() {
      if (signal) throw new Error("Deployment interrupted before activation");
    },
    watch(active: ChildPort) {
      child = active;
    },
    stopWatching() {
      child = undefined;
    },
    remove() {
      for (const [name, handler] of handlers)
        signalSource.removeListener(name, handler);
    },
  };
}

export async function spawnDeployment(
  args: string[],
  { env, signals, spawnProcess = spawn, fileSystem = fs }: DeploymentOptions
) {
  const releaseMatch =
    typeof args[3] === "string" &&
    /^([a-f0-9]{40})-([1-9][0-9]*)-([1-9][0-9]*)(?![\s\S])/.exec(args[3]);
  if (
    args.length !== 6 ||
    !releaseMatch ||
    releaseMatch[1] !== args[2] ||
    args[1] !== EXPECTED_CONFIG.root ||
    args[4] !== EXPECTED_CONFIG.localUrl ||
    args[5] !== EXPECTED_CONFIG.publicUrl
  ) {
    throw new Error("Invalid trusted deployment arguments");
  }
  signals.assertActive();
  // Exclusive creation is intentional: an uncertain same-attempt outcome must
  // be investigated, not replayed. Never follow a pre-existing log symlink.
  const logPath = path.join(EXPECTED_CONFIG.root, `deploy-${args[3]}.log`);
  let log;
  try {
    log = await fileSystem.open(
      logPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
  } catch {
    throw new Error(
      "Deployment log already exists or could not be created; inspect host state before retrying"
    );
  }
  try {
    signals.assertActive();
    await new Promise<void>((resolve, reject) => {
      let child: ChildPort | undefined;
      let failed = false;
      try {
        // A separate process group prevents an SSH-session hangup reaching the
        // deploy shell independently of our single, controlled forwarding.
        child = spawnProcess("/usr/bin/bash", [DEPLOY_SCRIPT, ...args], {
          cwd: EXPECTED_CONFIG.home,
          env,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        });
      } catch {
        reject(new Error("Deployment could not be started"));
        return;
      }
      signals.watch(child);
      child.once("error", () => {
        failed = true;
      });
      child.once("close", (code, signal) => {
        signals.stopWatching();
        if (failed || code !== 0 || signal)
          reject(
            new Error(
              "Deployment did not finish successfully; inspect host state before retrying"
            )
          );
        else resolve();
      });
    });
  } finally {
    // Retain the log even on failure. Closing before child close would lose
    // operational evidence or prematurely interfere with a live rollback.
    await log.close();
  }
}

export async function receiveDeployment(
  originalCommand: unknown,
  dependencies: ReceiverDependencies = {}
) {
  const command = parseCommand(originalCommand);
  const identity = dependencies.identity ?? {
    uid: process.getuid?.(),
    username: os.userInfo().username,
    nodeVersion: process.versions.node,
    execPath: process.execPath,
  };
  validateIdentity(identity);
  const config = validateConfig(
    dependencies.config ?? (await readHostConfig())
  );
  await (dependencies.checkInstallation ?? checkHostInstallation)();
  const env = deploymentEnvironment(config);
  const gateEnv = verificationEnvironment(config);
  const fileSystem = dependencies.fileSystem ?? fs;
  const runCommand = dependencies.runCommand ?? executeCommand;
  const deploy = dependencies.deploy ?? spawnDeployment;
  const retry = dependencies.retry ?? runWithRetries;
  const request = dependencies.request ?? globalThis.fetch;
  const recordFailure =
    dependencies.recordFailure ??
    ((entry: FailureEntry) => appendFailureLog(entry, { fileSystem }));
  const signals = installSignalGuard(dependencies.signalSource ?? process);
  let temp: string | undefined;
  let deploymentCompleted = false;
  let failure;
  let stage = "startup";
  const stageError = (name: string, error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    return Object.assign(
      new Error(`Deployment failed during ${name}: ${detail}`),
      { stage: name }
    );
  };
  try {
    stage = "authorize";
    try {
      await authorizeDeployment(command, request);
    } catch (error) {
      throw stageError(stage, error);
    }
    signals.assertActive();
    stage = "main-sha";
    try {
      await verifyCurrentMain(command, runCommand, gateEnv, {
        retry,
        request,
        recordFallback: recordFailure,
      });
    } catch (error) {
      throw stageError(stage, error);
    }
    signals.assertActive();
    stage = "prepare-temp";
    temp = await fileSystem.mkdtemp("/tmp/shutter-count-deploy-");
    await fileSystem.chmod(temp, 0o700);
    const gitDirectory = path.join(temp, "repository.git");
    const source = path.join(temp, "source");
    const archive = path.join(temp, "source.tar");
    await fileSystem.mkdir(source, { mode: 0o700 });
    const git = (args: string[]) =>
      runCommand("/usr/bin/git", [...GIT_OPTIONS, ...args], {
        env: gateEnv,
        cwd: temp!,
      });
    stage = "git-init";
    await git(["init", "--bare", gitDirectory]);
    signals.assertActive();
    stage = "git-fetch";
    try {
      await retry(() =>
        git([
          "--git-dir",
          gitDirectory,
          "fetch",
          "--depth=1",
          "--no-tags",
          "--no-recurse-submodules",
          REPOSITORY_URL,
          command.sha,
        ])
      );
    } catch (error) {
      throw stageError(stage, error);
    }
    stage = "rev-parse";
    const fetched = await git([
      "--git-dir",
      gitDirectory,
      "rev-parse",
      "--verify",
      "FETCH_HEAD^{commit}",
    ]);
    if (fetched !== `${command.sha}\n`)
      throw new Error("Fetched source does not match the requested commit");
    signals.assertActive();
    stage = "archive";
    await git([
      "--git-dir",
      gitDirectory,
      "archive",
      "--format=tar",
      "--output",
      archive,
      command.sha,
    ]);
    stage = "extract";
    await runCommand(
      "/usr/bin/tar",
      [
        "-xf",
        archive,
        "--directory",
        source,
        "--no-same-owner",
        "--no-same-permissions",
      ],
      { env: gateEnv, cwd: temp! }
    );
    for (const forbidden of [".git", "node_modules"]) {
      try {
        await fileSystem.lstat(path.join(source, forbidden));
      } catch (error) {
        if (errorField(error, "code") === "ENOENT") continue;
        throw new Error("Could not verify exported source");
      }
      throw new Error(
        "Exported source includes forbidden repository or dependency metadata"
      );
    }
    signals.assertActive();
    // No preparation or external decision happens between this check and the
    // trusted deploy script. That script owns the activation/rollback flock.
    stage = "main-sha-pre-activate";
    try {
      await verifyCurrentMain(command, runCommand, gateEnv, {
        retry,
        request,
        recordFallback: recordFailure,
      });
    } catch (error) {
      throw stageError(stage, error);
    }
    signals.assertActive();
    stage = "activate";
    await deploy(
      [
        source,
        config.root,
        command.sha,
        command.releaseId,
        config.localUrl,
        config.publicUrl,
      ],
      { env, signals }
    );
    deploymentCompleted = true;
  } catch (error) {
    failure = error;
    try {
      await recordFailure({
        releaseId: command.releaseId,
        stage:
          typeof errorField(error, "stage") === "string"
            ? String(errorField(error, "stage"))
            : stage,
        error,
      });
    } catch {
      /* Failure logging must not replace the original error. */
    }
  } finally {
    if (temp) {
      try {
        await fileSystem.rm(temp, { recursive: true, force: true });
      } catch {
        failure = new Error(
          deploymentCompleted
            ? "Deployment completed but temporary source cleanup failed; do not retry automatically"
            : "Deployment failed and temporary source cleanup failed; inspect host state before retrying"
        );
      }
    }
    signals.remove();
  }
  if (failure) throw failure;
  return { sha: command.sha, releaseId: command.releaseId };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 2)
      throw new Error("Receiver arguments are not accepted");
    const result = await receiveDeployment(process.env.SSH_ORIGINAL_COMMAND);
    console.log(`Deployed shutter-count ${result.sha}`);
  } catch {
    // SSH input, third-party output and low-level errors are never reflected.
    console.error(
      "Deployment receiver stopped; inspect /opt/shutter-count/receive-failures.log and deploy-*.log before retrying."
    );
    process.exitCode = 1;
  }
}
