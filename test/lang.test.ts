import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import {
  decideEnter,
  hrefFor,
  matchLanguage,
  normalizeMount,
  placeInMount,
} from "../shared/lang.js";
import { readPref, writePref, type PrefHost } from "../web/storage.js";
import { runEnter } from "../web/enter.js";

const root = new URL("../../", import.meta.url);

test("mount language is the en segment after the configured base", () => {
  assert.equal(normalizeMount("/"), "/");
  assert.equal(normalizeMount(""), "/");
  assert.equal(normalizeMount("/shutter"), "/shutter/");
  assert.equal(normalizeMount("/tools/counter/"), "/tools/counter/");
  assert.deepEqual(placeInMount("/shutter/", "/shutter"), {
    lang: "zh",
    rest: "",
  });
  assert.deepEqual(placeInMount("/shutter/en/", "/shutter/"), {
    lang: "en",
    rest: "",
  });
  assert.deepEqual(placeInMount("/shutter/en", "/shutter/"), {
    lang: "en",
    rest: "",
  });
  assert.deepEqual(
    placeInMount("/tools/counter/en/index.html", "/tools/counter"),
    {
      lang: "en",
      rest: "index.html",
    }
  );
  assert.deepEqual(placeInMount("/en/", "/"), { lang: "en", rest: "" });
  assert.deepEqual(placeInMount("/en/en/", "/en"), { lang: "en", rest: "" });
  assert.deepEqual(placeInMount("/en/", "/en"), { lang: "zh", rest: "" });
});

test("language matching keeps zh-HK and zh-TW in Chinese and defaults nowhere", () => {
  assert.equal(matchLanguage(["zh-HK", "en-US"]), "zh");
  assert.equal(matchLanguage(["zh_TW"]), "zh");
  assert.equal(matchLanguage(["fr-FR", "en-GB"]), "en");
  assert.equal(matchLanguage(["fr", "de"]), null);
  assert.equal(matchLanguage([]), null);
});

test("enter follows explicit URL, then manual preference, then languages, then English", () => {
  const base = {
    pathname: "/tools/counter/",
    mount: "/tools/counter/",
    search: "",
    hash: "#shot",
    offersEn: true,
    pref: null as "zh" | "en" | null,
    languages: ["fr"] as readonly unknown[],
  };
  assert.deepEqual(decideEnter({ ...base, languages: ["en-US"] }), {
    leave: true,
    href: "/tools/counter/en/#shot",
  });
  assert.deepEqual(decideEnter({ ...base, pref: "zh", languages: ["en-US"] }), {
    leave: false,
    href: null,
  });
  assert.deepEqual(
    decideEnter({ ...base, search: "?lang=zh", languages: ["en-US"] }),
    { leave: false, href: null }
  );
  assert.deepEqual(
    decideEnter({
      ...base,
      pathname: "/tools/counter/en/",
      pref: "zh",
      languages: ["zh-CN"],
    }),
    { leave: false, href: null }
  );
  assert.deepEqual(
    decideEnter({ ...base, offersEn: false, languages: ["en"] }),
    {
      leave: false,
      href: null,
    }
  );
  assert.deepEqual(decideEnter({ ...base, languages: ["zh-HK", "en"] }), {
    leave: false,
    href: null,
  });
  assert.equal(
    hrefFor("zh", "/shutter/en/page", "/shutter/", "?a=1&lang=en&b=2", "#h"),
    "/shutter/page?a=1&b=2&lang=zh#h"
  );
  assert.equal(
    hrefFor("en", "/shutter/page", "/shutter/", "?lang=zh&a=1", "#h"),
    "/shutter/en/page?a=1#h"
  );
});

test("manual preference uses the shared rf-lang key and does not invent a choice", () => {
  const saved = new Map<string, string>();
  let cookie = "";
  const host: PrefHost = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    readCookie: () => cookie,
    writeCookie: (value) => {
      cookie = value;
    },
    protocol: "https:",
  };
  assert.equal(readPref(host), null);
  assert.equal(saved.size, 0);
  assert.equal(writePref(host, "en"), true);
  assert.equal(saved.get("rf-lang"), "en");
  assert.equal(cookie, "");
  saved.clear();
  host.setItem = () => {
    throw new Error("blocked");
  };
  assert.equal(writePref(host, "zh"), true);
  assert.match(
    cookie,
    /^rf-lang=zh; Path=\/; Max-Age=31536000; SameSite=Lax; Secure$/
  );
  assert.equal(readPref(host), "zh");
  host.readCookie = () => {
    throw new Error("blocked");
  };
  host.getItem = () => {
    throw new Error("blocked");
  };
  assert.equal(writePref(host, "en"), false);
  assert.equal(readPref(host), null);
});

