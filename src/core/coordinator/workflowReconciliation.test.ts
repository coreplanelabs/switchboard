// Feature: docs/reference/specs/orchestration-plane.md — exact immutable execution identity and native absence.
import { describe, expect, it } from "vitest";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { RecoveryAction } from "./recoveryHistory.js";
import {
  coordinatorReconciliationEffect,
  coordinatorWorkflowCanReconcile,
  isCoordinatorReconcileEffect,
  isCoordinatorReconcileReceipt,
} from "./workflowReconciliation.js";

const instance: CoordinatorInstance = {
  id: "workflow_contract",
  kind: "ship",
  userId: "cli:user",
  channelId: "cli:main",
  threadKey: "cli:main:1",
  repo: "acme/api",
  branch: "fix/original",
  base: "main",
  createdAt: 1,
  admission: "created",
};
const unit: CoordinatorUnit = {
  instanceId: instance.id,
  unit: "ONE",
  slug: "one",
  branch: instance.branch,
  dependsOn: [],
  rounds: [],
  startedAt: 2,
};
const currentEffect = {
  version: 1,
  id: "ONE/branch",
  ordinal: 1,
  execution: { workflowId: instance.id },
  target: { repo: instance.repo, ref: unit.branch, base: "main", headSha: "a".repeat(40) },
  phase: "active",
  calls: [{ operation: "branch_create", state: "pending" }],
} as const;

describe("coordinator Workflow reconciliation identity", () => {
  it("does not treat a terminal same-ID Workflow as recovery or legacy admission evidence", () => {
    const action = { id: "r_" + "b".repeat(64), workflowId: "new_recovery", state: "pending" } as RecoveryAction;
    expect(coordinatorWorkflowCanReconcile(instance, unit, action, "errored")).toBe(false);
    expect(coordinatorWorkflowCanReconcile({ ...instance, admission: undefined }, unit, undefined, "terminated")).toBe(
      false,
    );
    expect(
      coordinatorWorkflowCanReconcile(
        instance,
        {
          ...unit,
          currentEffect: {
            ...currentEffect,
            execution: { workflowId: action.workflowId, recoveryActionId: action.id },
            calls: [{ operation: "branch_create", state: "unstarted" }],
          },
        },
        action,
        "complete",
      ),
    ).toBe(false);
    expect(
      coordinatorWorkflowCanReconcile(
        instance,
        {
          ...unit,
          currentEffect: {
            ...currentEffect,
            execution: { workflowId: action.workflowId, recoveryActionId: action.id },
          },
        },
        action,
        "errored",
      ),
    ).toBe(true);
  });
  it("keeps progress outside admission identity and retains authority changes as different requests", async () => {
    const effect = await coordinatorReconciliationEffect(instance, unit);
    expect(isCoordinatorReconcileEffect(effect)).toBe(true);
    expect(
      await coordinatorReconciliationEffect(
        { ...instance, stop: { at: 3 } },
        {
          ...unit,
          rounds: [{ index: 0, agent: "coding", outcome: "started", at: 3 }],
          ending: { kind: "aborted", report: "finished", at: 4 },
        },
      ),
    ).toEqual(effect);
    expect(await coordinatorReconciliationEffect({ ...instance, userId: "cli:other" }, unit)).not.toEqual(effect);
    expect(isCoordinatorReconcileEffect({ ...effect, report: "private content" })).toBe(false);
    expect(isCoordinatorReconcileReceipt({ reportDelivery: {}, status: {}, privateReplyId: "unproved" })).toBe(false);
  });
  it("native absence requires created admission and a begun exact execution, including unknown results", () => {
    expect(coordinatorWorkflowCanReconcile(instance, { ...unit, currentEffect }, undefined, "absent")).toBe(true);
    expect(
      coordinatorWorkflowCanReconcile(
        instance,
        { ...unit, currentEffect: { ...currentEffect, calls: [{ operation: "branch_create", state: "uncertain" }] } },
        undefined,
        "absent",
      ),
    ).toBe(true);
    for (const row of [
      unit,
      { ...unit, startedAt: undefined, currentEffect },
      { ...unit, currentEffect: { ...currentEffect, execution: { workflowId: "foreign_execution" } } },
      {
        ...unit,
        currentEffect: {
          ...currentEffect,
          calls: [{ operation: "branch_create", state: "refused", cause: "not_started" }],
        },
      },
    ] satisfies CoordinatorUnit[])
      expect(coordinatorWorkflowCanReconcile(instance, row, undefined, "absent")).toBe(false);
    expect(
      coordinatorWorkflowCanReconcile(
        { ...instance, admission: "unreconciled" },
        { ...unit, currentEffect },
        undefined,
        "absent",
      ),
    ).toBe(false);
    expect(coordinatorWorkflowCanReconcile(instance, { ...unit, currentEffect }, undefined, "unfamiliar")).toBe(false);
  });
});
