import type {
  ErrorKind,
  MetadataView,
  SuccessView,
  ResultRow,
} from "./types.js";
function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing page element: ${selector}`);
  return element;
}

export function createView(viewActions: {
  onFile: (file: File) => void;
  onReset: () => void;
}) {
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

  const ERROR_COPY: Record<ErrorKind, { title: string; body: string }> = {
    unsupported: {
      title: "无法解析该文件",
      body: "文件可能已损坏或不是 JPG/JPEG 格式，请换一张相机直出的原图再试。",
    },
    too_large: {
      title: "文件过大",
      body: "请换一张较小的相机原图再试。",
    },
    rate_limited: {
      title: "请求过于频繁",
      body: "请稍等一分钟后再试。",
    },
    busy: {
      title: "解析服务繁忙",
      body: "当前等待解析的图片较多，请稍后重试。",
    },
    network: {
      title: "解析失败",
      body: "网络或服务异常，请稍后重试。",
    },
  };

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
    p.append(document.createTextNode("图片仅临时解析，不长期保存"));
    return p;
  }

  function buildDropzoneIdle() {
    const dz = document.createElement("div");
    dz.className = "upload-dropzone";
    dz.setAttribute("role", "button");
    dz.setAttribute("tabindex", "0");
    dz.setAttribute("aria-label", "点击或拖放原图到这里");
    dz.append(icon("upload"));

    const strong = document.createElement("strong");
    strong.textContent = "点击或拖放原图到这里";
    const span = document.createElement("span");
    span.textContent = "支持 JPG、JPEG，建议相机直出原图";
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
    strong.textContent = "正在解析原图…";
    const span = document.createElement("span");
    span.textContent = `${fileName} · 请稍候`;
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

  function renderUpload() {
    setIntro("上传一张相机原图，读取机身与快门计数。");
    setStage(buildDropzoneIdle(), buildPrivacyNote());
  }

  function renderLoading(fileName: string) {
    setIntro("上传一张相机原图，读取机身与快门计数。");
    setStage(buildDropzoneBusy(fileName), buildPrivacyNote());
  }

  function renderSuccess(data: SuccessView) {
    setIntro("已从原图中读取到机身与快门信息。");

    const rows: ResultRow[] = [
      { label: "机身型号", value: data.model || "未知" },
      {
        label: "快门次数",
        value: Number(data.shutterCount).toLocaleString("en-US"),
        shutter: true,
        note:
          data.note ||
          (data.approximate ? "该数值为近似值（相机记录的拍摄张数）。" : null),
      },
    ];
    if (data.capturedAt) {
      rows.push({ label: "拍摄时间", value: data.capturedAt });
    }

    setStage(
      buildFileChip(data.fileName || "upload"),
      buildResultCard(rows, "快门读取结果"),
      buildActions("再查一张", "primary")
    );
    introEl.focus();
  }

  function buildMissingShutterHelp() {
    const section = document.createElement("section");
    section.className = "missing-shutter";

    const title = document.createElement("h2");
    title.textContent = "未能读取快门次数";

    const causes = document.createElement("ul");
    causes.className = "missing-shutter__causes";
    for (const text of [
      "相机或该文件可能不提供此信息。",
      "也可能在编辑、导出或分享时丢失。",
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      causes.append(item);
    }

    const guideTitle = document.createElement("h3");
    guideTitle.textContent = "iPhone 用户可尝试";
    const steps = document.createElement("ol");
    steps.className = "missing-shutter__steps";
    for (const text of [
      "在照片中选中",
      "点击分享",
      "选择“导出未修改的原片”",
      "保存后重新上传",
    ]) {
      const item = document.createElement("li");
      item.textContent = text;
      steps.append(item);
    }

    const limit = document.createElement("p");
    limit.className = "missing-shutter__limit";
    limit.textContent =
      "原片也不保证一定能查到，仍取决于相机是否记录了可读取的快门次数。";

    const link = document.createElement("a");
    link.className = "missing-shutter__zoom";
    link.setAttribute("href", "./iphone-export-original.jpg");
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");

    const image = document.createElement("img");
    image.className = "missing-shutter__image";
    image.setAttribute("src", "./iphone-export-original.jpg");
    image.setAttribute("width", "1206");
    image.setAttribute("height", "1550");
    image.setAttribute(
      "alt",
      "iPhone 分享界面完整截图，红圈标出导出未修改的原片"
    );
    const zoom = document.createElement("span");
    zoom.textContent = "查看大图";
    link.append(image, zoom);
    section.append(title, causes, guideTitle, steps, limit, link);
    return section;
  }

  function renderFail(data: Partial<MetadataView>) {
    setIntro("已解析元数据，但未能读到快门计数。");

    const nodes: Node[] = [buildFileChip(data.fileName || "upload")];
    nodes.push(buildMissingShutterHelp());

    const rows: ResultRow[] = [];
    if (data.model) rows.push({ label: "机身型号", value: data.model });
    if (data.capturedAt)
      rows.push({ label: "拍摄时间", value: data.capturedAt });
    if (rows.length > 0) nodes.push(buildResultCard(rows, "已知元数据"));

    nodes.push(buildActions("重新上传", "secondary"));
    setStage(...nodes);
    introEl.focus();
  }

  function renderError(kind: ErrorKind, fileName?: string | null) {
    const copy =
      kind === "too_large"
        ? {
            ...ERROR_COPY.too_large,
            body: `单张图片不能超过 ${maxUploadMb} MB，请换一张原图再试。`,
          }
        : ERROR_COPY[kind];
    setIntro("未能解析这张图片。");

    const nodes: Node[] = [];
    if (fileName) nodes.push(buildFileChip(fileName));
    nodes.push(
      buildWarnBanner(copy.title, copy.body),
      buildActions("重新上传", "secondary")
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
    setUploadLimit: (value: number) => {
      maxUploadMb = value;
    },
  };
}
