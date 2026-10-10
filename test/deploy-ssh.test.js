import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSshArgs, deploySsh, parseKnownHosts, readDeployConfig, runSsh, safeErrorMessage } from "../scripts/deploy-ssh.mjs";

// Intentionally invalid cryptographic private-key material: tests never run SSH,
// use real credentials, scan host keys or contact a server.
const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.from("fake-private-key-offline-tests-only").toString("base64")}\n-----END OPENSSH PRIVATE KEY-----\n`;
const algorithm = "ssh-ed25519";
const length = Buffer.alloc(4);
length.writeUInt32BE(algorithm.length);
const publicKey = Buffer.concat([length, Buffer.from(algorithm), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7)]).toString("base64");
const hostLine = host => `${host} ${algorithm} ${publicKey}`;
const sha = "a".repeat(40);
const secret = "fake-secret-DO-NOT-LOG";
const env = Object.freeze({
  DEPLOY_HOST: "deploy.example.com",
  DEPLOY_SSH_KEY: privateKey,
  DEPLOY_KNOWN_HOSTS: `${hostLine("deploy.example.com")}\n`,
  DEPLOY_PUBLIC_URL: "https://example.com/shutter",
  GITHUB_SHA: sha,
  GITHUB_RUN_ID: "1234567890",
  GITHUB_RUN_ATTEMPT: "2",
});
const option = (args, flag) => args[args.indexOf(flag) + 1];
const sshOptions = args => args.flatMap((value, index) => value === "-o" ? [args[index + 1]] : []);

async function fixture(t, overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shutter-ssh-test-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const calls = [];
  const checks = [];
  const logs = [];
  const signals = new EventEmitter();
  const options = {
    temporaryRoot: root, signals, healthAttempts: 1, healthDelayMs: 0,
    log: message => logs.push(message),
    run: async (args, options) => { calls.push({ args, options }); },
    verify: async (...args) => { checks.push(args); },
    ...overrides,
  };
  return { root, calls, checks, logs, signals, options };
}

async function assertClean(f) {
  assert.deepEqual(await fsp.readdir(f.root), []);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "exit"]) assert.equal(f.signals.listenerCount(signal), 0, signal);
}

test("configuration is immutable, defaults port 22, and omits key material from enumeration", () => {
  const config = readDeployConfig(env);
  assert.ok(Object.isFrozen(config));
  assert.deepEqual({ ...config }, { host: env.DEPLOY_HOST, port: "22", commit: sha, runId: env.GITHUB_RUN_ID, runAttempt: "2", publicUrl: env.DEPLOY_PUBLIC_URL });
  assert.equal(config.privateKey, privateKey);
  assert.equal(config.knownHosts, env.DEPLOY_KNOWN_HOSTS);
  assert.ok(!JSON.stringify(config).includes(privateKey));
  assert.equal(readDeployConfig({ ...env, DEPLOY_HOST: "DEPLOY.EXAMPLE.COM" }).host, env.DEPLOY_HOST);
  assert.equal(readDeployConfig({ ...env, DEPLOY_PORT: "" }).port, "22");
});

test("canonical IPv4 and nondefault SSH ports use correctly bound known-hosts entries", () => {
  for (const host of ["127.0.0.1", "203.0.113.254", "host", "a-b.example.com"]) {
    for (const port of ["22", "2222", "65535"]) {
      const target = port === "22" ? host : `[${host}]:${port}`;
      const config = readDeployConfig({ ...env, DEPLOY_HOST: host, DEPLOY_PORT: port, DEPLOY_KNOWN_HOSTS: hostLine(target) });
      assert.equal(config.host, host);
      assert.equal(config.port, port);
    }
  }
});

test("verified multiline host key input supports aliases, comments, CRLF and hashed hosts", () => {
  const salt = Buffer.alloc(20, 4);
  const digest = createHmac("sha1", salt).update(env.DEPLOY_HOST).digest("base64");
  const hashed = `|1|${salt.toString("base64")}|${digest}`;
  for (const knownHosts of [
    `# independently verified host keys\r\n${hostLine("other.example.com")} comment\r\n${hostLine(env.DEPLOY_HOST)}\r\n`,
    `${hostLine(`alias.example.com,${env.DEPLOY_HOST}`)} verified fingerprint`,
    hostLine(hashed),
    hostLine(env.DEPLOY_HOST).replaceAll(" ", "\t"),
  ]) {
    const config = readDeployConfig({ ...env, DEPLOY_SSH_KEY: privateKey.replaceAll("\n", "\r\n"), DEPLOY_KNOWN_HOSTS: knownHosts });
    assert.equal(config.privateKey, privateKey);
    assert.ok(config.knownHosts.endsWith("\n"));
    assert.ok(!config.knownHosts.includes("\r"));
  }
  const target = `[${env.DEPLOY_HOST}]:2222`;
  const portDigest = createHmac("sha1", salt).update(target).digest("base64");
  assert.ok(parseKnownHosts(hostLine(`|1|${salt.toString("base64")}|${portDigest}`), env.DEPLOY_HOST, "2222"));
});

