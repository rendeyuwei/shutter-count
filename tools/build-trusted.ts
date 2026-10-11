import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist/trusted");
await mkdir(output, { recursive: true });
for (const name of [
  "receive-deploy",
  "check-deploy",
  "deploy-guard",
  "deploy-ssh",
]) {
  const result = await build({
    entryPoints: [path.join(root, "scripts", name + ".ts")],
    outfile: path.join(output, name + ".mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    metafile: true,
  });
  for (const file of Object.values(result.metafile.outputs)) {
    if (file.imports.some((item) => !item.path.startsWith("node:")))
      throw new Error("Trusted tools must depend only on Node builtins");
  }
}
await copyFile(
  path.join(root, "scripts/deploy-release.sh"),
  path.join(output, "deploy-release.sh")
);
const files = [
  "receive-deploy.mjs",
  "check-deploy.mjs",
  "deploy-guard.mjs",
  "deploy-ssh.mjs",
  "deploy-release.sh",
];
const checksums = await Promise.all(
  files.map(
    async (name) =>
      `${createHash("sha256")
        .update(await readFile(path.join(output, name)))
        .digest("hex")}  ${name}`
  )
);
await writeFile(path.join(output, "SHA256SUMS"), checksums.join("\n") + "\n");
