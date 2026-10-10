# ShutterCount TypeScript modernization plan

[English](MODERNIZATION.md) | [简体中文](MODERNIZATION.zh-CN.md)

The entire project's application logic will move to strict TypeScript: browser code, HTTP handling, parsing, camera mapping, Node tools, startup logic, and tests. Each phase must produce a working application with a tested release path. Fastify, ExifTool, the single-page experience, and the single-process deployment remain appropriate for the current product.

## Scope and completion criteria

| Area                      | Target                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                   | TypeScript modules for application assembly, configuration, HTTP routes, the photo-processing workflow, diagnostics, and an application-owned ExifTool adapter |
| Browser                   | Vite and TypeScript, with separate upload state, HTTP decoding, rendering, and diagnostic modules; keep the current visual design                              |
| Contracts                 | Shared result types and runtime validation for network data; one authoritative upload limit and explicit result variants                                       |
| Tests                     | All test implementations in TypeScript, retain Node's test runner and documented JPEG fixtures, add a small browser suite                                      |
| Node tools                | TypeScript smoke, deployment client, health checker, receiver, and build tools; compile production tools to JavaScript                                         |
| Startup and configuration | TypeScript startup logic; preserve `bin/start.mjs` as a minimal stable PM2 bootstrap; keep PM2's required CommonJS configuration                               |
| Other files               | HTML, CSS, SVG, JSON, YAML, and Bash keep their native formats; compile TypeScript to ignored JavaScript artifacts                                             |

Maintained prototype scripts and Node logic embedded in Bash also move into typed modules or are retired when the Vite preview replaces them.

Completion means `allowJs` is removed, every maintained TypeScript file passes strict checking, no implementation is hidden behind blanket `any` or `ts-nocheck`, and the production application starts with only production dependencies. Generated JavaScript and minimal external-tool bootstraps are expected output, not unfinished migration.

## Target module layout

```text
src/
  app.ts                 application assembly without opening a listener
  main.ts                listening and bounded graceful shutdown
  config.ts              validated environment and explicit options
  photo/                 upload validation, parsing and awaited cleanup
  parse.ts               owned ExifTool adapter and diagnostic mapping
  mapping.ts             pure camera and tag rules
shared/                  result contracts and safe diagnostic vocabulary
web/
  index.html
  app.ts                 browser entrypoint, upload state and cancellation
  api.ts                 request cancellation and response validation
  render.ts              DOM rendering with textContent
  diagnostics.ts         privacy-safe feedback
public/                  CSS, favicon and other static assets
test/                    TypeScript regression tests and JPEG fixtures
scripts/                 TypeScript operational tools and Bash release script
tools/                   TypeScript build and development tools
bin/start.mjs            stable PM2 bootstrap into compiled startup logic
dist/                    compiled application, tools, tests and browser assets
```

The photo module owns the complete upload-to-cleanup lifetime. Routes should not reproduce resource management. Production and fake ExifTool adapters share the same interface, including reading, health, and closing; tests must not share a global parser with unrelated application instances.

## Migration phases

| Phase                                        | Deliverables                                                                                                                                                                                                                             | Exit checks                                                                                                                                                                                            | Status           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1 Build foundation and first modules         | Strict TypeScript checks; deterministic Node and Vite builds; typed shared mapping results; migrate camera mapping, browser entrypoint and mapping tests; patched static-file dependency; release installation/build/test/prune sequence | Existing regression suite, type checks, compiled page/assets, camera upload, custom mount path and production-only startup                                                                             | Complete locally |
| 2 Backend and runtime contracts              | Migrate parser and HTTP code; separate app/main; validate configuration; expose effective upload settings to the browser; validate result schemas; own and close parser per app; bounded concurrency and waiting                         | Failure/timeout/cleanup contracts; invalid configuration rejected at startup; busy responses; app isolation; graceful shutdown; no metadata in diagnostics                                             | Complete locally |
| 3 Browser modules and browser verification   | Split browser entrypoint into HTTP, upload state, rendering and diagnostics modules; consume shared contracts; migrate frontend tests; add real browser tests                                                                            | Successful upload, missing count, rejection, retry, cancellation, clipboard fallback, keyboard interaction and mobile layout                                                                           | Complete locally |
| 4 Operational tools and full strict checking | Migrate all remaining Node tools/tests/startup logic; deliver self-contained trusted receiver/checker bundles; remove transitional JS compilation; enable full formatting checks and dependency maintenance                              | Restricted SSH protocol, exact revision, obsolete-release rejection, rollback, interruption and production-only startup; zero maintained JS implementations except documented bootstraps/configuration | Complete locally |

Each phase is a separate reviewable change. Introduce type constraints before changing business behavior, and preserve the existing JPEG expectations, HTTP statuses, request IDs, privacy rules and `/shutter` mounting. Add regression tests when fixing a specific behavior. Formatting changes should stay within migrated files.

## Build and development

Use Node 22.12 or newer; CI continues to select Node 22 through `.nvmrc`. Node output uses ESM with explicit `.js` import paths. Vite builds relative asset URLs so the same output can be mounted at `/shutter`, `/`, or a custom prefix.

Phase 1 used transitional `allowJs`; it and `checkJs` are now removed. Every maintained TS source file, Node tool and test is included in strict checking. Browser checking has its own DOM-only configuration so Node globals cannot accidentally enter browser code.

