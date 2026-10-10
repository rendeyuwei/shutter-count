import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");

async function run(script: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build step failed: ${script} (${code})`));
    });
  });
}

await rm(output, { recursive: true, force: true });
await run("node_modules/typescript/bin/tsc", ["-p", "tsconfig.json"]);
await run("node_modules/vite/bin/vite.js", ["build"]);
await run("node_modules/tsx/dist/cli.mjs", ["tools/build-trusted.ts"]);
await mkdir(path.join(output, "scripts"), { recursive: true });
await copyFile(
  path.join(root, "scripts/deploy-release.sh"),
  path.join(output, "scripts/deploy-release.sh")
);
await cp(path.join(root, "test/fixtures"), path.join(output, "test/fixtures"), {
  recursive: true,
});
try {
  await copyFile(path.join(root, "REVISION"), path.join(output, "REVISION"));
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}
