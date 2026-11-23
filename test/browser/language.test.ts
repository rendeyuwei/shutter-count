import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildApp } from "../../src/app.js";

const nikon = await fs.readFile(
  new URL("../fixtures/NikonD70.jpg", import.meta.url)
);
const canon = await fs.readFile(
  new URL("../fixtures/Canon.jpg", import.meta.url)
);

async function overflow(page: Page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    ),
    true
  );
}

test(
  "language pages negotiate, reset, and keep the full guide image",
  { timeout: 90_000 },
  async (t) => {
    const browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, headless: true }
        : { channel: "chrome", headless: true }
    );
    t.after(() => browser.close());

    await t.test(
      "custom mount keeps locale through success and failure",
      async () => {
        const app = buildApp({
          port: 0,
          basePath: "/tools/counter",
          maxUploadMb: 2.5,
        });
        t.after(() => app.close());
        const origin = await app.listen({ port: 0, host: "127.0.0.1" });
        const page = await open(browser, origin, "zh-CN");
        const root = origin + "/tools/counter/";
        await page.goto(root);
        assert.equal(page.url(), root);
        assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
        await page.setViewportSize({ width: 390, height: 844 });
        await overflow(page);

        await page.goto(root + "en/");
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        assert.match(
          await page.locator("h1").innerText(),
          /Check your camera shutter count/
        );
        await overflow(page);
        await page.locator("#file-input").setInputFiles({
          name: "camera.jpg",
          mimeType: "image/jpeg",
          buffer: canon,
        });
        await page
          .getByRole("heading", { name: "Shutter count was not found" })
          .waitFor();
        assert.match(
          await page.locator("#stage").innerText(),
          /Export Unmodified Original/
        );
        assert.doesNotMatch(
          await page.locator("#stage").innerText(),
          /反馈这个问题|requestId/
        );
        const image = page.locator(".missing-shutter__image");
        const src = await image.getAttribute("src");
        assert.equal(src, "/tools/counter/iphone-export-original.jpg");
        const bytes = await page.request.get(origin + src);
        assert.equal(bytes.status(), 200);
        const body = Buffer.from(await bytes.body());
        assert.equal(body[0], 0xff);
        assert.equal(body[1], 0xd8);
        const natural = await image.evaluate((element) => {
          const img = element as HTMLImageElement;
          return { width: img.naturalWidth, height: img.naturalHeight };
        });
        assert.deepEqual(natural, { width: 1206, height: 1550 });
        await overflow(page);

        await page.locator("#file-input").setInputFiles({
          name: "camera.jpg",
          mimeType: "image/jpeg",
          buffer: nikon,
        });
        await page.getByRole("button", { name: "Check another" }).waitFor();
        assert.match(await page.locator("#stage").innerText(), /526/);
        assert.equal(await page.locator(".missing-shutter").count(), 0);
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        await overflow(page);
        await page.getByRole("button", { name: "Check another" }).click();
        await page
          .getByRole("button", { name: "Click or drop an original photo here" })
          .waitFor();

        await page.locator("#file-input").setInputFiles({
          name: "notes.png",
          mimeType: "image/png",
          buffer: Buffer.from("nope"),
        });
        await page.getByText("This file could not be read").waitFor();
        assert.equal(await page.locator(".missing-shutter").count(), 0);
        await page.getByRole("button", { name: "Upload again" }).click();
        await page
          .getByRole("button", { name: "Click or drop an original photo here" })
          .waitFor();
      }
    );

    await t.test(
      "explicit URL wins and automatic choice is not stored",
      async () => {
        const app = buildApp({
          port: 0,
          basePath: "/shutter",
          maxUploadMb: 2.5,
        });
        t.after(() => app.close());
        const origin = await app.listen({ port: 0, host: "127.0.0.1" });
        const english = await browser.newContext({ locale: "en-US" });
        await blockExternal(english, origin);
        const page = await english.newPage();
        await page.goto(origin + "/shutter/?album=1#shot");
        await page.waitForURL(/\/shutter\/en\/\?album=1#shot$/);
        assert.equal(
          await page.evaluate(() => localStorage.getItem("rf-lang")),
          null
        );
        await page.goto(origin + "/shutter/?lang=zh");
        await page.waitForTimeout(100);
        assert.equal(new URL(page.url()).pathname, "/shutter/");
        assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
        await english.close();

        const hongKong = await browser.newContext({ locale: "zh-HK" });
        await blockExternal(hongKong, origin);
        const hk = await hongKong.newPage();
        await hk.goto(origin + "/shutter/");
        await hk.waitForTimeout(100);
        assert.equal(new URL(hk.url()).pathname, "/shutter/");
        await hongKong.close();

        const french = await browser.newContext({ locale: "fr-FR" });
        await blockExternal(french, origin);
        const fr = await french.newPage();
        await fr.goto(origin + "/shutter/en/?keep=1#stay");
        await fr.waitForTimeout(100);
        assert.equal(new URL(fr.url()).pathname, "/shutter/en/");
        assert.match(fr.url(), /keep=1/);
        assert.match(fr.url(), /#stay/);
        await french.close();
      }
    );

    await t.test(
      "blocked storage can still switch and does not loop",
      async () => {
        const app = buildApp({ port: 0, basePath: "/", maxUploadMb: 2.5 });
        t.after(() => app.close());
        const origin = await app.listen({ port: 0, host: "127.0.0.1" });
        const context = await browser.newContext({ locale: "zh-CN" });
        await blockExternal(context, origin);
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
        const page = await context.newPage();
        await page.goto(origin + "/en/#kept");
        await page.waitForTimeout(100);
        assert.equal(new URL(page.url()).pathname, "/en/");
        await page.locator("#lang-switch").click();
        await page.waitForURL(/\/\?lang=zh#kept$/);
        assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
        await page.goto(origin + "/");
        await page.waitForTimeout(100);
        assert.equal(new URL(page.url()).pathname, "/");
        await context.close();
      }
    );

    await t.test("custom mount topbar can leave English", async () => {
      const app = buildApp({
        port: 0,
        basePath: "/tools/counter",
        maxUploadMb: 2.5,
      });
      t.after(() => app.close());
      const origin = await app.listen({ port: 0, host: "127.0.0.1" });
      const context = await browser.newContext({ locale: "zh-CN" });
      await blockExternal(context, origin);
      await context.route("**/shell/topbar.js", (route) =>
        route.fulfill({
          contentType: "text/javascript; charset=utf-8",
          body: TOPBAR_STUB,
        })
      );
      const page = await context.newPage();
      await page.goto(origin + "/tools/counter/en/?album=1#shot");
      await page.locator("a.rf-lang").waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-bar-lang"),
        "en"
      );
      assert.equal(
        await page.locator("#lang-switch").getAttribute("hidden"),
        ""
      );
      assert.equal(
        await page.locator("a.rf-lang").getAttribute("href"),
        "/tools/counter/?album=1&lang=zh#shot"
      );
      await page.locator("a.rf-lang").click();
      await page.waitForURL(/\/tools\/counter\/\?album=1&lang=zh#shot$/);
      await page.waitForTimeout(200);
      assert.equal(new URL(page.url()).pathname, "/tools/counter/");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("rf-lang")),
        "zh"
      );
      assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");

      await page.goto(origin + "/tools/counter/?album=1#shot");
      await page.locator("a.rf-lang").waitFor();
      assert.equal(
        await page.locator("html").getAttribute("data-bar-lang"),
        "zh"
      );
      assert.equal(
        await page.locator("a.rf-lang").getAttribute("href"),
        "/tools/counter/en/?album=1#shot"
      );
      await page.locator("a.rf-lang").click();
      await page.waitForURL(/\/tools\/counter\/en\/\?album=1#shot$/);
      await page.waitForTimeout(200);
      assert.equal(new URL(page.url()).pathname, "/tools/counter/en/");
      assert.equal(
        await page.evaluate(() => localStorage.getItem("rf-lang")),
        "en"
      );
      await context.close();
    });
  }
);

const TOPBAR_STUB = `(function () {
  var rf = window.rfLang;
  if (!rf || !document.body) return;
  var here = rf.place(location.pathname);
  var other = here.lang === "en" ? "zh" : "en";
  var toggle = document.createElement("a");
  toggle.className = "rf-lang";
  toggle.textContent = other === "en" ? "EN" : "\\u4e2d\\u6587";
  toggle.href = rf.href(other);
  toggle.addEventListener("click", function () {
    rf.choose(other);
    toggle.href = rf.href(other);
  });
  document.body.insertBefore(toggle, document.body.firstChild);
  document.documentElement.setAttribute("data-bar-lang", here.lang);
})();`;

async function blockExternal(
  context: Awaited<ReturnType<Browser["newContext"]>>,
  origin: string
) {
  await context.route("**/*", async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) await route.continue();
    else await route.abort("blockedbyclient");
  });
}

async function open(browser: Browser, origin: string, locale: string) {
  const context = await browser.newContext({ locale });
  await blockExternal(context, origin);
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  return page;
}
