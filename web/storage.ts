import type { LangCode } from "../shared/lang.js";

export const PREF_KEY = "rf-lang";

export interface PrefHost {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  readCookie(): string;
  writeCookie(value: string): void;
  protocol: string;
}

/** Manual preference only. Reads localStorage["rf-lang"], then the rf-lang cookie. */
export function readPref(host: PrefHost): LangCode | null {
  let value: string | null = null;
  try {
    value = host.getItem(PREF_KEY);
  } catch {
    value = null;
  }
  if (value !== "zh" && value !== "en") {
    try {
      value =
        /(?:^|;\s*)rf-lang=(zh|en)(?:;|$)/.exec(host.readCookie())?.[1] ?? null;
    } catch {
      value = null;
    }
  }
  return value === "zh" || value === "en" ? value : null;
}

/** Writes the manual choice. Falls back to a cookie when storage throws. */
export function writePref(host: PrefHost, lang: LangCode): boolean {
  try {
    host.setItem(PREF_KEY, lang);
  } catch {
    try {
      const secure = host.protocol === "https:" ? "; Secure" : "";
      host.writeCookie(
        `${PREF_KEY}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
      );
    } catch {
      return false;
    }
  }
  return readPref(host) === lang;
}

export function browserPrefHost(): PrefHost {
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
