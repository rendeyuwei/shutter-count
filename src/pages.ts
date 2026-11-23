import type { LangCode } from "../shared/lang.js";
import { normalizeMount } from "../shared/lang.js";

export type PageDecision =
  { type: "html"; lang: LangCode } | { type: "redirect"; to: string } | null;

/** Which HTML document or slash redirect a request path is, if either. */
export function pageRequest(basePath: string, rawUrl: string): PageDecision {
  const queryAt = rawUrl.indexOf("?");
  const path = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const query = queryAt === -1 ? "" : rawUrl.slice(queryAt);
  const mount = normalizeMount(basePath);
  let rest: string | null = null;
  if (path.startsWith(mount)) rest = path.slice(mount.length);
  else if (`${path}/` === mount) rest = "";
  if (rest === null) return null;
  if (rest === "" || rest === "index.html") return { type: "html", lang: "zh" };
  if (rest === "en") return { type: "redirect", to: `${mount}en/${query}` };
  if (rest === "en/" || rest === "en/index.html") {
    return { type: "html", lang: "en" };
  }
  return null;
}

export function pageLinks(origin: string, mount: string, lang: LangCode) {
  const root = `${origin}${normalizeMount(mount)}`;
  const zh = root;
  const en = `${root}en/`;
  return {
    mount: normalizeMount(mount),
    canonical: lang === "en" ? en : zh,
    zh,
    en,
    switchHref:
      lang === "en"
        ? `${normalizeMount(mount)}?lang=zh`
        : `${normalizeMount(mount)}en/`,
  };
}

const TOKENS = [
  "__SC_MOUNT__",
  "__SC_CANONICAL__",
  "__SC_ZH__",
  "__SC_EN__",
  "__SC_SWITCH__",
] as const;

export function fillPage(
  template: string,
  links: ReturnType<typeof pageLinks>
): string {
  const values: Record<(typeof TOKENS)[number], string> = {
    __SC_MOUNT__: links.mount,
    __SC_CANONICAL__: links.canonical,
    __SC_ZH__: links.zh,
    __SC_EN__: links.en,
    __SC_SWITCH__: links.switchHref,
  };
  let html = template;
  for (const token of TOKENS) html = html.replaceAll(token, values[token]);
  return html;
}

/** Host headers become canonical origins only when they cannot break out of a URL. */
export function safeOrigin(
  protocol: string,
  host: string | undefined,
  fallbackHost: string,
  fallbackPort: number
): string {
  const scheme = protocol === "https" ? "https" : "http";
  if (
    host &&
    /^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\])(?::\d{1,5})?$/.test(host)
  ) {
    return `${scheme}://${host}`;
  }
  const port =
    fallbackPort > 0 && fallbackPort !== 80 && fallbackPort !== 443
      ? `:${fallbackPort}`
      : "";
  return `${scheme}://${fallbackHost}${port}`;
}
