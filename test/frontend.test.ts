type FakeFile = { name: string; size: number };
type FakeResponse = ReturnType<typeof response>;
type FetchOptions = { signal: AbortSignal; body?: unknown; method?: string };
type FakeFetch = (
  url: string,
  options: FetchOptions
) => FakeResponse | Promise<FakeResponse>;
type FakeEvent = {
  key?: string;
  preventDefault?: () => void;
  dataTransfer?: { types: string[]; files: FakeFile[]; dropEffect?: string };
};
interface FakeDocument {
  activeElement: HarnessElement | null;
  root: HarnessElement;
  documentElement: HarnessElement;
  getElementById: (id: string) => HarnessElement | undefined;
  querySelector: (selector: string) => HarnessElement | undefined;
  createElement: (tag: string) => HarnessElement;
  createTextNode: (text: string) => HarnessElement;
}
interface BrowserActions {
  handleFile: (file: FakeFile) => Promise<void>;
  resetAndPick: () => void;
}

class HarnessElement {
  tagName: string;
  _text: string;
  children: HarnessElement[] = [];
  parentNode: HarnessElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: FakeEvent) => unknown)[]> = {};
  dataset: Record<string, string> = {};
  className = "";
  value = "";
  disabled = false;
  clickCount = 0;
  readOnly = false;
  rows = 0;
  spellcheck = false;
  selectionStart = 0;
  selectionEnd = 0;
  content: { firstElementChild?: HarnessElement } = {};
  constructor(
    tagName: string,
    text: string,
    private readonly owner: FakeDocument
  ) {
    this.tagName = tagName;
    this._text = text;
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = "";
    this.value = "";
    this.disabled = false;
    this.clickCount = 0;
    if (tagName === "template") this.content = {};
  }
  append(...nodes: (HarnessElement | string)[]) {
    for (let node of nodes) {
      if (typeof node === "string")
        node = new HarnessElement("#text", node, this.owner);
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: (HarnessElement | string)[]) {
    for (const node of this.children) node.parentNode = null;
    this.children = [];
    this._text = "";
    this.append(...nodes);
  }
  set textContent(text: string) {
    this.replaceChildren();
    this._text = String(text);
  }
  get textContent(): string {
    return this._text + this.children.map((node) => node.textContent).join("");
  }
  set innerHTML(markup: string) {
    assert.equal(
      this.tagName,
      "template",
      "only the static icon template uses innerHTML"
    );
    assert.match(markup, /^<svg /);
    assert.doesNotMatch(markup, /script|PRIVATE/i);
    this.content.firstElementChild = new HarnessElement("svg", "", this.owner);
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }
  set href(value: string) {
    this.setAttribute("href", value);
  }
  get href() {
    return this.attributes.href ?? "";
  }
  addEventListener(type: string, listener: (event: FakeEvent) => unknown) {
    (this.listeners[type] ||= []).push(listener);
  }
  async emit(type: string, event: FakeEvent = {}) {
    for (const listener of this.listeners[type] || []) await listener(event);
  }
  click() {
    this.clickCount += 1;
    return this.emit("click", { preventDefault() {} });
  }
  focus() {
    this.owner.activeElement = this;
  }
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  get isConnected() {
    let node: HarnessElement | null = this;
    while (node) {
      if (node === this.owner.root) return true;
      node = node.parentNode;
    }
    return false;
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

// Bundle the real module graph into this deterministic fake DOM harness.
import { build } from "esbuild";
const root = new URL("../../", import.meta.url);
const bundle = await build({
  entryPoints: [new URL("web/app.ts", root).pathname],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ShutterUI",
  platform: "browser",
});
const source = bundle.outputFiles[0]!.text;
const ID_A = "3cafc9f3-b919-4ad1-9bc8-3a4dbf55dc34";
const ID_B = "8ef6f54a-85ee-476e-b6da-c089859bc41f";
const INITIAL_TIME = Date.parse("2026-10-10T00:00:00.000Z");

// A deliberately small DOM harness exercises the actual browser entrypoint:
// rendering, event handlers, async fetches, selection, and detached DOM nodes.
function createHarness({
  fetch,
  settings,
  pathname = "/shutter/",
  search = "",
  hash = "",
  mount = "/shutter/",
  storage = "ok",
}: {
  fetch?: FakeFetch;
  settings?: () => FakeResponse | Promise<FakeResponse>;
  pathname?: string;
  search?: string;
  hash?: string;
  mount?: string;
  storage?: "ok" | "blocked" | "cookie";
} = {}) {
  const document = { activeElement: null } as FakeDocument;
  document.root = new HarnessElement("body", "", document);
  document.documentElement = new HarnessElement("html", "", document);
  const intro = new HarnessElement("p", "", document);
  const stage = new HarnessElement("div", "", document);
  const fileInput = new HarnessElement("input", "", document);
  const langSwitch = new HarnessElement("a", "EN", document);
  document.root.append(intro, stage, fileInput, langSwitch);
  document.getElementById = (id) =>
    (
      ({
        intro,
        stage,
        "file-input": fileInput,
        "lang-switch": langSwitch,
      }) as Record<string, HarnessElement>
    )[id];
  document.querySelector = (selector) =>
    document.getElementById(selector.slice(1));
  document.createElement = (tag) => new HarnessElement(tag, "", document);
  document.createTextNode = (text) =>
    new HarnessElement("#text", String(text), document);

  let now = INITIAL_TIME;
  let nextTimer = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  class ClockDate extends Date {
    constructor(value?: string | number) {
      super(value ?? now);
    }
    static now() {
      return now;
    }
  }
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now && timers.delete(id)) timer.fn();
    }
  };
  let cookie = "";
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get() {
      if (storage === "blocked") throw new Error("cookie blocked");
      return cookie;
    },
    set(value: string) {
      if (storage === "blocked") throw new Error("cookie blocked");
      cookie = String(value);
    },
  });
  const calls: [string, FetchOptions][] = [];
  const listeners: Record<string, (() => void)[]> = {};
  const stored = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => {
      if (storage !== "ok") throw new Error("storage blocked");
      return stored.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storage !== "ok") throw new Error("storage blocked");
      stored.set(key, String(value));
    },
  };
  const location = {
    pathname,
    search,
    hash,
    protocol: "http:",
    replace(url: string) {
      this.pathname = url;
    },
    assign(url: string) {
      const next = new URL(url, "http://127.0.0.1");
      this.pathname = next.pathname;
      this.search = next.search;
      this.hash = next.hash;
    },
  };
  const context = vm.createContext({
    document,
    window: {
      __SC_MOUNT: mount,
      addEventListener(type: string, listener: () => void) {
        (listeners[type] ||= []).push(listener);
      },
    },
    location,
    history: {
      pushState(_data: unknown, _title: string, url: string) {
        const next = new URL(url, "http://127.0.0.1");
        location.pathname = next.pathname;
        location.search = next.search;
        location.hash = next.hash;
      },
    },
    localStorage,
    navigator: {},
    URLSearchParams,
    AbortController,
    AbortSignal,
    Date: ClockDate,
    FormData: class {
      fields: unknown[][] = [];
      constructor() {}
      append(...field: unknown[]) {
        this.fields.push(field);
      }
    },
    setTimeout: (fn: () => void, ms: number) => {
      const id = ++nextTimer;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch: async (...args: [string, FetchOptions]) => {
      if (args[0] === `${mount}api/config`)
        return settings
          ? settings()
          : response({
              data: { maxUploadMb: 50, maxUploadBytes: 50 * 1048576 },
            });
      calls.push(args);
      if (!fetch) throw new TypeError("network unavailable");
      return fetch(...args);
    },
  });
  vm.runInContext(source, context, { filename: "web/app.js" });

  const actions = context.ShutterUI as BrowserActions;
  const all = (
    predicate: (node: HarnessElement) => boolean,
    node: HarnessElement = stage
  ): HarnessElement[] => {
    const matches = predicate(node) ? [node] : [];
    return matches.concat(
      node.children.flatMap((child) => all(predicate, child))
    );
  };
  const byClass = (className: string) =>
    all((node) => node.className.split(" ").includes(className));
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const finish = async (pending: Promise<void>) => {
    await flush();
    advance(400);
    await pending;
  };
  const upload = async (file = { name: "camera.jpg", size: 1234 }) => {
    await finish(actions.handleFile(file));
  };
  return {
    actions,
    document,
    intro,
    stage,
    fileInput,
    langSwitch,
    location,
    stored,
    cookie: () => cookie,
    emit(type: string) {
      for (const listener of listeners[type] || []) listener();
    },
    calls,
    timers,
    all,
    byClass,
    advance,
    flush,
    finish,
    upload,
  };
}

