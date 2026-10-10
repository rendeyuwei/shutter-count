import type { TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import type { Response as InjectResponse } from "light-my-request";
import type { AppOptions } from "../src/app.js";
import type { ParseDiagnostic } from "../src/diagnostics.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.js";
import { parseFile } from "../src/parse.js";
import { summarizeMapping } from "../src/mapping.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BOUNDARY = "diagnostics-test-boundary";
const nikon = await fsp.readFile(
  new URL("./fixtures/NikonD70.jpg", import.meta.url)
);
const canon = await fsp.readFile(
  new URL("./fixtures/Canon.jpg", import.meta.url)
);
const SECRET = "private-photo-GPS-51.5007-serial-12345";

function upload({
  filename = "sample.jpg",
  field = "file",
  content = nikon,
} = {}) {
  return Buffer.concat([
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: image/jpeg\r\n\r\n`
    ),
    content,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
  ]);
}

async function makeApp(t: TestContext, options: AppOptions = {}) {
  const logs: (Record<string, unknown> & {
    durationMs: number;
    mapping?: ReturnType<typeof summarizeMapping>;
  })[] = [];
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "sc-diagnostics-"));
  const app = buildApp({
    tmpRoot,
    logger: {
      level: "info",
      stream: {
        write(line) {
          logs.push(JSON.parse(line));
        },
      },
    },
    ...options,
  });
  t.after(async () => {
    await app.close();
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });
  await app.ready();
  return { app, logs, tmpRoot };
}

function post(
  app: FastifyInstance,
  payload: Buffer | string = upload(),
  extraHeaders: Record<string, string> = {}
) {
  return app.inject({
    method: "POST",
    url: "/shutter/api/parse",
    headers: {
      "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
      ...extraHeaders,
    },
    payload,
  });
}

function resultLog(
  res: InjectResponse,
  logs: Awaited<ReturnType<typeof makeApp>>["logs"],
  expected: Record<string, unknown>
) {
  assert.match(res.json().requestId, UUID);
  assert.equal(res.headers["x-request-id"], res.json().requestId);
  const matched = logs.filter(
    (entry) =>
      entry.event === "parse_result" && entry.requestId === res.json().requestId
  );
  assert.equal(matched.length, 1, "exactly one parse result per request");
  const log = matched[0];
  assert.ok(log);
  assert.equal(log.status, res.json().status);
  assert.equal(log.httpCode, res.statusCode);
  assert.ok(Number.isFinite(log.durationMs) && log.durationMs >= 0);
  for (const [key, value] of Object.entries(expected))
    assert.equal(log[key], value);
  return log;
}

test("success request IDs correlate and cannot be supplied by a client or reused", async (t) => {
  const { app, logs } = await makeApp(t);
  const supplied = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const a = await post(app, upload(), { "x-request-id": supplied });
  const b = await post(app);
  assert.equal(a.statusCode, 200);
  resultLog(a, logs, {
    diagnosticCode: "parse_ok",
    stage: "complete",
    level: 30,
  });
  resultLog(b, logs, { diagnosticCode: "parse_ok", stage: "complete" });
  assert.notEqual(a.json().requestId, supplied);
  assert.notEqual(a.json().requestId, b.json().requestId);
  assert.equal(
    logs.filter((entry) => entry.msg === "incoming request").length,
    0
  );
});

test("missing shutter field logs safe mapping facts, not camera metadata", async (t) => {
  const { app, logs } = await makeApp(t);
  const res = await post(
    app,
    upload({ content: canon, filename: SECRET + ".jpg" })
  );
  assert.equal(res.json().status, "no_shutter_field");
  const log = resultLog(res, logs, {
    diagnosticCode: "no_shutter_field",
    stage: "mapping",
    level: 40,
  });
  assert.equal(log.mapping!.brand, "canon");
  assert.equal(log.mapping!.presentCandidateCount, 0);
  assert.equal(log.mapping!.candidateCount, 2);
  assert.equal(log.mapping!.hasExif, true);
  const serialized = JSON.stringify(logs);
  for (const forbidden of [
    SECRET,
    res.json().model,
    res.json().capturedAt,
    "fileName",
    "SourceFile",
    "GPS",
    "SerialNumber",
  ]) {
    assert.ok(
      !serialized.includes(forbidden),
      `logs must exclude ${forbidden}`
    );
  }
});

test("upload validation failures all have correlatable, distinct reason codes", async (t) => {
  const { app, logs, tmpRoot } = await makeApp(t);
  const cases = [
    [Buffer.from(`--${BOUNDARY}--\r\n`), 400, "upload_missing_file", "upload"],
    [upload({ field: "wrong" }), 400, "upload_invalid_field", "upload"],
    [
      upload({ filename: "test.png" }),
      422,
      "upload_invalid_extension",
      "validation",
    ],
    [
      upload({ content: Buffer.from("not a JPEG") }),
      422,
      "upload_invalid_magic",
      "validation",
    ],
  ] as const;
  for (const [payload, code, diagnosticCode, stage] of cases) {
    const res = await post(app, payload);
    assert.equal(res.statusCode, code);
    resultLog(res, logs, { diagnosticCode, stage });
  }
  assert.deepEqual(
    await fsp.readdir(tmpRoot),
    [],
    "uploads removed before response"
  );
});

test("oversized upload is logged with its response ID and cleaned up", async (t) => {
  const { app, logs, tmpRoot } = await makeApp(t, { maxUploadMb: 0.001 });
  const res = await post(app);
  assert.equal(res.statusCode, 413);
  resultLog(res, logs, { diagnosticCode: "upload_too_large", stage: "upload" });
  assert.deepEqual(await fsp.readdir(tmpRoot), []);
});

test(
  "malformed multipart and wrong content type become safe 400 diagnostics",
  { timeout: 5000 },
  async (t) => {
    const { app, logs } = await makeApp(t);
    for (const [type, payload] of [
      ["multipart/form-data", "bad"],
      ["text/plain", SECRET],
      [
        `multipart/form-data; boundary=${BOUNDARY}`,
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="bad.jpg"\r\n\r\nmissing terminator`,
      ],
    ] as const) {
      const res = await post(app, payload, { "content-type": type });
      assert.equal(res.statusCode, 400, res.body);
      resultLog(res, logs, {
        diagnosticCode: "upload_invalid_multipart",
        stage: "upload",
      });
    }
    assert.ok(!JSON.stringify(logs).includes(SECRET));
  }
);

