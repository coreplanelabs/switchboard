// Feature: docs/reference/specs/browser-home.md — persistent, purpose-separated history keys.
import { describe, expect, it } from "vitest";
import { deriveHomeHistoryKey } from "./historyKey.js";

const encoded = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");
describe("Home history key", () => {
  it("keeps a stable installation key separate from the credential key and other organizations", () => {
    const key = deriveHomeHistoryKey("fixture-org", encoded);
    expect(Buffer.from(key!).toString("hex")).toBe("ab7ffc3d14bde857ad3c8d32e1374d653072aca4d8336aa67928a0b3c4e08030");
    expect(deriveHomeHistoryKey("fixture-org", encoded)).toEqual(key);
    expect(deriveHomeHistoryKey("fixture-org", Buffer.from(encoded, "base64").toString("base64url"))).toEqual(key);
    expect(key).not.toEqual(new Uint8Array(Buffer.from(encoded, "base64")));
    expect(deriveHomeHistoryKey("another-org", encoded)).not.toEqual(key);
  });
  it("leaves missing keys unavailable and refuses invalid keys without exposing their value", () => {
    expect(deriveHomeHistoryKey("fixture-org", undefined)).toBeUndefined();
    expect(() => deriveHomeHistoryKey("fixture-org", "private-invalid-value")).toThrow(
      "Home history requires a 32-byte base64 key",
    );
  });
});
