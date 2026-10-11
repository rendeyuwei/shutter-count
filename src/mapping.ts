import { MAX_SHUTTER_COUNT } from "../shared/protocol.js";
// Pure mapping from ExifTool raw tags (-G1 -n group-prefixed keys) to the API
// result shape. No I/O in this module.

import type {
  CameraBrand,
  MappedResult,
  MappingSummary,
} from "../shared/result.js";

interface CountSource {
  name: string;
  approximate?: boolean;
  note?: string;
}

interface BrandRule {
  id: CameraBrand;
  makeIncludes: string[];
  groupPrefix: string;
  display: string;
  brandWord: string;
  sources: CountSource[];
}

interface TagEntry {
  key: string;
  group: string;
  name: string;
  value: unknown;
}

type TagIndex = Map<string, TagEntry>;

const CANON_IMAGE_COUNT_NOTE =
  "该机型记录的是图像计数，格式化存储卡后可能归零，仅供参考。";
const FUJI_IMAGE_COUNT_NOTE =
  "富士记录的是拍摄计数（含电子快门），固件升级后可能归零，仅供参考。";

// Brand table: how to recognize the brand from IFD0:Make, which MakerNote
// group prefix counts as "the vendor's own group", the ordered shutter-count
// candidate tags in that group, and how to display the brand.
const BRANDS: BrandRule[] = [
  {
    id: "nikon",
    makeIncludes: ["nikon"],
    groupPrefix: "nikon",
    display: "Nikon",
    brandWord: "nikon",
    sources: [{ name: "ShutterCount" }, { name: "MechanicalShutterCount" }],
  },
  {
    id: "canon",
    makeIncludes: ["canon"],
    groupPrefix: "canon",
    display: "Canon",
    brandWord: "canon",
    sources: [
      { name: "ShutterCount" },
      { name: "ImageCount", approximate: true, note: CANON_IMAGE_COUNT_NOTE },
    ],
  },
  {
    id: "sony",
    makeIncludes: ["sony"],
    groupPrefix: "sony",
    display: "Sony",
    brandWord: "sony",
    sources: [
      { name: "ShutterCount" },
      { name: "ShutterCount2" },
      { name: "ShutterCount3" },
    ],
  },
  {
    id: "fujifilm",
    makeIncludes: ["fujifilm", "fuji photo"],
    groupPrefix: "fujifilm",
    display: "FUJIFILM",
    brandWord: "fujifilm",
    sources: [
      { name: "ImageCount", approximate: true, note: FUJI_IMAGE_COUNT_NOTE },
    ],
  },
  {
    id: "pentax",
    makeIncludes: ["pentax", "ricoh imaging", "asahi"],
    groupPrefix: "pentax",
    display: "PENTAX",
    brandWord: "pentax",
    sources: [{ name: "ShutterCount" }],
  },
  {
    id: "olympus",
    makeIncludes: ["olympus", "om digital", "om system"],
    groupPrefix: "olympus",
    display: "OLYMPUS",
    brandWord: "olympus",
    sources: [
      { name: "ShutterCount" },
      { name: "MechanicalShutterCount" },
      { name: "ImageCount" },
    ],
  },
  {
    id: "panasonic",
    makeIncludes: ["panasonic"],
    groupPrefix: "panasonic",
    display: "Panasonic",
    brandWord: "panasonic",
    sources: [
      { name: "ShutterCount" },
      { name: "MechanicalShutterCount" },
      { name: "ImageCount" },
    ],
  },
];

/**
 * Normalize raw tags into a list of entries plus lookup maps.
 * Keys look like "Group:Name" (e.g. "Nikon:ShutterCount"); we index both by
 * the full key and by the bare name, case-insensitively.
 */
function normalize(rawTags: Record<string, unknown>) {
  const entries: TagEntry[] = [];
  const byFullKey: TagIndex = new Map(); // "group:name" (lowercased) -> entry
  const byBareName: TagIndex = new Map(); // "name" (lowercased) -> first entry
  for (const [key, value] of Object.entries(rawTags || {})) {
    const idx = key.indexOf(":");
    const group = idx === -1 ? "" : key.slice(0, idx);
    const name = idx === -1 ? key : key.slice(idx + 1);
    const entry = { key, group, name, value };
    entries.push(entry);
    const fk = key.toLowerCase();
    if (!byFullKey.has(fk)) byFullKey.set(fk, entry);
    const bn = name.toLowerCase();
    if (!byBareName.has(bn)) byBareName.set(bn, entry);
  }
  return { entries, byFullKey, byBareName };
}

function getStr(
  byFullKey: TagIndex,
  byBareName: TagIndex,
  fullKey: string,
  bareName: string
): string | null {
  const entry =
    byFullKey.get(fullKey.toLowerCase()) ||
    byBareName.get(bareName.toLowerCase());
  if (!entry || entry.value === null || entry.value === undefined) return null;
  const s = String(entry.value).trim();
  return s === "" ? null : s;
}

function detectBrand(make: string | null): BrandRule | null {
  if (!make) return null;
  const m = make.toLowerCase();
  for (const brand of BRANDS) {
    if (brand.makeIncludes.some((needle) => m.includes(needle))) return brand;
  }
  return null;
}

// Plausibility cap: no camera has actuated a shutter more than ~5M times, and
// some MakerNotes report garbage in shutter tags (e.g. a Sony NEX-5N sample
// with Sony:ShutterCount=5723156 and ShutterCount3=2488431957). Values above
// the cap are ignored so the next candidate tag is tried.
export const MAX_PLAUSIBLE_COUNT = MAX_SHUTTER_COUNT;

