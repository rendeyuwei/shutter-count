#!/usr/bin/env node
// Smoke test against a running instance.
//
// Usage: node scripts/smoke.mjs [baseUrl] <file1.jpg> [file2.jpg ...]
//   baseUrl defaults to http://127.0.0.1:3020/shutter
//
// Checks: GET <base>/ is 200 html, GET <base>/api/health is 200, then POSTs
// each JPEG (multipart field "file") to <base>/api/parse and prints
// status/model/shutterCount/capturedAt per file.
//
// Exits non-zero if the page/health check fails or any request returns 5xx.
import fsp from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE = "http://127.0.0.1:3020/shutter";

const argv = process.argv.slice(2);
let base = DEFAULT_BASE;
if (argv.length > 0 && /^https?:\/\//i.test(argv[0])) {
  base = argv.shift();
}
base = base.replace(/\/+$/, "");
const files = argv;

if (files.length === 0) {
  console.error(
    "usage: node scripts/smoke.mjs [baseUrl] <file1.jpg> [file2.jpg ...]"
  );
  process.exit(2);
}

let failed = false;

function fail(msg) {
  failed = true;
  console.error(`FAIL ${msg}`);
}

async function main() {
  // 1) Landing page: 200 html.
  try {
    const res = await fetch(base + "/");
    const ct = res.headers.get("content-type") || "";
    if (res.status !== 200 || !/text\/html/i.test(ct)) {
      fail(`GET ${base}/ -> ${res.status} ${ct} (want 200 text/html)`);
    } else {
      console.log(`ok   GET ${base}/ -> 200 ${ct}`);
    }
  } catch (err) {
    fail(`GET ${base}/ -> ${err.message}`);
  }

  // 2) Health: 200.
  try {
    const res = await fetch(base + "/api/health");
    if (res.status !== 200) {
      fail(`GET ${base}/api/health -> ${res.status} (want 200)`);
    } else {
      const body = await res.json().catch(() => null);
      console.log(
        `ok   GET ${base}/api/health -> 200 ${body ? JSON.stringify(body) : ""}`
      );
    }
  } catch (err) {
    fail(`GET ${base}/api/health -> ${err.message}`);
  }

  // 3) Parse each file.
  for (const file of files) {
    const name = path.basename(file);
    let res;
    try {
      const buf = await fsp.readFile(file);
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "image/jpeg" }), name);
      res = await fetch(base + "/api/parse", { method: "POST", body: form });
    } catch (err) {
      fail(`POST ${base}/api/parse (${name}) -> ${err.message}`);
      continue;
    }
    const body = await res.json().catch(() => null);
    if (res.status >= 500) {
      fail(`POST ${base}/api/parse (${name}) -> ${res.status}`);
      continue;
    }
    console.log(
      `${res.status} ${name}: status=${body?.status ?? "?"} model=${body?.model ?? "-"} ` +
        `shutterCount=${body?.shutterCount ?? "-"} capturedAt=${body?.capturedAt ?? "-"}`
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
