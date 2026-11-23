import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { isRecord } from "../shared/protocol.js";
import { GUIDE } from "../web/guide.js";

const execute = promisify(execFile);
const root = process.cwd();
const revision = (
  await fs.readFile(path.join(root, "REVISION"), "utf8")
).trim();
assert.match(revision, /^[a-f0-9]{40}$/);
assert.equal(
  (await fs.readFile(path.join(root, "dist/REVISION"), "utf8")).trim(),
  revision,
  "The build must copy the source revision"
);
const isolated = await fs.mkdtemp(
  path.join(os.tmpdir(), "shutter-production-")
);
let child: ChildProcess | undefined;

function jpegSize(bytes: Buffer) {
  let offset = 2;
  while (offset + 8 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1] ?? 0;
    const length = bytes.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("JPEG has no size marker");
}

function waitForExit(process: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Shutdown timed out")),
      20_000
    );
    process.once("exit", (code, signal) => {
      clearTimeout(timer);
      try {
        assert.equal(code, 0);
        assert.equal(signal, null);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

try {
  await fs.cp(path.join(root, "dist"), path.join(isolated, "dist"), {
    recursive: true,
  });
  await fs.mkdir(path.join(isolated, "bin"));
  for (const name of ["package.json", "package-lock.json", "bin/start.mjs"])
    await fs.copyFile(path.join(root, name), path.join(isolated, name));
  await execute("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], {
    cwd: isolated,
    timeout: 120_000,
    maxBuffer: 262144,
  });
  for (const name of [
    "tsx",
    "typescript",
    "vite",
    "prettier",
    "playwright-core",
    "esbuild",
  ])
    await assert.rejects(fs.stat(path.join(isolated, "node_modules", name)), {
      code: "ENOENT",
    });
  const running = spawn(process.execPath, ["bin/start.mjs"], {
    cwd: isolated,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: "0",
      BASE_PATH: "/preview/shutter",
      MAX_UPLOAD_MB: "2.5",
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = running;
  running.stderr.resume();
  const address = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Startup timed out"));
    }, 20_000);
    const fail = () => {
      cleanup();
      reject(new Error("Production process failed before listening"));
    };
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
      const match = /Server listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(
        output
      );
      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      running.off("error", fail);
      running.off("exit", fail);
      running.stdout.off("data", read);
      running.stdout.resume();
    };
    running.once("error", fail);
    running.once("exit", fail);
    running.stdout.on("data", read);
  });
  const base = address + "/preview/shutter";
  const request = (url: string, options: RequestInit = {}) =>
    fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const health = await request(base + "/api/health");
  assert.equal(health.status, 200);
  const healthBody: unknown = await health.json();
  assert.ok(isRecord(healthBody));
  assert.equal(healthBody.revision, revision);
  assert.equal(healthBody.status, "ok");
  const page = await request(base + "/");
  assert.equal(page.status, 200);
  const chinese = await page.text();
  assert.match(chinese, /<html lang="zh-CN"/);
  assert.match(chinese, /查看相机快门次数/);
  const english = await request(base + "/en/");
  assert.equal(english.status, 200);
  const englishHtml = await english.text();
  assert.match(englishHtml, /<html lang="en"/);
  assert.match(englishHtml, /Check your camera shutter count/);
  assert.match(englishHtml, /\/preview\/shutter\/app\.js/);
  assert.match(englishHtml, /\/preview\/shutter\/styles\.css/);
  assert.match(englishHtml, /\/preview\/shutter\/favicon\.svg/);
  assert.match(chinese, /\/preview\/shutter\/app\.js/);
  assert.doesNotMatch(englishHtml, /(?:src|href)="(?:\.\/|\.\.\/)/);
  assert.doesNotMatch(chinese, /(?:src|href)="(?:\.\/|\.\.\/)/);
  assert.doesNotMatch(englishHtml, /__SC_(?:MOUNT|CANONICAL|ZH|EN|SWITCH)__/);
  for (const [asset, type] of [
    ["app.js", /javascript/],
    ["styles.css", /text\/css/],
    ["favicon.svg", /svg/],
    [GUIDE.zh.file, /image\/jpeg/],
    [GUIDE.en.file, /image\/jpeg/],
  ] as const) {
    const response = await request(base + "/" + asset);
    assert.equal(response.status, 200, asset);
    assert.match(response.headers.get("content-type") ?? "", type, asset);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (asset === "app.js") {
      assert.match(bytes.toString("utf8"), /iphone-export-original\.jpg/);
      assert.match(bytes.toString("utf8"), /iphone-export-original-en\.jpg/);
    }
    const spec = [GUIDE.zh, GUIDE.en].find((item) => item.file === asset);
    if (spec) {
      const file = await fs.readFile(path.join(root, "public", spec.file));
      assert.deepEqual(bytes, file);
      assert.deepEqual(jpegSize(bytes), {
        width: spec.width,
        height: spec.height,
      });
      const nested = await request(base + "/en/" + spec.file);
      assert.equal(nested.status, 404, spec.file);
    }
  }
  const config: unknown = await (await request(base + "/api/config")).json();
  assert.ok(isRecord(config));
  assert.equal(config.maxUploadBytes, 2.5 * 1048576);
  const payload = new FormData();
  payload.append(
    "file",
    new Blob(
      [await fs.readFile(path.join(root, "test/fixtures/NikonD70.jpg"))],
      { type: "image/jpeg" }
    ),
    "camera.jpg"
  );
  const response = await request(base + "/api/parse", {
    method: "POST",
    body: payload,
  });
  assert.equal(response.status, 200);
  const result: unknown = await response.json();
  assert.ok(isRecord(result));
  assert.equal(result.shutterCount, 526);
  const ended = waitForExit(running);
  running.kill("SIGTERM");
  await ended;
  console.log(
    "Production-only installation passed: stable bootstrap, copied revision, assets, effective settings, Nikon 526 and graceful shutdown"
  );
} finally {
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // The process group may already have exited.
    }
  }
  await fs.rm(isolated, { recursive: true, force: true });
}