```bash
npm ci
npm run typecheck
npm run build
npm run test:built
npm start
```

`npm test` builds first and runs compiled tests. `npm run dev:server` watches the backend with tsx; `npm run dev:web` serves the browser with Vite and proxies `/api` to the local `/shutter/api`. Build artifacts are ignored and rebuilt from the committed lockfile.

## Release and rollback

The host currently installs only production dependencies and has no compile step. The new sequence installs locked development dependencies for verification, checks types, builds, runs compiled tests, then prunes development dependencies before activating the release. The application runs compiled code without tsx, TypeScript or Vite installed. Build, test or prune failures must leave the previous release active.

Keep the externally configured `current/bin/start.mjs` path stable. Copy the release's `REVISION` into the build output so health checks identify the running release correctly. Preserve exact revision checks, the release lock, symlink switch, named PM2 restart and health-triggered rollback.

The receiver, Bash release script and trusted health checker are root-managed files outside the checkout. Their reviewed updates require a separate administrator installation before the new release flow is used. A merge does not update those installed files. Trusted TS tools now compile to standalone `dist/trusted/` artifacts importing only Node builtins, with a SHA256 manifest. Fixed filenames and installation checks are preserved; embedded Node checks now live in `deploy-guard.mjs`.

## Validation and operational limits

- Run strict checks and the full regression suite on Node 22 in CI; run the same checks locally where possible.
- Confirm HTML, JavaScript, CSS and favicon work from the root and a custom prefix, then upload a documented Nikon fixture.
- Verify built code starts after development dependencies are removed.
- Test install, build, test and prune failure before activation, plus health failure and interruption after activation.
- Add browser tests for actual platform behavior; retain fast unit tests for mapping and privacy classifications.
- Confirm the static-file dependency's security advisories are resolved by the locked version; dependency audit is separate from proving production exploitability.
- Verify host-side script installation, available disk/CPU and rollback on the real server before production activation. Local fixtures cannot establish those host guarantees.

Do not log photos, filenames, arbitrary EXIF, raw exceptions or metadata. Bound parser waiting and request duration, remove temporary uploads before completing responses, and retain cleanup-failure diagnostics. Performance limits should follow measured server capacity rather than an assumed traffic target.

## Phase 1 verification

Verified locally on 2026-10-10 with Node 24.21.0: strict Node/browser checks and formatting passed; all 226 compiled regression tests passed; dependency audit reported zero vulnerabilities. An isolated clean installation with only production dependencies started through the stable PM2 bootstrap, served relative assets under a custom prefix, passed ExifTool health, and parsed the Nikon fixture as 526. The development backend also imports mixed TS/JS source successfully through tsx. Node 22 CI and the administrator-installed production release script remain required before production rollout.

## References

[Fastify type providers](https://fastify.dev/docs/latest/Reference/Type-Providers/), [TypeScript strict checking](https://www.typescriptlang.org/tsconfig/strict.html), [Vite guide](https://vite.dev/guide/), [static-file security advisory](https://github.com/fastify/fastify-static/security/advisories/GHSA-83w8-p2f5-377r), and [existing deployment requirements](DEPLOYMENT.md).

## Local delivery of phases 2–4

The backend now separates `app.ts`, `main.ts`, `config.ts`, `photo/upload.ts`, `photo/admission.ts` and `parse.ts`. Each application owns its ExifTool pool. The default whole-upload admission limit is two active uploads, eight queued and a five-second wait. Full/timed-out queues return 503 / `busy`. Temporary files are cleaned before releasing capacity and sending a response; diagnostics retain only the documented fields.

Shared contracts include both compile-time types and runtime decoders. Browser/server checks reject invalid discriminants, counts, bounds and metadata types, and strip undocumented fields. `GET /api/config` publishes the effective byte limit. Failed settings requests can be retried; uploads wait for valid settings. Browser modules separate upload control, API handling, rendering, diagnostics and types.

Every test, smoke script and deployment tool is now TS. `npm run test:browser` uses an isolated session in installed Chrome; builds do not download browsers. The old HTML prototype is retired in favor of the actual page's `?demo` states. PM2 retains the minimal `bin/start.mjs` bootstrap; SIGINT/SIGTERM shutdown has a 20-second deadline and the live host PM2 requires a verified 25-second kill timeout.

Initial local verification on 2026-10-11 used Node 24.21.0 and Chrome 155: strict type and formatting checks, all 238 regression tests and 9 Chrome browser checks passed; the dependency audit reported zero vulnerabilities. An isolated production-only installation verified the stable bootstrap, exact SHA, assets, effective settings, Nikon count 526 and clean shutdown.

The completed local phases are preserved as a migration snapshot on `codex/modernize-typescript`, integrated with main `7e5237a8888686c187c2e6181c09e28a183c2b37`. The Baidu snippet from PR #4 is retained verbatim. PR preparation adds actual browser cancellation coverage and blocks external browser requests, and promotes the production-only check to `npm run test:production` in Node 22 CI. CI records the revision before building, so the production check also verifies the build's revision copy.

Standards and Spec reviews found no blocking runtime or build regression. Their documentation and browser-coverage findings were addressed. The draft PR must record CI evidence for its exact final head before review is complete. Review/release must still satisfy each phase's exit checks; trusted host tools, live PM2 shutdown settings, server capacity and a real-server rollback need separate administrator verification before application activation. No production deployment or main merge is part of this PR preparation.
