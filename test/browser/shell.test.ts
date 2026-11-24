import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { buildApp } from "../../src/app.js";
import { GUIDE } from "../../web/guide.js";

// Exact dist/shell bytes from rende-site fdaa701bbf2736ee2874cfe5456bd25d941145f6.
// The page pins these names. Tests never request the public hash URLs.
const SHELL_JS =
  "/shell/topbar.4a304e017601ad56e80a5c39886c186fa462161ce585d093ae92c4cfc17edd7b.js";
const SHELL_CSS =
  "/shell/topbar.918f2c1a3eaa24581dfb11b360b323fa925b5a2548108b6ad5d8bd98ff3cc23b.css";
const shellJs = await fs.readFile(
  new URL(
    `../fixtures/shell/${SHELL_JS.slice("/shell/".length)}`,
    import.meta.url
  )
);
const shellCss = await fs.readFile(
  new URL(
    `../fixtures/shell/${SHELL_CSS.slice("/shell/".length)}`,
    import.meta.url
  )
);
const nikon = await fs.readFile(
  new URL("../fixtures/NikonD70.jpg", import.meta.url)
);
const canon = await fs.readFile(
  new URL("../fixtures/Canon.jpg", import.meta.url)
);

test(
  "the v2 shell refreshes the whole bar without a second navigation",
  { timeout: 180_000 },
  async (t) => {
    const browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, headless: true }
        : { channel: "chrome", headless: true }
    );
    t.after(() => browser.close());

    for (const basePath of ["/", "/shutter", "/tools/counter"]) {
      await t.test(
        `${basePath} toggles the real bar on every result`,
        async () => {
          const app = buildApp({ port: 0, basePath, maxUploadMb: 2.5 });
          t.after(() => app.close());
          const origin = await app.listen({ port: 0, host: "127.0.0.1" });
          const mount = basePath === "/" ? "/" : `${basePath}/`;
          const context = await browser.newContext({ locale: "zh-CN" });
          await context.addInitScript(countListeners);
          await serveShell(context, origin);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          let posts = 0;
          let shellScripts = 0;
          page.on("request", (request) => {
            if (request.method() === "POST") posts += 1;
            if (new URL(request.url()).pathname === SHELL_JS) shellScripts += 1;
          });
          await page.goto(`${origin}${mount}en/`, {
            waitUntil: "domcontentloaded",
          });
          await page.locator("a.rf-lang").waitFor();
          await page.evaluate(() => {
            const rf = window.rfLang;
            const mark = window as unknown as {
              __rfPlace?: unknown;
              __rfHref?: unknown;
              __scStay?: number;
              __scBar?: Element | null;
            };
            mark.__rfPlace = rf?.place;
            mark.__rfHref = rf?.href;
            mark.__scStay = 1;
            mark.__scBar = document.querySelector("header.rf-bar");
          });
          await expectChrome(page, origin, mount, "en", true);
          assert.equal(await pref(page), null);
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
          const listeners = await listenerSnapshot(page);
          let current: "en" | "zh" = "en";
          for (let step = 0; step < 5; step += 1) {
            current = current === "en" ? "zh" : "en";
            await clickSwitch(page);
            await settled(page, current);
            await expectChrome(page, origin, mount, current, true);
            await expectGuide(
              page,
              origin,
              mount,
              current === "en" ? GUIDE.en : GUIDE.zh
            );
            await expectAssets(page, origin, mount);
            assert.equal(await focusedSwitch(page), true);
            assert.equal(posts, posted);
            assert.equal(await stayed(page), 1);
          }
          assert.equal(current, "zh");
          assert.equal(await pref(page), "zh");
          assert.equal(await listenerSnapshot(page), listeners);
          assert.equal(shellScripts, 1);
          assert.deepEqual(errors, []);

          await page.goBack();
          await settled(page, "en");
          await expectChrome(page, origin, mount, "en", true);
          await expectGuide(page, origin, mount, GUIDE.en);
          assert.equal(await pref(page), "zh");
          await page.goForward();
          await settled(page, "zh");
          await expectChrome(page, origin, mount, "zh", true);
          assert.equal(await pref(page), "zh");
          assert.equal(posts, posted);

          await page.goBack();
          await settled(page, "en");
          await page.locator("#file-input").setInputFiles({
            name: "camera.jpg",
            mimeType: "image/jpeg",
            buffer: nikon,
          });
          await page.getByRole("button", { name: "Check another" }).waitFor();
          assert.equal(posts, posted + 1);
          await clickSwitch(page);
          await settled(page, "zh");
          assert.match(await page.locator("#stage").innerText(), /526/);
          assert.match(await page.locator("#stage").innerText(), /再查一张/);
          await expectChrome(page, origin, mount, "zh", true);
          assert.equal(posts, posted + 1);
          await clickSwitch(page);
          await settled(page, "en");

          await page.locator("#file-input").setInputFiles({
            name: "notes.png",
            mimeType: "image/png",
            buffer: Buffer.from("nope"),
          });
          await page.getByText("This file could not be read").waitFor();
          assert.equal(posts, posted + 1);
          await clickSwitch(page);
          await settled(page, "zh");
          assert.match(
            await page.locator("#stage").innerText(),
            /无法解析该文件/
          );
          await expectChrome(page, origin, mount, "zh", true);
          await expectAssets(page, origin, mount);
          assert.equal(posts, posted + 1);
          assert.equal(await stayed(page), 1);
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

          await context.setOffline(true);
          await clickSwitch(page);
          await settled(page, "en");
          await expectChrome(page, origin, mount, "en", true);
          assert.equal(shellScripts, 1);
          assert.equal(await stayed(page), 1);
          assert.deepEqual(errors, []);
          await context.close();
        }
      );
    }

    await t.test("both blocked stores still refresh the real bar", async () => {
      const app = buildApp({ port: 0, basePath: "/shutter", maxUploadMb: 2.5 });
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(String(error)));
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
      await page.evaluate(() => {
        (window as unknown as { __scBar?: Element | null }).__scBar =
          document.querySelector("header.rf-bar");
      });
      let current: "en" | "zh" = "en";
      for (let step = 0; step < 5; step += 1) {
        current = current === "en" ? "zh" : "en";
        await clickSwitch(page);
        await settled(page, current);
        await expectChrome(page, origin, "/shutter/", current, false);
        await expectGuide(
          page,
          origin,
          "/shutter/",
          current === "en" ? GUIDE.en : GUIDE.zh
        );
      }
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
);

