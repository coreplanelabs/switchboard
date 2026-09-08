import { describe, expect, it } from "vitest";
import { API_TOKEN_ENV, apiTokenMissingProblem, imagesHostIO, RENEW_BEFORE_MS, type Transfer } from "./imagesHost.js";
import { planImageCopies } from "./images.js";
import { containersEditProblem, CREDENTIAL_MINUTES } from "./registryTransfer.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES } from "./testing/profile.js";

// Feature: docs/reference/specs/release-and-deploy.md item 26 — the host half of
// the image copy over a fake transfer: the credential minted once per account
// from CLOUDFLARE_API_TOKEN and spent by every registry read and copy, and how
// each failure is reported. Nothing here spawns a process or opens a socket.

const ACCOUNT = TEST_PROFILE.account;
const [COPY, SECOND] = planImageCopies(TEST_PUBLISHED_IMAGES, ACCOUNT, []).copy;
const ENV = { [API_TOKEN_ENV]: "cf-token" };
const CREDENTIALS_ENDPOINT = `POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/containers/registries/registry.cloudflare.com/credentials`;

/** A transfer that records its calls: the mint answers as told, the list is what it is told, the copy lands. */
function fakeTransfer(
  mint: Awaited<ReturnType<Transfer["mint"]>> = { ok: true, credential: { authorization: "Basic djE6and0" } },
  listing: Awaited<ReturnType<Transfer["list"]>> = { value: [{ name: "switchboard", tags: ["1.2.3"] }] },
) {
  const mints: { account: string; token: string }[] = [];
  const lists: { account: string; authorization: string }[] = [];
  const copies: { source: string; account: string; authorization: string }[] = [];
  const transfer: Transfer = {
    mint: async (account, token) => {
      mints.push({ account, token });
      return mint;
    },
    list: async (account, credential) => {
      lists.push({ account, authorization: credential.authorization });
      return listing;
    },
    transfer: async (copy, account, credential) => {
      copies.push({ source: copy.source, account, authorization: credential.authorization });
      return { ok: true, report: { digest: `sha256:${copy.name}`, blobs: 3, uploaded: 2, bytes: 10 } };
    },
  };
  return { transfer, mints, lists, copies };
}

const host = (transfer: Transfer, env: Record<string, string | undefined> = ENV, now?: () => number) =>
  imagesHostIO({ transfer, env, ...(now ? { now } : {}) });
const MINUTE = 60_000;

