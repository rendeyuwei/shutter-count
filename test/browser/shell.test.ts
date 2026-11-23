import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { buildApp } from "../../src/app.js";
import { GUIDE } from "../../web/guide.js";

// Real shell from rende-site 64701ced2b3e495f8e5237148096a5a665e41c17.
// Not a stand-in: these are the bytes that commit published.
const shellJs = await fs.readFile(
  new URL("../fixtures/shell/topbar.js", import.meta.url)
);
const shellCss = await fs.readFile(
  new URL("../fixtures/shell/topbar.css", import.meta.url)
);
const nikon = await fs.readFile(
  new URL("../fixtures/NikonD70.jpg", import.meta.url)
);
const canon = await fs.readFile(
  new URL("../fixtures/Canon.jpg", import.meta.url)
);

test(
  "the real shared bar keeps a result, its switch, history, and mount assets",
  { timeout: 120_000 },
  async (t) => {
    const browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, headless: true }
        : { channel: "chrome", headless: true }
    );
    t.after(() => browser.close());

    for (const basePath of ["/", "/shutter", "/tools/counter"]) {
      await t.test(
        `${basePath} result survives repeated bar toggles`,
        async () => {
          const app = buildApp({ port: 0, basePath, maxUploadMb: 2.5 });
          t.after(() => app.close());
          const origin = await app.listen({ port: 0, host: "127.0.0.1" });
          const mount = basePath === "/" ? "/" : `${basePath}/`;
          const context = await browser.newContext({ locale: "zh-CN" });
          await serveShell(context, origin);
          const page = await context.newPage();
          page.on("pageerror", (error) => {
            throw error;
          });
          let posts = 0;
          page.on("request", (request) => {
            if (request.method() === "POST") posts += 1;
          });
          await page.goto(`${origin}${mount}en/`, {
            waitUntil: "domcontentloaded",
          });
          await page.locator("a.rf-lang").waitFor();
          await page.evaluate(() => {
            const rf = window.rfLang;
            (
              window as unknown as { __rfPlace?: unknown; __rfHref?: unknown }
            ).__rfPlace = rf?.place;
            (window as unknown as { __rfHref?: unknown }).__rfHref = rf?.href;
            (window as unknown as { __scStay?: number }).__scStay = 1;
          });
          const contractOwns = mount === "/" || mount === "/shutter/";
          if (!contractOwns) {
            assert.equal(await page.locator("a.rf-lang").innerText(), "EN");
            assert.equal(
              await page.locator("#lang-switch").getAttribute("hidden"),
              null
            );
          }
          await expectAssets(page, origin, mount);
          await page.locator("#file-input").setInputFiles({
            name: "camera.jpg",
            mimeType: "image/jpeg",
            buffer: canon,
          });
          await page
            .getByRole("heading", { name: "Shutter count was not found" })
            .waitFor();
          await expectGuide(page, origin, mount, GUIDE.en);
          const posted = posts;

          if (!contractOwns) {
            assert.equal(
              await page.locator("#lang-switch").getAttribute("hidden"),
              null
            );
          }
          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "zh-CN"
          );
          assert.equal(await stayed(page), 1);
          assert.equal(posts, posted);
          assert.match(
            await page.locator("#stage").innerText(),
            /未能读取快门次数/
          );
          await expectGuide(page, origin, mount, GUIDE.zh);
          await expectAssets(page, origin, mount);
          assert.equal(await page.locator("a.rf-lang").innerText(), "EN");
          assert.equal(
            await page.locator("a.rf-home .rf-t").innerText(),
            contractOwns ? "Back to home" : "回到主站"
          );

          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "en"
          );
          assert.equal(await stayed(page), 1);
          assert.equal(posts, posted);
          assert.match(
            await page.locator("#stage").innerText(),
            /English illustration/
          );
          await expectGuide(page, origin, mount, GUIDE.en);
          await expectAssets(page, origin, mount);
          assert.equal(await page.locator("a.rf-lang").innerText(), "中文");
          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "zh-CN"
          );
          await page.goBack();
          await page.waitForFunction(
            () => document.documentElement.lang === "en"
          );
          await expectGuide(page, origin, mount, GUIDE.en);
          await expectAssets(page, origin, mount);
          assert.equal(await page.locator("a.rf-lang").innerText(), "中文");
          await page.goForward();
          await page.waitForFunction(
            () => document.documentElement.lang === "zh-CN"
          );
          await expectGuide(page, origin, mount, GUIDE.zh);
          assert.equal(await page.locator("a.rf-lang").innerText(), "EN");
          await page.goBack();
          await page.waitForFunction(
            () => document.documentElement.lang === "en"
          );

          await page.locator("#file-input").setInputFiles({
            name: "camera.jpg",
            mimeType: "image/jpeg",
            buffer: nikon,
          });
          await page.getByRole("button", { name: "Check another" }).waitFor();
          assert.equal(posts, posted + 1);
          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "zh-CN"
          );
          assert.match(await page.locator("#stage").innerText(), /526/);
          assert.match(await page.locator("#stage").innerText(), /再查一张/);
          assert.equal(posts, posted + 1);
          assert.equal(await stayed(page), 1);
          await expectAssets(page, origin, mount);
          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "en"
          );

          await page.locator("#file-input").setInputFiles({
            name: "notes.png",
            mimeType: "image/png",
            buffer: Buffer.from("nope"),
          });
          await page.getByText("This file could not be read").waitFor();
          assert.equal(posts, posted + 1);
          await clickVisibleSwitch(page);
          await page.waitForFunction(
            () => document.documentElement.lang === "zh-CN"
          );
          assert.match(
            await page.locator("#stage").innerText(),
            /无法解析该文件/
          );
          assert.equal(posts, posted + 1);
          await expectAssets(page, origin, mount);
          assert.equal(
            await page.evaluate(() => {
              const rf = window.rfLang;
              const mark = window as unknown as {
                __rfPlace?: unknown;
                __rfHref?: unknown;
              };
              return rf?.place === mark.__rfPlace && rf?.href === mark.__rfHref;
            }),
            true
          );
          await context.close();
        }
      );
    }

    await t.test(
      "blocked storage still toggles the real /shutter bar",
      async () => {
        const app = buildApp({
          port: 0,
          basePath: "/shutter",
          maxUploadMb: 2.5,
        });
        t.after(() => app.close());
        const origin = await app.listen({ port: 0, host: "127.0.0.1" });
        const context = await browser.newContext({ locale: "zh-CN" });
        await context.addInitScript(() => {
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
              throw new Error("blocked");
            },
          });
          Object.defineProperty(document, "cookie", {
            configurable: true,
            get() {
              return "";
            },
            set() {
              throw new Error("blocked");
            },
          });
        });
        await serveShell(context, origin);
        const page = await context.newPage();
        page.on("pageerror", (error) => {
          throw error;
        });
        await page.goto(`${origin}/shutter/en/`, {
          waitUntil: "domcontentloaded",
        });
        await page.locator("#file-input").setInputFiles({
          name: "camera.jpg",
          mimeType: "image/jpeg",
          buffer: canon,
        });
        await page
          .getByRole("heading", { name: "Shutter count was not found" })
          .waitFor();
        await page.locator("a.rf-lang").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "zh-CN"
        );
        assert.equal(await page.locator("a.rf-lang").innerText(), "EN");
        await expectGuide(page, origin, "/shutter/", GUIDE.zh);
        await page.locator("a.rf-lang").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "en"
        );
        assert.equal(await page.locator("a.rf-lang").innerText(), "中文");
        await expectAssets(page, origin, "/shutter/");
        await context.close();
      }
    );
  }
);

