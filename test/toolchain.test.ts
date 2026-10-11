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
