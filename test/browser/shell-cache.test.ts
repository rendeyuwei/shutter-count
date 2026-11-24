import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildApp } from "../../src/app.js";
import { GUIDE } from "../../web/guide.js";

// Local bytes from rende-site fdaa701. Do not request these hash URLs publicly.
const SHELL_JS =
  "/shell/topbar.4a304e017601ad56e80a5c39886c186fa462161ce585d093ae92c4cfc17edd7b.js";
const SHELL_CSS =
  "/shell/topbar.918f2c1a3eaa24581dfb11b360b323fa925b5a2548108b6ad5d8bd98ff3cc23b.css";
const TOPBAR_SHA =
  "4a304e017601ad56e80a5c39886c186fa462161ce585d093ae92c4cfc17edd7b";
const CSS_SHA =
  "918f2c1a3eaa24581dfb11b360b323fa925b5a2548108b6ad5d8bd98ff3cc23b";

const shellJs = await readFile(
  new URL(`../fixtures/shell/${path.basename(SHELL_JS)}`, import.meta.url)
);
const shellCss = await readFile(
  new URL(`../fixtures/shell/${path.basename(SHELL_CSS)}`, import.meta.url)
);
const october = await readFile(
  new URL("../fixtures/shell/topbar-2026-10-22.js", import.meta.url)
);
const nikon = await readFile(
  new URL("../fixtures/NikonD70.jpg", import.meta.url)
);
const canon = await readFile(new URL("../fixtures/Canon.jpg", import.meta.url));

