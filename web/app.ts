import {
  hrefFor,
  mountUrl,
  normalizeMount,
  placeInMount,
  sameMount,
} from "../shared/lang.js";
import type { LangCode } from "../shared/lang.js";
import { loadUploadSettings, classifyResponse } from "./api.js";
import { COPY } from "./copy.js";
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
const pageLang: LangCode = placeInMount(location.pathname, mount).lang;
const copy = COPY[pageLang];
const API_URL = mountUrl(mount, "api/parse");
const CONFIG_URL = mountUrl(mount, "api/config");
const FETCH_TIMEOUT_MS = 60_000;
const MIN_LOADING_MS = 400;
let uploadGeneration = 0;
let activeController: AbortController | null = null;
const {
  fileInput,
  renderUpload,
  renderLoading,
  renderSuccess,
  renderFail,
  renderError,
  setUploadLimit,
} = createView({
  onFile: (file) => {
    void handleFile(file);
  },
  onReset: resetAndPick,
  copy,
  guideImage: mountUrl(mount, "iphone-export-original.jpg"),
});
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

function bindLanguageSwitch() {
  const anchor = document.querySelector<HTMLAnchorElement>("#lang-switch");
  if (!anchor) return;
  const other: LangCode = pageLang === "en" ? "zh" : "en";
  const sync = () => {
    anchor.href = hrefFor(
      other,
      location.pathname,
      mount,
      location.search || "",
      location.hash || ""
    );
  };
  sync();
  window.addEventListener("hashchange", sync);
  anchor.addEventListener("click", () => {
    writePref(browserPrefHost(), other);
    sync();
  });
  const rf = window.rfLang;
  if (
    rf?.href &&
    rf.place &&
    !sameMount(rf.place(location.pathname).site.base, mount)
  ) {
    rf.href = (lang) =>
      hrefFor(
        lang,
        location.pathname,
        mount,
        location.search || "",
        location.hash || ""
      );
    const bar = document.querySelector<HTMLAnchorElement>("a.rf-lang");
    if (bar) bar.href = rf.href(other);
  }
  if (document.querySelector("a.rf-lang")) anchor.hidden = true;
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
