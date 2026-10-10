#!/usr/bin/env node
// Install this file and its helpers outside the checkout, owned by root.
// SSH supplies only a commit/run/attempt tuple, never code, paths or settings.
import { execFile, spawn } from "node:child_process";
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
const REPOSITORY_URL = `https://github.com/${EXPECTED_CONFIG.repository}.git`;
const API_BASE = `https://api.github.com/repos/${EXPECTED_CONFIG.repository}/actions/runs`;
const SIGNALS = ["SIGHUP", "SIGINT", "SIGTERM"];
const GIT_OPTIONS = [
  "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null", "-c", "http.followRedirects=false",
  "-c", "protocol.allow=never", "-c", "protocol.https.allow=always",
];

export function parseCommand(command) {
  // A dollar anchor alone accepts a final newline. This anchor accepts nothing.
  const match = typeof command === "string" && command.length <= 256 &&
    /^deploy ([a-f0-9]{40}) ([1-9][0-9]*) ([1-9][0-9]*)(?![\s\S])/.exec(command);
  if (!match) throw new Error("Invalid deployment command");
  const [, sha, runId, attempt] = match;
  return Object.freeze({ sha, runId, attempt, releaseId: `${sha}-${runId}-${attempt}` });
}

export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).length !== Object.keys(EXPECTED_CONFIG).length ||
      Object.entries(EXPECTED_CONFIG).some(([key, value]) =>
        !Object.hasOwn(config, key) || config[key] !== value)) {
    throw new Error("Invalid host deployment configuration");
  }
  return EXPECTED_CONFIG;
}

export function validateIdentity(identity) {
  if (!identity || !Number.isSafeInteger(identity.uid) || identity.uid <= 0 ||
      identity.username !== "shutter-deploy" ||
      !/^22\./.test(identity.nodeVersion ?? "") ||
      identity.execPath !== RECEIVER_NODE) {
    throw new Error("The receiver requires shutter-deploy and the fixed Node.js 22 runtime");
  }
}

function canonicalId(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === "string" && /^[1-9][0-9]*(?![\s\S])/.test(value) ? value : null;
}

function expectedRepository(repository) {
  return repository?.full_name === EXPECTED_CONFIG.repository &&
    canonicalId(repository.id) === String(EXPECTED_CONFIG.repositoryId);
}

export function validateRun(run, command) {
  if (!run || canonicalId(run.id) !== command.runId || run.head_sha !== command.sha ||
      run.head_branch !== "main" || !["push", "workflow_dispatch"].includes(run.event) ||
      run.path !== ".github/workflows/ci-deploy.yml" || canonicalId(run.run_attempt) !== command.attempt ||
      !expectedRepository(run.repository) || !expectedRepository(run.head_repository)) {
    throw new Error("GitHub run does not authorize this deployment");
  }
  // The overall run can still be in progress: its deploy job is this caller.
}

export function validateJobs(body, command) {
  if (!body || !Number.isSafeInteger(body.total_count) || !Array.isArray(body.jobs) ||
      body.total_count !== body.jobs.length || body.total_count > 100 || body.total_count < 1) {
    throw new Error("GitHub jobs response is incomplete");
  }
  const tests = body.jobs.filter(job => job?.name === "test");
  if (tests.length !== 1 || tests[0].status !== "completed" || tests[0].conclusion !== "success" ||
      tests[0].head_sha !== command.sha || canonicalId(tests[0].run_id) !== command.runId ||
      (Object.hasOwn(tests[0], "run_attempt") && canonicalId(tests[0].run_attempt) !== command.attempt)) {
    throw new Error("The exact run attempt has no unique successful test job");
  }
}

export function validateAuthorization(run, jobs, command) {
  validateRun(run, command);
  validateJobs(jobs, command);
}

async function fetchPublicJson(url, request) {
  try {
    const response = await request(url, {
      method: "GET", redirect: "error", credentials: "omit", cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "shutter-count-deploy-receiver" },
    });
    if (response.status !== 200 || response.redirected || (response.url && response.url !== url)) throw new Error();
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error();
    return JSON.parse(text);
  } catch {
    // Never echo API response bodies, request errors or ambient credentials.
    throw new Error("Public GitHub deployment verification failed");
  }
}

export async function authorizeDeployment(command, request = globalThis.fetch) {
  const run = await fetchPublicJson(`${API_BASE}/${command.runId}`, request);
  validateRun(run, command);
  const jobs = await fetchPublicJson(`${API_BASE}/${command.runId}/attempts/${command.attempt}/jobs?per_page=100`, request);
  validateJobs(jobs, command);
}