test(
  "a disk-cached Chinese topbar does not paint the new English page",
  { timeout: 180_000 },
  async () => {
    assert.equal(
      createHash("sha256").update(shellJs).digest("hex"),
      TOPBAR_SHA
    );
    assert.equal(shellJs.length, 9981);
    assert.equal(createHash("sha256").update(shellCss).digest("hex"), CSS_SHA);
    const app = buildApp({
      port: 0,
      basePath: "/shutter",
      maxUploadMb: 2.5,
    });
    const upstream = new URL(await app.listen({ port: 0, host: "127.0.0.1" }));
    const stats = { october: 0, pinned: 0 };
    const proxy = await startProxy(Number(upstream.port), stats);
    const dir = await mkdtemp(path.join(tmpdir(), "shutter-shell-cache-"));
    const launch = {
      ...(process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH }
        : { channel: "chrome" as const }),
      headless: true,
      locale: "zh-CN" as const,
      viewport: { width: 1280, height: 900 },
      args: [
        `--disk-cache-dir=${path.join(dir, "cache")}`,
        "--disk-cache-size=67108864",
      ],
    };
    let browser = await chromium.launchPersistentContext(dir, launch);
    try {
      let session = await watch(browser, proxy.origin);
      await session.page.goto(`${proxy.origin}/cache-seed.html`, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(await buttonText(session.page), "工具");
      assert.equal(await session.page.locator("a.rf-lang").count(), 0);
      assert.equal(stats.october, 1);
      await browser.close();

      browser = await chromium.launchPersistentContext(dir, launch);
      session = await watch(browser, proxy.origin);
      await session.page.goto(`${proxy.origin}/cache-seed.html?again=1`, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(await buttonText(session.page), "工具");
      assert.equal(
        stats.october,
        1,
        "the restarted browser did not reuse the cached topbar"
      );

      const seen = session.scripts.length;
      const html = await session.page.goto(
        `${proxy.origin}/shutter/en/?album=1#shot`,
        { waitUntil: "domcontentloaded" }
      );
      await session.page.locator("a.rf-lang").waitFor();
      const fresh = session.scripts.slice(seen);
      assert.equal(stats.october, 1, JSON.stringify(fresh));
      assert.equal(stats.pinned, 1, JSON.stringify(fresh));
      assert.deepEqual(fresh, [SHELL_JS]);
      assert.equal(html?.headers()["cache-control"], "no-cache");
      assert.match(await html!.text(), new RegExp(escapeRegExp(SHELL_JS)));
      assert.equal(new URL(session.page.url()).pathname, "/shutter/en/");
      assert.equal(new URL(session.page.url()).search, "?album=1");
      assert.equal(new URL(session.page.url()).hash, "#shot");
      await expectEnglish(session.page);
      assert.equal(await session.page.evaluate(() => window.rfLang?.v), 2);
      await expectNoOverflow(session.page);
      await session.page.setViewportSize({ width: 390, height: 800 });
      await expectNoOverflow(session.page);
      await session.page.setViewportSize({ width: 320, height: 700 });
      await expectNoOverflow(session.page);
      await session.page.setViewportSize({ width: 1280, height: 900 });

      const warm = session.scripts.length;
      await session.page.goto(
        `${proxy.origin}/shutter/en/?album=1&warm=1#shot`,
        { waitUntil: "domcontentloaded" }
      );
      await session.page.locator("a.rf-lang").waitFor();
      assert.equal(
        stats.pinned,
        1,
        JSON.stringify(session.scripts.slice(warm))
      );
      assert.deepEqual(session.scripts.slice(warm), [SHELL_JS]);
      assert.equal(new URL(session.page.url()).hash, "#shot");
      const page = session.page;

      await page.locator("#file-input").setInputFiles({
        name: "camera.jpg",
        mimeType: "image/jpeg",
        buffer: canon,
      });
      await page
        .getByRole("heading", { name: "Shutter count was not found" })
        .waitFor();
      await expectGuide(page, GUIDE.en);
      const posted = session.posts;
      await page.setViewportSize({ width: 390, height: 800 });
      await expectNoOverflow(page);
      await page.setViewportSize({ width: 320, height: 700 });
      await expectNoOverflow(page);

      await page.evaluate(() => {
        (window as unknown as { __scBar?: Element | null }).__scBar =
          document.querySelector("header.rf-bar");
      });
      await clickSwitch(page);
      await settled(page, "zh");
      assert.equal(await focusedSwitch(page), true);
      assert.equal(session.posts, posted);
      const switched = new URL(page.url());
      assert.equal(switched.pathname, "/shutter/");
      assert.match(switched.search, /(?:^|[?&])album=1(?:&|$)/);
      assert.match(switched.search, /(?:^|[?&])lang=zh(?:&|$)/);
      assert.equal(switched.hash, "#shot");
      await expectChinese(page);
      await expectGuide(page, GUIDE.zh);
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector("header.rf-bar") ===
            (window as unknown as { __scBar?: Element | null }).__scBar
        ),
        true
      );
      assert.equal(await page.evaluate(() => window.rfLang?.v), 2);
      await expectNoOverflow(page);
      await page.setViewportSize({ width: 390, height: 800 });
      await expectNoOverflow(page);

      await page.goBack();
      await settled(page, "en");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("rf-lang")),
        "zh"
      );
      const returned = new URL(page.url());
      assert.equal(returned.pathname, "/shutter/en/");
      assert.match(returned.search, /album=1/);
      assert.equal(returned.hash, "#shot");
      await expectGuide(page, GUIDE.en);
      assert.equal(session.posts, posted);

      await page.locator("#file-input").setInputFiles({
        name: "camera.jpg",
        mimeType: "image/jpeg",
        buffer: nikon,
      });
      await page.getByRole("button", { name: "Check another" }).waitFor();
      assert.equal(session.posts, posted + 1);
      await clickSwitch(page);
      await settled(page, "zh");
      assert.match(await page.locator("#stage").innerText(), /526/);
      assert.match(await page.locator("#stage").innerText(), /再查一张/);
      assert.equal(session.posts, posted + 1);

      await page.locator("#file-input").setInputFiles({
        name: "notes.png",
        mimeType: "image/png",
        buffer: Buffer.from("nope"),
      });
      await page.getByText("无法解析该文件").waitFor();
      assert.equal(session.posts, posted + 1);
      assert.deepEqual(session.foreignPosts, []);
      assert.deepEqual(session.errors, []);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => proxy.server.close(() => resolve()));
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
);

async function watch(
  browser: Awaited<ReturnType<typeof chromium.launchPersistentContext>>,
  origin: string
) {
  const page = browser.pages()[0] ?? (await browser.newPage());
  const state = {
    page,
    scripts: [] as string[],
    posts: 0,
    errors: [] as string[],
    foreignPosts: [] as string[],
  };
  page.on("pageerror", (error) => state.errors.push(String(error)));
  page.on("request", (request) => {
    const requested = new URL(request.url());
    if (/\/topbar(?:\.[0-9a-f]{64})?\.js$/.test(requested.pathname)) {
      state.scripts.push(requested.pathname);
    }
    if (request.method() === "POST") {
      state.posts += 1;
      if (requested.origin !== origin)
        state.foreignPosts.push(requested.origin);
    }
  });
  return state;
}

