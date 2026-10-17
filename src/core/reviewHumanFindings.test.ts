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
  scenario: "Finishing connection setup saves the result but does not send it to the browser.",
  impact: "Connect and Continue stay hidden until the request times out. Reloading restores them.",
  evidence: { basis: "code_trace", detail: "The code waits before sending the result. This was not reproduced." },
  requestedChange: "Send the setup result before waiting.",
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
    expect(visible).toContain(
      "- 🟠 **Major**: **Users cannot continue a live connection setup.**\n" +
        `  [\`src/connection.ts:23\`](https://github.com/acme/api/blob/${head}/src/connection.ts#L23)\n\n` +
        "  **Why it matters:** Finishing connection setup saves the result but does not send it to the browser. Connect and Continue stay hidden until the request times out. Reloading restores them.\n\n" +
        "  **Evidence:** From reading the code. The code waits before sending the result. This was not reproduced.\n\n" +
        "  **Change:** Send the setup result before waiting.",
    );
    expect(visible).toContain(`/blob/${head}/src/connection.ts#L23`);
    expect(body.slice(body.indexOf("<details>"))).toContain("Malformed calls bypass validation.");
    const marker = JSON.parse(body.match(/^<!-- switchboard:verdict (.*) -->$/m)![1]!);
    expect(marker.findings[0]).toMatchObject({ file: "src/old.ts", line: 4, title: finding.title });
    expect(Object.keys(marker)).not.toContain("humanFindings");
  });

  it("publishes a plain review-request failure through the submission and rendering path", async () => {
    const recorded: Parameters<typeof buildReviewPostBody>[1][] = [];
    const ctx = {
      executor: {},
      onVerdict: (v: Parameters<typeof buildReviewPostBody>[1]) => recorded.push(v),
    } as unknown as ToolContext;
    const result = await submitVerdictTool.run(
      {
        ...input,
        humanFindings: [
          {
            findingId: "F1",
            problem: "Valid review requests can be rejected.",
            scenario: "A person puts the pull request link on a second line or after the first 300 characters.",
            impact: "The review does not start.",
            evidence: {
              basis: "code_trace",
              detail:
                "The check reads only the first line and cuts it off after 300 characters. This was not reproduced.",
            },
            requestedChange: "Use the full request when checking which pull request to review.",
            location: { file: "src/request.ts", line: 51 },
          },
        ],
      },
      ctx,
    );
    expect(result).toContain("verdict recorded: request_changes");
    const visible = buildReviewPostBody("Detailed source trace", recorded[0], { repo: "acme/api", head }).split(
      "<details>",
    )[0];
    expect(visible).toContain("**Major**: **Valid review requests can be rejected.**");
    expect(visible).toContain(
      "**Why it matters:** A person puts the pull request link on a second line or after the first 300 characters. The review does not start.",
    );
    expect(visible).toContain(
      "**Evidence:** From reading the code. The check reads only the first line and cuts it off after 300 characters. This was not reproduced.",
    );
    expect(visible).toContain("**Change:** Use the full request when checking which pull request to review.");
  });

  it.each([
    ["isolated_reproduction", "Reproduced in a separate test."],
    ["deployed_reproduction", "Reproduced on the deployed system."],
    ["repository_rule", "Project requirement."],
  ])("identifies %s evidence without changing its claim", (basis, label) => {
    const verdict = parseVerdictInput({
      ...input,
      humanFindings: [{ ...human, evidence: { basis, detail: "The recorded result is explained here." } }],
    })!;
    const visible = buildReviewPostBody("Detailed proof", verdict).split("<details>")[0];
    expect(visible).toContain(`**Evidence:** ${label} The recorded result is explained here.`);
    expect(visible).toContain("**Change:** Send the setup result before waiting.");
  });

  it("retains and redacts the current explanation through canonical verdict parsing", () => {
    const verdict = parseVerdictInput(input)!;
    expect(verdict).toMatchObject({ humanFindings: [human] });
    expect(parseVerdictInput(JSON.parse(JSON.stringify(verdict)))).toMatchObject({ humanFindings: [human] });
    expect(redactVerdict(verdict, (s) => s.replaceAll("result", "[redacted]"))).toMatchObject({
      humanFindings: [
        { scenario: "Finishing connection setup saves the [redacted] but does not send it to the browser." },
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