export function deploymentEnvironment(config = EXPECTED_CONFIG) {
  validateConfig(config);
  // Deliberately do not spread process.env: no agent, token, proxy, loader,
  // shell startup file, alternate Git config or client-supplied PATH survives.
  return {
    PATH: `${config.runtimeBin}:/usr/bin:/bin`, HOME: config.home, PM2_HOME: config.pm2Home,
    USER: "shutter-deploy", LOGNAME: "shutter-deploy", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false", GIT_SSH_COMMAND: "/usr/bin/false",
  };
}

export function verificationEnvironment(config = EXPECTED_CONFIG) {
  // The root-managed gate must not depend on the application runtime's PATH.
  return { ...deploymentEnvironment(config), PATH: "/usr/bin:/bin" };
}

export async function assertRootOwnedPath(filename, fileSystem = fs) {
  // No symlink or group/other-writable ancestor may replace a trusted file.
  const absolute = path.resolve(filename);
  let current = "/";
  for (const component of ["", ...absolute.split("/").filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await fileSystem.lstat(current);
    if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || stat.isSymbolicLink() ||
        (current === absolute ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("Host deployment trust boundary is not root-owned and protected");
    }
  }
}

async function readHostConfig() {
  await assertRootOwnedPath(CONFIG_PATH);
  const text = await fs.readFile(CONFIG_PATH, "utf8");
  if (text.length > 8192) throw new Error("Invalid host deployment configuration");
  try { return validateConfig(JSON.parse(text)); }
  catch { throw new Error("Invalid host deployment configuration"); }
}

async function checkHostInstallation() {
  if (fileURLToPath(import.meta.url) !== `${TRUSTED_DIRECTORY}/receive-deploy.mjs`) {
    throw new Error("The receiver must be installed in the trusted host directory");
  }
  for (const filename of [`${TRUSTED_DIRECTORY}/receive-deploy.mjs`, DEPLOY_SCRIPT,
    `${TRUSTED_DIRECTORY}/check-deploy.mjs`, RECEIVER_NODE]) {
    await assertRootOwnedPath(filename);
  }
}

export function executeCommand(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { ...options, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 },
      (error, stdout) => error ? reject(new Error("Host source verification failed")) : resolve(stdout));
  });
}

export async function verifyCurrentMain(command, runCommand, env) {
  const output = await runCommand("/usr/bin/git", [...GIT_OPTIONS, "ls-remote", "--exit-code", REPOSITORY_URL, "refs/heads/main"], { env, cwd: "/" });
  if (output !== `${command.sha}\trefs/heads/main\n`) throw new Error("Requested commit is no longer current main");
}

function installSignalGuard(signalSource) {
  let signal;
  let child;
  let forwarded = false;
  const handlers = new Map(SIGNALS.map(name => [name, () => {
    signal ??= name;
    if (child && !forwarded) {
      forwarded = true;
      // Only the deployment shell receives this once. A second signal must
      // never interrupt its rollback or make us remove its source early.
      try { child.kill(signal); } catch { /* Still wait for the child's close. */ }
    }
  }]));
  for (const [name, handler] of handlers) signalSource.on(name, handler);
  return {
    assertActive() { if (signal) throw new Error("Deployment interrupted before activation"); },
    watch(active) { child = active; },
    stopWatching() { child = undefined; },
    remove() { for (const [name, handler] of handlers) signalSource.removeListener(name, handler); },
  };
}

