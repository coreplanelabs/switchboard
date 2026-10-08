// Feature: docs/reference/specs/load-harness.md — fixed candidate smoke.
import { describe, expect, it, vi } from "vitest";
import { CommandRegistry } from "../core/commandRegistry.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { registerCoreCommands, type CoreCommandDeps } from "../core/commands/all.js";
import { operatorPresets, runOperator, OPERATOR_READ_TOOLS, OPERATOR_BIND_TOOL } from "../core/dispatch/operator.js";
import { routableCommands, type RouteModel } from "../core/dispatch/route.js";
import { candidateDoorSmokeCases, candidateDoorSmokeInput, candidateRepositoryBriefs } from "./candidateDoorSmoke.js";

const registry = new CommandRegistry<CoreCommandDeps>({ audit: () => {}, capabilities: ALL_CAPABILITIES });
registerCoreCommands(registry);
const projection = { presets: operatorPresets(), commands: routableCommands(registry) };
const probe = candidateDoorSmokeCases(projection).find(
  (entry) => entry.name === "same-thread fix with historical foreign PR",
)!;
const work = {
  tool: OPERATOR_BIND_TOOL,
  input: { preset: "ship", shipEntry: "work_from_thread", repo: "acme/api", reason: "Fix the original issue." },
};

describe("fixed candidate smoke repository dependency", () => {
  it("answers a valid connected fixture helper through the same input builder used by candidate smoke", async () => {
    const replies = [{ tool: OPERATOR_READ_TOOLS.repositoryBrief, input: { repo: "acme/api" } }, work];
    const model = vi.fn<RouteModel>(async () => replies.shift()!);
    const result = await runOperator(candidateDoorSmokeInput(probe, projection, "openai"), model);
    const reply = model.mock.calls[1]![0].retries!.at(-1)!.violation;
    expect(reply).toContain('"repo":"acme/api"');
    expect(reply).not.toContain("Pass a repository");
    expect(model).toHaveBeenCalledTimes(2);
    expect(result.decision.kind).toBe("binds");
    if (result.decision.kind === "binds") expect(probe.expected(result.decision.binds[0]!)).toBe(true);
  });

  it("declares only synthetic metadata, refuses unknown scopes and cannot retain a caller's catalog edits", async () => {
    const context = candidateRepositoryBriefs();
    expect(context.catalog.map((brief) => brief.repo)).toEqual(["acme/api"]);
    expect(await context.read("private/unknown")).toBeUndefined();
    expect(await context.read(42 as never)).toBeUndefined();
    const known = (await context.read("ACME/API"))!;
    expect(known).toMatchObject({ repo: "acme/api", sourceStatus: "unavailable", sources: [] });
    expect(known).not.toHaveProperty("head");
    expect(known).not.toHaveProperty("owner");
    known.repo = "private/changed";
    context.catalog[0]!.repo = "private/catalog-change";
    expect((await context.read("acme/api"))!.repo).toBe("acme/api");
    expect(candidateRepositoryBriefs().catalog[0]!.repo).toBe("acme/api");
  });

  it.each([
    { repo: "private/unknown", result: "not_found" },
    { repo: undefined, result: "invalid_arguments" },
  ] as const)(
    "keeps the fixed helper's $result outcome distinct without granting a target",
    async ({ repo, result }) => {
      const replies = [{ tool: "repository_brief", input: { repo } }, work];
      const model = vi.fn<RouteModel>(async () => replies.shift()!);
      const answer = await runOperator(candidateDoorSmokeInput(probe, projection, "openai"), model, {
        smokeDiagnosticScope: "candidate-smoke-v1",
      });
      expect(answer.smokeDiagnostic!.reads[0]!.result).toBe(result);
      expect(answer.decision.kind).toBe("binds");
      if (answer.decision.kind === "binds") expect(answer.decision.binds[0]!.repo).toBe("acme/api");
      expect(model).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps an explicit throwing seam and its fallback without exposing the exception", async () => {
    const read = vi.fn(async () => {
      throw new Error("PRIVATE_FIXTURE_ERROR");
    });
    const scoped = {
      ...probe,
      context: { ...probe.context, repositoryBriefs: { status: "available" as const, catalog: [], read } },
    };
    const replies = [{ tool: "repository_brief", input: { repo: "acme/api" } }, work];
    const model = vi.fn<RouteModel>(async () => replies.shift()!);
    const answer = await runOperator(candidateDoorSmokeInput(scoped, projection, "openai"), model, {
      smokeDiagnosticScope: "candidate-smoke-v1",
    });
    expect(read).toHaveBeenCalledOnce();
    expect(answer.smokeDiagnostic!.reads[0]!.result).toBe("read_error");
    expect(model.mock.calls[1]![0].retries!.at(-1)!.violation).toBe(
      "The repository brief could not be read; other context remains available.",
    );
    expect(JSON.stringify(answer.smokeDiagnostic)).not.toContain("PRIVATE_FIXTURE_ERROR");
  });

  it("keeps decoded argument equality distinct from repository aliases that the fixture reader resolves equally", async () => {
    const replies = [
      { tool: "repository_brief", input: { repo: "acme/api" } },
      { tool: "repository_brief", input: { repo: "ACME/API" } },
      work,
    ];
    const answer = await runOperator(
      candidateDoorSmokeInput(probe, projection, "openai"),
      async () => replies.shift()!,
      { smokeDiagnosticScope: "candidate-smoke-v1" },
    );
    expect(answer.smokeDiagnostic!.reads.map((read) => read.argument)).toEqual([
      { kind: "group", ordinal: 1 },
      { kind: "group", ordinal: 2 },
    ]);
    expect(answer.smokeDiagnostic!.reads.map((read) => read.result)).toEqual(["metadata_only", "metadata_only"]);
  });

  it.each(candidateDoorSmokeCases(projection).filter((entry) => /review/.test(entry.name)))(
    "preserves the fixed Review candidate target for $name",
    async (entry) => {
      const preset =
        entry.name === "standalone PR review"
          ? "review"
          : entry.name === "read about review severity"
            ? "general"
            : "ship";
      const model = vi.fn<RouteModel>(async () => ({
        tool: OPERATOR_BIND_TOOL,
        input: {
          preset,
          reason: "Requested fixed fixture route.",
          ...(preset !== "general"
            ? {
                repo: "acme/api",
                prTarget: { source: "request", number: 7, quote: "https://github.com/acme/api/pull/7" },
              }
            : {}),
          ...(preset === "ship" ? { shipEntry: "review" } : {}),
          ...(entry.name === "review with requested renewals"
            ? { renewals: 2, settingsEvidence: { renewals: { quote: "two renewals", intent: "requested" } } }
            : {}),
        },
      }));
      const answer = await runOperator(candidateDoorSmokeInput(entry, projection, "openai"), model, {
        smokeDiagnosticScope: "candidate-smoke-v1",
      });
      expect(answer.decision.kind).toBe("binds");
      if (answer.decision.kind === "binds") expect(entry.expected(answer.decision.binds[0]!)).toBe(true);
      expect(model.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
});