function response({
  status = 200,
  data = {},
  headerId = null,
  invalidJson = false,
}: {
  status?: number;
  data?: unknown;
  headerId?: string | null;
  invalidJson?: boolean;
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "x-request-id" ? headerId : null,
    },
    json: async () => {
      if (invalidJson)
        throw new SyntaxError("PRIVATE proxy HTML, never report");
      if (
        data &&
        typeof data === "object" &&
        "status" in data &&
        (data.status === "ok" || data.status === "no_shutter_field")
      ) {
        return {
          fileName: null,
          make: null,
          model: null,
          capturedAt: null,
          note: null,
          approximate: false,
          shutterCount: null,
          shutterSource: data.status === "ok" ? "Nikon:ShutterCount" : null,
          ...data,
        };
      }
      return data;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("no_shutter_field hides private response fields and internal diagnostics", async () => {
  const ui = createHarness({
    fetch: () =>
      response({
        data: {
          requestId: ID_A,
          status: "no_shutter_field",
          fileName: "camera.jpg",
          model: "NIKON Z 30",
          serial: "PRIVATE_serial",
          GPS: "PRIVATE_GPS",
          message: "PRIVATE_message",
          reason: "PRIVATE_reason",
        },
      }),
  });
  await ui.upload();
  assert.match(ui.stage.textContent, /未能读取快门次数/);
  assert.match(ui.stage.textContent, /NIKON Z 30/);
  assert.doesNotMatch(
    ui.stage.textContent,
    /PRIVATE|requestId|反馈这个问题|复制诊断信息|status:|reason:/
  );
});

test("successful recognition shows the count without the missing-count help", async () => {
  const ui = createHarness({
    fetch: () =>
      response({
        data: {
          requestId: ID_A,
          status: "ok",
          shutterCount: 12345,
          model: "Nikon",
        },
      }),
  });
  await ui.upload();
  assert.match(ui.stage.textContent, /12,345/);
  assert.doesNotMatch(
    ui.stage.textContent,
    /未能读取快门次数|查看大图|反馈这个问题/
  );
});

test("invalid successful counts show an invalid-response report instead of a result", async (t) => {
  for (const shutterCount of [
    undefined,
    null,
    "123",
    {},
    [],
    true,
    NaN,
    Infinity,
    -1,
    0,
    1.5,
    5_000_001,
  ]) {
    await t.test(String(shutterCount), async () => {
      const ui = createHarness({
        fetch: () =>
          response({
            data: { requestId: ID_A, status: "ok", shutterCount },
          }),
      });
      await ui.upload();
      assert.match(ui.stage.textContent, /解析失败/);
      assert.match(ui.stage.textContent, /重新上传/);
      assert.doesNotMatch(
        ui.stage.textContent,
        /NaN|快门读取结果|requestId|反馈这个问题/
      );
    });
  }
});

test("unexpected metadata types show an invalid-response report without exposing values", async () => {
  const ui = createHarness({
    fetch: () =>
      response({
        data: {
          status: "ok",
          shutterCount: 123,
          model: { private: "PRIVATE" },
          note: ["PRIVATE"],
          capturedAt: { private: "PRIVATE" },
        },
      }),
  });
  await ui.upload();
  assert.match(ui.stage.textContent, /解析失败/);
  assert.doesNotMatch(
    ui.stage.textContent,
    /PRIVATE|\[object Object\]|requestId|反馈这个问题/
  );
});

test("server error states keep a user message and hide diagnostics", async (t) => {
  for (const [status, apiStatus, reason, visible] of [
    [400, "bad_request", undefined, "解析失败"],
    [413, "file_too_large", undefined, "文件过大"],
    [422, "unsupported_or_corrupt", "corrupt", "无法解析该文件"],
    [429, "rate_limited", undefined, "请求过于频繁"],
    [500, "error", "parser_unavailable", "解析失败"],
    [504, "error", "timeout", "解析失败"],
  ] as const) {
    await t.test(apiStatus + status, async () => {
      const ui = createHarness({
        fetch: () =>
          response({
            status,
            data: { requestId: ID_A, status: apiStatus, reason },
          }),
      });
      await ui.upload();
      assert.match(ui.stage.textContent, new RegExp(visible));
      assert.match(ui.stage.textContent, /重新上传/);
      assert.doesNotMatch(
        ui.stage.textContent,
        new RegExp(`${ID_A}|反馈这个问题|复制诊断信息|status:|reason:`)
      );
    });
  }
});

test("bad responses show a user error and hide private payloads", async () => {
  const html = createHarness({
    fetch: () => response({ status: 502, invalidJson: true, headerId: ID_B }),
  });
  await html.upload();
  assert.match(html.stage.textContent, /解析失败/);
  assert.doesNotMatch(
    html.stage.textContent,
    new RegExp(`${ID_B}|PRIVATE|反馈这个问题`)
  );

  const empty = createHarness({
    fetch: () => response({ status: 500, invalidJson: true }),
  });
  await empty.upload();
  assert.match(empty.stage.textContent, /解析失败/);
  assert.doesNotMatch(empty.stage.textContent, /requestId|reason:/);

  const unknown = createHarness({
    fetch: () =>
      response({
        data: { requestId: "PRIVATE", status: "PRIVATE", reason: "PRIVATE" },
        headerId: "PRIVATE_header",
      }),
  });
  await unknown.upload();
  assert.match(unknown.stage.textContent, /解析失败/);
  assert.doesNotMatch(unknown.stage.textContent, /PRIVATE|反馈这个问题/);
});

test("local validation explains the problem and never uploads the file", async (t) => {
  for (const [file, visible] of [
    [{ name: "notes.png", size: 100 }, "无法解析该文件"],
    [{ name: "large.jpg", size: 50 * 1024 * 1024 + 1 }, "文件过大"],
  ] as const) {
    await t.test(visible, async () => {
      const ui = createHarness();
      await ui.upload(file);
      assert.equal(ui.calls.length, 0);
      assert.match(ui.stage.textContent, new RegExp(visible));
      assert.doesNotMatch(
        ui.stage.textContent,
        /反馈这个问题|requestId|status:/
      );
    });
  }
});

test("network failure shows the retry message and hides the exception", async () => {
  const ui = createHarness({
    fetch: () => {
      throw new Error("PRIVATE_network_message");
    },
  });
  await ui.upload();
  assert.match(ui.stage.textContent, /解析失败/);
  assert.doesNotMatch(ui.stage.textContent, /PRIVATE|requestId|反馈这个问题/);
});

test("client timeout reports no server ID without fabricating a correlatable request", async () => {
  const ui = createHarness({
    fetch: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error("PRIVATE timeout")),
          { once: true }
        );
      }),
  });
  const pending = ui.actions.handleFile({ name: "camera.jpg", size: 100 });
  await ui.flush();
  ui.advance(60_000);
  await pending;
  assert.match(ui.stage.textContent, /解析失败/);
  assert.doesNotMatch(ui.stage.textContent, /PRIVATE|requestId|反馈这个问题/);
  assert.equal(ui.timers.size, 0);
});

