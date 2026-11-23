import type { LangCode } from "../shared/lang.js";
import type { NoteCode } from "../shared/notes.js";
import type { ErrorKind } from "./types.js";

export interface Copy {
  htmlLang: "zh-CN" | "en";
  title: string;
  description: string;
  h1: string;
  switchLabel: string;
  switchTitle: string;
  switchLang: "zh-CN" | "en";
  intro: { upload: string; success: string; fail: string; error: string };
  dropzone: { label: string; hint: string };
  privacy: string;
  loading: { title: string; wait: (name: string) => string };
  labels: {
    model: string;
    shutter: string;
    capturedAt: string;
    unknown: string;
  };
  resultLabel: string;
  knownLabel: string;
  again: string;
  reupload: string;
  missing: {
    title: string;
    causes: readonly string[];
    guideTitle: string;
    steps: readonly string[];
    limit: string;
    alt: string;
    zoom: string;
  };
  errors: Record<ErrorKind, { title: string; body: string }>;
  tooLarge: (mb: number) => string;
  notes: Record<NoteCode, string> & { approximate: string };
  fileFallback: string;
}

const zh: Copy = {
  htmlLang: "zh-CN",
  title: "ShutterCount · 查看相机快门次数",
  description:
    "ShutterCount — 上传一张相机直出原图（JPG/JPEG），读取机身型号、快门次数与拍摄时间。图片仅临时解析，不长期保存。",
  h1: "查看相机快门次数",
  switchLabel: "EN",
  switchTitle: "Switch to English",
  switchLang: "en",
  intro: {
    upload: "上传一张相机原图，读取机身与快门计数。",
    success: "已从原图中读取到机身与快门信息。",
    fail: "已解析元数据，但未能读到快门计数。",
    error: "未能解析这张图片。",
  },
  dropzone: {
    label: "点击或拖放原图到这里",
    hint: "支持 JPG、JPEG，建议相机直出原图",
  },
  privacy: "图片仅临时解析，不长期保存",
  loading: {
    title: "正在解析原图…",
    wait: (name) => `${name} · 请稍候`,
  },
  labels: {
    model: "机身型号",
    shutter: "快门次数",
    capturedAt: "拍摄时间",
    unknown: "未知",
  },
  resultLabel: "快门读取结果",
  knownLabel: "已知元数据",
  again: "再查一张",
  reupload: "重新上传",
  missing: {
    title: "未能读取快门次数",
    causes: [
      "相机或该文件可能不提供此信息。",
      "也可能在编辑、导出或分享时丢失。",
    ],
    guideTitle: "iPhone 用户可尝试",
    steps: [
      "在照片中选中",
      "点击分享",
      "选择“导出未修改的原片”",
      "保存后重新上传",
    ],
    limit: "原片也不保证一定能查到，仍取决于相机是否记录了可读取的快门次数。",
    alt: "iPhone 分享界面完整截图，红圈标出导出未修改的原片",
    zoom: "查看大图",
  },
  errors: {
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
  },
  tooLarge: (mb) => `单张图片不能超过 ${mb} MB，请换一张原图再试。`,
  notes: {
    canon_image_count:
      "该机型记录的是图像计数，格式化存储卡后可能归零，仅供参考。",
    fuji_image_count:
      "富士记录的是拍摄计数（含电子快门），固件升级后可能归零，仅供参考。",
    approximate: "该数值为近似值（相机记录的拍摄张数）。",
  },
  fileFallback: "upload",
};

const en: Copy = {
  htmlLang: "en",
  title: "ShutterCount · Check your camera shutter count",
  description:
    "ShutterCount — upload a camera-original JPEG to read the camera model, shutter count, and capture time. The photo is parsed temporarily and is not kept.",
  h1: "Check your camera shutter count",
  switchLabel: "中文",
  switchTitle: "切换到中文",
  switchLang: "zh-CN",
  intro: {
    upload:
      "Upload a camera-original photo to read the body and shutter count.",
    success: "Camera and shutter details were read from the original photo.",
    fail: "Metadata was read, but the shutter count was not.",
    error: "This photo could not be read.",
  },
  dropzone: {
    label: "Click or drop an original photo here",
    hint: "JPG and JPEG, preferably a camera-original file",
  },
  privacy: "Parsed temporarily and not kept",
  loading: {
    title: "Reading the original photo…",
    wait: (name) => `${name} · Please wait`,
  },
  labels: {
    model: "Camera model",
    shutter: "Shutter count",
    capturedAt: "Capture time",
    unknown: "Unknown",
  },
  resultLabel: "Shutter count result",
  knownLabel: "Metadata found",
  again: "Check another",
  reupload: "Upload again",
  missing: {
    title: "Shutter count was not found",
    causes: [
      "The camera or this file may not include a shutter count.",
      "It may also have been removed while editing, exporting, or sharing.",
    ],
    guideTitle: "On iPhone",
    steps: [
      "In Photos, select the photo.",
      "Tap Share.",
      "Choose the circled command “导出未修改的原片” (Export Unmodified Original).",
      "Save the file, then upload it again.",
    ],
    limit:
      "An original file still may not include a readable shutter count. That depends on the camera.",
    alt: "Full iPhone share-sheet screenshot in Chinese. The red circle marks “导出未修改的原片” (Export Unmodified Original).",
    zoom: "View full image",
  },
  errors: {
    unsupported: {
      title: "This file could not be read",
      body: "The file may be damaged or not a JPG/JPEG. Try a camera-original photo.",
    },
    too_large: {
      title: "File is too large",
      body: "Try a smaller camera-original photo.",
    },
    rate_limited: {
      title: "Too many requests",
      body: "Wait a minute and try again.",
    },
    busy: {
      title: "The reader is busy",
      body: "Too many photos are waiting. Try again shortly.",
    },
    network: {
      title: "Could not read the photo",
      body: "The network or the service failed. Try again shortly.",
    },
  },
  tooLarge: (mb) =>
    `Each photo must be ${mb} MB or smaller. Try another original.`,
  notes: {
    canon_image_count:
      "This model records an image count. Formatting the card can reset it, so treat it as a guide.",
    fuji_image_count:
      "Fujifilm records a shot count, including the electronic shutter. A firmware update can reset it, so treat it as a guide.",
    approximate:
      "This number is approximate (the camera's recorded frame count).",
  },
  fileFallback: "upload",
};

export const COPY: Record<LangCode, Copy> = { zh, en };
