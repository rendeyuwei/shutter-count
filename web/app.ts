import { loadUploadSettings, classifyResponse } from "./api.js";
import { makeDiagnostics, responseDiagnostics } from "./diagnostics.js";
import { createView } from "./render.js";
import type { ParseOutcome, Diagnostics } from "./types.js";
import type { UploadSettings } from "../shared/protocol.js";
const API_URL = "./api/parse";
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
});
let settingsPromise: Promise<UploadSettings | null> | null = null;
function getUploadSettings(): Promise<UploadSettings | null> {
  return (settingsPromise ??= loadUploadSettings().then((settings) => {
    if (settings) setUploadLimit(settings.maxUploadMb);
    else settingsPromise = null;
    return settings;
  }));
}
void getUploadSettings();
export async function handleFile(file: File) {
  const name = file.name || "upload.jpg";
  if (!/\.jpe?g$/i.test(name)) {
    cancelPendingUpload();
    renderError(
      "unsupported",
      name,
      makeDiagnostics({
        status: "client_validation_failed",
        reason: "not_jpeg",
      }),
      "文件在浏览器中未通过校验，尚未上传，因此没有服务器诊断 ID。"
    );
    return;
  }
  cancelPendingUpload();
  const selection = uploadGeneration;
  const settings = await getUploadSettings();
  if (selection !== uploadGeneration) return;
  if (!settings) {
    cancelPendingUpload();
    renderError(
      "network",
      name,
      makeDiagnostics({ status: "network_error", reason: "network_error" })
    );
    return;
  }
  if (file.size > settings.maxUploadBytes) {
    cancelPendingUpload();
    renderError(
      "too_large",
      name,
      makeDiagnostics({
        status: "client_validation_failed",
        reason: "file_too_large",
      }),
      "文件在浏览器中未通过校验，尚未上传，因此没有服务器诊断 ID。"
    );
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
  let diagnostics: Diagnostics;
  let response: Response | null = null;
  try {
    const fd = new FormData();
    fd.append("file", file, name);
    const res = await fetch(API_URL, {
      method: "POST",
      body: fd,
      signal: controller.signal,
    });
    response = res;
    let data: unknown = null;
    let invalidResponse = false;
    try {
      data = await res.json();
    } catch {
      // A proxy may return HTML. Recover the server ID from headers, without
      // copying its body or exception message into the user's report.
      invalidResponse = true;
    }
    outcome = classifyResponse(res, data);
    diagnostics = responseDiagnostics(
      res,
      data,
      invalidResponse ? "invalid_response" : "not_provided"
    );
    if (res.ok && outcome.kind === "error") {
      diagnostics = makeDiagnostics({
        ...diagnostics,
        status: "unexpected_response",
        reason: "invalid_response",
      });
    }
    if (timedOut) {
      outcome = { kind: "error", error: "network" };
      diagnostics = responseDiagnostics(res, null, "timeout");
    }
  } catch {
    // network failure, CORS, or the 60 s abort
    outcome = { kind: "error", error: "network" };
    diagnostics = response
      ? responseDiagnostics(
          response,
          null,
          timedOut ? "timeout" : "network_error"
        )
      : makeDiagnostics({
          status: timedOut ? "client_timeout" : "network_error",
          reason: timedOut ? "timeout" : "network_error",
        });
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
  else if (outcome.kind === "fail") renderFail(outcome.data, diagnostics);
  else
    renderError(
      outcome.error,
      name,
      diagnostics,
      response
        ? null
        : "未收到服务器响应，因此没有服务器诊断 ID。可复制以下信息反馈。"
    );
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

function init() {
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
