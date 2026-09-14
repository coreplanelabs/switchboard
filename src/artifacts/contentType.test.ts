import { describe, expect, it } from "vitest";
import { contentTypeFor, INLINE_IMAGE_TYPES, OCTET_STREAM } from "./contentType.js";

// Feature: docs/reference/specs/execution.md item 20 — one derivation of a
// produced file's type, from its extension, carried on the PUT, the event and
// the proxy alike.

describe("contentTypeFor (item 20)", () => {
  it("maps the extensions a run produces, case-insensitively, and everything else to a plain binary", () => {
    expect(contentTypeFor("sheet.png")).toBe("image/png");
    expect(contentTypeFor("SHOT.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("clip.mp4")).toBe("video/mp4");
    expect(contentTypeFor("report.pdf")).toBe("application/pdf");
    expect(contentTypeFor("notes.md")).toBe("text/markdown");
    expect(contentTypeFor("index.html")).toBe("text/html");
    expect(contentTypeFor("archive.tar")).toBe("application/x-tar");
    expect(contentTypeFor("big.bin")).toBe(OCTET_STREAM);
    expect(contentTypeFor("Makefile")).toBe(OCTET_STREAM);
    expect(contentTypeFor("trailing.")).toBe(OCTET_STREAM);
  });

  it("the inline image set is exactly the four raster types the run page renders; SVG is not one of them", () => {
    expect([...INLINE_IMAGE_TYPES].sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
    expect(INLINE_IMAGE_TYPES.has(contentTypeFor("logo.svg"))).toBe(false);
  });
});