function startProxy(port: number, stats: { october: number; pinned: number }) {
  const files = new Map<string, { body: Buffer; type: string }>([
    [SHELL_JS, { body: shellJs, type: "text/javascript; charset=utf-8" }],
    [SHELL_CSS, { body: shellCss, type: "text/css; charset=utf-8" }],
  ]);
  const seed = Buffer.from(`<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>已缓存的中文页</title></head>
<body>
<script src="/shell/topbar.js" defer data-tool="shutter"></script>
</body>
</html>`);
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/shell/topbar.js") {
      stats.october += 1;
      send(res, 200, october, {
        "Content-Type": "text/javascript; charset=utf-8",
        "Last-Modified": "Thu, 22 Oct 2026 03:35:52 GMT",
      });
      return;
    }
    const pinned = files.get(url.pathname);
    if (pinned) {
      if (url.pathname === SHELL_JS) stats.pinned += 1;
      send(res, 200, pinned.body, {
        "Content-Type": pinned.type,
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      return;
    }
    if (url.pathname.startsWith("/shell/")) {
      send(res, 404, Buffer.from("missing"), {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      return;
    }
    if (url.pathname === "/cache-seed.html") {
      send(res, 200, seed, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      return;
    }
    forward(req, res, port);
  });
  return new Promise<{ origin: string; server: typeof server }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("proxy did not bind");
      }
      resolve({ origin: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Record<string, string>
) {
  res.writeHead(status, {
    "Content-Length": String(body.length),
    ...headers,
  });
  res.end(body);
}

function forward(req: IncomingMessage, res: ServerResponse, port: number) {
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers["proxy-connection"];
  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.pipe(upstream);
}

async function buttonText(page: Page) {
  return page.locator(".rf-btn").evaluate((node) =>
    [...node.childNodes]
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => child.textContent)
      .join("")
      .trim()
  );
}

async function expectEnglish(page: Page) {
  assert.equal(await page.locator(".rf-cur").textContent(), "ShutterCount");
  assert.equal(await buttonText(page), "Tools");
  assert.equal(await page.locator("a.rf-lang").textContent(), "中文");
  assert.equal(
    await page.locator(".rf-home .rf-t").textContent(),
    "Back to home"
  );
}

async function expectChinese(page: Page) {
  assert.equal(await page.locator(".rf-cur").textContent(), "快门计数");
  assert.equal(await buttonText(page), "工具");
  assert.equal(await page.locator("a.rf-lang").textContent(), "EN");
  assert.equal(await page.locator(".rf-home .rf-t").textContent(), "回到主站");
}

async function expectNoOverflow(page: Page) {
  const box = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    bar: document.querySelector("header.rf-bar")?.scrollWidth ?? 0,
  }));
  assert.ok(box.scroll <= box.client, JSON.stringify(box));
  assert.ok(box.bar <= box.client, JSON.stringify(box));
}

async function expectGuide(
  page: Page,
  spec: { file: string; width: number; height: number }
) {
  const image = page.locator(".missing-shutter__image");
  const src = await image.getAttribute("src");
  assert.equal(src, `/shutter/${spec.file}`);
  const response = await page.request.get(new URL(src!, page.url()).href);
  assert.equal(response.status(), 200);
  const body = Buffer.from(await response.body());
  const file = await readFile(
    new URL(`../../public/${spec.file}`, import.meta.url)
  );
  assert.deepEqual(body, file);
  assert.deepEqual(jpegSize(body), { width: spec.width, height: spec.height });
  const natural = await image.evaluate(
    (element) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = element as HTMLImageElement;
        if (img.complete && img.naturalWidth) {
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
          return;
        }
        img.addEventListener("load", () =>
          resolve({ width: img.naturalWidth, height: img.naturalHeight })
        );
        img.addEventListener("error", () => reject(new Error("image")));
      })
  );
  assert.deepEqual(natural, { width: spec.width, height: spec.height });
}

function jpegSize(body: Buffer) {
  let offset = 2;
  while (offset + 8 < body.length && body[offset] === 0xff) {
    const marker = body[offset + 1] ?? 0;
    const length = body.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return {
        height: body.readUInt16BE(offset + 5),
        width: body.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  throw new Error("jpeg size missing");
}

async function clickSwitch(page: Page) {
  await page.evaluate(() => {
    const link = document.querySelector("a.rf-lang");
    if (!(link instanceof HTMLAnchorElement)) throw new Error("missing switch");
    link.focus();
    link.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
  });
}

async function focusedSwitch(page: Page) {
  return page.evaluate(
    () => document.activeElement === document.querySelector("a.rf-lang")
  );
}

async function settled(page: Page, lang: "en" | "zh") {
  await page.waitForFunction(
    (expected) => document.documentElement.lang === expected,
    lang === "en" ? "en" : "zh-CN"
  );
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
