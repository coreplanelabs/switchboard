// Feature: docs/reference/specs/slack-channel.md — existing native file ABI and exact media acknowledgments.
import { describe, expect, it } from "vitest";
import { openCodeMediaFiles, openCodeMediaId, openCodeMediaAck } from "./media.js";
describe("OpenCode native media identity", () => {
  it("builds ordered server-owned image and PDF data URIs with stable original-input identity", () => {
    const files = openCodeMediaFiles([
      { type: "image", mediaType: "image/png", data: "AAA=" },
      { type: "document", mediaType: "application/pdf", name: "plan.pdf", data: "JVBERg==" },
    ]);
    expect(files).toEqual([
      { uri: "data:image/png;base64,AAA=" },
      { uri: "data:application/pdf;base64,JVBERg==", name: "plan.pdf" },
    ]);
    expect(openCodeMediaId("run", "caption", files, "source")).toBe(openCodeMediaId("run", "caption", files, "source"));
    expect(openCodeMediaId("run", "caption", files, "source")).not.toBe(
      openCodeMediaId("run", "caption", [...files].reverse(), "source"),
    );
    expect(() => openCodeMediaFiles([{ type: "image", mediaType: "image/png", data: "file:/private" }])).toThrow(
      "original media representation",
    );
    expect(() =>
      openCodeMediaFiles([
        { type: "image", mediaType: "image/png", data: Buffer.alloc(20 * 1024 * 1024 + 1).toString("base64") },
      ]),
    ).toThrow("bounds");
  });
  it("accepts installed image normalization only under the exact full original request identity", () => {
    const expected = {
      id: "msg_original",
      text: "caption",
      files: [{ uri: "data:image/gif;base64,AAA=" }, { uri: "data:application/pdf;base64,JVBERg==", name: "plan.pdf" }],
    };
    const data = {
      id: "msg_original",
      sessionID: "ses_original",
      type: "user",
      payload: {
        text: "caption",
        files: [
          { data: "AQI=", mime: "image/jpeg", source: { type: "inline" } },
          { data: "JVBERg==", mime: "application/pdf", name: "plan.pdf", source: { type: "inline" } },
        ],
      },
    };
    expect(openCodeMediaAck({ data }, "ses_original", expected)).toBe(true);
    expect(openCodeMediaAck({ data: { ...data, id: "msg_other" } }, "ses_original", expected)).toBe(false);
    expect(
      openCodeMediaAck(
        { data: { ...data, payload: { ...data.payload, files: [...data.payload.files].reverse() } } },
        "ses_original",
        expected,
      ),
    ).toBe(false);
    expect(
      openCodeMediaAck(
        {
          data: {
            ...data,
            payload: { ...data.payload, files: [data.payload.files[0], { ...data.payload.files[1], data: "changed" }] },
          },
        },
        "ses_original",
        expected,
      ),
    ).toBe(false);
  });
  it("requires exact original ID, session, caption and full ordered media rather than a text-only ACK", () => {
    const expected = { id: "msg_original", text: "caption", files: [{ uri: "data:image/png;base64,AAA=" }] };
    const data = {
      id: "msg_original",
      sessionID: "ses_original",
      type: "user",
      payload: { text: "caption", files: [{ data: "AAA=", mime: "image/png", source: { type: "inline" } }] },
    };
    expect(openCodeMediaAck({ data }, "ses_original", expected)).toBe(true);
    expect(openCodeMediaAck({ data: { ...data, payload: { text: "caption" } } }, "ses_original", expected)).toBe(false);
    expect(openCodeMediaAck({ data: { ...data, id: "msg_other" } }, "ses_original", expected)).toBe(false);
    expect(openCodeMediaAck({ data }, "ses_other", expected)).toBe(false);
    expect(
      openCodeMediaAck(
        {
          data: {
            ...data,
            payload: {
              ...data.payload,
              files: [{ data: "BBB=", mime: "application/pdf", source: { type: "inline" } }],
            },
          },
        },
        "ses_original",
        expected,
      ),
    ).toBe(false);
  });
});