async function serveShell(context: BrowserContext, origin: string) {
  await context.route("**/*", async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await context.route("**/shell/topbar.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: shellJs,
    })
  );
  await context.route("**/shell/topbar.css", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      body: shellCss,
    })
  );
}

async function clickVisibleSwitch(page: Page) {
  const inline = page.locator("#lang-switch");
  const hidden = await inline.getAttribute("hidden");
  const target = hidden === null ? inline : page.locator("a.rf-lang");
  await target.click();
}

async function stayed(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __scStay?: number }).__scStay
  );
}

async function expectAssets(page: Page, origin: string, mount: string) {
  const urls = await page.evaluate(() => ({
    icon: (document.querySelector('link[rel="icon"]') as HTMLLinkElement).href,
    css: (
      document.querySelector(
        'link[rel="stylesheet"]:not([data-rf])'
      ) as HTMLLinkElement
    ).href,
    app: (document.querySelector('script[type="module"]') as HTMLScriptElement)
      .src,
  }));
  assert.deepEqual(urls, {
    icon: `${origin}${mount}favicon.svg`,
    css: `${origin}${mount}styles.css`,
    app: `${origin}${mount}app.js`,
  });
  for (const url of Object.values(urls)) {
    const response = await page.request.get(url);
    assert.equal(response.status(), 200, url);
  }
}

async function expectGuide(
  page: Page,
  origin: string,
  mount: string,
  spec: { file: string; width: number; height: number }
) {
  const image = page.locator(".missing-shutter__image");
  const src = await image.getAttribute("src");
  assert.equal(src, `${mount}${spec.file}`);
  const response = await page.request.get(origin + src);
  assert.equal(response.status(), 200);
  assert.match(response.headers()["content-type"] ?? "", /image\/jpeg/);
  const body = Buffer.from(await response.body());
  const file = await fs.readFile(
    new URL(`../../public/${spec.file}`, import.meta.url)
  );
  assert.deepEqual(body, file);
  assert.deepEqual(jpegSize(body), { width: spec.width, height: spec.height });
  const natural = await image.evaluate(
    (element) =>
      new Promise<{ width: number; height: number }>((resolve, reject) => {
        const img = element as HTMLImageElement;
        const done = () =>
          resolve({ width: img.naturalWidth, height: img.naturalHeight });
        if (img.complete && img.naturalWidth > 0) done();
        else {
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", () => reject(new Error("guide")), {
            once: true,
          });
        }
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
  throw new Error("JPEG has no size marker");
}
