import { createHash } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { testSourceInputIntent } from "../../testing/sourceInputs.js";
import { readPiSourceInputReceipt } from "./sourceInputReceipt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "source-native-receipt-"));
  roots.push(root);
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "Synthetic seed", timestamp: 1 });
  const intent = testSourceInputIntent().entries[0]!;
  intent.phase = "begun";
  intent.native.sessionId = manager.getSessionFile()!;
  const content = "Same visible evidence";
  intent.renderedHash = createHash("sha256").update(content).digest("hex");
  const append = (original = intent, text = content) =>
    manager.appendCustomMessageEntry("switchboard-source-input", text, false, { version: 1, intent: original });
  const file = () => ({ path: manager.getSessionFile()!, content: readFileSync(manager.getSessionFile()!, "utf8") });
  return { manager, intent, content, append, file };
}

describe("Pi source input file receipt", () => {
  it("reads distinct originals with identical text from the native file and original-session restart", () => {
    const f = fixture();
    const second = { ...f.intent, id: "second-original", witness: { ...f.intent.witness, seq: 9 } };
    const firstEntry = f.append();
    const secondEntry = f.append(second);
    const first = readPiSourceInputReceipt(f.intent, f.file());
    const other = readPiSourceInputReceipt(second, f.file());
    expect(first).toMatchObject({
      ok: true,
      receipt: { version: 1, inputId: "source-input-one", native: { entryId: firstEntry, sessionFile: f.file().path } },
    });
    expect(other).toMatchObject({
      ok: true,
      receipt: { inputId: "second-original", native: { entryId: secondEntry } },
    });
    expect(firstEntry).not.toEqual(secondEntry);
    const reopened = SessionManager.open(f.file().path);
    expect(
      reopened
        .getEntries()
        .filter((entry) => entry.type === "custom_message")
        .map((entry) => entry.id),
    ).toEqual([firstEntry, secondEntry]);
    expect(readPiSourceInputReceipt(f.intent, f.file())).toEqual(first);
    expect(readPiSourceInputReceipt(second, f.file())).toEqual(other);
  });

  it("holds a command response or live entry list until the original native file contains the exact input", () => {
    const f = fixture();
    const before = f.file();
    const id = f.append();
    expect(readPiSourceInputReceipt(f.intent, before)).toEqual({ ok: false, reason: "native-unproved" });
    expect(
      readPiSourceInputReceipt(f.intent, {
        path: before.path,
        content: JSON.stringify({ success: true, data: { disposition: "handled" } }) + "\n",
      }),
    ).toEqual({ ok: false, reason: "session-unproved" });
    expect(
      readPiSourceInputReceipt(f.intent, {
        path: before.path,
        content: JSON.stringify({ entries: f.manager.getEntries() }) + "\n",
      }),
    ).toEqual({ ok: false, reason: "session-unproved" });
    expect(readPiSourceInputReceipt(f.intent, f.file())).toMatchObject({
      ok: true,
      receipt: { native: { entryId: id } },
    });
  });

  it("holds changed original identity, text, native path and an unstarted intent", () => {
    const f = fixture();
    const id = f.append();
    expect(readPiSourceInputReceipt(f.intent, f.file())).toMatchObject({
      ok: true,
      receipt: { native: { entryId: id } },
    });
    expect(readPiSourceInputReceipt({ ...f.intent, phase: "prepared" }, f.file())).toEqual({
      ok: false,
      reason: "input-unproved",
    });
    expect(readPiSourceInputReceipt({ ...f.intent, witness: { ...f.intent.witness, seq: 99 } }, f.file())).toEqual({
      ok: false,
      reason: "native-unproved",
    });
    expect(readPiSourceInputReceipt(f.intent, { ...f.file(), path: f.file().path + ".copy" })).toEqual({
      ok: false,
      reason: "session-unproved",
    });
    const changed = f.file().content.replace("Same visible evidence", "Changed evidence");
    expect(readPiSourceInputReceipt(f.intent, { ...f.file(), content: changed })).toEqual({
      ok: false,
      reason: "native-unproved",
    });
  });

  it("holds duplicate input identities and incomplete or corrupt native files", () => {
    const f = fixture();
    f.append();
    const complete = f.file();
    expect(readPiSourceInputReceipt(f.intent, complete)).toMatchObject({
      ok: true,
      receipt: { inputId: "source-input-one" },
    });
    expect(readPiSourceInputReceipt(f.intent, { ...complete, content: complete.content.slice(0, -1) })).toEqual({
      ok: false,
      reason: "session-unproved",
    });
    expect(readPiSourceInputReceipt(f.intent, { ...complete, content: complete.content + "{broken\n" })).toEqual({
      ok: false,
      reason: "session-unproved",
    });
    f.append();
    expect(readPiSourceInputReceipt(f.intent, f.file())).toEqual({ ok: false, reason: "native-ambiguous" });
  });

  it.each(["owner", "session", "source", "rendered", "display", "version"] as const)(
    "holds changed %s proof in the native entry without replacing the original",
    (fault) => {
      const f = fixture();
      const id = f.append();
      const original = f.file();
      expect(readPiSourceInputReceipt(f.intent, original)).toMatchObject({
        ok: true,
        receipt: { inputId: "source-input-one", native: { entryId: id } },
      });
      const rows = original.content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const entry = rows.find((row) => row.id === id);
      if (fault === "owner") entry.details.intent.owner.runId = "other-consumer";
      if (fault === "session") entry.details.intent.native.sessionId = "other-native-file";
      if (fault === "source") entry.details.intent.reference.inputHash = "c".repeat(64);
      if (fault === "rendered") entry.details.intent.renderedHash = "d".repeat(64);
      if (fault === "display") entry.display = true;
      if (fault === "version") entry.details.version = 99;
      expect(
        readPiSourceInputReceipt(f.intent, {
          path: original.path,
          content: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        }),
      ).toEqual({
        ok: false,
        reason: "native-unproved",
      });
      expect(readPiSourceInputReceipt(f.intent, f.file())).toEqual(readPiSourceInputReceipt(f.intent, original));
    },
  );

  it.each(["duplicate-entry", "broken-parent", "unsupported-session", "second-header"] as const)(
    "holds a %s native file instead of issuing a partial receipt",
    (fault) => {
      const f = fixture();
      const id = f.append();
      const original = f.file();
      expect(readPiSourceInputReceipt(f.intent, original)).toMatchObject({
        ok: true,
        receipt: { native: { entryId: id } },
      });
      const rows = original.content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      if (fault === "duplicate-entry") rows.push(rows.find((row) => row.id === id));
      if (fault === "broken-parent") rows.find((row) => row.id === id).parentId = "missing-parent";
      if (fault === "unsupported-session") rows[0].version = 99;
      if (fault === "second-header") rows.push(rows[0]);
      expect(
        readPiSourceInputReceipt(f.intent, {
          path: original.path,
          content: rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
        }),
      ).toEqual({
        ok: false,
        reason: "session-unproved",
      });
    },
  );
});
