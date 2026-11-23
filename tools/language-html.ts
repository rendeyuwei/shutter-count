import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { Plugin } from "vite";

const root = fileURLToPath(new URL("../", import.meta.url));
const DEV_ORIGIN = "http://127.0.0.1:5173";

function assertInline(source: string, name: string): void {
  if (/<\/script|<script|<!--/i.test(source)) {
    throw new Error(`${name} cannot be inlined`);
  }
}

/** Icon, stylesheet, and app script stay on the mount after pushState. */
export function mountAssetRefs(html: string): string {
  return html.replace(
    /((?:href|src)=")(?:\.\/|\.\.\/|\/)(favicon\.svg|styles\.css|app\.(?:js|ts))"/g,
    '$1__SC_MOUNT__$2"'
  );
}

function fillDev(html: string, lang: "zh" | "en"): string {
  const zh = `${DEV_ORIGIN}/`;
  const en = `${DEV_ORIGIN}/en/`;
  return html
    .replaceAll("__SC_MOUNT__", "/")
    .replaceAll("__SC_CANONICAL__", lang === "en" ? en : zh)
    .replaceAll("__SC_ZH__", zh)
    .replaceAll("__SC_EN__", en)
    .replaceAll("__SC_SWITCH__", lang === "en" ? "/?lang=zh" : "/en/");
}

export function languagePages(): Plugin {
  let head = "";
  let enTemplate = "";
  let ready: Promise<void> | null = null;

  const prepare = () =>
    (ready ??= (async () => {
      const langJs = (
        await readFile(path.join(root, "web/vendor/rf-lang.js"), "utf8")
      ).trim();
      const bundled = await build({
        entryPoints: [path.join(root, "web/enter-main.ts")],
        bundle: true,
        write: false,
        format: "iife",
        platform: "browser",
        target: "es2022",
        legalComments: "none",
      });
      const enter = bundled.outputFiles[0]?.text.trim() ?? "";
      if (!enter) throw new Error("enter script bundle was empty");
      assertInline(langJs, "rf-lang.js");
      assertInline(enter, "enter.js");
      head = [
        '<link rel="canonical" href="__SC_CANONICAL__" />',
        '<link rel="alternate" hreflang="zh-CN" href="__SC_ZH__" />',
        '<link rel="alternate" hreflang="en" href="__SC_EN__" />',
        '<link rel="alternate" hreflang="x-default" href="__SC_EN__" />',
        '<meta name="sc-mount" content="__SC_MOUNT__" />',
        `<script>${langJs}</script>`,
        `<script data-sc-enter>${enter}</script>`,
      ].join("\n");
      enTemplate = await readFile(path.join(root, "web/en/index.html"), "utf8");
    })());

  return {
    name: "shutter-language-pages",
    // After vite:build-html has emitted index.html into the bundle.
    enforce: "post",
    buildStart: prepare,
    transformIndexHtml: {
      order: "post",
      async handler(html, ctx) {
        await prepare();
        const injected = html.replace("<!--SC_HEAD-->", () => head);
        return ctx.server ? fillDev(mountAssetRefs(injected), "zh") : injected;
      },
    },
    generateBundle: {
      order: "post",
      async handler(_options, bundle) {
        await prepare();
        for (const item of Object.values(bundle)) {
          if (
            item.type === "asset" &&
            item.fileName === "index.html" &&
            typeof item.source === "string"
          ) {
            item.source = mountAssetRefs(item.source);
          }
        }
        this.emitFile({
          type: "asset",
          fileName: "en/index.html",
          source: enTemplate.replace("<!--SC_HEAD-->", () => head),
        });
      },
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url ?? "/";
        const pathOnly = raw.split("?")[0] ?? "/";
        const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
        if (pathOnly === "/en") {
          res.statusCode = 308;
          res.setHeader("Location", `/en/${query}`);
          res.end();
          return;
        }
        if (pathOnly !== "/en/" && pathOnly !== "/en/index.html") {
          next();
          return;
        }
        try {
          await prepare();
          const html = await server.transformIndexHtml(
            pathOnly,
            fillDev(
              enTemplate
                .replace("<!--SC_HEAD-->", () => head)
                .replace('src="__SC_MOUNT__app.js"', 'src="/app.ts"'),
              "en"
            )
          );
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(html);
        } catch (error) {
          next(error);
        }
      });
    },
  };
}