test("timeout while reading the response body preserves the already received ID", async () => {
  const ui = createHarness({
    fetch: (_url, { signal }) => ({
      ...response({ headerId: ID_A }),
      json: () =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("PRIVATE body timeout")),
            { once: true }
          );
        }),
    }),
  });
  const pending = ui.actions.handleFile({ name: "camera.jpg", size: 100 });
  await ui.flush();
  ui.advance(60_000);
  await pending;
  assert.match(ui.stage.textContent, /解析失败/);
  assert.doesNotMatch(ui.stage.textContent, /PRIVATE|requestId|反馈这个问题/);
});

test("new upload aborts the old one and late old data cannot overwrite the result", async () => {
  const first = deferred<FakeResponse>();
  let fetchCount = 0;
  const ui = createHarness({
    fetch: () =>
      ++fetchCount === 1
        ? first.promise
        : response({ data: { status: "no_shutter_field" } }),
  });
  const oldUpload = ui.actions.handleFile({ name: "first.jpg", size: 100 });
  await ui.flush();
  const newUpload = ui.actions.handleFile({ name: "second.jpg", size: 100 });
  await ui.flush();
  assert.equal(ui.calls[0]![1].signal.aborted, true);
  await ui.finish(newUpload);
  first.resolve(response({ data: { status: "ok", shutterCount: 111 } }));
  await oldUpload;
  assert.match(ui.stage.textContent, /未能读取快门次数/);
  assert.doesNotMatch(ui.stage.textContent, /111/);
});

