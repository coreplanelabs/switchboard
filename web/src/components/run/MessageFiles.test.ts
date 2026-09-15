// Feature: docs/reference/specs/live-view.md item 26 — the files of one message,
// nested in its card: one row per file, raster images inline from the run's
// proxy route, everything else a link, an expired image named as such, and a
// compact form (rows without the picture) for the attach call once the Reply
// carries the same files.
import { describe, expect, it } from "vitest";
import type { InjectionKey } from "vue";
import MessageFiles from "./MessageFiles.vue";
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

const withLinks = (links: ArtifactsSeed | null) => [[ArtifactLinksKey as InjectionKey<unknown>, links]] as const;

describe("MessageFiles", () => {
  it("on a live page an image row renders an <img> whose src carries the token; a zip row is a link with no image; sizes, types and the direction word are facts", () => {
    const w = mountApp(MessageFiles, {
      props: { files: [zip, png] },
      provides: withLinks({ urlBase: "/runs/run-1/artifacts/", retentionDays: 30, token: "tok-1" }),
    });
    expect(w.find(".files").attributes("data-preview")).toBe("1");
    expect(w.find("h3").text()).toContain("2 files");
    const rows = w.findAll("li.artifact");
    expect(rows).toHaveLength(2);
    // Event order, direction first.
    expect(rows[0].attributes("data-direction")).toBe("in");
    expect(rows[0].text()).toContain("↓ received");
    expect(rows[0].find("a.name").attributes("href")).toBe(
      "/runs/run-1/artifacts/threads/slack-C1-1.0/in/1.0/0-bundle.zip?t=tok-1",
    );
    expect(rows[0].find("img").exists()).toBe(false);
    expect(rows[0].text()).toContain("12.0 MB");
    expect(rows[0].text()).toContain("application/zip");
    expect(rows[1].attributes("data-direction")).toBe("out");
    expect(rows[1].text()).toContain("↑ sent");
    const img = rows[1].find("img.preview");
    expect(img.attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png?t=tok-1");
    expect(img.attributes("alt")).toBe("dashboard.png");
    expect(rows[1].find("a.name").attributes("href")).toBe(img.attributes("src"));
  });

  it("on a finished run's page the URLs carry no query; an SVG is a link, never inline (the route downloads it)", () => {
    const w = mountApp(MessageFiles, {
      props: { files: [png, svg] },
      provides: withLinks({ urlBase: "/runs/run-1/artifacts/", retentionDays: 30 }),
    });
    const rows = w.findAll("li.artifact");
    expect(rows[0].find("img.preview").attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png");
    expect(rows[1].find("img").exists()).toBe(false);
    expect(rows[1].find("a.name").attributes("href")).toBe("/runs/run-1/artifacts/runs/run-1/out/2-logo.svg");
  });

  it("`preview: false` keeps the row — the link, the size, the type — and drops the picture (the attach call's compact form)", () => {
    const w = mountApp(MessageFiles, {
      props: { files: [png], preview: false },
      provides: withLinks({ urlBase: "/runs/run-1/artifacts/", retentionDays: 30 }),
    });
    expect(w.find(".files").attributes("data-preview")).toBe("0");
    const row = w.find("li.artifact");
    expect(row.find("img").exists()).toBe(false);
    expect(row.find("a.name").attributes("href")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png");
    expect(row.text()).toContain("3.0 MB");
    expect(row.text()).toContain("image/png");
  });

  it("an image the route no longer serves reads `expired after N days` in place of the picture and the link", async () => {
    const w = mountApp(MessageFiles, {
      props: { files: [png] },
      provides: withLinks({ urlBase: "/runs/run-1/artifacts/", retentionDays: 30 }),
    });
    const row = w.find("li.artifact");
    expect(row.attributes("data-expired")).toBe("0");
    await row.find("img.preview").trigger("error");
    expect(row.attributes("data-expired")).toBe("1");
    expect(row.find("img").exists()).toBe(false);
    expect(row.find("a").exists()).toBe(false);
    expect(row.find(".expired").text()).toBe("expired after 30 days");
    expect(row.text()).toContain("dashboard.png");
  });

  it("without a store (no `artifacts` in the seed, nothing provided) the rows are text: names, sizes and types, no links, no images", () => {
    const w = mountApp(MessageFiles, { props: { files: [png, zip] } });
    expect(w.findAll("a")).toHaveLength(0);
    expect(w.findAll("img")).toHaveLength(0);
    expect(w.text()).toContain("dashboard.png");
    expect(w.text()).toContain("3.0 MB");
    expect(w.text()).toContain("↑ sent");
    expect(w.text()).toContain("↓ received");
  });
});
