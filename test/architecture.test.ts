import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readConfig, parseTrustProxy } from "../src/config.js";
import { Admission } from "../src/photo/admission.js";
import { buildApp } from "../src/app.js";
import { createParser } from "../src/parse.js";
import {
  decodeParseResult,
  decodeParseResponse,
  decodeUploadSettings,
} from "../shared/protocol.js";

const validResult = {
  status: "ok",
  fileName: "camera.jpg",
  make: "NIKON",
  model: "D70",
  capturedAt: null,
  note: null,
  shutterCount: 526,
  shutterSource: "Nikon:ShutterCount",
  approximate: false,
} as const;
const fixture = new URL("./fixtures/NikonD70.jpg", import.meta.url);

test("invalid configuration fails before starting workers or listening", () => {
  for (const PORT of ["", "NaN", "-1", "65536", "1.5"])
    assert.throws(() => readConfig({}, { PORT }), /PORT/);
  for (const MAX_UPLOAD_MB of ["", "0", "-1", "Infinity", "abc", "1e30"])
    assert.throws(() => readConfig({}, { MAX_UPLOAD_MB }), /MAX_UPLOAD_MB/);
  for (const BASE_PATH of [
    "/a/../b",
    "/a?b",
    "/a#b",
    "/a%2fb",
    "/a\\b",
    "/a b",
  ])
    assert.throws(() => readConfig({}, { BASE_PATH }), /BASE_PATH/);
  for (const proxy of ["anything", "127.0.0.1/33", "::1/129", "127.0.0.1/no"])
    assert.throws(() => parseTrustProxy(proxy), /TRUST_PROXY/);
  assert.equal(
    readConfig({ port: 0, basePath: "/", maxUploadMb: 0.001 }, {})
      .maxUploadBytes,
    1049
  );
  assert.equal(readConfig({ basePath: "custom/" }, {}).basePath, "/custom");
});

test("the shared decoder rejects malformed counts and strips undocumented fields", () => {
  for (const shutterCount of [
    0,
    -1,
    0.5,
    5_000_001,
    Infinity,
    NaN,
    "526",
    {},
    null,
  ]) {
    assert.equal(decodeParseResult({ ...validResult, shutterCount }), null);
  }
  assert.deepEqual(
    decodeParseResult({
      ...validResult,
      GPS: "private",
      rawExif: { serial: "private" },
    }),
    validResult
  );
  assert.equal(decodeParseResult({ ...validResult, model: {} }), null);
  assert.equal(
    decodeParseResponse({ ...validResult, requestId: "client ID" }),
    null
  );
  assert.equal(
    decodeUploadSettings({ maxUploadMb: 1, maxUploadBytes: 50 * 1048576 }),
    null
  );
});

test("admission bounds active and queued uploads and releases exactly once", async () => {
  const admission = new Admission(1, 1, 1000);
  const first = await admission.acquire();
  const queued = admission.acquire();
  await assert.rejects(admission.acquire(), { code: "parser_queue_full" });
  first();
  first();
  const second = await queued;
  second();
  const third = await admission.acquire();
  third();
  admission.close();
  await assert.rejects(admission.acquire(), { code: "parser_closed" });
});

test("queued admission times out, cancels and closes without occupying a slot", async () => {
  const admission = new Admission(1, 1, 20);
  const first = await admission.acquire();
  await assert.rejects(admission.acquire(), { code: "parser_queue_timeout" });
  const controller = new AbortController();
  const cancelled = admission.acquire(controller.signal);
  controller.abort();
  await assert.rejects(cancelled, { code: "parser_closed" });
  const queued = admission.acquire();
  admission.close();
  await assert.rejects(queued, { code: "parser_closed" });
  first();
});

test("the effective upload limit is published under a custom mount", async (t) => {
  const app = buildApp({ basePath: "/custom", maxUploadMb: 2.5 });
  t.after(() => app.close());
  const response = await app.inject("/custom/api/config");
  assert.equal(response.statusCode, 200);
  assert.deepEqual(decodeUploadSettings(response.json()), {
    maxUploadMb: 2.5,
    maxUploadBytes: 2.5 * 1048576,
  });
});

test("saturated uploads return 503 before creating temporary files and recover after cleanup", async (t) => {
  const tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "shutter-capacity-test-")
  );
  let parsed!: () => void;
  const started = new Promise<void>((resolve) => {
    parsed = resolve;
  });
  let complete!: (value: unknown) => void;
  const pendingParse = new Promise<unknown>((resolve) => {
    complete = resolve;
  });
  const app = buildApp({
    tmpRoot,
    maxActiveUploads: 1,
    maxWaitingUploads: 0,
    parseFile: async () => {
      parsed();
      return pendingParse;
    },
  });
  t.after(async () => {
    complete(validResult);
    await app.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
  const photo = await fs.readFile(fixture);
  const payload = Buffer.concat([
    Buffer.from(
      '--test\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
    ),
    photo,
    Buffer.from("\r\n--test--\r\n"),
  ]);
  const upload = () =>
    app.inject({
      method: "POST",
      url: "/shutter/api/parse",
      headers: { "content-type": "multipart/form-data; boundary=test" },
      payload,
    });
  const first = Promise.resolve(upload());
  await started;
  const busy = await upload();
  assert.equal(busy.statusCode, 503);
  assert.equal(busy.json().reason, "busy");
  assert.equal((await fs.readdir(tmpRoot)).length, 1);
  complete({ ...validResult, rawExif: "private" });
  const result = await first;
  assert.equal(result.statusCode, 200);
  assert.ok(!result.body.includes("private"));
  assert.deepEqual(await fs.readdir(tmpRoot), []);
  assert.equal((await upload()).statusCode, 200);
});

test("malformed parser results become safe errors and are cleaned up", async (t) => {
  const app = buildApp({
    parseFile: async () => ({
      ...validResult,
      shutterCount: "526",
      rawExif: "private",
    }),
  });
  t.after(() => app.close());
  const photo = await fs.readFile(fixture);
  const body = Buffer.concat([
    Buffer.from(
      '--test\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\n'
    ),
    photo,
    Buffer.from("\r\n--test--\r\n"),
  ]);
  const result = await app.inject({
    method: "POST",
    url: "/shutter/api/parse",
    headers: { "content-type": "multipart/form-data; boundary=test" },
    payload: body,
  });
  assert.equal(result.statusCode, 500);
  assert.ok(!result.body.includes("private"));
});

test("closing one application does not close another application's ExifTool pool", async (t) => {
  const first = buildApp();
  const second = buildApp();
  t.after(async () => {
    await first.close();
    await second.close();
  });
  assert.equal((await first.inject("/shutter/api/health")).statusCode, 200);
  assert.equal((await second.inject("/shutter/api/health")).statusCode, 200);
  await first.close();
  assert.equal((await second.inject("/shutter/api/health")).statusCode, 200);
  const parser = createParser();
  await parser.close();
  await assert.rejects(parser.version(), /closed/);
});
