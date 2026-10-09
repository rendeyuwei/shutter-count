import { test } from "node:test";
import assert from "node:assert/strict";

import { mapTags, MAX_PLAUSIBLE_COUNT } from "../src/mapping.js";

test("Nikon: ShutterCount is used", () => {
  const r = mapTags({
    "File:FileType": "JPEG",
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON D70",
    "ExifIFD:DateTimeOriginal": "2005:01:14 08:57:59",
    "Nikon:ShutterCount": 526,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 526);
  assert.equal(r.shutterSource, "Nikon:ShutterCount");
  assert.equal(r.approximate, false);
  assert.equal(r.note, null);
  assert.equal(r.make, "NIKON CORPORATION");
  assert.equal(r.model, "NIKON D70"); // model already contains brand word
  assert.equal(r.capturedAt, "2005-01-14 08:57:59");
});

test("Nikon: MechanicalShutterCount is a fallback when ShutterCount is absent", () => {
  const r = mapTags({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON Z 6II",
    "Nikon:MechanicalShutterCount": 1234,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1234);
  assert.equal(r.shutterSource, "Nikon:MechanicalShutterCount");
  assert.equal(r.model, "NIKON Z 6II");
});

test("Nikon: ShutterCount wins over MechanicalShutterCount", () => {
  const r = mapTags({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON Z 6II",
    "Nikon:ShutterCount": 100,
    "Nikon:MechanicalShutterCount": 90,
  });
  assert.equal(r.shutterCount, 100);
  assert.equal(r.shutterSource, "Nikon:ShutterCount");
});

test("Nikon: ImageCount alone is ignored (not a shutter source)", () => {
  const r = mapTags({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON D2Hs",
    "Nikon:ImageCount": 999,
    "Nikon:DeletedImageCount": 3,
  });
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.shutterCount, null);
  assert.equal(r.shutterSource, null);
});

test("Canon: ShutterCount is used, not approximate", () => {
  const r = mapTags({
    "IFD0:Make": "Canon",
    "IFD0:Model": "Canon EOS-1D Mark III",
    "Canon:ShutterCount": 1,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1);
  assert.equal(r.shutterSource, "Canon:ShutterCount");
  assert.equal(r.approximate, false);
  assert.equal(r.note, null);
  assert.equal(r.model, "Canon EOS-1D Mark III");
});

test("Canon: ImageCount is approximate with Chinese note", () => {
  const r = mapTags({
    "IFD0:Make": "Canon",
    "IFD0:Model": "Canon EOS 5D",
    "Canon:ImageCount": 4242,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 4242);
  assert.equal(r.shutterSource, "Canon:ImageCount");
  assert.equal(r.approximate, true);
  assert.equal(
    r.note,
    "该机型记录的是图像计数，格式化存储卡后可能归零，仅供参考。"
  );
});

test("Sony: ShutterCount / ShutterCount2 / ShutterCount3 priority", () => {
  const base = { "IFD0:Make": "SONY", "IFD0:Model": "ILCE-7M4" };
  const r1 = mapTags({ ...base, "Sony:ShutterCount": 3, "Sony:ShutterCount2": 2, "Sony:ShutterCount3": 1 });
  assert.equal(r1.shutterCount, 3);
  assert.equal(r1.shutterSource, "Sony:ShutterCount");

  const r2 = mapTags({ ...base, "Sony:ShutterCount2": 2, "Sony:ShutterCount3": 1 });
  assert.equal(r2.shutterCount, 2);
  assert.equal(r2.shutterSource, "Sony:ShutterCount2");

  const r3 = mapTags({ ...base, "Sony:ShutterCount3": 1 });
  assert.equal(r3.shutterCount, 1);
  assert.equal(r3.shutterSource, "Sony:ShutterCount3");

  assert.equal(r1.model, "Sony ILCE-7M4"); // brand prefixed
});

test("FujiFilm: ImageCount is approximate with Chinese note", () => {
  const r = mapTags({
    "IFD0:Make": "FUJIFILM",
    "IFD0:Model": "X-T4",
    "FujiFilm:ImageCount": 777,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 777);
  assert.equal(r.shutterSource, "FujiFilm:ImageCount");
  assert.equal(r.approximate, true);
  assert.equal(
    r.note,
    "富士记录的是拍摄计数（含电子快门），固件升级后可能归零，仅供参考。"
  );
  assert.equal(r.model, "FUJIFILM X-T4");
});

test("Pentax: ShutterCount (incl. RICOH IMAGING make)", () => {
  const r = mapTags({
    "IFD0:Make": "PENTAX Corporation",
    "IFD0:Model": "PENTAX K10D",
    "Pentax:ShutterCount": 1648,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1648);
  assert.equal(r.shutterSource, "Pentax:ShutterCount");
  assert.equal(r.model, "PENTAX K10D");

  const r2 = mapTags({
    "IFD0:Make": "RICOH IMAGING COMPANY, LTD.",
    "IFD0:Model": "PENTAX K-3",
    "Pentax:ShutterCount": "55",
  });
  assert.equal(r2.status, "ok");
  assert.equal(r2.shutterCount, 55); // numeric string accepted
});

test("Olympus / Panasonic with no count tag -> no_shutter_field", () => {
  const oly = mapTags({
    "IFD0:Make": "OLYMPUS OPTICAL CO.,LTD",
    "IFD0:Model": "C2000Z",
    "Olympus:SomeOtherTag": 1,
  });
  assert.equal(oly.status, "no_shutter_field");
  assert.equal(oly.shutterCount, null);
  assert.equal(oly.model, "OLYMPUS C2000Z");

  const om = mapTags({
    "IFD0:Make": "OM Digital Solutions",
    "IFD0:Model": "OM-1",
    "Olympus:ShutterCount": 42,
  });
  assert.equal(om.status, "ok");
  assert.equal(om.shutterCount, 42);
  assert.equal(om.model, "OLYMPUS OM-1"); // model lacks brand word -> display brand prefix

  const pana = mapTags({
    "IFD0:Make": "Panasonic",
    "IFD0:Model": "DMC-FZ3",
  });
  assert.equal(pana.status, "no_shutter_field");
  assert.equal(pana.model, "Panasonic DMC-FZ3");
});

test("ShutterCount in the WRONG vendor group is ignored", () => {
  const r = mapTags({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON D70",
    "Canon:ShutterCount": 999,
    "Sony:ShutterCount": 888,
    "Nikon:ImageCount": 7,
  });
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.shutterCount, null);
});

test("invalid values (0, negative, non-numeric) are skipped; next candidate used", () => {
  const r = mapTags({
    "IFD0:Make": "Canon",
    "IFD0:Model": "Canon EOS 5D",
    "Canon:ShutterCount": 0,
    "Canon:ImageCount": -4,
  });
  assert.equal(r.status, "no_shutter_field");

  const r2 = mapTags({
    "IFD0:Make": "SONY",
    "IFD0:Model": "ILCE-7M4",
    "Sony:ShutterCount": "abc",
    "Sony:ShutterCount2": 12.5,
    "Sony:ShutterCount3": "61",
  });
  assert.equal(r2.status, "ok");
  assert.equal(r2.shutterCount, 61);
  assert.equal(r2.shutterSource, "Sony:ShutterCount3");
});

test("plausibility cap: MAX_PLAUSIBLE_COUNT is 5,000,000", () => {
  assert.equal(MAX_PLAUSIBLE_COUNT, 5_000_000);
});

test("Sony NEX-5N garbage values above the cap are all rejected -> no_shutter_field", () => {
  // Real-world sample: Sony:ShutterCount=5723156 and ShutterCount3=2488431957
  // are both garbage (above MAX_PLAUSIBLE_COUNT) and must be ignored.
  const r = mapTags({
    "IFD0:Make": "SONY",
    "IFD0:Model": "NEX-5N",
    "Sony:ShutterCount": 5723156,
    "Sony:ShutterCount3": 2488431957,
  });
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.shutterCount, null);
  assert.equal(r.shutterSource, null);
});

test("over-cap ShutterCount is skipped; next plausible candidate is used", () => {
  const r = mapTags({
    "IFD0:Make": "SONY",
    "IFD0:Model": "ILCE-7M4",
    "Sony:ShutterCount": 9_000_000,
    "Sony:ShutterCount2": 1200,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 1200);
  assert.equal(r.shutterSource, "Sony:ShutterCount2");
});

test("counts exactly at the cap are accepted", () => {
  const r = mapTags({
    "IFD0:Make": "NIKON CORPORATION",
    "IFD0:Model": "NIKON D70",
    "Nikon:ShutterCount": MAX_PLAUSIBLE_COUNT,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, MAX_PLAUSIBLE_COUNT);
});

test("model display: brand prefixing rules", () => {
  const sony = mapTags({ "IFD0:Make": "SONY", "IFD0:Model": "ILCE-7M4" });
  assert.equal(sony.model, "Sony ILCE-7M4");

  const nikon = mapTags({ "IFD0:Make": "NIKON CORPORATION", "IFD0:Model": "NIKON D70" });
  assert.equal(nikon.model, "NIKON D70");

  const canon = mapTags({ "IFD0:Make": "Canon", "IFD0:Model": "Canon EOS-1D Mark III" });
  assert.equal(canon.model, "Canon EOS-1D Mark III");

  const fuji = mapTags({ "IFD0:Make": "FUJIFILM", "IFD0:Model": "FinePix2400Zoom" });
  assert.equal(fuji.model, "FUJIFILM FinePix2400Zoom");

  const other = mapTags({ "IFD0:Make": "Hasselblad", "IFD0:Model": "L1D-20c" });
  assert.equal(other.model, "Hasselblad L1D-20c");

  const noModel = mapTags({ "IFD0:Make": "Canon" });
  assert.equal(noModel.model, null);
});

test("date formatting and null dates", () => {
  const ok = mapTags({ "ExifIFD:DateTimeOriginal": "2025:11:03 14:22:08" });
  assert.equal(ok.capturedAt, "2025-11-03 14:22:08");

  const subsec = mapTags({ "ExifIFD:DateTimeOriginal": "2025:11:03 14:22:08.20+09:00" });
  assert.equal(subsec.capturedAt, "2025-11-03 14:22:08");

  const zero = mapTags({ "ExifIFD:DateTimeOriginal": "0000:00:00 00:00:00" });
  assert.equal(zero.capturedAt, null);

  const fallbackCreate = mapTags({ "ExifIFD:CreateDate": "2007:02:22 17:02:42" });
  assert.equal(fallbackCreate.capturedAt, "2007-02-22 17:02:42");

  const anyGroup = mapTags({ "MakerNotes:DateTimeOriginal": "2010:01:02 03:04:05" });
  assert.equal(anyGroup.capturedAt, "2010-01-02 03:04:05");

  const missing = mapTags({});
  assert.equal(missing.capturedAt, null);
});

test("no EXIF at all -> no_shutter_field with nulls", () => {
  const r = mapTags({ "File:FileType": "JPEG" });
  assert.equal(r.status, "no_shutter_field");
  assert.equal(r.make, null);
  assert.equal(r.model, null);
  assert.equal(r.shutterCount, null);
  assert.equal(r.shutterSource, null);
  assert.equal(r.approximate, false);
  assert.equal(r.note, null);
  assert.equal(r.capturedAt, null);
});

test("generic fallback for unknown brands: any makernote ShutterCount", () => {
  const r = mapTags({
    "IFD0:Make": "Leica Camera AG",
    "IFD0:Model": "LEICA M10",
    "Leica:ShutterCount": 12345,
  });
  assert.equal(r.status, "ok");
  assert.equal(r.shutterCount, 12345);
  assert.equal(r.shutterSource, "Leica:ShutterCount");
});