test("config rejects missing, mistyped, control-bearing or injection-bearing scalar settings before any dispatch", async t => {
  const f = await fixture(t);
  const scalars = ["DEPLOY_HOST", "DEPLOY_PUBLIC_URL", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"];
  const invalid = [];
  for (const name of scalars) {
    for (const value of [undefined, null, 1, "", ` ${env[name]}`, `${env[name]} `, `${env[name]}\n`, `${env[name]}\r`, `${env[name]}\t`, `${env[name]}\0`, `${env[name]}\x7f`, `${env[name]}\u2028`, `--${env[name]}`]) invalid.push([name, value]);
  }
  invalid.push(
    ["DEPLOY_HOST", "-oProxyCommand=evil"], ["DEPLOY_HOST", "host;whoami"], ["DEPLOY_HOST", "$(whoami)"],
    ["DEPLOY_HOST", "root@host"], ["DEPLOY_HOST", "[::1]"], ["DEPLOY_HOST", "::1"],
    ["DEPLOY_HOST", "a..com"], ["DEPLOY_HOST", ".example.com"], ["DEPLOY_HOST", "example.com."],
    ["DEPLOY_HOST", "under_score.example"], ["DEPLOY_HOST", "-host.com"], ["DEPLOY_HOST", "host-.com"],
    ["DEPLOY_HOST", "a".repeat(64) + ".com"], ["DEPLOY_HOST", "a.".repeat(127) + "a"],
    ["DEPLOY_HOST", "256.1.1.1"], ["DEPLOY_HOST", "01.2.3.4"], ["DEPLOY_HOST", "127.1"], ["DEPLOY_HOST", "2130706433"],
    ["GITHUB_SHA", "A".repeat(40)], ["GITHUB_SHA", "a".repeat(39)], ["GITHUB_SHA", "a".repeat(41)], ["GITHUB_SHA", `${sha};echo x`],
    ["GITHUB_RUN_ID", "0"], ["GITHUB_RUN_ID", "01"], ["GITHUB_RUN_ID", "+1"], ["GITHUB_RUN_ID", "-1"],
    ["GITHUB_RUN_ATTEMPT", "1.0"], ["GITHUB_RUN_ATTEMPT", "1e3"], ["GITHUB_RUN_ATTEMPT", "0"], ["GITHUB_RUN_ATTEMPT", "01"],
    ["GITHUB_RUN_ID", "9".repeat(21)], ["GITHUB_RUN_ATTEMPT", "9".repeat(21)],
    ["DEPLOY_PORT", " "], ["DEPLOY_PORT", "0"], ["DEPLOY_PORT", "022"], ["DEPLOY_PORT", "65536"], ["DEPLOY_PORT", "-1"],
    ["DEPLOY_PORT", "22\n"], ["DEPLOY_PORT", "22 -oStrictHostKeyChecking=no"], ["DEPLOY_PORT", 22],
    ["DEPLOY_PUBLIC_URL", "http://example.com/shutter"], ["DEPLOY_PUBLIC_URL", "https://user:password@example.com/shutter"],
    ["DEPLOY_PUBLIC_URL", "https://@example.com/shutter"], ["DEPLOY_PUBLIC_URL", "https://example.com/?secret=value"],
    ["DEPLOY_PUBLIC_URL", "https://example.com/#fragment"], ["DEPLOY_PUBLIC_URL", "https://example.com/../other"],
    ["DEPLOY_PUBLIC_URL", "https://example.com/./shutter"], ["DEPLOY_PUBLIC_URL", "https://example.com/%0a"],
    ["DEPLOY_PUBLIC_URL", "https://example.com\\@other.com"], ["DEPLOY_PUBLIC_URL", "https://example.com:65536"],
  );
  for (const [name, value] of invalid) {
    await assert.rejects(deploySsh({ ...env, [name]: value }, f.options), /Missing or invalid deployment setting/, `${name}: ${String(value)}`);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.checks.length, 0);
  await assertClean(f);
});

test("private-key validation accepts only OpenSSH framing and never echoes rejected material", async t => {
  const f = await fixture(t);
  for (const value of [undefined, null, 4, "", secret, privateKey + secret, privateKey.replace("OPENSSH", "RSA"), privateKey.replace("\n", "\0"), privateKey.replace("\n", "\r"), privateKey.replace("\n", "\n-oProxyCommand=evil\n"), privateKey.replace("\n", `\n${"a".repeat(64 * 1024)}\n`)]) {
    await assert.rejects(deploySsh({ ...env, DEPLOY_SSH_KEY: value }, f.options), error => {
      assert.equal(safeErrorMessage(error), "Missing or invalid deployment setting: DEPLOY_SSH_KEY");
      assert.ok(!error.stack.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(f.calls.length, 0);
  await assertClean(f);
});

test("missing, unrelated, malformed or permissive host pins fail closed", async t => {
  const f = await fixture(t);
  const invalid = [undefined, null, 2, "", "\n# comments alone\n", secret,
    hostLine("other.example.com"), hostLine(`[${env.DEPLOY_HOST}]:2222`), hostLine("*.example.com"),
    hostLine(`!${env.DEPLOY_HOST}`), hostLine(`-oProxyCommand=evil,${env.DEPLOY_HOST}`),
    `@cert-authority ${hostLine(env.DEPLOY_HOST)}`, `@revoked ${hostLine(env.DEPLOY_HOST)}`,
    hostLine(env.DEPLOY_HOST).replace(algorithm, "ssh-unknown"), `${env.DEPLOY_HOST} ${algorithm} !!!!`,
    `${env.DEPLOY_HOST} ${algorithm} AAAA`, `${env.DEPLOY_HOST} ssh-rsa ${publicKey}`,
    hostLine("|1|bad|bad"), hostLine(`|2|${Buffer.alloc(20).toString("base64")}|${Buffer.alloc(20).toString("base64")}`),
    hostLine(`|1|${Buffer.alloc(20).toString("base64")}|${Buffer.alloc(20).toString("base64")}`),
    `${hostLine(env.DEPLOY_HOST)}\n-oStrictHostKeyChecking=no`, `${hostLine(env.DEPLOY_HOST)}\0`,
    `${hostLine(env.DEPLOY_HOST)}\r`, `${hostLine(env.DEPLOY_HOST)}\n${"#".repeat(128 * 1024)}`,
  ];
  for (const value of invalid) await assert.rejects(deploySsh({ ...env, DEPLOY_KNOWN_HOSTS: value }, f.options), /Missing or invalid deployment setting: DEPLOY_KNOWN_HOSTS/);
  assert.equal(f.calls.length, 0);
  await assertClean(f);
});

test("SSH argv fixes identity, command, host pins, no shell/config/agent/forwarding/stdin", () => {
  const args = buildSshArgs(readDeployConfig(env), { keyPath: "/tmp/test dir/identity", knownHostsPath: "/tmp/test dir/known_hosts" });
  assert.deepEqual(args.slice(0, 2), ["-F", "/dev/null"]);
  assert.equal(option(args, "-i"), "/tmp/test dir/identity");
  assert.equal(option(args, "-p"), "22");
  assert.equal(option(args, "-l"), "shutter-deploy");
  assert.deepEqual(args.slice(-3), ["--", env.DEPLOY_HOST, `deploy ${sha} ${env.GITHUB_RUN_ID} 2`]);
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("-T"));
  const options = sshOptions(args);
  for (const setting of ["BatchMode=yes", "IdentitiesOnly=yes", "IdentityAgent=none", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "PreferredAuthentications=publickey", "StrictHostKeyChecking=yes", 'UserKnownHostsFile="/tmp/test dir/known_hosts"', "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "ControlMaster=no", "ControlPath=none", "ClearAllForwardings=yes", "ForwardAgent=no", "ForwardX11=no", "PermitLocalCommand=no", "ConnectionAttempts=1"]) assert.ok(options.includes(setting), setting);
  assert.ok(!args.some(arg => /ssh-keyscan|scp|rsync|tar|bash|sudo/.test(arg)));
  assert.ok(!JSON.stringify(args).includes(privateKey));
});

test("SSH temporary file paths reject option/config expansion and control injection", () => {
  for (const key of ["keyPath", "knownHostsPath"]) {
    for (const value of ["relative", "--evil", "/tmp/evil\n-oProxyCommand=evil", "/tmp/%h", '/tmp/quote"', "/tmp/back\\slash", undefined]) {
      assert.throws(() => buildSshArgs(readDeployConfig(env), { keyPath: "/tmp/identity", knownHostsPath: "/tmp/known_hosts", [key]: value }), /Invalid SSH temporary-file path/);
    }
  }
});

test("transport runs once, creates restrictive files, restores umask, cleans before exact-revision verification", async t => {
  const mask = process.umask();
  const f = await fixture(t);
  f.options.run = async (args, options) => {
    f.calls.push({ args, options });
    const keyPath = option(args, "-i");
    const dir = path.dirname(keyPath);
    assert.equal((await fsp.stat(dir)).mode & 0o777, 0o700);
    for (const [name, text] of [["identity", privateKey], ["known_hosts", env.DEPLOY_KNOWN_HOSTS]]) {
      assert.equal((await fsp.stat(path.join(dir, name))).mode & 0o777, 0o600);
      assert.equal(await fsp.readFile(path.join(dir, name), "utf8"), text);
    }
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.timeoutMs, 20 * 60 * 1000);
    assert.equal(process.umask(), mask);
    return { stdout: secret, stderr: secret };
  };
  f.options.verify = async (...args) => {
    f.checks.push(args);
    assert.deepEqual(await fsp.readdir(f.root), []);
  };
  assert.deepEqual(await deploySsh(env, f.options), { commit: sha, status: "Success" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.checks.length, 1);
  assert.deepEqual(f.checks[0].slice(0, 2), [env.DEPLOY_PUBLIC_URL, sha]);
  assert.equal(f.checks[0][2].attempts, 1);
  assert.equal(process.umask(), mask);
  assert.ok(!f.logs.join("\n").includes(secret));
  assert.ok(!f.logs.join("\n").includes(privateKey));
  await assertClean(f);
});

test("uncertain or failed SSH is never retried, verified, rolled back, or allowed to leak output", async t => {
  for (const error of [new Error(secret), Object.assign(new Error(secret), { stdout: privateKey, stderr: secret, code: 255 })]) {
    const f = await fixture(t);
    f.options.run = async (...args) => { f.calls.push(args); throw error; };
    await assert.rejects(deploySsh(env, f.options), result => {
      assert.match(safeErrorMessage(result), /not confirmed and was not retried/);
      assert.match(safeErrorMessage(result), /receive-failures\.log/);
      assert.ok(!result.stack.includes(secret));
      assert.ok(!result.stack.includes(privateKey));
      assert.equal(result.cause, undefined);
      return true;
    });
    assert.equal(f.calls.length, 1);
    assert.equal(f.checks.length, 0);
    assert.deepEqual(f.logs, []);
    await assertClean(f);
  }
});

test("public verification retries reads with exact revision, never repeats SSH or dispatches rollback", async t => {
  const f = await fixture(t, { healthAttempts: 3 });
  f.options.verify = async (...args) => {
    f.checks.push(args);
    if (f.checks.length < 3) throw new Error(secret);
  };
  await deploySsh(env, f.options);
  assert.equal(f.calls.length, 1);
  assert.equal(f.checks.length, 3);
  for (const args of f.checks) assert.deepEqual(args.slice(0, 2), [env.DEPLOY_PUBLIC_URL, sha]);
  assert.ok(!f.logs.join("\n").includes(secret));
  await assertClean(f);
});

test("exhausted public verification fails safely with no racing remote action", async t => {
  const f = await fixture(t, { healthAttempts: 2 });
  f.options.verify = async (...args) => { f.checks.push(args); throw new Error(secret); };
  await assert.rejects(deploySsh(env, f.options), error => {
    assert.match(safeErrorMessage(error), /exact commit revision could not be verified/);
    assert.match(safeErrorMessage(error), /No additional remote command/);
    assert.ok(!error.stack.includes(secret));
    return true;
  });
  assert.equal(f.calls.length, 1);
  assert.equal(f.checks.length, 2);
  await assertClean(f);
});

test("existing checker sees exact public URL/revision, preserves fetch safeguards and rejects stale revisions", async t => {
  for (const revision of [sha, "b".repeat(40)]) {
    const requested = [];
    const f = await fixture(t, { verify: undefined, request: async (url, options) => {
      requested.push({ url, options });
      if (url.endsWith("/api/health")) return Response.json({ status: "ok", exiftool: "13.34", revision });
      return new Response("<html>", { headers: { "content-type": "text/html" } });
    } });
    if (revision === sha) await deploySsh(env, f.options);
    else await assert.rejects(deploySsh(env, f.options), /exact commit revision could not be verified/);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(requested.map(item => item.url), revision === sha ? [`${env.DEPLOY_PUBLIC_URL}/api/health`, `${env.DEPLOY_PUBLIC_URL}/`] : [`${env.DEPLOY_PUBLIC_URL}/api/health`]);
    for (const { options } of requested) {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
    }
    await assertClean(f);
  }
});

test("system OpenSSH executes without a shell, stdin, output, inherited secrets or agent environment", async () => {
  let calls = 0;
  const signal = new AbortController().signal;
  const args = buildSshArgs(readDeployConfig(env), { keyPath: "/tmp/identity", knownHostsPath: "/tmp/known_hosts" });
  await runSsh(args, { signal, timeoutMs: 1234, spawnProcess: (file, actualArgs, options) => {
    calls++;
    assert.equal(file, "/usr/bin/ssh");
    assert.equal(actualArgs, args);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, "ignore");
    assert.deepEqual(options.env, { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });
    assert.equal(options.env.DEPLOY_SSH_KEY, undefined);
    assert.equal(options.env.SSH_AUTH_SOCK, undefined);
    assert.equal(options.env.SSH_ASKPASS, undefined);
    assert.equal(options.signal, signal);
    assert.equal(options.timeout, 1234);
    assert.equal(options.killSignal, "SIGKILL");
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  } });
  assert.equal(calls, 1);
});

test("SSH spawn throws, error events, nonzero/unknown exits and killed children are redacted and never retried", async () => {
  for (const result of ["throw", "error", 255, 1, null, "0", "SIGTERM"]) {
    let calls = 0;
    await assert.rejects(runSsh([], { spawnProcess: () => {
      calls++;
      if (result === "throw") throw new Error(secret);
      const child = new EventEmitter();
      queueMicrotask(() => {
        if (result === "error") { child.emit("error", Object.assign(new Error(secret), { stderr: privateKey })); child.emit("close", 0, null); }
        else child.emit("close", result === "SIGTERM" ? 0 : result, result === "SIGTERM" ? "SIGTERM" : null);
      });
      return child;
    } }), error => {
      assert.match(safeErrorMessage(error), /not retried/);
      assert.ok(!error.stack.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(calls, 1);
  }
  assert.ok(!safeErrorMessage(new Error(privateKey)).includes(privateKey));
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  test(`${signal} during SSH aborts, cleans secrets, restores listeners and never re-dispatches`, async t => {
    const f = await fixture(t);
    let receivedSignal;
    f.options.run = (args, { signal: cancellation }) => {
      f.calls.push(args);
      receivedSignal = cancellation;
      queueMicrotask(() => f.signals.emit(signal));
      return new Promise(() => {});
    };
    await assert.rejects(deploySsh(env, f.options), error => {
      assert.equal(error.exitCode, exitCode);
      assert.match(safeErrorMessage(error), new RegExp(`interrupted by ${signal}`));
      return true;
    });
    assert.equal(receivedSignal.aborted, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.checks.length, 0);
    await assertClean(f);
  });
}

test("cancellation during public health aborts fetch, exits promptly and never invokes SSH again", async t => {
  const f = await fixture(t, { verify: undefined, healthAttempts: 15, healthDelayMs: 60000 });
  let receivedSignal;
  f.options.request = (url, { signal }) => {
    receivedSignal = signal;
    queueMicrotask(() => f.signals.emit("SIGTERM"));
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(new Error(secret)), { once: true }));
  };
  await assert.rejects(deploySsh(env, f.options), /interrupted by SIGTERM/);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(f.calls.length, 1);
  await assertClean(f);
});

test("cancellation during a public retry delay cancels the timer and further verification", async t => {
  const f = await fixture(t, { healthAttempts: 15, healthDelayMs: 60000 });
  f.options.verify = async (...args) => {
    f.checks.push(args);
    setImmediate(() => f.signals.emit("SIGHUP"));
    throw new Error(secret);
  };
  await assert.rejects(deploySsh(env, f.options), /interrupted by SIGHUP/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.checks.length, 1);
  await assertClean(f);
});

test("process exit cleanup removes pending secret files and preserves unrelated signal listeners", async t => {
  const f = await fixture(t);
  const unrelated = () => {};
  f.signals.on("SIGTERM", unrelated);
  f.options.run = async (...args) => {
    f.calls.push(args);
    assert.equal((await fsp.readdir(f.root)).length, 1);
    f.signals.emit("exit", 1);
    assert.deepEqual(await fsp.readdir(f.root), []);
    throw new Error(secret);
  };
  await assert.rejects(deploySsh(env, f.options), /not confirmed/);
  assert.deepEqual(f.signals.listeners("SIGTERM"), [unrelated]);
  f.signals.removeListener("SIGTERM", unrelated);
  await assertClean(f);
});

test("temporary-file creation failure is redacted and leaves no listeners or umask change", async t => {
  const f = await fixture(t);
  const originalMask = process.umask();
  f.options.temporaryRoot = path.join(f.root, secret, "missing");
  await assert.rejects(deploySsh(env, f.options), error => {
    assert.ok(!error.stack.includes(secret));
    assert.match(safeErrorMessage(error), /withheld/);
    return true;
  });
  assert.equal(process.umask(), originalMask);
  assert.equal(f.calls.length, 0);
  await assertClean(f);
});

test("invalid timing configuration fails before temporary files or SSH", async t => {
  const f = await fixture(t);
  for (const [name, value] of [["timeoutMs", 0], ["timeoutMs", -1], ["timeoutMs", NaN], ["healthAttempts", 0], ["healthAttempts", 1.5], ["healthDelayMs", -1]]) {
    await assert.rejects(deploySsh(env, { ...f.options, [name]: value }), /Invalid deployment timing configuration/);
  }
  await assert.rejects(runSsh([], { timeoutMs: 0, spawnProcess: () => assert.fail("must not spawn") }), /Invalid SSH timeout/);
  assert.equal(f.calls.length, 0);
  await assertClean(f);
});

test("CLI rejects invalid configuration without exposing a supplied fake secret", async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/deploy-ssh.mjs", import.meta.url))], { env: { ...env, DEPLOY_HOST: secret + ";echo x" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 1);
  assert.match(output, /Missing or invalid deployment setting: DEPLOY_HOST/);
  assert.ok(!output.includes(secret));
  assert.ok(!output.includes(privateKey));
});