test("locally rejected new file wins over an older pending upload", async () => {
  const first = deferred<FakeResponse>();
  const ui = createHarness({ fetch: () => first.promise });
  const oldUpload = ui.actions.handleFile({ name: "first.jpg", size: 100 });
  await ui.upload({ name: "new.png", size: 100 });
  first.resolve(
    response({ data: { status: "no_shutter_field", requestId: ID_A } })
  );
  await oldUpload;
  assert.match(ui.stage.textContent, /无法解析该文件/);
  assert.doesNotMatch(ui.stage.textContent, /未能读取快门次数/);
});

test("retry during the minimum loading delay cannot restore old diagnostics", async () => {
  const ui = createHarness({
    fetch: () =>
      response({
        data: { status: "no_shutter_field", requestId: ID_A },
      }),
  });
  const pending = ui.actions.handleFile({ name: "camera.jpg", size: 100 });
  await ui.flush();
  ui.actions.resetAndPick();
  assert.equal(ui.fileInput.value, "");
  assert.equal(ui.fileInput.clickCount, 1);
  ui.advance(400);
  await pending;
  assert.doesNotMatch(ui.stage.textContent, /未能读取快门次数/);
  assert.match(ui.stage.textContent, /点击或拖放/);
});

test("no_shutter_field shows the full guide and other states remove it", async () => {
  const title = "未能读取快门次数";
  const missing = createHarness({
    fetch: () => response({ data: { status: "no_shutter_field" } }),
  });
  await missing.upload();
  assert.match(missing.stage.textContent, new RegExp(title));
  assert.match(missing.stage.textContent, /iPhone 用户可尝试/);
  assert.match(missing.stage.textContent, /在照片中选中/);
  assert.match(missing.stage.textContent, /点击分享/);
  assert.match(missing.stage.textContent, /导出未修改的原片/);
  assert.match(missing.stage.textContent, /保存后重新上传/);
  assert.match(missing.stage.textContent, /原片也不保证一定能查到/);
  assert.match(missing.stage.textContent, /查看大图/);
  const image = missing.byClass("missing-shutter__image")[0];
  const zoom = missing.byClass("missing-shutter__zoom")[0];
  assert.equal(image?.tagName, "img");
  assert.equal(image?.attributes.src, "/shutter/iphone-export-original.jpg");
  assert.equal(image?.attributes.width, "1206");
  assert.equal(image?.attributes.height, "1550");
  assert.equal(zoom?.tagName, "a");
  assert.equal(zoom?.attributes.href, "/shutter/iphone-export-original.jpg");
  assert.equal(zoom?.attributes.target, "_blank");
  assert.equal(zoom?.textContent.includes("查看大图"), true);
  missing.actions.resetAndPick();
  assert.doesNotMatch(missing.stage.textContent, new RegExp(title));
  assert.equal(missing.byClass("missing-shutter").length, 0);

  const success = createHarness({
    fetch: () => response({ data: { status: "ok", shutterCount: 526 } }),
  });
  await success.upload();
  assert.match(success.stage.textContent, /526/);
  assert.doesNotMatch(success.stage.textContent, new RegExp(title));

  const rejected = createHarness({});
  await rejected.upload({ name: "notes.png", size: 100 });
  assert.match(rejected.stage.textContent, /无法解析该文件/);
  assert.doesNotMatch(rejected.stage.textContent, new RegExp(title));
  assert.equal(rejected.byClass("missing-shutter").length, 0);
});

