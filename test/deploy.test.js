import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkDeployment } from "../scripts/check-deploy.mjs";

const script = fileURLToPath(new URL("../scripts/deploy-release.sh", import.meta.url));
const sha = "a".repeat(40);
const oldSha = "b".repeat(40);
const releaseId = `${sha}-123-1`;

function response(body, status = 200, type = "application/json") {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
}

test("deployment checker requires the exact revision, ExifTool and page", async () => {
  const calls = [];
  await checkDeployment("https://example.com/shutter/", sha, { attempts: 1, request: async url => {
    calls.push(url);
    return url.endsWith("/api/health") ? response({ status: "ok", exiftool: "13.34", revision: sha }) : response("<html>", 200, "text/html");
  } });
  assert.deepEqual(calls, ["https://example.com/shutter/api/health", "https://example.com/shutter/"]);
});

for (const [name, body, status] of [
  ["old healthy process", { status: "ok", exiftool: "13.34", revision: oldSha }, 200],
  ["failed parser", { status: "error", revision: sha }, 200],
  ["HTTP failure", { status: "ok", exiftool: "13.34", revision: sha }, 503],
]) {
  test(`deployment checker rejects ${name}`, async () => {
    await assert.rejects(checkDeployment("http://127.0.0.1:3020/shutter", sha, { attempts: 1, request: async () => response(body, status) }));
  });
}

test("deployment checker retries startup and supports a legacy rollback without revision", async () => {
  let calls = 0;
  await checkDeployment("http://127.0.0.1:3020/shutter", "-", { attempts: 2, delayMs: 0, request: async url => {
    if (++calls === 1) throw new Error("starting");
    return url.endsWith("/api/health") ? response({ status: "ok", exiftool: "13.34" }) : response("<html>", 200, "text/html");
  } });
  assert.equal(calls, 3);
});

test("deployment checker rejects credential-bearing URLs", async () => {
  await assert.rejects(checkDeployment("https://user:secret@example.com/shutter", sha));
});

async function fixture(t, extraEnv = {}) {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "shutter-deploy-test-"));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "app");
  const previous = path.join(root, "releases", "old");
  const source = path.join(temp, "source");
  const bin = path.join(temp, "bin");
  const trusted = path.join(temp, "trusted");
  await Promise.all([fsp.mkdir(previous, { recursive: true }), fsp.mkdir(path.join(source, "scripts"), { recursive: true }), fsp.mkdir(bin), fsp.mkdir(trusted)]);
  await fsp.symlink(previous, path.join(root, "current"));
  const env = { NODE_ENV: "production", PORT: 3020, HOST: "127.0.0.1", BASE_PATH: "/shutter" };
  const config = `module.exports = ${JSON.stringify({ apps: [{ name: "shutter-count", script: "bin/start.mjs", env }] })};`;
  await Promise.all([
    fsp.writeFile(path.join(source, "ecosystem.config.cjs"), config),
    fsp.writeFile(path.join(previous, "ecosystem.config.cjs"), config),
    fsp.writeFile(path.join(previous, "REVISION"), oldSha),
    fsp.writeFile(path.join(source, "package-lock.json"), "{}"),
    fsp.writeFile(path.join(source, "scripts", "check-deploy.mjs"), "// Candidate code is not the trusted health checker.\n"),
    fsp.copyFile(script, path.join(trusted, "deploy-release.sh")),
    fsp.writeFile(path.join(trusted, "check-deploy.mjs"), `
      import fs from 'node:fs';
      const expected = process.argv[3];
      const actual = fs.readFileSync(process.env.TEST_ROOT + '/current/REVISION', 'utf8').trim();
      if (process.env.HOLD_HEALTH === '1' && expected === '${sha}') {
        fs.writeFileSync(process.env.TEST_ROOT + '/health-started', '1');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (actual !== expected || (expected === process.env.FAIL_HEALTH_SHA) || (process.argv[2].startsWith('https:') && process.env.FAIL_PUBLIC === '1')) process.exit(1);
    `),
    fsp.writeFile(path.join(temp, "pm2.json"), JSON.stringify([{ name: "shutter-count", pm_id: 7, pm2_env: { ...env, pm_cwd: path.join(root, "current"), pm_exec_path: path.join(root, "current", "bin/start.mjs"), exec_interpreter: process.execPath, node_version: "22.0.0", status: "online" } }])),
    fsp.writeFile(path.join(bin, "git"), '#!/bin/sh\nprintf "%s\\trefs/heads/main\\n" "${TEST_MAIN_SHA:-' + sha + '}"\n', { mode: 0o755 }),
    fsp.writeFile(path.join(bin, "npm"), '#!/bin/sh\necho "npm $*" >> "$TEST_LOG"\n[ "$FAIL_NPM" != "1" ]\n', { mode: 0o755 }),
    fsp.writeFile(path.join(bin, "pm2"), '#!/bin/sh\nif [ "$1" = "jlist" ]; then cat "$TEST_PM2"; exit; fi\necho "pm2 $*" >> "$TEST_LOG"\ncase "$(readlink -f "$TEST_ROOT/current")" in *"$FAIL_RELOAD_ID"*) [ -z "$FAIL_RELOAD_ID" ];; *) exit 0;; esac\n', { mode: 0o755 }),
  ]);
  const log = path.join(temp, "commands.log");
  const args = [source, root, sha, releaseId, "http://127.0.0.1:3020/shutter", "https://example.com/shutter"];
  return { root, previous, source, log, args, script: path.join(trusted, "deploy-release.sh"), env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_ROOT: root, TEST_LOG: log, TEST_PM2: path.join(temp, "pm2.json"), ...extraEnv } };
}