test("shutter and root hrefs match the vendored contract, custom mounts do not", async () => {
  const source = await fs.readFile(
    new URL("web/vendor/rf-lang.js", root),
    "utf8"
  );
  assert.doesNotMatch(source, /<\/script|<script|<!--/i);
  const cases = [
    ["/shutter/", "/shutter/", "", "", "en", "/shutter/en/"],
    ["/shutter/", "/shutter/", "?lang=zh", "#x", "en", "/shutter/en/#x"],
    [
      "/shutter/en/",
      "/shutter/",
      "?a=1",
      "#demo",
      "zh",
      "/shutter/?a=1&lang=zh#demo",
    ],
    ["/", "/", "", "", "en", "/en/"],
    ["/", "/", "?x=1", "", "zh", "/?x=1&lang=zh"],
  ] as const;
  for (const [pathname, mount, search, hash, lang, expected] of cases) {
    const contract = contractHref(source, pathname, search, hash, lang);
    assert.equal(contract, expected);
    assert.equal(hrefFor(lang, pathname, mount, search, hash), expected);
  }
  const custom = hrefFor(
    "en",
    "/tools/counter/",
    "/tools/counter/",
    "?a=1",
    "#z"
  );
  assert.equal(custom, "/tools/counter/en/?a=1#z");
  assert.equal(
    contractHref(source, "/tools/counter/", "?a=1", "#z", "en"),
    "/en/tools/counter/?a=1#z"
  );
});

test("automatic enter redirects without asking storage to store a preference", () => {
  const writes: string[] = [];
  let replaced = "";
  let left = false;
  runEnter({
    mount: "/tools/counter/",
    pathname: "/tools/counter/",
    search: "",
    hash: "",
    languages: ["en-US"],
    offersEn: true,
    pref: null,
    contractBase: "/",
    contractEnter: () => {
      throw new Error("contract enter must not run for a custom mount");
    },
    contractLeaving: () => false,
    replace: (url) => {
      replaced = url;
    },
    markLeaving: () => {
      left = true;
    },
  });
  assert.equal(replaced, "/tools/counter/en/");
  assert.equal(left, true);
  assert.deepEqual(writes, []);

  let contractRan = false;
  runEnter({
    mount: "/shutter/",
    pathname: "/shutter/en/",
    search: "",
    hash: "",
    languages: ["zh-CN"],
    offersEn: true,
    pref: "zh",
    contractBase: "/shutter/",
    contractEnter: () => {
      contractRan = true;
    },
    contractLeaving: () => false,
    replace: () => {
      throw new Error("english pages do not redirect");
    },
    markLeaving: () => {
      throw new Error("english pages are not leaving");
    },
  });
  assert.equal(contractRan, true);
});

test("the inlined v1 contract still misreads a custom mount, and this app does not replace it", async () => {
  const source = await fs.readFile(
    new URL("web/vendor/rf-lang.js", root),
    "utf8"
  );
  assert.match(source, /const V = 1/);
  const english = contractWindow(source, {
    pathname: "/tools/counter/en/",
    search: "?album=1",
    hash: "#shot",
  });
  const place = english.rf.place;
  const href = english.rf.href;
  assert.equal(place("/tools/counter/en/").lang, "zh");
  assert.equal(place("/tools/counter/en/").site.base, "/");
  assert.equal(href("en"), "/en/tools/counter/en/?album=1#shot");
  assert.equal(english.rf.place, place);
  assert.equal(english.rf.href, href);
  const enter = await fs.readFile(new URL("web/enter.ts", root), "utf8");
  const app = await fs.readFile(new URL("web/app.ts", root), "utf8");
  assert.doesNotMatch(enter, /rf\.place\s*=/);
  assert.doesNotMatch(enter, /rf\.href\s*=/);
  assert.doesNotMatch(app, /rf\.place\s*=/);
  assert.doesNotMatch(app, /rf\.href\s*=/);
  assert.doesNotMatch(app, /barFollowsPage/);
  assert.match(app, /new Event\("rf:locale"\)/);
});

function contractWindow(
  source: string,
  location: { pathname: string; search: string; hash: string }
) {
  const window = {} as {
    rfLang?: {
      place(pathname: string): {
        site: { base: string };
        lang: "zh" | "en";
        rest: string;
      };
      href(next: "zh" | "en"): string;
    };
  };
  const context = vm.createContext({
    window,
    document: { cookie: "", currentScript: null, querySelector: () => null },
    location: { ...location, protocol: "http:", replace() {} },
    navigator: { languages: ["en-US"], language: "en-US" },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(source, context);
  const rf = window.rfLang;
  if (!rf) throw new Error("vendored contract did not install");
  return {
    rf,
    location: context.location as {
      pathname: string;
      search: string;
      hash: string;
    },
  };
}

function contractHref(
  source: string,
  pathname: string,
  search: string,
  hash: string,
  lang: "zh" | "en"
): string {
  const location = {
    pathname,
    search,
    hash,
    protocol: "http:",
    replace() {},
  };
  const window = {} as { rfLang?: { href(next: "zh" | "en"): string } };
  const context = vm.createContext({
    window,
    document: { cookie: "", currentScript: null, querySelector: () => null },
    location,
    navigator: { languages: ["en-US"], language: "en-US" },
    localStorage: {
      getItem: () => null,
      setItem: () => {},
    },
  });
  vm.runInContext(source, context);
  const api = window.rfLang;
  if (!api) throw new Error("vendored contract did not install");
  return api.href(lang);
}
