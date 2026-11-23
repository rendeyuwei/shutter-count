import {
  decideEnter,
  hrefFor,
  normalizeMount,
  placeInMount,
  sameMount,
  type LangCode,
} from "../shared/lang.js";
import { readPref, type PrefHost } from "./storage.js";

export interface RfPlace {
  site: { base: string };
  lang: LangCode;
  rest: string;
}

export interface RfLangContract {
  v: number;
  leaving: boolean;
  place(pathname: string): RfPlace;
  match(tags: readonly unknown[]): LangCode | null;
  pref(): LangCode | null;
  choose(lang: LangCode): boolean;
  offers(lang: LangCode): boolean;
  href(lang: LangCode): string;
  siteHref(id: string): string;
  enter(): void;
}

declare global {
  interface Window {
    rfLang?: RfLangContract;
    __SC_MOUNT?: string;
    __SC_LEAVING?: boolean;
  }
}

export interface EnterEnv {
  mount: string;
  pathname: string;
  search: string;
  hash: string;
  languages: readonly unknown[];
  offersEn: boolean;
  pref: LangCode | null;
  match?: (tags: readonly unknown[]) => LangCode | null;
  contractBase: string | null;
  contractEnter: (() => void) | null;
  contractLeaving: () => boolean;
  replace: (url: string) => void;
  markLeaving: () => void;
}

/**
 * Earliest language decision. Explicit English and explicit `lang=zh` never
 * redirect. Automatic choice is not written; only a switch click persists.
 * When the shared contract owns this mount, its enter() runs unchanged.
 */
export function runEnter(env: EnterEnv): void {
  if (env.contractEnter && sameMount(env.contractBase, env.mount)) {
    env.contractEnter();
    if (env.contractLeaving()) env.markLeaving();
    return;
  }
  const decision = decideEnter({
    pathname: env.pathname,
    mount: env.mount,
    search: env.search,
    hash: env.hash,
    offersEn: env.offersEn,
    pref: env.pref,
    languages: env.languages,
    match: env.match,
  });
  if (decision.leave && decision.href) {
    env.markLeaving();
    env.replace(decision.href);
  }
}

export function installEnter(
  mountToken: string,
  host: PrefHost = browserHost()
): void {
  const mount = normalizeMount(mountToken);
  window.__SC_MOUNT = mount;
  const rf = window.rfLang;
  const languages =
    navigator.languages && navigator.languages.length
      ? navigator.languages
      : [navigator.language];
  runEnter({
    mount,
    pathname: location.pathname,
    search: location.search || "",
    hash: location.hash || "",
    languages,
    offersEn: !!document.querySelector('link[rel="alternate"][hreflang="en"]'),
    pref: rf?.pref ? rf.pref() : readPref(host),
    match: rf?.match ? (tags) => rf.match(tags) : undefined,
    contractBase: rf?.place ? rf.place(location.pathname).site.base : null,
    contractEnter: rf ? () => rf.enter() : null,
    contractLeaving: () => Boolean(rf?.leaving),
    replace: (url) => location.replace(url),
    markLeaving: () => {
      window.__SC_LEAVING = true;
      if (rf) rf.leaving = true;
    },
  });
  if (rf) alignContract(rf, mount, location);
}

/**
 * The shared bar reads place() once, before this page's module runs.
 * On a mount the contract table does not list, that read would treat
 * `{mount}en/` as Chinese and the only switch would point back at English.
 * Repair place() and href() here, while the head script is still running.
 */
export function alignContract(
  rf: RfLangContract,
  mount: string,
  where: { pathname: string; search: string; hash: string }
): void {
  const root = normalizeMount(mount);
  if (sameMount(rf.place(where.pathname).site.base, root)) return;
  const contractPlace = rf.place.bind(rf);
  rf.place = (pathname: string) => {
    const path = pathname || "/";
    if (path.startsWith(root) || `${path}/` === root) {
      const located = placeInMount(path, root);
      return { site: { base: root }, lang: located.lang, rest: located.rest };
    }
    return contractPlace(pathname);
  };
  rf.href = (lang) =>
    hrefFor(lang, where.pathname, root, where.search || "", where.hash || "");
}

function browserHost(): PrefHost {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    readCookie: () => document.cookie,
    writeCookie: (value) => {
      document.cookie = value;
    },
    protocol: location.protocol,
  };
}
