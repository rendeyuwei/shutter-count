export type LangCode = "zh" | "en";

/** Configured application mount, always with one trailing slash. "/" stays "/". */
export function normalizeMount(basePath: string): string {
  if (basePath === "" || basePath === "/") return "/";
  const trimmed = basePath.startsWith("/") ? basePath : `/${basePath}`;
  return `${trimmed.replace(/\/+$/, "")}/`;
}

export interface AppPlace {
  lang: LangCode;
  rest: string;
}

/**
 * Language is only the `en` segment directly after the mount.
 * `/tools/counter/en/guide` is English at mount `/tools/counter/`; the mount
 * itself may contain any other segments, including the word "en".
 */
export function placeInMount(pathname: string, mount: string): AppPlace {
  const path = pathname || "/";
  const root = normalizeMount(mount);
  let rest = "";
  if (path.startsWith(root)) rest = path.slice(root.length);
  else if (`${path}/` === root) rest = "";
  let lang: LangCode = "zh";
  if (rest === "en" || rest.startsWith("en/")) {
    lang = "en";
    rest = rest.slice(3);
  }
  return { lang, rest: rest.replace(/^\/+/, "") };
}

/** First primary language subtag that is zh or en. zh-HK and zh-TW are zh. */
export function matchLanguage(tags: readonly unknown[]): LangCode | null {
  for (const tag of tags) {
    const primary = String(tag).toLowerCase().split(/[-_]/)[0];
    if (primary === "zh" || primary === "en") return primary;
  }
  return null;
}

export function explicitChinese(search: string): boolean {
  return /(?:^|[?&])lang=zh(?:&|$)/.test(search || "");
}

/** Keeps every other query parameter byte for byte; only the lang marker changes. */
export function languageQuery(search: string, zh: boolean): string {
  const parts = (search || "")
    .replace(/^\?/, "")
    .split("&")
    .filter((part) => part && part.split("=")[0] !== "lang");
  if (zh) parts.push("lang=zh");
  return parts.length ? `?${parts.join("&")}` : "";
}

export function hrefFor(
  lang: LangCode,
  pathname: string,
  mount: string,
  search: string,
  hash: string
): string {
  const here = placeInMount(pathname, mount);
  const root = normalizeMount(mount);
  return `${root}${lang === "en" ? "en/" : ""}${here.rest}${languageQuery(search, lang === "zh")}${hash || ""}`;
}

export function mountUrl(mount: string, leaf: string): string {
  return `${normalizeMount(mount)}${leaf.replace(/^\/+/, "")}`;
}

export function decideEnter(input: {
  pathname: string;
  mount: string;
  search: string;
  hash: string;
  offersEn: boolean;
  pref: LangCode | null;
  languages: readonly unknown[];
  match?: (tags: readonly unknown[]) => LangCode | null;
}): { leave: boolean; href: string | null } {
  const here = placeInMount(input.pathname, input.mount);
  if (here.lang === "en" || explicitChinese(input.search)) {
    return { leave: false, href: null };
  }
  const match = input.match ?? matchLanguage;
  const want = input.pref ?? match(input.languages) ?? "en";
  if (want === "en" && input.offersEn) {
    return {
      leave: true,
      href: hrefFor(
        "en",
        input.pathname,
        input.mount,
        input.search,
        input.hash
      ),
    };
  }
  return { leave: false, href: null };
}

export function sameMount(contractBase: string | null, mount: string): boolean {
  if (!contractBase) return false;
  return normalizeMount(contractBase) === normalizeMount(mount);
}