test("failed settings retrieval can be retried and effective limits replace defaults", async () => {
  let checks = 0;
  const ui = createHarness({
    settings: () =>
      ++checks === 1
        ? response({ status: 502 })
        : response({ data: { maxUploadMb: 1, maxUploadBytes: 1048576 } }),
    fetch: () => response({ data: { status: "ok", shutterCount: 526 } }),
  });
  await ui.upload();
  assert.match(ui.stage.textContent, /解析失败/);
  assert.equal(ui.calls.length, 0);
  await ui.upload({ name: "large.jpg", size: 1048577 });
  assert.match(ui.stage.textContent, /1 MB/);
  assert.match(ui.stage.textContent, /文件过大/);
  assert.equal(ui.calls.length, 0);
  await ui.upload();
  assert.match(ui.stage.textContent, /526/);
  assert.equal(checks, 2);
});

test("english pages keep their language through loading, success, failure, and reset", async () => {
  let release = (_value: FakeResponse) => {};
  const pending = new Promise<FakeResponse>((resolve) => {
    release = resolve;
  });
  const ui = createHarness({
    pathname: "/tools/counter/en/",
    mount: "/tools/counter/",
    hash: "#kept",
    search: "?from=mail",
    fetch: () => pending,
  });
  const running = ui.actions.handleFile({ name: "camera.jpg", size: 100 });
  await ui.flush();
  assert.match(ui.stage.textContent, /Reading the original photo/);
  assert.match(ui.stage.textContent, /camera\.jpg · Please wait/);
  assert.doesNotMatch(ui.stage.textContent, /正在解析/);
  release(
    response({ data: { status: "ok", shutterCount: 526, model: "NIKON D70" } })
  );
  await ui.finish(running);
  assert.match(ui.stage.textContent, /526/);
  assert.match(ui.stage.textContent, /Camera model/);
  assert.match(ui.stage.textContent, /Shutter count/);
  assert.match(ui.stage.textContent, /Check another/);
  assert.doesNotMatch(ui.stage.textContent, /未能读取快门次数|机身型号/);
  ui.actions.resetAndPick();
  assert.match(ui.stage.textContent, /Click or drop an original photo here/);
  assert.equal(ui.byClass("missing-shutter").length, 0);

  const failed = createHarness({
    pathname: "/tools/counter/en/index.html",
    mount: "/tools/counter/",
    fetch: () => response({ status: 500, invalidJson: true }),
  });
  await failed.upload();
  assert.match(failed.stage.textContent, /Could not read the photo/);
  assert.equal(failed.byClass("missing-shutter").length, 0);
  failed.actions.resetAndPick();
  assert.match(
    failed.stage.textContent,
    /Click or drop an original photo here/
  );

  const missing = createHarness({
    pathname: "/en/",
    mount: "/",
    fetch: () =>
      response({ data: { status: "no_shutter_field", model: "iPhone 15" } }),
  });
  await missing.upload();
  assert.match(missing.stage.textContent, /Shutter count was not found/);
  assert.match(missing.stage.textContent, /Export Unmodified Original/);
  assert.match(missing.stage.textContent, /English illustration/);
  assert.doesNotMatch(missing.stage.textContent, /导出未修改的原片/);
  assert.match(missing.stage.textContent, /View full image/);
  const image = missing.byClass("missing-shutter__image")[0];
  const zoom = missing.byClass("missing-shutter__zoom")[0];
  assert.equal(image?.attributes.src, "/iphone-export-original-en.jpg");
  assert.equal(image?.attributes.width, "864");
  assert.equal(image?.attributes.height, "1152");
  assert.match(image?.attributes.alt ?? "", /English illustration/);
  assert.equal(zoom?.attributes.href, "/iphone-export-original-en.jpg");
});

