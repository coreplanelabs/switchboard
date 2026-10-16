// Feature: docs/reference/specs/browser-home.md — exact server-proved attention recipient.
import { enableAutoUnmount } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { HomeUnit } from "@core/core/home/service.js";
import UnitList from "./UnitList.vue";
import { mountApp } from "../../src/testing/mount";
enableAutoUnmount(afterEach);
function row(): HomeUnit {
  return {
    unit: {
      unit: "i:a",
      instanceId: "i",
      id: "a",
      title: "Confirm work",
      branch: "codex/a",
      threads: {},
      sourceUrls: {},
      rounds: [],
    },
    instance: { id: "i", repo: "sample/api", createdAt: 1 },
    nextAction: { kind: "unknown" },
    conditions: ["access:alice", "access:bob"].map((id) => ({
      id,
      unitKey: "i:a",
      revision: 1,
      state: "open",
      owner: { kind: "person", id },
      summary: `Question for ${id}`,
      nextAction: "Answer the question",
    })),
  };
}
describe("Home condition ownership", () => {
  it("shows Working only for a projected moving row while retaining unknown state and explicit waits", () => {
    const moving = {
      ...row(),
      unit: { ...row().unit, unit: "i:moving", title: "Moving work" },
      conditions: [],
      activity: "moving",
    };
    const unknown = { ...row(), unit: { ...row().unit, unit: "i:unknown", title: "Unknown work" }, conditions: [] };
    const waiting = { ...row(), activity: "moving" };
    const wrapper = mountApp(UnitList, { props: { rows: [moving, unknown, waiting], label: "Pipeline units" } });
    expect(wrapper.findAll(".green-unit-row .green-badge").map((badge) => badge.text())).toEqual([
      "Working",
      "State not recorded",
      "Waiting",
    ]);
  });
  it("labels only the exact proved attention recipient as You in a multi-owner urgent row", () => {
    const wrapper = mountApp(UnitList, {
      props: { rows: [row()], label: "Needs you", urgent: true, attentionRecipient: "access:alice" },
    });
    expect(wrapper.find(".green-unit-row").text()).toContain("You · Assigned to: access:bob");
    const unknown = mountApp(UnitList, { props: { rows: [row()], label: "Needs you", urgent: true } });
    expect(unknown.find(".green-unit-row").text()).toContain("Assigned to: access:alice · Assigned to: access:bob");
  });
});
