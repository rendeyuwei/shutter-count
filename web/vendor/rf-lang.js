/* rende.fun zh/en routing. Vendored from rendeyuwei/rende-site src/shell/lang.ts
   at 64701ced2b3e495f8e5237148096a5a665e41c17 (contract v1).
   Inline in <head> WITHOUT data-rf-enter. Shutter calls enter() only when
   this table's site base is the configured mount. */
(function () {
  const V = 1;
  const KEY = "rf-lang";
  const HREFLANG = { zh: "zh-CN", en: "en" };

  // Longest base first. Set en: true only after that site serves <base>en/.
  const SITES = [
    { id: "easypic", base: "/easypic/", en: false },
    { id: "shutter", base: "/shutter/", en: false },
    { id: "recipes", base: "/recipes/", en: false },
    { id: "home", base: "/", en: true },
  ];

  const place = (pathname) => {
    const path = pathname || "/";
    const site =
      SITES.find((s) => path.indexOf(s.base) === 0 || `${path}/` === s.base) ??
      SITES[SITES.length - 1];
    let rest = path.slice(site.base.length);
    let lang = "zh";
    if (rest === "en" || rest.indexOf("en/") === 0) {
      lang = "en";
      rest = rest.slice(3);
    }
    return { site, lang, rest: rest.replace(/^\/+/, "") };
  };

  const match = (tags) => {
    for (const tag of tags) {
      const primary = String(tag).toLowerCase().split(/[-_]/)[0];
      if (primary === "zh" || primary === "en") return primary;
    }
    return null;
  };

  const pref = () => {
    let value = null;
    try {
      value = localStorage.getItem(KEY);
    } catch {
      value = null;
    }
    if (value !== "zh" && value !== "en") {
      try {
        value =
          /(?:^|;\s*)rf-lang=(zh|en)(?:;|$)/.exec(document.cookie)?.[1] ?? null;
      } catch {
        value = null;
      }
    }
    return value === "zh" || value === "en" ? value : null;
  };

  const choose = (lang) => {
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      try {
        const secure = location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `${KEY}=${lang}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
      } catch {
        return false;
      }
    }
    return pref() === lang;
  };

  const offers = (lang) =>
    !!document.querySelector(`link[rel="alternate"][hreflang="${HREFLANG[lang]}"]`);

  const explicitZh = () => /(?:^|[?&])lang=zh(?:&|$)/.test(location.search || "");

  const query = (zh) => {
    const parts = (location.search || "")
      .replace(/^\?/, "")
      .split("&")
      .filter((part) => part && part.split("=")[0] !== "lang");
    if (zh) parts.push("lang=zh");
    return parts.length ? `?${parts.join("&")}` : "";
  };

  const href = (lang) => {
    const here = place(location.pathname);
    return `${here.site.base}${lang === "en" ? "en/" : ""}${here.rest}${query(lang === "zh")}${location.hash || ""}`;
  };

  const siteHref = (id) => {
    const site = SITES.find((s) => s.id === id) ?? SITES[SITES.length - 1];
    if (place(location.pathname).lang === "en")
      return site.en ? `${site.base}en/` : site.base;
    return explicitZh() && pref() !== "zh" ? `${site.base}?lang=zh` : site.base;
  };

  const enter = () => {
    if (place(location.pathname).lang === "en" || explicitZh()) return;
    const languages =
      navigator.languages && navigator.languages.length
        ? navigator.languages
        : [navigator.language];
    const want = pref() ?? match(languages) ?? "en";
    if (want === "en" && offers("en")) {
      api.leaving = true;
      location.replace(href("en"));
    }
  };

  const host = window;
  const api = {
    v: V,
    sites: SITES,
    leaving: false,
    place,
    match,
    pref,
    choose,
    offers,
    href,
    siteHref,
    enter,
  };
  if (!host.rfLang || host.rfLang.v < V) host.rfLang = api;
  const script = document.currentScript;
  if (script && script.hasAttribute("data-rf-enter")) host.rfLang.enter();
})();
