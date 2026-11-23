import {
  explicitChinese,
  hrefFor,
  mountUrl,
  normalizeMount,
  placeInMount,
} from "../shared/lang.js";
import type { LangCode } from "../shared/lang.js";
import { loadUploadSettings, classifyResponse } from "./api.js";
import { COPY } from "./copy.js";
import { guideFor } from "./guide.js";
import { createView } from "./render.js";
import { browserPrefHost, writePref } from "./storage.js";
import type { ParseOutcome } from "./types.js";
import type { UploadSettings } from "../shared/protocol.js";

function readMount(): string {
  const value = window.__SC_MOUNT;
  if (typeof value !== "string" || !value.startsWith("/")) {
    throw new Error("Missing shutter mount");
  }
  return normalizeMount(value);
}

const mount = readMount();
let lang: LangCode = placeInMount(location.pathname, mount).lang;
const API_URL = mountUrl(mount, "api/parse");
const CONFIG_URL = mountUrl(mount, "api/config");
const FETCH_TIMEOUT_MS = 60_000;
const MIN_LOADING_MS = 400;
let uploadGeneration = 0;
let activeController: AbortController | null = null;
const view = createView({
  onFile: (file) => {
    void handleFile(file);
  },
  onReset: resetAndPick,
  copy: COPY[lang],
  guide: guideFor(mount, lang),
});
const {
  fileInput,
  renderUpload,
  renderLoading,
  renderSuccess,
  renderFail,
  renderError,
  setUploadLimit,
} = view;
let settingsPromise: Promise<UploadSettings | null> | null = null;
function getUploadSettings(): Promise<UploadSettings | null> {
  return (settingsPromise ??= loadUploadSettings(CONFIG_URL).then(
    (settings) => {
      if (settings) setUploadLimit(settings.maxUploadMb);
      else settingsPromise = null;
      return settings;
    }
  ));
}
void getUploadSettings();
export async function handleFile(file: File) {
  const name = file.name || "upload.jpg";
  if (!/\.jpe?g$/i.test(name)) {
    cancelPendingUpload();
    renderError("unsupported", name);
    return;
  }
  cancelPendingUpload();
  const selection = uploadGeneration;
  const settings = await getUploadSettings();
  if (selection !== uploadGeneration) return;
  if (!settings) {
    cancelPendingUpload();
    renderError("network", name);
    return;
  }
  if (file.size > settings.maxUploadBytes) {
    cancelPendingUpload();
    renderError("too_large", name);
    return;
  }
  return startParse(file, name);
}

