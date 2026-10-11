import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { buildApp } from "./app.js";

export async function start(): Promise<void> {
  const app = buildApp({ logger: true });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    const deadline = setTimeout(() => process.exit(1), 20_000).unref();
    try {
      await app.close();
    } catch {
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  try {
    await app.listen({ port: app.appConfig.port, host: app.appConfig.host });
  } catch {
    process.exitCode = 1;
    await shutdown();
  }
}

let direct = false;
try {
  direct =
    !!process.argv[1] &&
    import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
} catch {
  /* imported module */
}
if (direct && process.env.SHUTTER_NO_LISTEN !== "1") await start();
