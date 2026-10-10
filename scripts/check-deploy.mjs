#!/usr/bin/env node
import { pathToFileURL } from "node:url";

export async function checkDeployment(baseUrl, revision, { attempts = 15, delayMs = 2000, request = fetch } = {}) {
  if (!(revision === "-" || (typeof revision === "string" && revision.length === 40 && /^[a-f0-9]{40}$/.test(revision)))) throw new Error("Invalid deployment revision");
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("Use an HTTP(S) application base URL without credentials, query or fragment");
  }
  const prefix = base.href.replace(/\/+$/, "");
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const health = await request(`${prefix}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" });
      if (health.status !== 200) throw new Error(`Health HTTP ${health.status}`);
      const data = await health.json();
      if (data.status !== "ok" || !/^\d+\.\d+/.test(String(data.exiftool))) throw new Error("ExifTool health is not OK");
      if (revision !== "-" && data.revision !== revision) throw new Error("Running revision does not match the deployment");
      const page = await request(`${prefix}/`, { signal: AbortSignal.timeout(5000), redirect: "error", cache: "no-store" });
      if (page.status !== 200 || !/text\/html/i.test(page.headers.get("content-type") || "")) throw new Error("Application page is not HTTP 200 HTML");
      await page.body?.cancel();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, revision] = process.argv.slice(2);
  if (!base || !(revision === "-" || (revision?.length === 40 && /^[a-f0-9]{40}$/.test(revision)))) {
    console.error("Usage: node scripts/check-deploy.mjs <base-url> <commit-sha|->");
    process.exitCode = 2;
  } else {
    try {
      await checkDeployment(base, revision);
      console.log("Application page, ExifTool health and requested revision verified");
    } catch (error) {
      console.error(`Deployment health check failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
