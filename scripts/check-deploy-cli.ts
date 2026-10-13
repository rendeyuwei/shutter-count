#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { checkDeployment } from "./check-deploy.js";

export { checkDeployment };
export type { CheckOptions, HealthRequest } from "./check-deploy.js";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [base, revision] = process.argv.slice(2);
  if (
    !base ||
    !(
      revision === "-" ||
      (revision?.length === 40 && /^[a-f0-9]{40}$/.test(revision))
    )
  ) {
    console.error(
      "Usage: node scripts/check-deploy.mjs <base-url> <commit-sha|->"
    );
    process.exitCode = 2;
  } else {
    try {
      await checkDeployment(base, revision);
      console.log(
        "Application page, ExifTool health and requested revision verified"
      );
    } catch (error) {
      console.error(
        `Deployment health check failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      process.exitCode = 1;
    }
  }
}