test("result notes follow noteCode and keep the original note when the code is unknown", async () => {
  const english = createHarness({
    pathname: "/shutter/en/",
    mount: "/shutter/",
    fetch: () =>
      response({
        data: {
          status: "ok",
          shutterCount: 42,
          approximate: true,
          note: "该机型记录的是图像计数，格式化存储卡后可能归零，仅供参考。",
          noteCode: "canon_image_count",
        },
      }),
  });
  await english.upload();
  assert.match(english.stage.textContent, /Formatting the card can reset it/);
  assert.doesNotMatch(english.stage.textContent, /格式化存储卡/);

  const legacy = createHarness({
    pathname: "/shutter/en/",
    mount: "/shutter/",
    fetch: () =>
      response({
        data: {
          status: "ok",
          shutterCount: 7,
          approximate: true,
          note: "该机型记录的是图像计数，格式化存储卡后可能归零，仅供参考。",
          noteCode: "PRIVATE_future_code",
        },
      }),
  });
  await legacy.upload();
  assert.match(legacy.stage.textContent, /格式化存储卡/);
  assert.doesNotMatch(legacy.stage.textContent, /PRIVATE/);

  const approximate = createHarness({
    pathname: "/shutter/",
    fetch: () =>
      response({
        data: { status: "ok", shutterCount: 9, approximate: true, note: null },
      }),
  });
  await approximate.upload();
  assert.match(approximate.stage.textContent, /该数值为近似值/);
});

