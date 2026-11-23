import { test } from "node:test";
import assert from "node:assert/strict";
import { fillPage, pageLinks, pageRequest, safeOrigin } from "../src/pages.js";

test("page requests separate language from every supported mount", () => {
  for (const base of ["/", "", "/shutter", "/tools/counter"]) {
    const prefix = base === "/" || base === "" ? "" : base;
    assert.deepEqual(pageRequest(base, `${prefix}/`), {
      type: "html",
      lang: "zh",
    });
    assert.deepEqual(pageRequest(base, `${prefix}/index.html`), {
      type: "html",
      lang: "zh",
    });
    assert.deepEqual(pageRequest(base, `${prefix}/en/`), {
      type: "html",
      lang: "en",
    });
    assert.deepEqual(pageRequest(base, `${prefix}/en/index.html?x=1`), {
      type: "html",
      lang: "en",
    });
    assert.deepEqual(pageRequest(base, `${prefix}/en?a=1`), {
      type: "redirect",
      to: `${prefix}/en/?a=1`,
    });
    assert.equal(pageRequest(base, `${prefix}/api/parse`), null);
    assert.equal(
      pageRequest(base, `${prefix}/iphone-export-original.jpg`),
      null
    );
    assert.equal(
      pageRequest(base, `${prefix}/en/iphone-export-original.jpg`),
      null
    );
  }
});

test("filled heads are absolute, self-canonical, and free of mount tokens", () => {
  const template = [
    '<link rel="canonical" href="__SC_CANONICAL__" />',
    '<link rel="alternate" hreflang="zh-CN" href="__SC_ZH__" />',
    '<link rel="alternate" hreflang="en" href="__SC_EN__" />',
    '<link rel="alternate" hreflang="x-default" href="__SC_EN__" />',
    '<meta name="sc-mount" content="__SC_MOUNT__" />',
    '<a href="__SC_SWITCH__">',
    'installEnter("__SC_MOUNT__")',
  ].join("");
  const html = fillPage(
    template,
    pageLinks("https://rende.fun", "/tools/counter", "en")
  );
  assert.equal(html.includes("__SC_"), false);
  assert.match(
    html,
    /canonical" href="https:\/\/rende\.fun\/tools\/counter\/en\/"/
  );
  assert.match(
    html,
    /hreflang="zh-CN" href="https:\/\/rende\.fun\/tools\/counter\/"/
  );
  assert.match(
    html,
    /hreflang="x-default" href="https:\/\/rende\.fun\/tools\/counter\/en\/"/
  );
  assert.match(html, /content="\/tools\/counter\/"/);
  assert.match(html, /href="\/tools\/counter\/\?lang=zh"/);
  assert.match(html, /installEnter\("\/tools\/counter\/"\)/);
  assert.equal(
    safeOrigin("http", '"><script>', "127.0.0.1", 3020),
    "http://127.0.0.1:3020"
  );
  assert.equal(
    safeOrigin("https", "rende.fun", "127.0.0.1", 443),
    "https://rende.fun"
  );
});
