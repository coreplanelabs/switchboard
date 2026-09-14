// Feature: docs/reference/specs/live-view.md item 26 — the Files block: one row per
// artifact event, raster images inline from the run's proxy route, everything
// else a link, an expired image named as such.
import { describe, expect, it } from "vitest";
import ArtifactsBlock from "./ArtifactsBlock.vue";
import { mountApp } from "../../testing/mount";
import type { TimelineArtifact } from "@core/channels/runTimeline.js";

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
  at: 1001,
};
const svg: TimelineArtifact = {
  ...png,
  key: "runs/run-1/out/2-logo.svg",
  name: "logo.svg",
  contentType: "image/svg+xml",
};

describe("ArtifactsBlock", () => {
  it("on a live page an image row renders an <img> whose src carries the token; a zip row is a link with no image; sizes and types are facts", () => {
    const w = mountApp(ArtifactsBlock, {
      props: {
        artifacts: [zip, png],
        links: { urlBase: "/runs/run-1/artifacts/", retentionDays: 30, token: "tok-1" },
        position: "last",
      },
    });
    expect(w.find("#artifacts").attributes("data-position")).toBe("last");
    expect(w.find("h2").text()).toContain("2 files");
    const rows = w.findAll("li.artifact");
    expect(rows).toHaveLength(2);
    // Event order, direction first.
    expect(rows[0].attributes("data-direction")).toBe("in");
    expect(rows[0].find("a.name").attributes("href")).toBe(
      "/runs/run-1/artifacts/threads/slack-C1-1.0/in/1.0/0-bundle.zip?t=tok-1",
    );
    expect(rows[0].find("img").exists()).toBe(false);
    expect(rows[0].text()).toContain("12.0 MB");
    expect(rows[0].text()).toContain("application/zip");
    expect(rows[1].attributes("data-direction")).toBe("out");
    const img = rows[1].find("img.preview");
    expect(img.attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png?t=tok-1");
    expect(img.attributes("alt")).toBe("dashboard.png");
    expect(rows[1].find("a.name").attributes("href")).toBe(img.attributes("src"));
  });

  it("on a finished run's page the URLs carry no query; an SVG is a link, never inline (the route downloads it)", () => {
    const w = mountApp(ArtifactsBlock, {
      props: {
        artifacts: [png, svg],
        links: { urlBase: "/runs/run-1/artifacts/", retentionDays: 30 },
        position: "first",
      },
    });
    const rows = w.findAll("li.artifact");
    expect(rows[0].find("img.preview").attributes("src")).toBe("/runs/run-1/artifacts/runs/run-1/out/1-dashboard.png");
    expect(rows[1].find("img").exists()).toBe(false);
    expect(rows[1].find("a.name").attributes("href")).toBe("/runs/run-1/artifacts/runs/run-1/out/2-logo.svg");
  });

  it("an image the route no longer serves reads `expired after N days` in place of the picture and the link", async () => {
    const w = mountApp(ArtifactsBlock, {
      props: { artifacts: [png], links: { urlBase: "/runs/run-1/artifacts/", retentionDays: 30 }, position: "first" },
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

  it("without a store (no `artifacts` in the seed) the rows are text: names, sizes and types, no links, no images", () => {
    const w = mountApp(ArtifactsBlock, { props: { artifacts: [png, zip], links: null, position: "first" } });
    expect(w.findAll("a")).toHaveLength(0);
    expect(w.findAll("img")).toHaveLength(0);
    expect(w.text()).toContain("dashboard.png");
    expect(w.text()).toContain("3.0 MB");
    expect(w.text()).toContain("↑ sent");
    expect(w.text()).toContain("↓ received");
  });
});
