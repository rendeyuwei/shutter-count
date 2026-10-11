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
  addEventListener(type: string, listener: (event: FakeEvent) => unknown) {
    (this.listeners[type] ||= []).push(listener);
  }
  async emit(type: string, event: FakeEvent = {}) {
    for (const listener of this.listeners[type] || []) await listener(event);
  }
  click() {
    this.clickCount += 1;
    return this.emit("click");
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
  clipboard,
  settings,
}: {
  fetch?: FakeFetch;
  settings?: () => FakeResponse | Promise<FakeResponse>;
  clipboard?: { writeText: (text: string) => Promise<unknown> };
} = {}) {
  const document = { activeElement: null } as FakeDocument;
  document.root = new HarnessElement("body", "", document);
  const intro = new HarnessElement("p", "", document);
  const stage = new HarnessElement("div", "", document);
  const fileInput = new HarnessElement("input", "", document);
  document.root.append(intro, stage, fileInput);
  document.getElementById = (id) =>
    (
      ({ intro, stage, "file-input": fileInput }) as Record<
        string,
        HarnessElement
      >
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
  const calls: [string, FetchOptions][] = [];
  const context = vm.createContext({
    document,
    window: { addEventListener() {} },
    location: { search: "", hash: "" },
    navigator: clipboard ? { clipboard } : {},
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
      if (args[0] === "./api/config")
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
  const report = () => byClass("feedback-panel__report")[0];
  const copyButton = () => byClass("feedback-panel__actions")[0]?.children[0];
  const copyStatus = () => byClass("feedback-panel__copy-status")[0];
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
    calls,
    timers,
    all,
    byClass,
    report,
    copyButton,
    copyStatus,
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

test("no_shutter_field exposes a readonly allowlisted report, excluding file and EXIF", async () => {
  const data = {
    requestId: ID_A,
    status: "no_shutter_field",
    fileName: "PRIVATE_filename.jpg",
    make: "PRIVATE_make",
    model: "PRIVATE_model",
    serial: "PRIVATE_serial",
    GPS: "PRIVATE_GPS",
    capturedAt: "PRIVATE_capture_time",
    metadata: "PRIVATE_metadata",
    message: "PRIVATE_message<script>alert(1)</script>",
    reason: "PRIVATE_reason<script>alert(1)</script>",
  };
  const ui = createHarness({ fetch: () => response({ data }) });
  await ui.upload();
  assert.equal(ui.report()!.readOnly, true);
  assert.match(
    ui.report()!.value,
    new RegExp(
      `^requestId: ${ID_A}\\nstatus: no_shutter_field\\nreason: unknown\\n`
    )
  );
  assert.match(
    ui.report()!.value,
    /发生时间（客户端 UTC）: 2026-10-10T00:00:00\.000Z$/
  );
  assert.equal(ui.report()!.value.split("\n").length, 4);
  assert.doesNotMatch(
    ui.report()!.value,
    /PRIVATE|script|filename|model|serial|GPS|capture/i
  );
  assert.match(ui.stage.textContent, /反馈这个问题/);
  assert.match(ui.stage.textContent, /不含文件名、照片或 EXIF/);
});

test("successful recognition keeps the existing result with no feedback panel", async () => {
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
  assert.equal(ui.report(), undefined);
  assert.match(ui.stage.textContent, /12,345/);
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
      assert.match(ui.report()!.value, new RegExp(ID_A));
      assert.match(
        ui.report()!.value,
        /status: unexpected_response\nreason: invalid_response/
      );
      assert.doesNotMatch(ui.stage.textContent, /NaN|快门读取结果/);
      assert.match(ui.stage.textContent, /重新上传/);
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
  assert.match(
    ui.report()!.value,
    /unexpected_response\nreason: invalid_response/
  );
  assert.doesNotMatch(ui.stage.textContent, /PRIVATE|\[object Object\]/);
});

test("all server error states show a report and retry action", async (t) => {
  for (const [status, apiStatus, reason] of [
    [400, "bad_request", undefined],
    [413, "file_too_large", undefined],
    [422, "unsupported_or_corrupt", "corrupt"],
    [429, "rate_limited", undefined],
    [500, "error", "parser_unavailable"],
    [504, "error", "timeout"],
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
      assert.match(ui.report()!.value, new RegExp(`status: ${apiStatus}\\n`));
      assert.match(
        ui.report()!.value,
        new RegExp(`reason: ${reason || "not_provided"}\\n`)
      );
      assert.match(ui.stage.textContent, /重新上传/);
    });
  }
});

test("non-JSON errors preserve the X-Request-ID fallback without exposing the body", async () => {
  const ui = createHarness({
    fetch: () => response({ status: 502, invalidJson: true, headerId: ID_B }),
  });
  await ui.upload();
  assert.match(ui.report()!.value, new RegExp(`requestId: ${ID_B}\\n`));
  assert.match(ui.report()!.value, /status: error\nreason: invalid_response\n/);
  assert.doesNotMatch(ui.report()!.value, /PRIVATE/);
});

test("invalid or missing JSON IDs use only a valid UUID response header", async (t) => {
  for (const requestId of [
    undefined,
    "PRIVATE_ID\nGPS: coordinates",
    ID_A + "extra",
    ID_A + "\n",
    123,
    {},
  ]) {
    await t.test(String(requestId), async () => {
      const ui = createHarness({
        fetch: () =>
          response({
            data: { status: "no_shutter_field", requestId },
            headerId: ID_B,
          }),
      });
      await ui.upload();
      assert.match(ui.report()!.value, new RegExp(`requestId: ${ID_B}\\n`));
      assert.doesNotMatch(ui.report()!.value, /PRIVATE|coordinates|extra/);
    });
  }
});

test("valid JSON request ID is preferred over the fallback header", async () => {
  const ui = createHarness({
    fetch: () =>
      response({
        data: { status: "no_shutter_field", requestId: ID_A },
        headerId: ID_B,
      }),
  });
  await ui.upload();
  assert.match(ui.report()!.value, new RegExp(ID_A));
  assert.doesNotMatch(ui.report()!.value, new RegExp(ID_B));
});

test("missing IDs and unrecognized codes are bounded, explicit, and never invented", async (t) => {
  for (const data of [
    null,
    {},
    { requestId: "PRIVATE", status: "PRIVATE", reason: "PRIVATE" },
  ]) {
    await t.test(JSON.stringify(data), async () => {
      const ui = createHarness({
        fetch: () => response({ data, headerId: "PRIVATE_header" }),
      });
      await ui.upload();
      assert.match(
        ui.report()!.value,
        /^requestId: 无服务器诊断 ID\nstatus: unexpected_response\n/
      );
      assert.match(ui.stage.textContent, /服务器响应未提供有效的诊断 ID/);
      assert.doesNotMatch(ui.report()!.value, /PRIVATE/);
    });
  }
});

test("non-JSON response with no ID still offers manual diagnostics", async () => {
  const ui = createHarness({
    fetch: () => response({ status: 500, invalidJson: true }),
  });
  await ui.upload();
  assert.match(ui.report()!.value, /requestId: 无服务器诊断 ID\n/);
  assert.match(ui.report()!.value, /reason: invalid_response/);
});

test("local validation reports no server ID and never uploads the file", async (t) => {
  for (const [file, reason] of [
    [{ name: "PRIVATE.png", size: 100 }, "not_jpeg"],
    [{ name: "PRIVATE.jpg", size: 50 * 1024 * 1024 + 1 }, "file_too_large"],
  ] as const) {
    await t.test(reason, async () => {
      const ui = createHarness();
      await ui.upload(file);
      assert.equal(ui.calls.length, 0);
      assert.match(ui.stage.textContent, /尚未上传，因此没有服务器诊断 ID/);
      assert.match(
        ui.report()!.value,
        new RegExp(`status: client_validation_failed\\nreason: ${reason}\\n`)
      );
      assert.doesNotMatch(ui.report()!.value, /PRIVATE/);
    });
  }
});

test("network failure has no server ID and excludes exception details", async () => {
  const ui = createHarness({
    fetch: () => {
      throw new Error("PRIVATE_network_message");
    },
  });
  await ui.upload();
  assert.match(
    ui.report()!.value,
    /status: network_error\nreason: network_error\n/
  );
  assert.match(ui.stage.textContent, /未收到服务器响应，因此没有服务器诊断 ID/);
  assert.doesNotMatch(ui.report()!.value, /PRIVATE/);
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
  assert.match(
    ui.report()!.value,
    /^requestId: 无服务器诊断 ID\nstatus: client_timeout\nreason: timeout\n/
  );
  assert.match(ui.stage.textContent, /未收到服务器响应/);
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
  assert.match(ui.report()!.value, new RegExp(`requestId: ${ID_A}\\n`));
  assert.match(ui.report()!.value, /reason: timeout\n/);
  assert.doesNotMatch(ui.stage.textContent, /未收到服务器响应/);
});

test("copy diagnostics writes exactly the safe report and announces success", async () => {
  const copied: string[] = [];
  const ui = createHarness({
    fetch: () =>
      response({ data: { requestId: ID_A, status: "no_shutter_field" } }),
    clipboard: { writeText: async (text) => copied.push(text) },
  });
  await ui.upload();
  await ui.copyButton()!.click();
  assert.deepEqual(copied, [ui.report()!.value]);
  assert.equal(ui.copyButton()!.textContent, "已复制");
  assert.equal(ui.copyButton()!.disabled, false);
  assert.match(ui.copyStatus()!.textContent, /请粘贴/);
});

test("denied or missing clipboard access selects the readonly report for manual copying", async (t) => {
  for (const clipboard of [
    undefined,
    {
      writeText: async () => {
        throw new Error("denied");
      },
    },
  ]) {
    await t.test(clipboard ? "denied" : "unavailable", async () => {
      const ui = createHarness({
        fetch: () =>
          response({ data: { status: "no_shutter_field", requestId: ID_A } }),
        clipboard,
      });
      await ui.upload();
      await ui.copyButton()!.click();
      assert.equal(ui.document.activeElement, ui.report());
      assert.equal(ui.report()!.selectionStart, 0);
      assert.equal(ui.report()!.selectionEnd, ui.report()!.value.length);
      assert.equal(ui.copyButton()!.disabled, false);
      assert.match(ui.copyStatus()!.textContent, /已选中内容，请手动复制/);
    });
  }
});

test("a late clipboard failure cannot steal focus from a new upload", async () => {
  const copy = deferred();
  const ui = createHarness({
    fetch: () =>
      response({ data: { status: "no_shutter_field", requestId: ID_A } }),
    clipboard: { writeText: () => copy.promise },
  });
  await ui.upload();
  const oldReport = ui.report();
  const copying = ui.copyButton()!.click();
  ui.actions.resetAndPick();
  assert.equal(oldReport!.isConnected, false);
  copy.reject(new Error("denied late"));
  await copying;
  assert.notEqual(ui.document.activeElement, oldReport);
  assert.equal(ui.report(), undefined);
  assert.match(ui.stage.textContent, /点击或拖放/);
});

test("pending copy is not issued twice and does not update a detached panel", async () => {
  const copy = deferred();
  const copied: string[] = [];
  const ui = createHarness({
    fetch: () =>
      response({ data: { status: "no_shutter_field", requestId: ID_A } }),
    clipboard: {
      writeText: (text) => {
        copied.push(text);
        return copy.promise;
      },
    },
  });
  await ui.upload();
  const button = ui.copyButton()!;
  const pending = button.click();
  await button.click();
  assert.equal(copied.length, 1);
  await ui.upload({ name: "new.png", size: 100 });
  copy.resolve(undefined);
  await pending;
  assert.equal(ui.copyButton()!.textContent, "复制诊断信息");
  assert.match(ui.report()!.value, /reason: not_jpeg/);
});

test("new upload aborts the old one and late old data cannot overwrite its report", async () => {
  const first = deferred<FakeResponse>();
  let fetchCount = 0;
  const ui = createHarness({
    fetch: () =>
      ++fetchCount === 1
        ? first.promise
        : response({
            data: { status: "no_shutter_field", requestId: ID_B },
          }),
  });
  const oldUpload = ui.actions.handleFile({ name: "first.jpg", size: 100 });
  await ui.flush();
  const newUpload = ui.actions.handleFile({ name: "second.jpg", size: 100 });
  await ui.flush();
  assert.equal(ui.calls[0]![1].signal.aborted, true);
  await ui.finish(newUpload);
  first.resolve(
    response({ data: { status: "no_shutter_field", requestId: ID_A } })
  );
  await oldUpload;
  assert.match(ui.report()!.value, new RegExp(ID_B));
  assert.doesNotMatch(ui.report()!.value, new RegExp(ID_A));
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
  assert.match(ui.report()!.value, /status: client_validation_failed/);
  assert.doesNotMatch(ui.report()!.value, new RegExp(ID_A));
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
  assert.equal(ui.report(), undefined);
  assert.match(ui.stage.textContent, /点击或拖放/);
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
  assert.match(ui.report()!.value, /network_error/);
  assert.equal(ui.calls.length, 0);
  await ui.upload({ name: "large.jpg", size: 1048577 });
  assert.match(ui.stage.textContent, /1 MB/);
  assert.match(ui.report()!.value, /client_validation_failed/);
  assert.equal(ui.calls.length, 0);
  await ui.upload();
  assert.match(ui.stage.textContent, /526/);
  assert.equal(checks, 2);
});
