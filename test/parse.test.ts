import { test, after } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createParser } from "../src/parse.js";

const FIXTURES = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "fixtures"
);
const parser = createParser();
const parseFile = (file: string, name: string) => parser.parse(file, name, {});
const fx = (name: string) => path.join(FIXTURES, name);

after(async () => {
  await parser.close();
});

// Expected results from test/fixtures/README.md
test("NikonD70.jpg -> ok 526", async () => {
  const r = await parseFile(fx("NikonD70.jpg"), "NikonD70.jpg");
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 526);
  assert.equal(r.shutterSource, "Nikon:ShutterCount");
  assert.equal(r.approximate, false);
  assert.equal(r.model, "NIKON D70");
  assert.equal(r.capturedAt, "2005-01-14 08:57:59");
});

test("NikonD2Hs.jpg -> ok 2", async () => {
  const r = await parseFile(fx("NikonD2Hs.jpg"), "NikonD2Hs.jpg");
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 2);
  assert.equal(r.shutterSource, "Nikon:ShutterCount");
  assert.equal(r.model, "NIKON D2Hs");
  assert.equal(r.capturedAt, "2005-03-18 02:55:18");
});

test("Canon1DmkIII.jpg -> ok 1", async () => {
  const r = await parseFile(fx("Canon1DmkIII.jpg"), "Canon1DmkIII.jpg");
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1);
  assert.equal(r.shutterSource, "Canon:ShutterCount");
  assert.equal(r.model, "Canon EOS-1D Mark III");
  assert.equal(r.capturedAt, "2007-02-22 17:02:42");
});

test("Pentax.jpg -> ok 1648", async () => {
  const r = await parseFile(fx("Pentax.jpg"), "Pentax.jpg");
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1648);
  assert.equal(r.shutterSource, "Pentax:ShutterCount");
  assert.equal(r.model, "PENTAX K10D");
  assert.equal(r.capturedAt, "2008-03-02 12:01:23");
});

test("Canon.jpg -> no_shutter_field with model", async () => {
  const r = await parseFile(fx("Canon.jpg"), "Canon.jpg");
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.shutterCount, null);
  assert.equal(r.model, "Canon EOS DIGITAL REBEL");
  assert.equal(r.capturedAt, "2003-12-04 06:46:52");
});

test("Sony.jpg -> no_shutter_field with model", async () => {
  const r = await parseFile(fx("Sony.jpg"), "Sony.jpg");
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.model, "Sony DSC-F828");
});

test("FujiFilm.jpg -> no_shutter_field with model", async () => {
  const r = await parseFile(fx("FujiFilm.jpg"), "FujiFilm.jpg");
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.model, "FUJIFILM FinePix2400Zoom");
});

test("Olympus.jpg -> no_shutter_field with model", async () => {
  const r = await parseFile(fx("Olympus.jpg"), "Olympus.jpg");
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.model, "OLYMPUS C2000Z");
});

test("Panasonic.jpg -> no_shutter_field with model", async () => {
  const r = await parseFile(fx("Panasonic.jpg"), "Panasonic.jpg");
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.model, "Panasonic DMC-FZ3");
});

test("corrupt file (JPEG magic + garbage) -> unsupported_or_corrupt", async (t) => {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "shuttercount-parse-test-")
  );
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const bad = path.join(dir, "bad.jpg");
  const garbage = Buffer.from(
    "this is definitely not jpeg data".repeat(8),
    "utf8"
  );
  await fsp.writeFile(
    bad,
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), garbage])
  );
  const r = await parseFile(bad, "bad.jpg");
  assert.equal(r.status, "unsupported_or_corrupt");
  assert.equal(r.reason, "corrupt");
  assert.equal(r.fileName, "bad.jpg");
  assert.ok(typeof r.message === "string" && r.message.length > 0);
});

test("non-JPEG file content -> unsupported_or_corrupt reason not_jpeg", async (t) => {
  const dir = await fsp.mkdtemp(
    path.join(os.tmpdir(), "shuttercount-parse-test-")
  );
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const png = path.join(dir, "x.jpg");
  // Minimal PNG signature + IHDR-ish bytes renamed to .jpg
  await fsp.writeFile(
    png,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  );
  const r = await parseFile(png, "x.jpg");
  assert.equal(r.status, "unsupported_or_corrupt");
  assert.equal(r.reason, "not_jpeg");
});