async function startParse(file: File, name: string) {
  cancelPendingUpload();
  const generation = uploadGeneration;
  renderLoading(name);
  const startedAt = Date.now();
  const controller = new AbortController();
  activeController = controller;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  let outcome: ParseOutcome;
  try {
    const fd = new FormData();
    fd.append("file", file, name);
    const res = await fetch(API_URL, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    outcome = classifyResponse(res, data);
    if (timedOut) outcome = { kind: "error", error: "network" };
  } catch {
    outcome = { kind: "error", error: "network" };
  } finally {
    clearTimeout(timer);
    if (activeController === controller) activeController = null;
  }

  if (generation !== uploadGeneration) return;
  // Keep the spinner visible for at least MIN_LOADING_MS so it doesn't flash.
  const elapsed = Date.now() - startedAt;
  if (elapsed < MIN_LOADING_MS) {
    await new Promise((r) => setTimeout(r, MIN_LOADING_MS - elapsed));
  }

  if (generation !== uploadGeneration) return;
  if (outcome.kind === "success") renderSuccess(outcome.data);
  else if (outcome.kind === "fail") renderFail(outcome.data);
  else renderError(outcome.error, name);
}

function cancelPendingUpload() {
  uploadGeneration += 1;
  if (activeController) activeController.abort();
  activeController = null;
}

/** Back to the upload state, and immediately reopen the picker (one click). */
export function resetAndPick() {
  cancelPendingUpload();
  fileInput.value = ""; // allow re-choosing the same file
  renderUpload();
  fileInput.click();
}

/* ------------------------------------------------------------------ */
/* QA preview: /shutter/?demo#success | #fail | #error | #loading      */
/* ------------------------------------------------------------------ */

const DEMO_STATES: Record<string, () => void> = {
  success: () =>
    renderSuccess({
      fileName: "DSC_2480.JPG",
      model: "Nikon Z6 II",
      shutterCount: 12480,
      capturedAt: "2025-11-03 14:22:08",
      approximate: false,
      note: null,
      noteCode: null,
    }),
  fail: () =>
    renderFail({
      fileName: "IMG_7021.JPG",
      model: "Sony ILCE-7M4",
      capturedAt: "2025-09-18 09:05:41",
    }),
  error: () => renderError("network", "DSC_2480.JPG"),
  loading: () => renderLoading("DSC_2480.JPG"),
};

/* ------------------------------------------------------------------ */
/* Init                                                                */
/* ------------------------------------------------------------------ */

function offeredLang(anchor: HTMLAnchorElement): LangCode | null {
  const tag = (anchor.hreflang || anchor.lang || "").toLowerCase();
  if (tag.startsWith("zh")) return "zh";
  if (tag.startsWith("en")) return "en";
  return null;
}

function languageUrl(next: LangCode): string {
  return hrefFor(
    next,
    location.pathname,
    mount,
    location.search || "",
    location.hash || ""
  );
}

function paintSwitch(anchor: HTMLAnchorElement, next: LangCode) {
  const copy = COPY[lang];
  anchor.textContent = copy.switchLabel;
  anchor.title = copy.switchTitle;
  anchor.lang = copy.switchLang;
  anchor.hreflang = copy.switchLang;
  anchor.href = languageUrl(next);
}

// True after the shared switch initially offered this page's other language.
// Later paints keep that one anchor current. The rest of the bar waits for
// the shell's own refresh. rfLang.place and rfLang.href are not replaced.
let barFollowsPage = false;

function syncSwitch() {
  const copy = COPY[lang];
  const next: LangCode = lang === "en" ? "zh" : "en";
  document.documentElement.lang = copy.htmlLang;
  document.title = copy.title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.setAttribute("content", copy.description);
  const heading = document.querySelector("h1");
  if (heading) heading.textContent = copy.h1;
  const canonical = document.querySelector('link[rel="canonical"]');
  const alternate = document.querySelector(
    `link[rel="alternate"][hreflang="${copy.htmlLang}"]`
  );
  const canonicalHref = alternate?.getAttribute("href");
  if (canonical && canonicalHref) canonical.setAttribute("href", canonicalHref);
  const inline = document.querySelector<HTMLAnchorElement>("#lang-switch");
  const bar = document.querySelector<HTMLAnchorElement>("a.rf-lang");
  if (inline) paintSwitch(inline, next);
  if (bar && (barFollowsPage || offeredLang(bar) === next)) {
    barFollowsPage = true;
    paintSwitch(bar, next);
  }
  if (inline) inline.hidden = Boolean(bar) && barFollowsPage;
}

function readUrlLang(): LangCode {
  const placed = placeInMount(location.pathname, mount).lang;
  if (placed === "en") return "en";
  return explicitChinese(location.search) ? "zh" : placed;
}

function onSwitchClick(event: Event, anchor: HTMLAnchorElement) {
  const offered = offeredLang(anchor);
  if (!offered || offered === lang) {
    event.preventDefault();
    return;
  }
  writePref(browserPrefHost(), offered);
  const url = languageUrl(offered);
  if (!view.showingResult()) {
    if ((anchor.getAttribute("href") || "") !== url) {
      event.preventDefault();
      location.assign(url);
    }
    return;
  }
  event.preventDefault();
  lang = offered;
  history.pushState(null, "", url);
  view.useLocale(COPY[lang], guideFor(mount, lang));
  syncSwitch();
}

function bindLanguageSwitch() {
  const inline = document.querySelector<HTMLAnchorElement>("#lang-switch");
  const bar = document.querySelector<HTMLAnchorElement>("a.rf-lang");
  syncSwitch();
  for (const anchor of [inline, bar]) {
    anchor?.addEventListener("click", (event) => onSwitchClick(event, anchor));
  }
  window.addEventListener("hashchange", syncSwitch);
  window.addEventListener("popstate", () => {
    lang = readUrlLang();
    view.useLocale(COPY[lang], guideFor(mount, lang));
    syncSwitch();
  });
}

function init() {
  bindLanguageSwitch();
  // Never let the browser navigate when a file is dropped outside the zone.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  fileInput.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) handleFile(file);
  });

  const params = new URLSearchParams(location.search);
  const hash = (location.hash || "").replace(/^#/, "");
  const demo = DEMO_STATES[hash];
  if (params.has("demo") && demo) {
    demo();
  } else {
    renderUpload();
  }
}

init();