function countListeners() {
  const counts: Record<string, number> = {};
  const mark = (owner: string, type: string) => {
    const key = `${owner}:${type}`;
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const docAdd = Document.prototype.addEventListener;
  Document.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    mark("document", type);
    return docAdd.call(this, type, listener, options);
  };
  const winAdd = Window.prototype.addEventListener;
  Window.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) {
    mark("window", type);
    return winAdd.call(this, type, listener, options);
  };
  (
    window as unknown as { __scListeners?: Record<string, number> }
  ).__scListeners = counts;
}

async function serveShell(context: BrowserContext, origin: string) {
  await context.route("**/*", async (route) => {
    const requested = new URL(route.request().url());
    if (requested.origin === origin) await route.continue();
    else await route.abort("blockedbyclient");
  });
  await context.route(`**${SHELL_JS}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: shellJs,
    })
  );
  await context.route(`**${SHELL_CSS}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/css; charset=utf-8",
      body: shellCss,
    })
  );
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

async function settled(page: Page, lang: "en" | "zh") {
  const html = lang === "en" ? "en" : "zh-CN";
  await page.waitForFunction(
    (expected) => document.documentElement.lang === expected,
    html
  );
}

async function stayed(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __scStay?: number }).__scStay
  );
}

async function pref(page: Page) {
  return page.evaluate(() => localStorage.getItem("rf-lang"));
}

