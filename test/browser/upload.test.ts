import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";
import { buildApp } from "../../src/app.js";
import { decodeParseResponse } from "../../shared/protocol.js";
import type { ParseResponse } from "../../shared/protocol.js";

test(
  "the compiled page supports uploads and error states with external requests blocked in Chrome",
  { timeout: 60_000 },
  async (t) => {
    const app = buildApp({
      port: 0,
      basePath: "/tools/counter",
      maxUploadMb: 2.5,
    });
    const browser = await chromium.launch(
      process.env.CHROME_PATH
        ? { executablePath: process.env.CHROME_PATH, headless: true }
        : { channel: "chrome", headless: true }
    );
    t.after(async () => {
      await browser.close();
      await app.close();
    });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    const context = await browser.newContext();
    const blockedHosts = new Set<string>();
    await context.route("**/*", async (route) => {
      const requested = new URL(route.request().url());
      if (requested.origin === origin) {
        await route.continue();
      } else {
        blockedHosts.add(requested.hostname);
        await route.abort("blockedbyclient");
      }
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const url = origin + "/tools/counter/";
    const nikon = await fs.readFile(
      new URL("../fixtures/NikonD70.jpg", import.meta.url)
    );
    const canon = await fs.readFile(
      new URL("../fixtures/Canon.jpg", import.meta.url)
    );
    const select = (buffer: Buffer, name = "camera.jpg") =>
      page
        .locator("#file-input")
        .setInputFiles({ name, mimeType: "image/jpeg", buffer });
    const stage = page.locator("#stage");

    await t.test(
      "camera sample reads 526 and retry resets the picker",
      async () => {
        await page.goto(url);
        await select(nikon);
        await page.locator(".result-row--shutter").waitFor();
        assert.match(await page.locator("#stage").innerText(), /526/);
        await page.getByRole("button", { name: "再查一张" }).click();
        await page.locator(".upload-dropzone").waitFor();
        assert.equal(await page.locator("#file-input").inputValue(), "");
      }
    );

    await t.test(
      "missing shutter fields show the guide without diagnostics",
      async () => {
        await select(canon, "camera.jpg");
        await page.getByRole("heading", { name: "未能读取快门次数" }).waitFor();
        const text = await stage.innerText();
        assert.match(text, /iPhone 用户可尝试/);
        assert.match(text, /查看大图/);
        assert.doesNotMatch(
          text,
          /反馈这个问题|复制诊断信息|requestId|status:/
        );
        const image = page.locator(".missing-shutter__image");
        const box = await image.boundingBox();
        const natural = await image.evaluate((element) => {
          const img = element as HTMLImageElement;
          return { width: img.naturalWidth, height: img.naturalHeight };
        });
        assert.equal(natural.width, 1206);
        assert.equal(natural.height, 1550);
        assert.ok(box && box.width <= 420);
      }
    );

    await t.test(
      "configured size rejection happens before an upload",
      async () => {
        await page.goto(url);
        let uploads = 0;
        const listener = (request: import("playwright-core").Request) => {
          if (request.method() === "POST") uploads++;
        };
        page.on("request", listener);
        await select(Buffer.alloc(3 * 1048576));
        await page.getByText("文件过大").waitFor();
        assert.match(await stage.innerText(), /2.5 MB/);
        assert.doesNotMatch(await stage.innerText(), /反馈这个问题/);
        assert.equal(uploads, 0);
        page.off("request", listener);
      }
    );

    await t.test(
      "the upload is keyboard accessible and fits a mobile viewport",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(url);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          ),
          true
        );
        const dropzone = page.getByRole("button", {
          name: "点击或拖放原图到这里",
        });
        await dropzone.focus();
        const choosing = page.waitForEvent("filechooser");
        await dropzone.press("Enter");
        await (
          await choosing
        ).setFiles({
          name: "camera.jpg",
          mimeType: "image/jpeg",
          buffer: nikon,
        });
        await page.locator(".result-row--shutter").waitFor();
        assert.match(await page.locator("#stage").innerText(), /526/);
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          ),
          true
        );
      }
    );

    await t.test("a new selection cancels the pending upload", async () => {
      const stale: ParseResponse = {
        status: "ok",
        shutterCount: 999,
        shutterSource: "Nikon:ShutterCount",
        approximate: false,
        make: null,
        model: null,
        capturedAt: null,
        note: null,
        fileName: "old.jpg",
        requestId: "3cafc9f3-b919-4ad1-9bc8-3a4dbf55dc34",
      };
      assert.equal(decodeParseResponse(stale)?.status, "ok");
      let releaseOld = () => {};
      let finishOld = () => {};
      const held = new Promise<void>((resolve) => {
        releaseOld = resolve;
      });
      const finished = new Promise<void>((resolve) => {
        finishOld = resolve;
      });
      let requests = 0;
      await page.route("**/api/parse", async (route) => {
        if (++requests !== 1) return route.continue();
        await held;
        try {
          await route.fulfill({
            status: 200,
            json: stale,
          });
        } catch {
          // Chrome may discard a route after the fetch was cancelled.
        } finally {
          finishOld();
        }
      });
      try {
        await page.goto(url);
        const pending = page.waitForRequest("**/api/parse");
        await select(nikon, "old.jpg");
        const old = await pending;
        const aborted = page.waitForEvent("requestfailed", {
          predicate: (request) => request === old,
        });
        await select(canon, "replacement.jpg");
        await aborted;
        await page.getByRole("heading", { name: "未能读取快门次数" }).waitFor();
        releaseOld();
        await finished;
        assert.equal(await page.locator(".result-row--shutter").count(), 0);
        assert.match(await stage.innerText(), /未能读取快门次数/);
      } finally {
        releaseOld();
        await page.unroute("**/api/parse");
      }
    });

    for (const [name, status, body, visible] of [
      [
        "rate limit",
        429,
        JSON.stringify({
          status: "rate_limited",
          requestId: "3cafc9f3-b919-4ad1-9bc8-3a4dbf55dc34",
        }),
        "请求过于频繁",
      ],
      ["proxy HTML", 502, "<html>PRIVATE</html>", "解析失败"],
      [
        "malformed success",
        200,
        JSON.stringify({
          status: "ok",
          shutterCount: "526",
          rawExif: "PRIVATE",
        }),
        "解析失败",
      ],
      [
        "busy service",
        503,
        JSON.stringify({ status: "error", reason: "busy" }),
        "解析服务繁忙",
      ],
    ] as const) {
      await t.test(name, async () => {
        await page.route("**/api/parse", (route) =>
          route.fulfill({
            status,
            body,
            headers: {
              "X-Request-ID": "3cafc9f3-b919-4ad1-9bc8-3a4dbf55dc34",
              "content-type": status === 502 ? "text/html" : "application/json",
            },
          })
        );
        await page.goto(url);
        await select(nikon);
        await page.getByText(visible).waitFor();
        const text = await stage.innerText();
        assert.match(text, new RegExp(visible));
        assert.doesNotMatch(
          text,
          /3cafc9f3-b919-4ad1-9bc8-3a4dbf55dc34|PRIVATE|rawExif|反馈这个问题/
        );
        await page.unroute("**/api/parse");
      });
    }
    assert.ok(blockedHosts.has("hm.baidu.com"));
    assert.deepEqual(errors, []);
  }
);