async function run(f) {
  const child = spawn("bash", [f.script, ...f.args], { env: f.env });
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  return await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve({ code, output })); });
}

test("release activation changes only current and the named PM2 app", async t => {
  const f = await fixture(t);
  const result = await run(f);
  assert.equal(result.code, 0, result.output);
  assert.equal(await fsp.realpath(path.join(f.root, "current")), path.join(f.root, "releases", releaseId));
  assert.equal((await fsp.readFile(path.join(f.root, "current", "REVISION"), "utf8")).trim(), sha);
  const commands = await fsp.readFile(f.log, "utf8");
  assert.match(commands, /npm ci --omit=dev --no-audit --no-fund/);
  assert.match(commands, /npm test/);
  assert.match(commands, /pm2 restart 7/);
  assert.doesNotMatch(commands, /pm2 (save|delete|restart all)|nginx|sudo/);
  assert.ok(await fsp.stat(f.previous));
});

for (const [name, env] of [
  ["install failure", { FAIL_NPM: "1" }],
  ["PM2 reload failure", { FAIL_RELOAD_ID: releaseId }],
  ["local health failure", { FAIL_HEALTH_SHA: sha }],
  ["public health failure", { FAIL_PUBLIC: "1" }],
]) {
  test(`${name} preserves or restores the previous release`, async t => {
    const f = await fixture(t, env);
    const result = await run(f);
    assert.notEqual(result.code, 0, result.output);
    assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
    if (name !== "install failure") assert.match(result.output, /Previous release restored and healthy/);
  });
}

test("a mismatched PM2 checkout aborts before installing or switching", async t => {
  const f = await fixture(t);
  const info = JSON.parse(await fsp.readFile(f.env.TEST_PM2, "utf8"));
  info[0].pm2_env.pm_cwd = f.source;
  await fsp.writeFile(f.env.TEST_PM2, JSON.stringify(info));
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
  await assert.rejects(fsp.stat(f.log), { code: "ENOENT" });
});

test("unsafe release IDs and mismatched health URLs fail closed", async t => {
  for (const [index, value] of [[3, "../../other"], [4, "http://127.0.0.1:9999/shutter"], [4, "http://example.com/shutter"]]) {
    const f = await fixture(t);
    f.args[index] = value;
    assert.notEqual((await run(f)).code, 0);
    assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
    await assert.rejects(fsp.stat(f.log), { code: "ENOENT" });
  }
});

test("a physical PM2 entrypoint is rejected even if it resolves to the active release", async t => {
  const f = await fixture(t);
  const info = JSON.parse(await fsp.readFile(f.env.TEST_PM2, "utf8"));
  info[0].pm2_env.pm_exec_path = path.join(f.previous, "bin/start.mjs");
  await fsp.writeFile(f.env.TEST_PM2, JSON.stringify(info));
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /stable current/);
  assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
});

for (const disconnected of [false, true]) {
  test(`HUP after activation rolls back${disconnected ? " even with disconnected SSH output" : ""}`, async t => {
    const f = await fixture(t, { HOLD_HEALTH: "1" });
    const child = spawn("bash", [f.script, ...f.args], { env: f.env });
    child.stdout.resume();
    child.stderr.resume();
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal })); });
    let started = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (await fsp.stat(path.join(f.root, "health-started")).catch(() => null)) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    if (!started) { child.kill("SIGTERM"); await done; assert.fail("Deployment never reached the health check"); }
    if (disconnected) { child.stdout.destroy(); child.stderr.destroy(); }
    child.kill("SIGHUP");
    const result = await done;
    assert.equal(result.code, 129, JSON.stringify(result));
    assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
    assert.match(await fsp.readFile(path.join(f.root, `rollback-${releaseId}.log`), "utf8"), /Previous release restored and healthy/);
  });
}


test("main advancing during preparation refuses activation", async t => {
  const f = await fixture(t, { TEST_MAIN_SHA: oldSha });
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /main advanced/);
  assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
  assert.doesNotMatch(await fsp.readFile(f.log, "utf8"), /pm2 restart/);
});


test("a different PM2 interpreter aborts before installation", async t => {
  const f = await fixture(t);
  const info = JSON.parse(await fsp.readFile(f.env.TEST_PM2, "utf8"));
  info[0].pm2_env.exec_interpreter = "/different/node";
  await fsp.writeFile(f.env.TEST_PM2, JSON.stringify(info));
  const result = await run(f);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /interpreter differs/);
  assert.equal(await fsp.realpath(path.join(f.root, "current")), f.previous);
  await assert.rejects(fsp.stat(f.log), { code: "ENOENT" });
});