describe("imagesHostIO", () => {
  it("mints the credential from CLOUDFLARE_API_TOKEN once per account and spends it on the registry read, the pre-check and every copy", async () => {
    const t = fakeTransfer();
    const io = host(t.transfer);
    expect(await io.registry(ACCOUNT)).toEqual({ value: [{ name: "switchboard", tags: ["1.2.3"] }] });
    expect(await io.credential(ACCOUNT)).toEqual({ ok: true });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({
      ok: true,
      report: { digest: "sha256:switchboard", blobs: 3, uploaded: 2, bytes: 10 },
    });
    expect(await io.copy(SECOND, ACCOUNT)).toMatchObject({ ok: true });
    expect(await io.registry(ACCOUNT)).toMatchObject({ value: expect.any(Array) });
    expect(t.mints).toEqual([{ account: ACCOUNT, token: "cf-token" }]);
    expect(t.lists).toEqual([
      { account: ACCOUNT, authorization: "Basic djE6and0" },
      { account: ACCOUNT, authorization: "Basic djE6and0" },
    ]);
    expect(t.copies).toEqual([
      { source: COPY.source, account: ACCOUNT, authorization: "Basic djE6and0" },
      { source: SECOND.source, account: ACCOUNT, authorization: "Basic djE6and0" },
    ]);
  });

  it("no CLOUDFLARE_API_TOKEN is refused by name before the API is asked — on the read, the pre-check and a copy alike", async () => {
    const unset = fakeTransfer();
    const io = host(unset.transfer, {});
    expect(await io.registry(ACCOUNT)).toEqual({ error: apiTokenMissingProblem() });
    expect(await io.credential(ACCOUNT)).toEqual({ ok: false, problem: apiTokenMissingProblem() });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({ ok: false, problem: apiTokenMissingProblem() });
    expect(apiTokenMissingProblem()).toContain("CLOUDFLARE_API_TOKEN is not set");
    expect(apiTokenMissingProblem()).toContain("Containers Edit");
    expect(unset.mints).toEqual([]);
    expect(unset.lists).toEqual([]);
  });

  it("a token the credentials endpoint refuses is the mint's problem — the endpoint and the permission by name — on every operation, and a refused mint is not kept", async () => {
    const forbidden = fakeTransfer({ ok: false, problem: containersEditProblem(CREDENTIALS_ENDPOINT) });
    const io = host(forbidden.transfer);
    const problem = containersEditProblem(CREDENTIALS_ENDPOINT);
    expect(problem).toContain(`${CREDENTIALS_ENDPOINT} answered 403`);
    expect(problem).toContain("Containers Edit");
    expect(await io.registry(ACCOUNT)).toEqual({ error: problem });
    expect(await io.credential(ACCOUNT)).toEqual({ ok: false, problem });
    expect(await io.copy(COPY, ACCOUNT)).toEqual({ ok: false, problem });
    expect(forbidden.lists).toEqual([]);
    expect(forbidden.copies).toEqual([]);
    expect(forbidden.mints).toHaveLength(3);
  });

  it("a credential nearing its 45-minute expiry is replaced before it is spent: fresh under 40 minutes old, minted again from then on", async () => {
    let t = 1_000_000;
    const clock = () => t;
    const late = fakeTransfer();
    const io = host(late.transfer, ENV, clock);
    expect(RENEW_BEFORE_MS).toBe(5 * MINUTE);
    expect(await io.registry(ACCOUNT)).toMatchObject({ value: expect.any(Array) });
    t += (CREDENTIAL_MINUTES - 5) * MINUTE - 1;
    expect(await io.copy(COPY, ACCOUNT)).toMatchObject({ ok: true });
    expect(late.mints).toHaveLength(1);
    t += 1;
    expect(await io.copy(SECOND, ACCOUNT)).toMatchObject({ ok: true });
    expect(late.mints).toHaveLength(2);
    // The fresh one is now the one every call spends.
    expect(await io.registry(ACCOUNT)).toMatchObject({ value: expect.any(Array) });
    expect(late.mints).toHaveLength(2);
  });

  it("a 401 from the account registry replaces the credential and retries the operation once — copy and listing alike; a second 401 is the error, said", async () => {
    let refusals = 2;
    const t = fakeTransfer();
    const expiring: Transfer = {
      ...t.transfer,
      list: async (account, credential) => {
        t.lists.push({ account, authorization: credential.authorization });
        return refusals-- > 0 ? { error: "GET …/_catalog answered 401", unauthorized: true } : { value: [] };
      },
      transfer: async (copy, account, credential) => {
        t.copies.push({ source: copy.source, account, authorization: credential.authorization });
        return refusals-- > 0
          ? { ok: false, problem: "asking … failed — HTTP 401", unauthorized: true }
          : { ok: true, report: { digest: "sha256:x", blobs: 1, uploaded: 1, bytes: 1 } };
      },
    };
    const logged: string[] = [];
    const io = imagesHostIO({ transfer: expiring, env: ENV, log: (l) => logged.push(l) });
    // Two refusals in a row: the retry's own 401 is the answer.
    expect(await io.registry(ACCOUNT)).toEqual({ error: "GET …/_catalog answered 401", unauthorized: true });
    expect(t.mints).toHaveLength(2);
    expect(t.lists).toHaveLength(2);
    expect(logged.filter((l) => l.includes("refused the credential (401)"))).toHaveLength(1);
    // One refusal: replaced and retried, the caller sees success.
    refusals = 1;
    expect(await io.copy(COPY, ACCOUNT)).toMatchObject({ ok: true });
    expect(t.mints).toHaveLength(3);
    expect(t.copies).toHaveLength(2);
    // A 403 is not a credential to replace.
    refusals = 0;
    const forbidden: Transfer = { ...expiring, list: async () => ({ error: "GET … answered 403" }) };
    const noRetry = imagesHostIO({ transfer: forbidden, env: ENV });
    expect(await noRetry.registry(ACCOUNT)).toEqual({ error: "GET … answered 403" });
  });

  it("a listing the registry refuses is its own error, with the credential already minted and kept", async () => {
    const denied = fakeTransfer(undefined, {
      error: "GET https://registry.cloudflare.com/v2/_catalog?tags=true answered 403 — …",
    });
    const io = host(denied.transfer);
    expect(await io.registry(ACCOUNT)).toEqual({
      error: "GET https://registry.cloudflare.com/v2/_catalog?tags=true answered 403 — …",
    });
    expect(await io.credential(ACCOUNT)).toEqual({ ok: true });
    expect(denied.mints).toHaveLength(1);
  });
});
