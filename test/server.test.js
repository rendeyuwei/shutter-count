import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildApp,
  cleanupStaleTmpDirs,
  parseTrustProxy,
} from "../src/server.js";
import { closeExifTool } from "../src/parse.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FIXTURES = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures"
);
const NIKON_D70 = await fsp.readFile(path.join(FIXTURES, "NikonD70.jpg"));

const BOUNDARY = "----shuttercountTestBoundary9d3a1b";

function multipartBody({ fieldName = "file", filename, contentType = "image/jpeg", content, extraFields = [] }) {
  const parts = [];
  for (const [name, value] of extraFields) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        "utf8"
      )
    );
  }
  if (filename !== undefined) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
        "utf8"
      ),
      content,
      Buffer.from("\r\n", "utf8")
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`, "utf8"));
  return Buffer.concat(parts);
}

function postParse(app, body) {
  return app.inject({
    method: "POST",
    url: "/shutter/api/parse",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    payload: body,
  });
}

let tmpRoot;
const apps = [];

async function makeApp(opts = {}) {
  const app = buildApp({ tmpRoot, logger: false, ...opts });
  apps.push(app);
  await app.ready();
  return app;
}

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "shuttercount-srvtest-"));
});

after(async () => {
  for (const app of apps) await app.close();
  await closeExifTool();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test("GET /shutter/api/health -> 200 with exiftool version", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/shutter/api/health" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.match(body.exiftool, /^\d+\.\d+/);
  assert.ok(body.revision === null || /^[a-f0-9]{40}$/.test(body.revision));
});

test("GET /shutter -> 308 redirect to /shutter/", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/shutter" });
  assert.equal(res.statusCode, 308);
  assert.equal(res.headers.location, "/shutter/");
});

test("GET /shutter/ -> 200 html with the product title", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/shutter/" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /查看相机快门次数/);
});

test("GET /shutter/app.js -> 200 javascript", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/shutter/app.js" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /javascript/);
  assert.match(res.body, /api\/parse/);
});

test("GET /shutter/styles.css -> 200 css", async () => {
  const app = await makeApp();
  const res = await app.inject({ method: "GET", url: "/shutter/styles.css" });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["content-type"], /text\/css/);
  assert.match(res.body, /--accent:\s*#efac4b/);
});

test("POST /shutter/api/parse with NikonD70.jpg -> 200 ok", async () => {
  const app = await makeApp();
  const res = await postParse(
    app,
    multipartBody({ filename: "DSC_0001.JPG", content: NIKON_D70 })
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.shutterCount, 526);
  assert.equal(body.model, "NIKON D70");
  assert.equal(body.capturedAt, "2005-01-14 08:57:59");
  assert.equal(body.fileName, "DSC_0001.JPG");
  assert.equal(body.approximate, false);
});

test(".png filename -> 422 not_jpeg", async () => {
  const app = await makeApp();
  const res = await postParse(
    app,
    multipartBody({ filename: "photo.png", content: NIKON_D70, contentType: "image/png" })
  );
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.status, "unsupported_or_corrupt");
  assert.equal(body.reason, "not_jpeg");
  assert.equal(body.fileName, "photo.png");
});

test("text content named x.jpg -> 422 not_jpeg", async () => {
  const app = await makeApp();
  const res = await postParse(
    app,
    multipartBody({
      filename: "x.jpg",
      content: Buffer.from("hello i am definitely a jpeg trust me", "utf8"),
      contentType: "text/plain",
    })
  );
  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.status, "unsupported_or_corrupt");
  assert.equal(body.reason, "not_jpeg");
});

test("missing file -> 400 bad_request", async () => {
  const app = await makeApp();
  const res = await postParse(
    app,
    multipartBody({ extraFields: [["note", "no file here"]] })
  );
  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.status, "bad_request");
  assert.ok(body.message);
});

test("oversize upload -> 413 file_too_large with maxMb", async () => {
  const app = await makeApp({ maxUploadMb: 0.001 }); // ~1 KB limit
  const res = await postParse(
    app,
    multipartBody({ filename: "big.jpg", content: NIKON_D70 }) // ~3.6 KB
  );
  assert.equal(res.statusCode, 413);
  const body = res.json();
  assert.equal(body.status, "file_too_large");
  assert.equal(body.maxMb, 0.001);
});

test("temp dirs created by requests are removed afterwards", async () => {
  const app = await makeApp();
  const before = await fsp.readdir(tmpRoot);
  await postParse(app, multipartBody({ filename: "a.jpg", content: NIKON_D70 }));
  await postParse(app, multipartBody({ filename: "b.png", content: NIKON_D70 }));
  await postParse(app, multipartBody({ filename: "c.jpg", content: Buffer.from("nope") }));
  const afterList = await fsp.readdir(tmpRoot);
  assert.deepEqual(
    afterList.filter((e) => e.startsWith("shuttercount-")),
    []
  );
  assert.deepEqual(afterList, before);
});

test("client filename is sanitized (path stripped, max 120 chars)", async () => {
  const app = await makeApp();
  const evil = "../../etc/passwd/" + "x".repeat(200) + ".jpg";
  const res = await postParse(
    app,
    multipartBody({ filename: evil, content: NIKON_D70 })
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(!body.fileName.includes("/"));
  assert.ok(!body.fileName.includes("\\"));
  assert.ok(body.fileName.length <= 120);

  const res2 = await postParse(
    app,
    multipartBody({ filename: "..\\..\\windows\\DSC_0001.JPG", content: NIKON_D70 })
  );
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.json().fileName, "DSC_0001.JPG");
});

test("rate limit applies to /api/parse only (30/min)", async () => {
  const app = await makeApp({ rateLimitMax: 3 });
  const small = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(64, 7)]);
  for (let i = 0; i < 3; i++) {
    const res = await postParse(
      app,
      multipartBody({ filename: "r.jpg", content: small })
    );
    assert.notEqual(res.statusCode, 429, `request ${i + 1} should not be limited`);
  }
  const limited = await postParse(
    app,
    multipartBody({ filename: "r.jpg", content: small })
  );
  assert.equal(limited.statusCode, 429);
  // health is NOT rate limited
  const health = await app.inject({ method: "GET", url: "/shutter/api/health" });
  assert.equal(health.statusCode, 200);
});

test("parseTrustProxy: defaults to loopback, accepts true/false and IP/CIDR lists", () => {
  assert.deepEqual(parseTrustProxy(undefined), ["127.0.0.1", "::1"]);
  assert.deepEqual(parseTrustProxy(""), ["127.0.0.1", "::1"]);
  assert.equal(parseTrustProxy("true"), true);
  assert.equal(parseTrustProxy("false"), false);
  assert.deepEqual(parseTrustProxy("127.0.0.1,::1"), ["127.0.0.1", "::1"]);
  assert.deepEqual(parseTrustProxy(" 10.0.0.0/8 , 192.168.1.1 "), [
    "10.0.0.0/8",
    "192.168.1.1",
  ]);
});

test("buildApp honors trustProxy option without breaking health", async () => {
  const app = await makeApp({ trustProxy: "127.0.0.1,::1" });
  const res = await app.inject({ method: "GET", url: "/shutter/api/health" });
  assert.equal(res.statusCode, 200);
});

for (const entrypoint of ["src/server.js", "bin/start.mjs"]) {
test(`server starts and answers health via a symlinked ${entrypoint}`, async () => {
  // Mirrors the deploy layout: /opt/shutter-count/current -> releases/<id>.
  // Node resolves the main module's realpath, so the invokedDirectly check
  // must realpath process.argv[1] or the server silently does nothing.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "sc-symlink-"));
  const link = path.join(tmp, "current");
  await fsp.symlink(REPO_ROOT, link, "dir");

  const port = 40000 + Math.floor(Math.random() * 10000); // 40000-49999
  const child = spawn(
    process.execPath,
    [path.join(link, entrypoint)],
    {
      cwd: tmp,
      detached: true, // own process group so we can kill exiftool children too
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        BASE_PATH: "/shutter",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += d;
  });

  const killChild = async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  try {
    const url = `http://127.0.0.1:${port}/shutter/api/health`;
    const deadline = Date.now() + 20000;
    let ok = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break; // server crashed / never started
      }
      try {
        const res = await fetch(url);
        if (res.status === 200) {
          const body = await res.json();
          assert.equal(body.status, "ok");
          ok = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(
      ok,
      `server via symlink did not answer health with 200 (exit=${child.exitCode})${stderr ? `\nstderr: ${stderr.slice(0, 500)}` : ""}`
    );
  } finally {
    await killChild();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

}

test("cleanupStaleTmpDirs removes only shuttercount-* dirs older than 10 min", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sc-cleanup-test-"));
  try {
    const stale = path.join(root, "shuttercount-stale");
    const fresh = path.join(root, "shuttercount-fresh");
    const other = path.join(root, "something-else");
    await fsp.mkdir(stale);
    await fsp.mkdir(fresh);
    await fsp.mkdir(other);
    await fsp.writeFile(path.join(stale, "upload.jpg"), "x");
    const old = new Date(Date.now() - 11 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    await cleanupStaleTmpDirs(root);

    const left = (await fsp.readdir(root)).sort();
    assert.deepEqual(left, ["shuttercount-fresh", "something-else"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
