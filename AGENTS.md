# Repository Guidelines

## Project Structure & Module Organization

- `src/app.ts`: Fastify assembly and routes; `src/main.ts`: listening and graceful shutdown; `src/config.ts`: validated configuration.
- `src/photo/`: bounded admission, upload validation, diagnostics, and awaited temporary-file cleanup.
- `src/parse.ts`: application-owned ExifTool lifecycle and JPEG parsing; `src/mapping.ts`: pure camera-brand and shutter-tag mapping.
- `web/`: browser TypeScript and HTML; `public/`: CSS and favicon; Vite emits served assets to `dist/public/`.
- `shared/`: typed and runtime-validated result contracts; `tools/build.ts`: Node/Vite build orchestration. The staged migration is tracked in `docs/MODERNIZATION.md`.
- `test/`: regression tests and sample JPEGs in `test/fixtures/`; fixture provenance and expected results live in its `README.md`.
- `scripts/`, `deploy/`, `bin/`, and `ecosystem.config.cjs`: smoke checks, release tooling, and PM2 startup.
- `docs/`: product requirements, design notes, and deployment guides.

## Build, Test, and Development Commands

Use Node.js 22.12 or newer; `.nvmrc` selects Node 22.

- `npm ci`: install dependencies from the committed lockfile.
- `npm run build`: compile Node code/tests and build browser assets into ignored `dist/`.
- `npm run typecheck`: strict-check all TS, including the separate browser configuration.
- `npm run test:browser`: run the compiled real-browser suite using installed Chrome (or `CHROME_PATH`).
- `npm run format:check`: check formatting of all TS and build configuration.
- `npm start`: run locally at `http://127.0.0.1:3020/shutter/` by default.
- `npm test`: build and run all compiled tests with `node --test`; `npm run test:built` reuses a completed build.
- `node --test dist/test/mapping.test.js`: run a focused test file after building.
- `npm run smoke -- test/fixtures/NikonD70.jpg`: check page, health, and parsing against a separately running service.

Run `npm run build` before `npm start`. Smoke checks supplement assertions; HTTP 4xx parse responses do not fail the smoke script.

## Coding Style & Naming Conventions

Match existing two-space indentation, double-quoted TypeScript strings, and semicolons. Use ESM imports with explicit file extensions, `camelCase` functions/variables, and `UPPER_SNAKE_CASE` constants. Keep mapping logic free of I/O and ExifTool operations in `parse.ts`. Render dynamic browser text through `textContent`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; name files `test/*.test.ts` and describe observable behavior in test titles. Add regression tests for changed behavior, including failure paths. Use Fastify injection for route tests and documented JPEG fixtures for parser tests. Close app/ExifTool resources and remove temporary files during teardown. No numeric coverage threshold is configured; run the full suite before submitting.

For deployment-script changes, also run CI's syntax checks: `bash -n scripts/deploy-release.sh`, `node --check dist/trusted/receive-deploy.mjs`, `node --check dist/trusted/deploy-ssh.mjs`, and `node --check dist/trusted/deploy-guard.mjs`.

## Commit & Pull Request Guidelines

Follow history's Conventional Commit style: `feat:`, `fix:`, or `docs:`, with optional scopes such as `fix(api):`. Keep changes focused. PRs should explain the problem, resulting behavior, and validation; link relevant issues and include screenshots for UI changes. Update English and Chinese documentation together when documented behavior changes.

## Security & Configuration Tips

Preserve temporary-upload cleanup and privacy-safe diagnostics: exclude photo content, filenames, and raw EXIF from logs/reports. Keep browser/server upload limits aligned and restrict `TRUST_PROXY` to actual proxies. Before changing release automation or host configuration, read `docs/DEPLOYMENT.md`; keep deployment credentials outside the repository.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for `rendeyuwei/shutter-count`. Before fetching, publishing, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before triaging or changing triage labels, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: root `GLOSSARY.md` and `docs/adr/`. Before exploring the codebase, read `docs/agents/domain.md`.