test("rate limiting before handler still returns and logs a request ID", async (t) => {
  const { app, logs } = await makeApp(t, { rateLimitMax: 1 });
  await post(app, upload({ filename: "bad.png" }));
  const res = await post(app);
  assert.equal(res.statusCode, 429);
  resultLog(res, logs, { diagnosticCode: "rate_limited", stage: "upload" });
});

test("unexpected parser errors retain phase and safe OS code, without leaking messages", async (t) => {
  const { app, logs, tmpRoot } = await makeApp(t, {
    parseFile: async () => {
      throw Object.assign(new Error(`/private/path/${SECRET}`), {
        code: "EIO",
      });
    },
  });
  const res = await post(app);
  assert.equal(res.statusCode, 500);
  resultLog(res, logs, {
    diagnosticCode: "internal_error",
    stage: "exiftool",
    errorCode: "EIO",
    level: 50,
  });
  assert.ok(!JSON.stringify(logs).includes(SECRET));
  assert.ok(!res.body.includes(SECRET));
  assert.ok(!res.body.includes("stack"));
  assert.deepEqual(await fsp.readdir(tmpRoot), []);
});

test("temporary storage failure can be diagnosed without revealing a path", async (t) => {
  const { app, logs } = await makeApp(t, {
    tmpRoot: path.join(os.tmpdir(), SECRET, "nonexistent"),
  });
  const res = await post(app);
  assert.equal(res.statusCode, 500);
  resultLog(res, logs, {
    diagnosticCode: "internal_error",
    stage: "upload",
    errorCode: "ENOENT",
  });
  assert.ok(!JSON.stringify(logs).includes(SECRET));
});

