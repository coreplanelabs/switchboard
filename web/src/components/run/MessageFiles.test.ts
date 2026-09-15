// Feature: docs/reference/specs/live-view.md item 26 — the files of one message,
// nested in its card: one row per file whose name is a disclosure, never a
// link. The panel under the row renders the file by its recorded type — a
// raster image as a picture (open by default), a video or audio file as a
// player (closed until asked), a text file as its first 64 KB, anything else
// as its facts and the one explicit Download action. An expired file is named
// as such; `openImages: false` starts every row closed (the attach call's
// compact form once the Reply carries the same files).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InjectionKey } from "vue";
import MessageFiles from "./MessageFiles.vue";
import { TEXT_PREVIEW_CAP, previewKindOf } from "../../lib/filePreview";
import { ArtifactLinksKey } from "../../lib/runPageModel";
import { mountApp } from "../../testing/mount";
import type { TimelineArtifact } from "@core/channels/runTimeline.js";
import type { ArtifactsSeed } from "@core/channels/webSeed.js";

const png: TimelineArtifact = {
  direction: "out",
  key: "runs/run-1/out/1-dashboard.png",
  name: "dashboard.png",
  size: 3_145_728,
  contentType: "image/png",
  at: 2100,
};
const zip: TimelineArtifact = {
  direction: "in",
  key: "threads/slack-C1-1.0/in/1.0/0-bundle.zip",
  name: "bundle.zip",
  size: 12_582_912,
  contentType: "application/zip",
};
const svg: TimelineArtifact = {
  ...png,
  key: "runs/run-1/out/2-logo.svg",
  name: "logo.svg",
  contentType: "image/svg+xml",
};
const mp4: TimelineArtifact = {
  direction: "out",
  key: "runs/run-1/out/3-clip.mp4",
  name: "clip.mp4",
  size: 24_854_792,
  contentType: "video/mp4",
  at: 2200,
};
const wav: TimelineArtifact = { ...mp4, key: "runs/run-1/out/4-take.wav", name: "take.wav", contentType: "audio/wav" };
const log: TimelineArtifact = {
  direction: "in",
  key: "threads/slack-C1-1.0/in/1.0/1-build.log",
  name: "build.log",
  size: 4_812,
  contentType: "text/plain",
};

const withLinks = (links: ArtifactsSeed | null) => [[ArtifactLinksKey as InjectionKey<unknown>, links]] as const;
const finished: ArtifactsSeed = { urlBase: "/runs/run-1/artifacts/", retentionDays: 30 };

/** A fetch double answering one text body, recording what it was asked for. */
function textFetch(body: string, status = 200) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(status === 200 ? body : null, { status, headers: { "content-type": "text/plain" } });
  });
  vi.stubGlobal("fetch", impl);
  return { calls };
}

afterEach(() => vi.unstubAllGlobals());

