import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
test("reviewed trusted tools run independently of the checkout and match their manifest", async (t) => {
  const source = new URL("../trusted/", import.meta.url);
  const isolated = await fs.mkdtemp(
    path.join(os.tmpdir(), "shutter-trusted-test-")
  );
  t.after(() => fs.rm(isolated, { recursive: true, force: true }));
  await fs.cp(source, isolated, { recursive: true });
  const manifest = (
    await fs.readFile(path.join(isolated, "SHA256SUMS"), "utf8")
  )
    .trim()
    .split("\n");
  assert.equal(manifest.length, 5);
  for (const line of manifest) {
    const [checksum, name] = line.split("  ");
    assert.ok(name && checksum);
    assert.equal(
      createHash("sha256")
        .update(await fs.readFile(path.join(isolated, name)))
        .digest("hex"),
      checksum
    );
  }
  const receiver = pathToFileURL(
    path.join(isolated, "receive-deploy.mjs")
  ).href;
  const checker = pathToFileURL(path.join(isolated, "check-deploy.mjs")).href;
  const guard = pathToFileURL(path.join(isolated, "deploy-guard.mjs")).href;
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const receiver = await import(${JSON.stringify(receiver)});
    const checker = await import(${JSON.stringify(checker)});
    const guard = await import(${JSON.stringify(guard)});
    if (receiver.parseCommand("deploy ${"a".repeat(40)} 1 1").runId !== "1") throw new Error("Invalid receiver export");
    guard.validateLoopback("http://127.0.0.1:3020/shutter");
    if (typeof checker.checkDeployment !== "function") throw new Error("Invalid checker export");
    console.log("standalone");
  `,
    ],
    { cwd: isolated, timeout: 10_000 }
  );
  assert.equal(stdout.trim(), "standalone");
});

test("bundled SSH and checker CLIs preserve their own success and failure exit codes", async (t) => {
  const isolated = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "shutter-cli-test-"))
  );
  t.after(() => fs.rm(isolated, { recursive: true, force: true }));
  const source = new URL("../trusted/", import.meta.url);
  for (const name of ["deploy-ssh.mjs", "check-deploy.mjs"])
    await fs.copyFile(new URL(name, source), path.join(isolated, name));
  const sha = "a".repeat(40);
  const preload = path.join(isolated, "offline.mjs");
  await fs.writeFile(
    preload,
    `
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const originalTimeout = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => originalTimeout(callback, 0, ...args);
childProcess.spawn = (command, args, options) => {
  if (command !== "/usr/bin/ssh" || args.at(-1) !== "deploy ${sha} 123 1")
    throw new Error("Unexpected offline SSH invocation");
  if (options.env.DEPLOY_SSH_KEY) throw new Error("Secret leaked to SSH environment");
  console.log("offline SSH invocation");
  const child = new EventEmitter();
  child.kill = () => true;
  queueMicrotask(() => child.emit("close", process.env.OFFLINE_SSH_FAIL ? 1 : 0, null));
  return child;
};
syncBuiltinESMExports();
globalThis.fetch = async (url) => {
  if (url === "https://example.com/shutter/api/health")
    return new Response(JSON.stringify({ status: "ok", exiftool: "13.59", revision: "${sha}" }));
  if (url === "https://example.com/shutter/")
    return new Response("<html></html>", { headers: { "content-type": "text/html" } });
  throw new Error("Unexpected offline health URL");
};
`
  );
  const algorithm = Buffer.from("ssh-ed25519");
  const algorithmLength = Buffer.alloc(4);
  algorithmLength.writeUInt32BE(algorithm.length);
  const keyLength = Buffer.alloc(4);
  keyLength.writeUInt32BE(32);
  const hostKey = Buffer.concat([
    algorithmLength,
    algorithm,
    keyLength,
    Buffer.alloc(32, 7),
  ]).toString("base64");
  const env = {
    TMPDIR: isolated,
    DEPLOY_HOST: "deploy.example.com",
    DEPLOY_SSH_KEY: `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.from("offline-fake-key").toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    DEPLOY_KNOWN_HOSTS: `deploy.example.com ssh-ed25519 ${hostKey}\n`,
    DEPLOY_PUBLIC_URL: "https://example.com/shutter",
    GITHUB_SHA: sha,
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  async function run(
    name: string,
    args: string[] = [],
    overrides: NodeJS.ProcessEnv = {}
  ) {
    try {
      const result = await execute(
        process.execPath,
        ["--import", preload, path.join(isolated, name), ...args],
        { cwd: isolated, env: { ...env, ...overrides }, timeout: 10_000 }
      );
      return { code: 0, ...result };
    } catch (error) {
      const failure = error as Error & {
        code: number;
        stdout: string;
        stderr: string;
      };
      assert.equal(typeof failure.code, "number", "child must exit normally");
      return failure;
    }
  }
  const success = await run("deploy-ssh.mjs");
  assert.equal(success.code, 0, success.stderr);
  assert.match(success.stdout, /Deployment verified:/);
  assert.equal(
    (success.stdout.match(/offline SSH invocation/g) ?? []).length,
    1
  );
  assert.doesNotMatch(success.stderr, /Usage:/);
  const sshFailure = await run("deploy-ssh.mjs", [], { OFFLINE_SSH_FAIL: "1" });
  assert.equal(sshFailure.code, 1);
  assert.match(sshFailure.stderr, /SSH deployment was not confirmed/);
  assert.doesNotMatch(sshFailure.stdout, /Deployment verified:/);
  const invalidChecker = await run("check-deploy.mjs");
  assert.equal(invalidChecker.code, 2);
  assert.match(invalidChecker.stderr, /Usage: node scripts\/check-deploy.mjs/);
  const healthyChecker = await run("check-deploy.mjs", [
    env.DEPLOY_PUBLIC_URL,
    sha,
  ]);
  assert.equal(healthyChecker.code, 0, healthyChecker.stderr);
  assert.match(healthyChecker.stdout, /requested revision verified/);
  const staleChecker = await run("check-deploy.mjs", [
    env.DEPLOY_PUBLIC_URL,
    "b".repeat(40),
  ]);
  assert.equal(staleChecker.code, 1);
  assert.match(staleChecker.stderr, /Running revision does not match/);
  assert.deepEqual((await fs.readdir(isolated)).sort(), [
    "check-deploy.mjs",
    "deploy-ssh.mjs",
    "offline.mjs",
  ]);
});
