import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readReleaseRevision } from "../src/app.js";

const distSha = "a".repeat(40);
const rootSha = "b".repeat(40);

async function releaseLayout() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "shutter-revision-"));
  const moduleDir = path.join(root, "dist", "src");
  await fsp.mkdir(moduleDir, { recursive: true });
  return root;
}

test("health revision prefers dist/REVISION over the release root", async () => {
  const root = await releaseLayout();
  try {
    await fsp.writeFile(path.join(root, "dist", "REVISION"), `${distSha}\n`);
    await fsp.writeFile(path.join(root, "REVISION"), `${rootSha}\n`);
    assert.equal(readReleaseRevision(path.join(root, "dist", "src")), distSha);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("health revision falls back to the release root when dist/REVISION is missing", async () => {
  const root = await releaseLayout();
  try {
    await fsp.writeFile(path.join(root, "REVISION"), `${rootSha}\n`);
    assert.equal(readReleaseRevision(path.join(root, "dist", "src")), rootSha);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("health revision is null without a REVISION file or when dist/REVISION is not a commit SHA", async () => {
  const root = await releaseLayout();
  try {
    const moduleDir = path.join(root, "dist", "src");
    assert.equal(readReleaseRevision(moduleDir), null);
    await fsp.writeFile(path.join(root, "dist", "REVISION"), "not-a-sha\n");
    await fsp.writeFile(path.join(root, "REVISION"), `${rootSha}\n`);
    assert.equal(readReleaseRevision(moduleDir), null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
