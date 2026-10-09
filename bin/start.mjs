#!/usr/bin/env node
// Explicit entrypoint for process managers (PM2). Always starts the server.
process.env.SHUTTER_FORCE_LISTEN = "1";
await import("../src/server.js");