describe("MessageFiles", () => {
  it("previewKindOf decides the panel by the recorded type: raster images, video, audio, text-like types, and everything else", () => {
    expect(previewKindOf("image/png")).toBe("image");
    expect(previewKindOf("image/webp")).toBe("image");
    expect(previewKindOf("image/svg+xml")).toBe("other"); // never inline: the route sandboxes it as a download
    expect(previewKindOf("video/mp4")).toBe("video");
    expect(previewKindOf("audio/wav")).toBe("audio");
    expect(previewKindOf("text/plain")).toBe("text");
    expect(previewKindOf("text/csv")).toBe("text");
    expect(previewKindOf("application/json")).toBe("text");
    expect(previewKindOf("application/zip")).toBe("other");
    expect(previewKindOf("application/pdf")).toBe("other");
  });

  it("no name is a link: an image row starts open with its <img> from the route (the token on a live page); a zip row starts closed; sizes, types and the direction word are facts", () => {
    const w = mountApp(MessageFiles, {
      props: { files: [zip, png] },
      provides: withLinks({ ...finished, token: "tok-1" }),
    });
    expect(w.find(".files").attributes("data-open-images")).toBe("1");
    expect(w.find("h3").text()).toContain("2 files");
    expect(w.findAll("a.name")).toHaveLength(0);
    const rows = w.findAll("li.artifact");
    expect(rows).toHaveLength(2);
    // Event order, direction first.
    expect(rows[0].attributes("data-direction")).toBe("in");
    expect(rows[0].attributes("data-kind")).toBe("other");
    expect(rows[0].attributes("data-open")).toBe("0");
    expect(rows[0].text()).toContain("↓ received");
    expect(rows[0].find("button.name").attributes("aria-expanded")).toBe("false");
    expect(rows[0].find("img").exists()).toBe(false);
    expect(rows[0].find("a.download").exists()).toBe(false); // nothing mounted until opened
    expect(rows[0].text()).toContain("12.0 MB");
    expect(rows[0].text()).toContain("application/zip");
    expect(rows[1].attributes("data-direction")).toBe("out");
    expect(rows[1].attributes("data-kind")).toBe("image");
    expect(rows[1].attributes("data-open")).toBe("1");
    expect(rows[1].text()).toContain("↑ sent");
    expect(rows[1].find("button.name").attributes("aria-expanded")).toBe("true");
    const img = rows[1].find("img.preview");
    expect(img.attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png?t=tok-1");
    expect(img.attributes("alt")).toBe("dashboard.png");
    // The panel's row is what animates: open is 1fr, closed 0fr.
    expect(rows[1].find(".panel").attributes("style")).toContain("1fr");
    expect(rows[0].find(".panel").attributes("style")).toContain("0fr");
  });

  it("the name toggles the panel by click and keyboard; a zip opens to its facts and the one Download action, which is the only anchor and never the name", async () => {
    const w = mountApp(MessageFiles, { props: { files: [zip] }, provides: withLinks(finished) });
    const row = w.find("li.artifact");
    const name = row.find("button.name");
    expect(name.attributes("aria-controls")).toBe(row.find(".panel").attributes("id"));
    await name.trigger("click");
    expect(row.attributes("data-open")).toBe("1");
    expect(name.attributes("aria-expanded")).toBe("true");
    expect(row.find(".panel").attributes("aria-hidden")).toBe("false");
    expect(row.text()).toContain("no preview for application/zip");
    const download = row.find("a.download");
    expect(download.attributes("href")).toBe("/runs/run-1/artifacts/threads/slack-C1-1.0/in/1.0/0-bundle.zip");
    expect(download.attributes("download")).toBe("bundle.zip");
    expect(download.text()).toBe("Download 12.0 MB");
    expect(row.findAll("a")).toHaveLength(1);
    // A button toggles on Enter/Space natively; a second click closes and the content stays mounted.
    await name.trigger("click");
    expect(row.attributes("data-open")).toBe("0");
    expect(name.attributes("aria-expanded")).toBe("false");
    expect(row.find(".panel").attributes("style")).toContain("0fr");
    expect(row.find("a.download").exists()).toBe(true);
  });

  it("a video row starts closed and mounts nothing; opening it renders a <video controls preload=metadata playsinline> from the route on a finished page (no query); audio likewise", async () => {
    const w = mountApp(MessageFiles, { props: { files: [mp4, wav] }, provides: withLinks(finished) });
    const [video, audio] = w.findAll("li.artifact");
    expect(video.attributes("data-kind")).toBe("video");
    expect(video.attributes("data-open")).toBe("0");
    expect(video.find("video").exists()).toBe(false);
    await video.find("button.name").trigger("click");
    const player = video.find("video.preview");
    expect(player.attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/3-clip.mp4");
    expect(player.attributes("controls")).toBeDefined();
    expect(player.attributes("preload")).toBe("metadata");
    expect(player.attributes("playsinline")).toBeDefined();
    expect(player.attributes("autoplay")).toBeUndefined();
    expect(video.findAll("a")).toHaveLength(0);
    expect(audio.attributes("data-kind")).toBe("audio");
    await audio.find("button.name").trigger("click");
    const sound = audio.find("audio.preview");
    expect(sound.attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/4-take.wav");
    expect(sound.attributes("controls")).toBeDefined();
  });

  it("a text row fetches the route once on first open and shows the text; a file past the cap is cut at 64 KB with a line saying so", async () => {
    const short = textFetch("PASS webhooks.test.ts (12 tests)\n");
    const w = mountApp(MessageFiles, { props: { files: [log] }, provides: withLinks(finished) });
    const row = w.find("li.artifact");
    expect(row.attributes("data-kind")).toBe("text");
    expect(short.calls).toHaveLength(0);
    await row.find("button.name").trigger("click");
    await vi.waitFor(() => expect(row.find("pre.text").text()).toContain("PASS webhooks.test.ts"));
    expect(short.calls).toEqual(["/runs/run-1/artifacts/threads/slack-C1-1.0/in/1.0/1-build.log"]);
    expect(row.text()).not.toContain("showing the first");
    // Close and reopen: no second fetch.
    await row.find("button.name").trigger("click");
    await row.find("button.name").trigger("click");
    expect(short.calls).toHaveLength(1);
    w.unmount();

    // The cap is in bytes, as the line says: 40,000 two-byte characters are 80,000 bytes, and the
    // panel keeps the 32,768 characters that fit in 64 KB.
    const long = textFetch("é".repeat(40_000));
    const w2 = mountApp(MessageFiles, {
      props: { files: [{ ...log, size: 80_000 }] },
      provides: withLinks(finished),
    });
    const row2 = w2.find("li.artifact");
    await row2.find("button.name").trigger("click");
    await vi.waitFor(() => expect(row2.find("pre.text").text()).toHaveLength(TEXT_PREVIEW_CAP / 2));
    expect(row2.text()).toContain("showing the first 64.0 KB of 78.1 KB");
    expect(long.calls).toHaveLength(1);
  });

  it("two lists showing the same file (the attach call's card and the Reply) give their panels distinct ids, so aria-controls never points at two elements", () => {
    const a = mountApp(MessageFiles, { props: { files: [png] }, provides: withLinks(finished) });
    const b = mountApp(MessageFiles, { props: { files: [png], openImages: false }, provides: withLinks(finished) });
    const idA = a.find(".panel").attributes("id");
    const idB = b.find(".panel").attributes("id");
    expect(idA).toBeTruthy();
    expect(idA).not.toBe(idB);
    expect(a.find("button.name").attributes("aria-controls")).toBe(idA);
    expect(b.find("button.name").attributes("aria-controls")).toBe(idB);
  });

  it("`openImages: false` starts an image row closed too (the attach call's compact form); its name still opens the picture", async () => {
    const w = mountApp(MessageFiles, { props: { files: [png], openImages: false }, provides: withLinks(finished) });
    expect(w.find(".files").attributes("data-open-images")).toBe("0");
    const row = w.find("li.artifact");
    expect(row.attributes("data-open")).toBe("0");
    expect(row.find("img").exists()).toBe(false);
    expect(row.text()).toContain("3.0 MB");
    expect(row.text()).toContain("image/png");
    await row.find("button.name").trigger("click");
    expect(row.find("img.preview").attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png");
  });

  it("an SVG is never inline: it opens to its facts and a Download, never an <img>", async () => {
    const w = mountApp(MessageFiles, { props: { files: [svg] }, provides: withLinks(finished) });
    const row = w.find("li.artifact");
    expect(row.attributes("data-kind")).toBe("other");
    await row.find("button.name").trigger("click");
    expect(row.find("img").exists()).toBe(false);
    expect(row.find("a.download").attributes("href")).toBe("/runs/run-1/artifacts/runs/run-1/out/2-logo.svg");
  });

  it("a file the route no longer serves reads `expired after N days` in place of the panel, the name is text and nothing opens — an errored image, an errored player, a text read answered 410", async () => {
    const w = mountApp(MessageFiles, { props: { files: [png, mp4] }, provides: withLinks(finished) });
    const [image, video] = w.findAll("li.artifact");
    expect(image.attributes("data-expired")).toBe("0");
    await image.find("img.preview").trigger("error");
    expect(image.attributes("data-expired")).toBe("1");
    expect(image.find("img").exists()).toBe(false);
    expect(image.find("button").exists()).toBe(false);
    expect(image.find(".panel").exists()).toBe(false);
    expect(image.find(".expired").text()).toBe("expired after 30 days");
    expect(image.text()).toContain("dashboard.png");
    await video.find("button.name").trigger("click");
    await video.find("video.preview").trigger("error");
    expect(video.attributes("data-expired")).toBe("1");
    expect(video.find("video").exists()).toBe(false);
    expect(video.find(".expired").text()).toBe("expired after 30 days");
    w.unmount();

    textFetch("", 410);
    const w2 = mountApp(MessageFiles, { props: { files: [log] }, provides: withLinks(finished) });
    const row = w2.find("li.artifact");
    await row.find("button.name").trigger("click");
    await vi.waitFor(() => expect(row.attributes("data-expired")).toBe("1"));
    expect(row.find(".expired").text()).toBe("expired after 30 days");
  });

  it("without a store (no `artifacts` in the seed, nothing provided) the rows are text: names, sizes and types, no buttons, no links, no panels", () => {
    const w = mountApp(MessageFiles, { props: { files: [png, zip, mp4] } });
    expect(w.findAll("a")).toHaveLength(0);
    expect(w.findAll("button")).toHaveLength(0);
    expect(w.findAll("img")).toHaveLength(0);
    expect(w.findAll(".panel")).toHaveLength(0);
    expect(w.text()).toContain("dashboard.png");
    expect(w.text()).toContain("3.0 MB");
    expect(w.text()).toContain("↑ sent");
    expect(w.text()).toContain("↓ received");
  });
});