/**
 * Valid shutter count: finite integer with 0 < n <= MAX_PLAUSIBLE_COUNT
 * (numeric strings accepted). Anything else -> null (try next candidate).
 */
function validCount(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean")
    return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  if (n > MAX_PLAUSIBLE_COUNT) return null;
  return n;
}

/** Find a tag value inside the vendor's own group (prefix-matched, case-insensitive). */
function findInVendorGroup(
  entries: TagEntry[],
  groupPrefix: string,
  tagName: string
): TagEntry | null {
  const lowerPrefix = groupPrefix.toLowerCase();
  const lowerName = tagName.toLowerCase();
  for (const e of entries) {
    if (
      e.group.toLowerCase().startsWith(lowerPrefix) &&
      e.name.toLowerCase() === lowerName
    ) {
      return e;
    }
  }
  return null;
}

/** Generic fallback for unknown brands: any "<makernote group>:ShutterCount". */
function findAnyShutterCount(entries: TagEntry[]): TagEntry | null {
  for (const e of entries) {
    if (e.group && e.name.toLowerCase() === "shuttercount") return e;
  }
  return null;
}

/**
 * "2005:01:14 08:57:59" (possibly with subseconds/timezone) -> "2005-01-14 08:57:59".
 * Returns null for missing, unparseable, or zeroed dates.
 */
export function formatCaptureTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = value
    .trim()
    .match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  if (m[1] === "0000" && m[2] === "00" && m[3] === "00") return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * Build the display model: raw Model, prefixed with a display brand when the
 * model string does not already contain the brand word.
 */
function displayModel(
  model: string | null,
  brand: BrandRule | null,
  make: string | null
): string | null {
  if (!model) return null;
  if (brand) {
    if (!model.toLowerCase().includes(brand.brandWord)) {
      return `${brand.display} ${model}`;
    }
    return model;
  }
  // Unknown brand: prefix the raw Make if the model doesn't already show it.
  if (make && !model.toLowerCase().includes(make.toLowerCase())) {
    return `${make} ${model}`;
  }
  return model;
}

/**
 * Pure function: map ExifTool raw tags to the API result (without fileName).
 */
export function mapTags(rawTags: Record<string, unknown>): MappedResult {
  const { entries, byFullKey, byBareName } = normalize(rawTags);

  const make = getStr(byFullKey, byBareName, "IFD0:Make", "Make");
  const rawModel = getStr(byFullKey, byBareName, "IFD0:Model", "Model");
  const brand = detectBrand(make);

  // Shutter count, in priority order, ONLY from the matching vendor group.
  let shutterCount: number | null = null;
  let shutterSource: string | null = null;
  let approximate = false;
  let note: string | null = null;

  if (brand) {
    for (const src of brand.sources) {
      const entry = findInVendorGroup(entries, brand.groupPrefix, src.name);
      if (!entry) continue;
      const n = validCount(entry.value);
      if (n === null) continue; // invalid -> try next candidate
      shutterCount = n;
      shutterSource = `${entry.group}:${entry.name}`;
      approximate = Boolean(src.approximate);
      note = src.note ?? null;
      break;
    }
  } else {
    const entry = findAnyShutterCount(entries);
    if (entry) {
      const n = validCount(entry.value);
      if (n !== null) {
        shutterCount = n;
        shutterSource = `${entry.group}:${entry.name}`;
      }
    }
  }

  // Capture time: ExifIFD:DateTimeOriginal, else ExifIFD:CreateDate, else any DateTimeOriginal.
  const dtRaw =
    getStr(
      byFullKey,
      byBareName,
      "ExifIFD:DateTimeOriginal",
      "DateTimeOriginal"
    ) || getStr(byFullKey, byBareName, "ExifIFD:CreateDate", "CreateDate");
  const capturedAt = formatCaptureTime(dtRaw);

  const metadata = {
    make,
    model: displayModel(rawModel, brand, make),
    capturedAt,
  };
  if (shutterCount === null || shutterSource === null) {
    return {
      ...metadata,
      status: "no_shutter_field",
      shutterCount: null,
      shutterSource: null,
      approximate: false,
      note: null,
    };
  }
  return {
    ...metadata,
    status: "ok",
    shutterCount,
    shutterSource,
    approximate,
    note,
  };
}

/** Safe diagnostic summary: no arbitrary tag names or values leave this helper. */
export function summarizeMapping(
  rawTags: Record<string, unknown>
): MappingSummary {
  const { entries, byFullKey, byBareName } = normalize(rawTags);
  const make = getStr(byFullKey, byBareName, "IFD0:Make", "Make");
  const brand = detectBrand(make);
  const candidates = brand
    ? brand.sources.map((src) =>
        findInVendorGroup(entries, brand.groupPrefix, src.name)
      )
    : [findAnyShutterCount(entries)];
  const present = candidates.filter(
    (entry): entry is TagEntry => entry !== null
  );
  return {
    brand: brand?.id ?? "unknown",
    hasExif: entries.some((entry) => /^(ifd0|exififd)$/i.test(entry.group)),
    candidateCount: candidates.length,
    presentCandidateCount: present.length,
    invalidCandidateCount: present.filter(
      (entry) => validCount(entry.value) === null
    ).length,
  };
}
