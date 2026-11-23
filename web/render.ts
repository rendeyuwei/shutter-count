import type { NoteCode } from "../shared/notes.js";
import type { Copy } from "./copy.js";
import type { GuideImage } from "./guide.js";
import type {
  ErrorKind,
  MetadataView,
  SuccessView,
  ResultRow,
} from "./types.js";
function isKnownNote(code: NoteCode): boolean {
  return code === "canon_image_count" || code === "fuji_image_count";
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

export function createView(viewActions: {
  onFile: (file: File) => void;
  onReset: () => void;
  copy: Copy;
  guide: GuideImage;
}) {
  let copy = viewActions.copy;
  let guide = viewActions.guide;
  let mode: "upload" | "result" = "upload";
  let paint: () => void = () => {};
  let maxUploadMb = 50;
  const introEl = requiredElement<HTMLElement>("#intro");
  const stageEl = requiredElement<HTMLElement>("#stage");
  const fileInput = requiredElement<HTMLInputElement>("#file-input");

  const ICONS = {
    upload: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 16V4m0 0 4 4m-4-4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M4 14v4.2A1.8 1.8 0 0 0 5.8 20h12.4a1.8 1.8 0 0 0 1.8-1.8V14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
  </svg>`,
    shield: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 3 5 6.5v5.2c0 4.1 2.8 7.9 7 8.8 4.2-.9 7-4.7 7-8.8V6.5L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M9.5 12.2 11.2 14l3.5-3.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
    file: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 3.8h6.2L19 9.6V20.2A1.8 1.8 0 0 1 17.2 22H7A1.8 1.8 0 0 1 5.2 20.2V5.6A1.8 1.8 0 0 1 7 3.8Z" stroke="currentColor" stroke-width="1.6"/>
    <path d="M13 3.8V9h5.8" stroke="currentColor" stroke-width="1.6"/>
  </svg>`,
    warn: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M12 9v4.5m0 3.2h.01M10.1 4.4 2.7 17.2A2.1 2.1 0 0 0 4.5 20.3h15a2.1 2.1 0 0 0 1.8-3.1L13.9 4.4a2.1 2.1 0 0 0-3.8 0Z" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  };

  function icon(name: keyof typeof ICONS): Element {
    const tpl = document.createElement("template");
    tpl.innerHTML = ICONS[name].trim();
    const element = tpl.content.firstElementChild;
    if (!element) throw new Error("Invalid static icon");
    return element;
  }

  /* ------------------------------------------------------------------ */
  /* Error copy                                                          */
  /* ------------------------------------------------------------------ */

  /* ------------------------------------------------------------------ */
  /* Small DOM builders                                                  */
  /* ------------------------------------------------------------------ */

  function setIntro(text: string) {
    introEl.textContent = text;
  }

  function setStage(...nodes: Node[]) {
    stageEl.replaceChildren(...nodes);
  }

  function buildPrivacyNote() {
    const p = document.createElement("p");
    p.className = "privacy-note";
    p.append(icon("shield"));
    p.append(document.createTextNode(copy.privacy));
    return p;
  }

  function buildDropzoneIdle() {
    const dz = document.createElement("div");
    dz.className = "upload-dropzone";
    dz.setAttribute("role", "button");
    dz.setAttribute("tabindex", "0");
    dz.setAttribute("aria-label", copy.dropzone.label);
    dz.append(icon("upload"));

    const strong = document.createElement("strong");
    strong.textContent = copy.dropzone.label;
    const span = document.createElement("span");
    span.textContent = copy.dropzone.hint;
    dz.append(strong, span);

    // Click / keyboard open the picker.
    dz.addEventListener("click", () => fileInput.click());
    dz.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        fileInput.click();
      }
    });

    // Drag & drop with an enter/leave counter so the highlight doesn't flicker.
    let dragDepth = 0;
    const hasFiles = (e: DragEvent) =>
      e.dataTransfer &&
      Array.from(e.dataTransfer.types || []).includes("Files");

    dz.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      dz.dataset.dragging = "true";
    });
    dz.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    });
    dz.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) delete dz.dataset.dragging;
    });
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dragDepth = 0;
      delete dz.dataset.dragging;
      const file =
        e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) viewActions.onFile(file);
    });

    return dz;
  }

  function buildDropzoneBusy(fileName: string) {
    const dz = document.createElement("div");
    dz.className = "upload-dropzone";
    dz.setAttribute("aria-busy", "true");
    dz.setAttribute("role", "status");
    dz.setAttribute("aria-live", "polite");

    const spinner = document.createElement("div");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const strong = document.createElement("strong");
    strong.className = "loading-hint";
    strong.textContent = copy.loading.title;
    const span = document.createElement("span");
    span.textContent = copy.loading.wait(fileName);
    dz.append(spinner, strong, span);
    return dz;
  }

  function buildFileChip(fileName: string) {
    const chip = document.createElement("div");
    chip.className = "file-chip";
    chip.title = fileName;
    chip.append(icon("file"));
    const name = document.createElement("span");
    name.className = "file-chip__name";
    name.textContent = fileName;
    chip.append(name);
    return chip;
  }

  /** rows: [{label, value, shutter?, note?}] */
  function buildResultCard(rows: ResultRow[], ariaLabel: string) {
    const card = document.createElement("div");
    card.className = "result-card";
    card.setAttribute("aria-label", ariaLabel);
    for (const row of rows) {
      const r = document.createElement("div");
      r.className = row.shutter
        ? "result-row result-row--shutter"
        : "result-row";
      const label = document.createElement("span");
      label.className = "result-row__label";
      label.textContent = row.label;
      const value = document.createElement("span");
      value.className = "result-row__value";
      value.textContent = row.value;
      r.append(label, value);
      if (row.note) {
        const note = document.createElement("span");
        note.className = "result-row__note";
        note.textContent = row.note;
        r.append(note);
      }
      card.append(r);
    }
    return card;
  }

  function buildWarnBanner(title: string, bodyText: string) {
    const banner = document.createElement("div");
    banner.className = "warn-banner";
    banner.setAttribute("role", "status");
    banner.append(icon("warn"));
    const div = document.createElement("div");
    const strong = document.createElement("strong");
    strong.textContent = title;
    div.append(strong, document.createTextNode(bodyText));
    banner.append(div);
    return banner;
  }

  function buildActions(label: string, variant: "primary" | "secondary") {
    const actions = document.createElement("div");
    actions.className = "result-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `button button--${variant}`;
    btn.textContent = label;
    btn.addEventListener("click", viewActions.onReset);
    actions.append(btn);
    return actions;
  }

  /* ------------------------------------------------------------------ */
  /* State renderers                                                     */
  /* ------------------------------------------------------------------ */

  function localizedNote(data: SuccessView): string | null {
    if (data.noteCode && isKnownNote(data.noteCode)) {
      return copy.notes[data.noteCode];
    }
    if (data.note) return data.note;
    if (data.approximate) return copy.notes.approximate;
    return null;
  }

  function drawUpload() {
    setIntro(copy.intro.upload);
    setStage(buildDropzoneIdle(), buildPrivacyNote());
  }

  function renderUpload() {
    mode = "upload";
    paint = drawUpload;
    paint();
  }

  function renderLoading(fileName: string) {
    mode = "result";
    paint = () => {
      setIntro(copy.intro.upload);
      setStage(buildDropzoneBusy(fileName), buildPrivacyNote());
    };
    paint();
  }

  function renderSuccess(data: SuccessView) {
    mode = "result";
    paint = () => drawSuccess(data);
    paint();
  }

  function drawSuccess(data: SuccessView) {
    setIntro(copy.intro.success);

    const rows: ResultRow[] = [
      { label: copy.labels.model, value: data.model || copy.labels.unknown },
      {
        label: copy.labels.shutter,
        value: Number(data.shutterCount).toLocaleString("en-US"),
        shutter: true,
        note: localizedNote(data),
      },
    ];
    if (data.capturedAt) {
      rows.push({ label: copy.labels.capturedAt, value: data.capturedAt });
    }

    setStage(
      buildFileChip(data.fileName || copy.fileFallback),
      buildResultCard(rows, copy.resultLabel),
      buildActions(copy.again, "primary")
    );
    introEl.focus();
  }

  function buildMissingShutterHelp() {
    const section = document.createElement("section");
    section.className = "missing-shutter";

    const title = document.createElement("h2");
    title.textContent = copy.missing.title;

    const causes = document.createElement("ul");
    causes.className = "missing-shutter__causes";
    for (const text of copy.missing.causes) {
      const item = document.createElement("li");
      item.textContent = text;
      causes.append(item);
    }

    const guideTitle = document.createElement("h3");
    guideTitle.textContent = copy.missing.guideTitle;
    const steps = document.createElement("ol");
    steps.className = "missing-shutter__steps";
    for (const text of copy.missing.steps) {
      const item = document.createElement("li");
      item.textContent = text;
      steps.append(item);
    }

    const limit = document.createElement("p");
    limit.className = "missing-shutter__limit";
    limit.textContent = copy.missing.limit;

    const link = document.createElement("a");
    link.className = "missing-shutter__zoom";
    link.setAttribute("href", guide.src);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");

    const image = document.createElement("img");
    image.className = "missing-shutter__image";
    image.setAttribute("src", guide.src);
    image.setAttribute("width", String(guide.width));
    image.setAttribute("height", String(guide.height));
    image.setAttribute("alt", copy.missing.alt);
    const zoom = document.createElement("span");
    zoom.textContent = copy.missing.zoom;
    link.append(image, zoom);
    section.append(title, causes, guideTitle, steps, limit, link);
    if (copy.missing.caption) {
      const caption = document.createElement("p");
      caption.className = "missing-shutter__caption";
      caption.textContent = copy.missing.caption;
      section.append(caption);
    }
    return section;
  }

  function renderFail(data: Partial<MetadataView>) {
    mode = "result";
    paint = () => drawFail(data);
    paint();
  }

  function drawFail(data: Partial<MetadataView>) {
    setIntro(copy.intro.fail);

    const nodes: Node[] = [buildFileChip(data.fileName || copy.fileFallback)];
    nodes.push(buildMissingShutterHelp());

    const rows: ResultRow[] = [];
    if (data.model) rows.push({ label: copy.labels.model, value: data.model });
    if (data.capturedAt) {
      rows.push({ label: copy.labels.capturedAt, value: data.capturedAt });
    }
    if (rows.length > 0) nodes.push(buildResultCard(rows, copy.knownLabel));

    nodes.push(buildActions(copy.reupload, "secondary"));
    setStage(...nodes);
    introEl.focus();
  }

  function renderError(kind: ErrorKind, fileName?: string | null) {
    mode = "result";
    paint = () => drawError(kind, fileName);
    paint();
  }

  function drawError(kind: ErrorKind, fileName?: string | null) {
    const message =
      kind === "too_large"
        ? {
            ...copy.errors.too_large,
            body: copy.tooLarge(maxUploadMb),
          }
        : copy.errors[kind];
    setIntro(copy.intro.error);

    const nodes: Node[] = [];
    if (fileName) nodes.push(buildFileChip(fileName));
    nodes.push(
      buildWarnBanner(message.title, message.body),
      buildActions(copy.reupload, "secondary")
    );
    setStage(...nodes);
    introEl.focus();
  }

  return {
    fileInput,
    renderUpload,
    renderLoading,
    renderSuccess,
    renderFail,
    renderError,
    showingResult: () => mode === "result",
    useLocale(nextCopy: Copy, nextGuide: GuideImage) {
      copy = nextCopy;
      guide = nextGuide;
      paint();
    },
    setUploadLimit: (value: number) => {
      maxUploadMb = value;
    },
  };
}
