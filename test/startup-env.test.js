import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const serverUrl = new URL("../src/server.js", import.meta.url).href;

test("PM2_HOME inherited by deployment tests does not start a server on import", async () => {
  const env = {
    ...process.env,
    PM2_HOME: "/tmp/shutter-import-test-not-a-pm2-process",
    HOST: "127.0.0.1",
    // A regression can only bind an ephemeral loopback port, never production.
    PORT: "0",
  };
  delete env.pm_id;
  delete env.SHUTTER_FORCE_LISTEN;
  delete env.SHUTTER_NO_LISTEN;
  const { stdout, stderr } = await execute(process.execPath, [
    "--input-type=module", "-e",
    `await import(${JSON.stringify(serverUrl)}); console.log("IMPORT_COMPLETED");`,
  ], { env, timeout: 15000, maxBuffer: 64 * 1024, killSignal: "SIGTERM" });
  assert.equal(stdout.trim(), "IMPORT_COMPLETED");
  assert.equal(stderr, "");
});
