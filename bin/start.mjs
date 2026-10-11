#!/usr/bin/env node
// Explicit entrypoint for process managers (PM2). Always starts the server.
await import("../dist/bin/start.js");
