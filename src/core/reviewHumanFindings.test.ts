import { describe, expect, it } from "vitest";
import { buildReviewPostBody, parseVerdictInput, redactVerdict } from "./reviewVerdict.js";
import { submitVerdictTool } from "../tools/submit.js";
import type { ToolContext } from "../tools/runnableTool.js";

const head = "a".repeat(40);
const finding = {
  id: "F1",
  severity: "major",
  kind: "single",
  file: "src/old.ts",
  line: 4,
  title: "Malformed calls bypass validation.",
};
const human = {
  findingId: "F1",
  problem: "Users cannot continue a live connection setup.",
  scenario: "Completing the normal connection flow saves a receipt without delivering it to the console.",
  impact: "Connect and Continue stay hidden until timeout; reloading restores them.",
  evidence: { basis: "code_trace", detail: "Traced the server and console path; not reproduced live." },
  requestedChange: "Send the receipt before waiting.",
  location: { file: "src/connection.ts", line: 23 },
};
const input = {
  verdict: "request_changes",
  summary: "Connection controls are missing",
  head,
  findings: [finding],
  humanFindings: [human],
};

describe("human review explanations", () => {
  it("shows the current failure, trigger, impact, proof limit and fix without opening agent evidence", () => {
    const verdict = parseVerdictInput(input)!;
    const body = buildReviewPostBody("Original agent evidence", verdict, { repo: "acme/api", head });
    const visible = body.split("<details>")[0];
    expect(visible).toContain("**Major**");
    for (const sentence of [human.problem, human.scenario, human.impact, human.evidence.detail, human.requestedChange])
      expect(visible).toContain(sentence);
    expect(visible).toContain(`/blob/${head}/src/connection.ts#L23`);
    expect(body.slice(body.indexOf("<details>"))).toContain("Malformed calls bypass validation.");
    const marker = JSON.parse(body.match(/^<!-- switchboard:verdict (.*) -->$/m)![1]!);
    expect(marker.findings[0]).toMatchObject({ file: "src/old.ts", line: 4, title: finding.title });
    expect(Object.keys(marker)).not.toContain("humanFindings");
  });

  it("retains and redacts the current explanation through canonical verdict parsing", () => {
    const verdict = parseVerdictInput(input)!;
    expect(verdict).toMatchObject({ humanFindings: [human] });
    expect(parseVerdictInput(JSON.parse(JSON.stringify(verdict)))).toMatchObject({ humanFindings: [human] });
    expect(redactVerdict(verdict, (s) => s.replaceAll("receipt", "[redacted]"))).toMatchObject({
      humanFindings: [
        { scenario: "Completing the normal connection flow saves a [redacted] without delivering it to the console." },
      ],
    });
  });

  it("does not carry the historical line into a current file-only locator", () => {
    const verdict = parseVerdictInput({
      ...input,
      humanFindings: [{ ...human, location: { file: "src/current.ts" } }],
    })!;
    const visible = buildReviewPostBody("agent evidence", verdict, { repo: "acme/api", head }).split("<details>")[0];
    expect(visible).toContain(`src/current.ts\`](https://github.com/acme/api/blob/${head}/src/current.ts)`);
    expect(visible).not.toContain("#L4");
  });

  it("keeps human prose literal and encodes grouped file paths without changing the machine finding", () => {
    const verdict = parseVerdictInput({
      ...input,
      humanFindings: [
        {
          ...human,
          problem: "</details> # Claimed approval",
          location: { file: "src/(setup)/connection.ts", line: 23 },
        },
      ],
    })!;
    const body = buildReviewPostBody("agent evidence", verdict, { repo: "acme/api", head });
    expect(body.match(/^<details>/gm)).toEqual(["<details>"]);
    expect(body.split("<details>")[0]).toContain("\\</details\\>");
    expect(body).toContain("/src/%28setup%29/connection.ts#L23");
    expect(body).toContain('"title":"Malformed calls bypass validation."');
  });

  it("rejects incomplete, duplicate, unknown and oversized explanations instead of dropping them", () => {
    for (const humanFindings of [
      [],
      [human, human],
      [{ ...human, findingId: "F2" }],
      [{ ...human, impact: "" }],
      [{ ...human, scenario: "x".repeat(901) }],
      [{ ...human, location: { file: "../private.ts" } }],
    ])
      expect(parseVerdictInput({ ...input, humanFindings })).toBeNull();
    expect(parseVerdictInput(input)?.verdict).toBe("request_changes");
  });

  it("refuses a fresh tool submission without human explanations while legacy records remain readable", async () => {
    const { humanFindings: _, ...legacy } = input;
    const recorded: unknown[] = [];
    const ctx = { executor: {}, onVerdict: (v: unknown) => recorded.push(v) } as unknown as ToolContext;
    const missing = await submitVerdictTool.run(legacy, ctx);
    expect(missing).toContain("error: humanFindings");
    const accepted = await submitVerdictTool.run(input, ctx);
    expect(accepted).toContain("verdict recorded: request_changes");
    expect(recorded).toMatchObject([{ humanFindings: [human] }]);
    expect(buildReviewPostBody("legacy evidence", parseVerdictInput(legacy)!)).toContain(finding.title);
  });
});