async function focusedSwitch(page: Page) {
  return page.evaluate(
    () => document.activeElement === document.querySelector("a.rf-lang")
  );
}

async function listenerSnapshot(page: Page) {
  return page.evaluate(() =>
    JSON.stringify(
      (window as unknown as { __scListeners?: Record<string, number> })
        .__scListeners
    )
  );
}

async function expectChrome(
  page: Page,
  origin: string,
  mount: string,
  lang: "en" | "zh",
  persisted: boolean
) {
  const url = new URL(page.url());
  const onEn = lang === "en";
  assert.equal(url.pathname, onEn ? `${mount}en/` : mount);
  assert.equal(url.search, onEn ? "" : "?lang=zh");
  const home = onEn ? "/en/" : persisted ? "/" : "/?lang=zh";
  const tool = onEn
    ? "/shutter/en/"
    : persisted
      ? "/shutter/"
      : "/shutter/?lang=zh";
  const easy = onEn
    ? "/easypic/en/"
    : persisted
      ? "/easypic/"
      : "/easypic/?lang=zh";
  const info = await page.evaluate(() => {
    const menu = [...document.querySelectorAll("#rf-menu a")].map(
      (anchor) => (anchor as HTMLAnchorElement).href
    );
    const mark = window as unknown as { __scBar?: Element | null };
    return {
      html: document.documentElement.lang,
      switchText: document.querySelector("a.rf-lang")?.textContent ?? "",
      switchHref: (document.querySelector("a.rf-lang") as HTMLAnchorElement)
        .href,
      back: document.querySelector("a.rf-home .rf-t")?.textContent ?? "",
      backHref: (document.querySelector("a.rf-home") as HTMLAnchorElement).href,
      tool: document.querySelector(".rf-cur")?.textContent ?? "",
      shutterHref: (
        document.querySelector(
          "#rf-menu a[aria-current='page']"
        ) as HTMLAnchorElement
      ).href,
      menu,
      v: window.rfLang?.v ?? 0,
      mountMeta:
        document
          .querySelector('meta[name="rf-mount"]')
          ?.getAttribute("content") ?? "",
      inlineHidden: document
        .querySelector("#lang-switch")
        ?.hasAttribute("hidden"),
      bars: document.querySelectorAll("header.rf-bar").length,
      scripts: document.querySelectorAll(
        'script[src="/shell/topbar.4a304e017601ad56e80a5c39886c186fa462161ce585d093ae92c4cfc17edd7b.js"]'
      ).length,
      legacy: document.querySelectorAll('script[src="/shell/topbar.js"]')
        .length,
      sameBar: document.querySelector("header.rf-bar") === mark.__scBar,
    };
  });
  assert.equal(info.html, onEn ? "en" : "zh-CN");
  assert.equal(info.switchText, onEn ? "中文" : "EN");
  assert.equal(
    info.switchHref,
    `${origin}${onEn ? `${mount}?lang=zh` : `${mount}en/`}`
  );
  assert.equal(info.back, onEn ? "Back to home" : "回到主站");
  assert.equal(info.backHref, `${origin}${home}`);
  assert.equal(info.tool, onEn ? "ShutterCount" : "快门计数");
  assert.equal(info.shutterHref, `${origin}${tool}`);
  assert.equal(info.menu.includes(`${origin}${easy}`), true);
  assert.equal(info.menu.includes(`${origin}/shutter/en/`), onEn);
  assert.equal(info.menu.includes(`${origin}/en/shutter/`), false);
  assert.equal(info.v, 2);
  assert.equal(info.mountMeta, mount);
  assert.equal(info.inlineHidden, true);
  assert.equal(info.bars, 1);
  assert.equal(info.scripts, 1);
  assert.equal(info.legacy, 0);
  assert.equal(info.sameBar, true);
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