test("ExifTool exceptions and format errors produce distinct safe diagnostics", async () => {
  const cases = [
    [
      async () => {
        throw new Error(`timed out /private/${SECRET}`);
      },
      "exiftool_timeout",
      "exiftool",
    ],
    [
      async () => {
        throw new Error(`read failed /private/${SECRET}`);
      },
      "exiftool_read_failed",
      "exiftool",
    ],
    [
      async () => ({ "ExifTool:Error": SECRET }),
      "exiftool_reported_error",
      "exiftool",
    ],
    [
      async () => ({
        "File:FileType": "JPEG",
        "ExifTool:Warning": `JPEG format error ${SECRET}`,
      }),
      "jpeg_format_error",
      "exiftool",
    ],
    [
      async () => ({ "File:FileType": "PNG" }),
      "upload_invalid_magic",
      "validation",
    ],
    [async () => null, "exiftool_read_failed", "exiftool"],
  ] as const;
  for (const [readRaw, diagnosticCode, stage] of cases) {
    const events: ParseDiagnostic[] = [];
    const result = await parseFile("/private/unused.jpg", "image.jpg", {
      readRaw,
      onDiagnostic: (d) => events.push(d),
    });
    const toolFailure = ["exiftool_timeout", "exiftool_read_failed"].includes(
      diagnosticCode
    );
    assert.equal(
      result.status,
      toolFailure ? "error" : "unsupported_or_corrupt"
    );
    if (toolFailure) {
      assert.ok(result.status === "error");
      assert.equal(
        result.reason,
        diagnosticCode === "exiftool_timeout" ? "timeout" : "parser_unavailable"
      );
    }
    assert.deepEqual(events, [{ stage, diagnosticCode }]);
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test("mapping diagnostics distinguish absent versus invalid counts using safe enums only", () => {
  const summary = summarizeMapping({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": SECRET,
    "GPS:GPSLatitude": SECRET,
    "Nikon:SerialNumber": SECRET,
    "Nikon:ShutterCount": 8000000,
  });
  assert.deepEqual(summary, {
    brand: "nikon",
    hasExif: true,
    candidateCount: 2,
    presentCandidateCount: 1,
    invalidCandidateCount: 1,
  });
  assert.equal(summarizeMapping({ "IFD0:Make": SECRET }).brand, "unknown");
  assert.equal(summarizeMapping({}).hasExif, false);
});

test("health response also correlates without exposing metadata", async (t) => {
  const { app, logs } = await makeApp(t);
  const res = await app.inject({ method: "GET", url: "/shutter/api/health" });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().requestId, UUID);
  assert.equal(res.headers["x-request-id"], res.json().requestId);
  const entry = logs.find((item) => item.event === "health_result");
  assert.ok(entry);
  assert.equal(entry.requestId, res.json().requestId);
  assert.equal(entry.diagnosticCode, "health_ok");
});

test("parser service failures return 503, not a damaged-image verdict", async (t) => {
  for (const [error, reason, diagnosticCode] of [
    [new Error("timed out " + SECRET), "timeout", "exiftool_timeout"],
    [
      Object.assign(new Error(SECRET), { code: "ENOENT" }),
      "parser_unavailable",
      "exiftool_read_failed",
    ],
  ] as const) {
    const { app, logs, tmpRoot } = await makeApp(t, {
      parseFile: (file, name, options) =>
        parseFile(file, name, {
          ...options,
          readRaw: async () => {
            throw error;
          },
        }),
    });
    const res = await post(app);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().status, "error");
    assert.equal(res.json().reason, reason);
    resultLog(res, logs, { diagnosticCode, stage: "exiftool", level: 50 });
    assert.ok(!JSON.stringify(logs).includes(SECRET));
    assert.deepEqual(await fsp.readdir(tmpRoot), []);
  }
});

test("multipart is fully validated before parsing, including trailing files and fields", async (t) => {
  let parseCalls = 0;
  const { app, logs, tmpRoot } = await makeApp(t, {
    parseFile: async () => {
      parseCalls++;
      return { status: "ok" };
    },
  });
  const ending = Buffer.from(`--${BOUNDARY}--\r\n`);
  const first = upload().subarray(0, -ending.length);
  const jsonField = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\nContent-Type: application/json\r\n\r\nnot-json\r\n--${BOUNDARY}--\r\n`
  );
  const protoField = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="__proto__"\r\n\r\nignored\r\n--${BOUNDARY}--\r\n`
  );
  for (const payload of [
    Buffer.concat([first, upload()]),
    Buffer.concat([first, jsonField]),
    jsonField,
    protoField,
    upload({ field: "__proto__" }),
  ]) {
    const res = await post(app, payload);
    assert.equal(res.statusCode, 400);
    resultLog(res, logs, {
      diagnosticCode: "upload_invalid_multipart",
      stage: "upload",
    });
  }
  assert.equal(parseCalls, 0);
  assert.deepEqual(await fsp.readdir(tmpRoot), []);
});

test("oversized rejected-extension and rejected-field streams remain diagnosed", async (t) => {
  const { app, logs } = await makeApp(t, { maxUploadMb: 0.001 });
  for (const options of [{ filename: "bad.png" }, { field: "wrong" }]) {
    const res = await post(app, upload(options));
    assert.equal(res.statusCode, 413);
    resultLog(res, logs, {
      diagnosticCode: "upload_too_large",
      stage: "upload",
    });
  }
});
