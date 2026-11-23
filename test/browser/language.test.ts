import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildApp } from "../../src/app.js";
import { GUIDE } from "../../web/guide.js";

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
        let posts = 0;
        page.on("request", (request) => {
          if (request.method() === "POST") posts += 1;
        });
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
        const stageText = await page.locator("#stage").innerText();
        assert.match(stageText, /Export Unmodified Original/);
        assert.match(stageText, /English illustration/);
        assert.doesNotMatch(
          stageText,
          /导出未修改的原片|反馈这个问题|requestId/
        );
        await page.evaluate(() => {
          (window as unknown as { __scStay?: number }).__scStay = 1;
        });
        await expectGuide(page, origin, "/tools/counter/", GUIDE.en);
        await overflow(page);
        const postsBefore = posts;
        await page.locator("#lang-switch").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "zh-CN"
        );
        assert.equal(
          await page.evaluate(
            () => (window as unknown as { __scStay?: number }).__scStay
          ),
          1
        );
        assert.match(page.url(), /\/tools\/counter\/\?lang=zh$/);
        assert.match(
          await page.locator("#stage").innerText(),
          /未能读取快门次数/
        );
        assert.match(await page.locator("#stage").innerText(), /camera\.jpg/);
        await expectGuide(page, origin, "/tools/counter/", GUIDE.zh);
        assert.equal(posts, postsBefore);
        await page.locator("#lang-switch").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "en"
        );
        assert.equal(
          await page.evaluate(
            () => (window as unknown as { __scStay?: number }).__scStay
          ),
          1
        );
        assert.match(page.url(), /\/tools\/counter\/en\//);
        await expectGuide(page, origin, "/tools/counter/", GUIDE.en);
        assert.equal(posts, postsBefore);

        await page.locator("#file-input").setInputFiles({
          name: "camera.jpg",
          mimeType: "image/jpeg",
          buffer: nikon,
        });
        await page.getByRole("button", { name: "Check another" }).waitFor();
        assert.match(await page.locator("#stage").innerText(), /526/);
        assert.equal(await page.locator(".missing-shutter").count(), 0);
        assert.equal(await page.locator("html").getAttribute("lang"), "en");
        const afterSuccess = posts;
        await page.locator("#lang-switch").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "zh-CN"
        );
        assert.equal(
          await page.evaluate(
            () => (window as unknown as { __scStay?: number }).__scStay
          ),
          1
        );
        assert.match(await page.locator("#stage").innerText(), /526/);
        assert.match(await page.locator("#stage").innerText(), /再查一张/);
        assert.equal(posts, afterSuccess);
        await page.locator("#lang-switch").click();
        await page.waitForFunction(
          () => document.documentElement.lang === "en"
        );
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
  }
);

async function expectGuide(
  page: Page,
  origin: string,
  mount: string,
  spec: { file: string; width: number; height: number }
) {
  const image = page.locator(".missing-shutter__image");
  const src = await image.getAttribute("src");
  assert.equal(src, `${mount}${spec.file}`);
  assert.equal(
    await page.locator(".missing-shutter__zoom").getAttribute("href"),
    src
  );
  const bytes = await page.request.get(origin + src);
  assert.equal(bytes.status(), 200);
  assert.match(bytes.headers()["content-type"] ?? "", /image\/jpeg/);
  const body = Buffer.from(await bytes.body());
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
          img.addEventListener(
            "error",
            () => reject(new Error("guide image failed")),
            { once: true }
          );
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
