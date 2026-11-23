import { mountUrl, type LangCode } from "../shared/lang.js";

export interface GuideImage {
  src: string;
  width: number;
  height: number;
}

/**
 * Pixel size is the SOF size of the file in `public/`, decoded from the JPEG.
 * Chinese is the original screenshot. English is the supplied illustration
 * after its APP11 block was removed; the compressed scan is unchanged.
 */
export const GUIDE: Record<
  LangCode,
  { file: string; width: number; height: number }
> = {
  zh: { file: "iphone-export-original.jpg", width: 1206, height: 1550 },
  en: { file: "iphone-export-original-en.jpg", width: 864, height: 1152 },
};

export function guideFor(mount: string, lang: LangCode): GuideImage {
  const spec = GUIDE[lang];
  return {
    src: mountUrl(mount, spec.file),
    width: spec.width,
    height: spec.height,
  };
}
