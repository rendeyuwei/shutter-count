#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { isRecord } from "../shared/protocol.js";

export function validateLoopback(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "The host-side health URL must be an explicit loopback HTTP application URL"
    );
  }
}

export function validatePm2(
  list: unknown,
  configuration: unknown,
  previous: string,
  baseUrl: string,
  root: string
): number {
  if (!Array.isArray(list)) throw new Error("Invalid PM2 process list");
  const matches = list
    .filter(isRecord)
    .filter((process) => process.name === "shutter-count");
  const match = matches[0];
  if (matches.length !== 1 || !match || !isRecord(match.pm2_env))
    throw new Error("Expected exactly one existing shutter-count process");
  const running = match.pm2_env;
  if (
    running.status !== "online" ||
    typeof running.pm_cwd !== "string" ||
    fs.realpathSync(running.pm_cwd) !== previous
  )
    throw new Error("PM2 process does not match current release");
  if (
    running.pm_cwd !== root + "/current" ||
    running.pm_exec_path !== root + "/current/bin/start.mjs"
  )
    throw new Error(
      "PM2 must already use the stable current cwd and entrypoint; migrate explicitly before automation"
    );
  if (running.exec_interpreter !== process.execPath)
    throw new Error(
      "PM2 interpreter differs from the fixed deployment runtime"
    );
  if (!(Number(String(running.node_version).split(".")[0]) >= 22))
    throw new Error(
      "The existing PM2 process must already run Node 22 or later"
    );
  if (
    typeof match.pm_id !== "number" ||
    !Number.isInteger(match.pm_id) ||
    match.pm_id < 0
  )
    throw new Error("Invalid PM2 process ID");
  const app =
    isRecord(configuration) && Array.isArray(configuration.apps)
      ? (configuration.apps[0] as unknown)
      : null;
  if (
    !isRecord(configuration) ||
    !Array.isArray(configuration.apps) ||
    configuration.apps.length !== 1 ||
    !isRecord(app) ||
    app.name !== "shutter-count" ||
    app.script !== "bin/start.mjs" ||
    !isRecord(app.env)
  )
    throw new Error("Unexpected PM2 application config");
  if (
    typeof app.kill_timeout !== "number" ||
    app.kill_timeout < 25000 ||
    running.kill_timeout !== app.kill_timeout
  )
    throw new Error(
      "PM2 shutdown timeout differs from repository config; reconcile explicitly before deploying"
    );
  for (const [key, value] of Object.entries(app.env)) {
    const environment = isRecord(running.env) ? running.env : {};
    if (String(running[key] ?? environment[key]) !== String(value))
      throw new Error(
        `Live PM2 ${key} differs from repository config; reconcile explicitly before deploying`
      );
  }
  const base = new URL(baseUrl);
  if (
    Number(base.port || 80) !== Number(app.env.PORT) ||
    base.pathname.replace(/\/+$/, "") !==
      String(app.env.BASE_PATH).replace(/\/+$/, "")
  )
    throw new Error("Health URL does not match the PM2 application config");
  return match.pm_id;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "runtime") {
    if (Number(process.versions.node.split(".")[0]) < 22) process.exitCode = 1;
  } else if (command === "url" && args[0]) {
    validateLoopback(args[0]);
  } else if (command === "pm2" && args.length === 4) {
    const [previous, configPath, baseUrl, root] = args;
    const config: unknown = createRequire(import.meta.url)(configPath!);
    const list: unknown = JSON.parse(fs.readFileSync(0, "utf8"));
    console.log(validatePm2(list, config, previous!, baseUrl!, root!));
  } else {
    throw new Error("Invalid deployment guard command");
  }
}