test("only a manual switch persists, and a blocked store still changes the URL", async () => {
  const ui = createHarness({
    pathname: "/shutter/",
    search: "?album=1",
    hash: "#top",
  });
  assert.equal(ui.stored.size, 0);
  assert.equal(ui.langSwitch.attributes.href, "/shutter/en/?album=1#top");
  ui.location.hash = "#later";
  ui.emit("hashchange");
  assert.equal(ui.langSwitch.attributes.href, "/shutter/en/?album=1#later");
  await ui.langSwitch.click();
  assert.equal(ui.stored.get("rf-lang"), "en");
  assert.equal(ui.cookie(), "");

  const blocked = createHarness({
    pathname: "/shutter/en/",
    mount: "/shutter/",
    storage: "blocked",
    search: "?album=1",
    hash: "#x",
  });
  assert.equal(blocked.langSwitch.textContent, "中文");
  await blocked.langSwitch.click();
  assert.equal(blocked.stored.size, 0);
  assert.equal(blocked.cookie(), "");
  assert.equal(
    blocked.langSwitch.attributes.href,
    "/shutter/?album=1&lang=zh#x"
  );

  const cookieOnly = createHarness({
    pathname: "/tools/counter/",
    mount: "/tools/counter/",
    storage: "cookie",
  });
  await cookieOnly.langSwitch.click();
  assert.equal(cookieOnly.stored.size, 0);
  assert.match(
    cookieOnly.cookie(),
    /^rf-lang=en; Path=\/; Max-Age=31536000; SameSite=Lax$/
  );
  assert.equal(cookieOnly.langSwitch.attributes.href, "/tools/counter/en/");
});

test("switching language keeps the parsed result and swaps the guide image", async () => {
  const ui = createHarness({
    pathname: "/tools/counter/en/",
    mount: "/tools/counter/",
    search: "?album=1",
    hash: "#shot",
    fetch: () =>
      response({
        data: {
          status: "no_shutter_field",
          model: "iPhone 15",
          fileName: "camera.jpg",
        },
      }),
  });
  await ui.upload();
  assert.equal(ui.calls.length, 1);
  assert.match(ui.stage.textContent, /English illustration/);
  await ui.langSwitch.click();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.location.pathname, "/tools/counter/");
  assert.equal(ui.location.search, "?album=1&lang=zh");
  assert.equal(ui.location.hash, "#shot");
  assert.match(ui.stage.textContent, /未能读取快门次数/);
  assert.match(ui.stage.textContent, /导出未修改的原片/);
  assert.match(ui.stage.textContent, /iPhone 15/);
  assert.doesNotMatch(ui.stage.textContent, /English illustration/);
  const image = ui.byClass("missing-shutter__image")[0];
  const zoom = ui.byClass("missing-shutter__zoom")[0];
  assert.equal(
    image?.attributes.src,
    "/tools/counter/iphone-export-original.jpg"
  );
  assert.equal(image?.attributes.width, "1206");
  assert.equal(image?.attributes.height, "1550");
  assert.equal(
    zoom?.attributes.href,
    "/tools/counter/iphone-export-original.jpg"
  );
  await ui.langSwitch.click();
  assert.equal(ui.calls.length, 1);
  assert.equal(ui.location.pathname, "/tools/counter/en/");
  assert.match(ui.stage.textContent, /English illustration/);
  assert.equal(
    ui.byClass("missing-shutter__image")[0]?.attributes.src,
    "/tools/counter/iphone-export-original-en.jpg"
  );
  assert.equal(
    ui.byClass("missing-shutter__image")[0]?.attributes.width,
    "864"
  );
  assert.equal(
    ui.byClass("missing-shutter__image")[0]?.attributes.height,
    "1152"
  );
});