export async function spawnDeployment(args, { env, signals, spawnProcess = spawn, fileSystem = fs }) {
  const releaseMatch = typeof args[3] === "string" && /^([a-f0-9]{40})-([1-9][0-9]*)-([1-9][0-9]*)(?![\s\S])/.exec(args[3]);
  if (args.length !== 6 || !releaseMatch || releaseMatch[1] !== args[2] || args[1] !== EXPECTED_CONFIG.root ||
      args[4] !== EXPECTED_CONFIG.localUrl || args[5] !== EXPECTED_CONFIG.publicUrl) {
    throw new Error("Invalid trusted deployment arguments");
  }
  signals.assertActive();
  // Exclusive creation is intentional: an uncertain same-attempt outcome must
  // be investigated, not replayed. Never follow a pre-existing log symlink.
  const logPath = path.join(EXPECTED_CONFIG.root, `deploy-${args[3]}.log`);
  let log;
  try {
    log = await fileSystem.open(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new Error("Deployment log already exists or could not be created; inspect host state before retrying");
  }
  try {
    signals.assertActive();
    await new Promise((resolve, reject) => {
      let child;
      let failed = false;
      try {
        // A separate process group prevents an SSH-session hangup reaching the
        // deploy shell independently of our single, controlled forwarding.
        child = spawnProcess("/usr/bin/bash", [DEPLOY_SCRIPT, ...args], {
          cwd: EXPECTED_CONFIG.home, env, detached: true, stdio: ["ignore", log.fd, log.fd],
        });
      } catch {
        reject(new Error("Deployment could not be started"));
        return;
      }
      signals.watch(child);
      child.once("error", () => { failed = true; });
      child.once("close", (code, signal) => {
        signals.stopWatching();
        if (failed || code !== 0 || signal) reject(new Error("Deployment did not finish successfully; inspect host state before retrying"));
        else resolve();
      });
    });
  } finally {
    // Retain the log even on failure. Closing before child close would lose
    // operational evidence or prematurely interfere with a live rollback.
    await log.close();
  }
}

export async function receiveDeployment(originalCommand, dependencies = {}) {
  const command = parseCommand(originalCommand);
  const identity = dependencies.identity ?? {
    uid: process.getuid?.(), username: os.userInfo().username,
    nodeVersion: process.versions.node, execPath: process.execPath,
  };
  validateIdentity(identity);
  const config = validateConfig(dependencies.config ?? await readHostConfig());
  await (dependencies.checkInstallation ?? checkHostInstallation)();
  const env = deploymentEnvironment(config);
  const gateEnv = verificationEnvironment(config);
  const fileSystem = dependencies.fileSystem ?? fs;
  const runCommand = dependencies.runCommand ?? executeCommand;
  const deploy = dependencies.deploy ?? spawnDeployment;
  const signals = installSignalGuard(dependencies.signalSource ?? process);
  let temp;
  let deploymentCompleted = false;
  let failure;
  try {
    await authorizeDeployment(command, dependencies.request ?? globalThis.fetch);
    signals.assertActive();
    await verifyCurrentMain(command, runCommand, gateEnv);
    signals.assertActive();
    temp = await fileSystem.mkdtemp("/tmp/shutter-count-deploy-");
    await fileSystem.chmod(temp, 0o700);
    const gitDirectory = path.join(temp, "repository.git");
    const source = path.join(temp, "source");
    const archive = path.join(temp, "source.tar");
    await fileSystem.mkdir(source, { mode: 0o700 });
    const git = args => runCommand("/usr/bin/git", [...GIT_OPTIONS, ...args], { env: gateEnv, cwd: temp });
    await git(["init", "--bare", gitDirectory]);
    signals.assertActive();
    await git(["--git-dir", gitDirectory, "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", REPOSITORY_URL, command.sha]);
    const fetched = await git(["--git-dir", gitDirectory, "rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (fetched !== `${command.sha}\n`) throw new Error("Fetched source does not match the requested commit");
    signals.assertActive();
    await git(["--git-dir", gitDirectory, "archive", "--format=tar", "--output", archive, command.sha]);
    await runCommand("/usr/bin/tar", ["-xf", archive, "--directory", source, "--no-same-owner", "--no-same-permissions"], { env: gateEnv, cwd: temp });
    for (const forbidden of [".git", "node_modules"]) {
      try {
        await fileSystem.lstat(path.join(source, forbidden));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw new Error("Could not verify exported source");
      }
      throw new Error("Exported source includes forbidden repository or dependency metadata");
    }
    signals.assertActive();
    // No preparation or external decision happens between this check and the
    // trusted deploy script. That script owns the activation/rollback flock.
    await verifyCurrentMain(command, runCommand, gateEnv);
    signals.assertActive();
    await deploy([source, config.root, command.sha, command.releaseId, config.localUrl, config.publicUrl], { env, signals });
    deploymentCompleted = true;
  } catch (error) {
    failure = error;
  } finally {
    if (temp) {
      try { await fileSystem.rm(temp, { recursive: true, force: true }); }
      catch {
        failure = new Error(deploymentCompleted
          ? "Deployment completed but temporary source cleanup failed; do not retry automatically"
          : "Deployment failed and temporary source cleanup failed; inspect host state before retrying");
      }
    }
    signals.remove();
  }
  if (failure) throw failure;
  return { sha: command.sha, releaseId: command.releaseId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  try {
    if (process.argv.length !== 2) throw new Error("Receiver arguments are not accepted");
    const result = await receiveDeployment(process.env.SSH_ORIGINAL_COMMAND);
    console.log(`Deployed shutter-count ${result.sha}`);
  } catch {
    // SSH input, third-party output and low-level errors are never reflected.
    console.error("Deployment receiver stopped; inspect the host deployment state before retrying.");
    process.exitCode = 1;
  }
}
