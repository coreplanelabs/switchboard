import { readFile, rename, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { parseSlackSmokeConfig, runSlackCommandSmoke, type SlackSmokeReceipt } from "../src/deploy/slackSmoke.js";
import {
  agentSmokeTransport,
  parseSmokeConfig,
  PRODUCT_ACCEPTANCE_GAP,
  runAgentSmoke,
  SmokeReaderError,
} from "../src/deploy/agentSmoke.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    check: { type: "boolean" },
    "check-reader": { type: "boolean" },
    model: { type: "string" },
    "review-transport": { type: "string" },
    "review-effort": { type: "string" },
    "require-vouched-controls": { type: "boolean" },
  },
});
const [planPath, receiptPath] = positionals;
if (!planPath || !receiptPath || positionals.length !== 2 || (values["check-reader"] && !values.check)) {
  throw new Error(
    "usage: smoke:ingress <deploy-plan.json> <receipt.json> [--check [--check-reader]] [--model provider/model] [--review-transport http|mcp] [--review-effort high] [--require-vouched-controls]",
  );
}
// Outside the tree, written atomically before admission and after each known phase.
const save = async (value: unknown) => {
  await writeFile(`${receiptPath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await rename(`${receiptPath}.tmp`, receiptPath);
};
await save({
  version: 1,
  scope: "deployment-capability-smoke",
  capabilityOutcome: "incomplete",
  productAcceptance: PRODUCT_ACCEPTANCE_GAP,
  reason: "configuration_unproven",
});
try {
  const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
  const steps = (plan as { steps?: { name?: string; healthUrl?: string; liveGate?: { healthUrl?: string } }[] }).steps;
  const bot = steps?.find((step) => step.name === "bot");
  const healthUrl = bot?.healthUrl ?? bot?.liveGate?.healthUrl;
  if (!healthUrl) throw new Error("deploy plan has no bot health URL");
  const supplied = JSON.parse(process.env.SMOKE_INGRESS_CONFIG ?? "null");
  const config = parseSmokeConfig({
    ...supplied,
    ...(values.model === undefined ? {} : { model: values.model }),
    ...(values["require-vouched-controls"] ? { requireVouchedControls: true } : {}),
    ...(values["review-transport"] === undefined && values["review-effort"] === undefined
      ? {}
      : {
          review: {
            ...supplied?.review,
            ...(values["review-transport"] === undefined ? {} : { transport: values["review-transport"] }),
            ...(values["review-effort"] === undefined ? {} : { effort: values["review-effort"] }),
          },
        }),
  });
  const transport = agentSmokeTransport({
    origin: process.env.SMOKE_INGRESS_ORIGIN ?? "",
    healthUrl,
    token: process.env.SMOKE_INGRESS_TOKEN ?? "",
    access: {
      clientId: process.env.SMOKE_ACCESS_CLIENT_ID,
      clientSecret: process.env.SMOKE_ACCESS_CLIENT_SECRET,
    },
    config,
  });
  const slackConfig = process.env.SMOKE_SLACK_CONFIG
    ? parseSlackSmokeConfig(JSON.parse(process.env.SMOKE_SLACK_CONFIG))
    : undefined;
  if (slackConfig && !process.env.SMOKE_SLACK_USER_TOKEN) throw new Error("SMOKE_SLACK_USER_TOKEN is not set");
  if (slackConfig && !process.env.SMOKE_EXPECTED_COMMIT)
    throw new Error("Slack acceptance requires an exact candidate commit");
  if (values.check) {
    let readerCheck:
      { outcome: "passed" | "incomplete"; observationError?: SmokeReaderError["observation"] } | undefined;
    if (values["check-reader"]) {
      await save({
        version: 1,
        scope: "deployment-capability-smoke",
        capabilityOutcome: "incomplete",
        reason: "reader_unproven",
      });
      try {
        if (!transport.readerReady) throw new SmokeReaderError({ code: "reader_unavailable" });
        await transport.readerReady();
        readerCheck = { outcome: "passed" };
      } catch (error) {
        readerCheck = {
          outcome: "incomplete",
          observationError: error instanceof SmokeReaderError ? error.observation : { code: "reader_check_failed" },
        };
      }
    }
    await save({
      version: 1,
      scope: "deployment-capability-smoke",
      capabilityOutcome: "incomplete",
      productAcceptance: PRODUCT_ACCEPTANCE_GAP,
      reason:
        readerCheck?.outcome === "incomplete"
          ? "reader_unproven"
          : readerCheck
            ? "reader_verified"
            : "configured_not_executed",
      ...(readerCheck ? { readerCheck } : {}),
      ...(config.model ? { requestedModel: config.model } : {}),
      reviewTransport: config.review.transport ?? "http",
      ...(config.review.effort ? { requestedReviewEffort: config.review.effort } : {}),
      ...(config.review.transport === "mcp" ? { mcpPermissions: "unverified" } : {}),
    });
    if (readerCheck?.outcome === "incomplete") {
      const error = readerCheck.observationError;
      const detail = error ? ` (${error.code}${error.http ? `, HTTP ${error.http.status}` : ""})` : "";
      process.stderr.write(`Smoke reader not verified${detail}. No agent started.\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        readerCheck
          ? "Smoke reader verified; acceptance not executed.\n"
          : "Smoke configured; acceptance not executed.\n",
      );
    }
  } else {
    if (!process.env.SMOKE_INGRESS_THREAD)
      throw new Error("SMOKE_INGRESS_THREAD is not set; use a fresh disposable thread prefix");
    const receipt = await runAgentSmoke({
      config,
      requireSlackConnection: process.env.SMOKE_REQUIRE_SLACK_CONNECTION === "true",
      transport,
      expectedCommit: process.env.SMOKE_EXPECTED_COMMIT || undefined,
      thread: process.env.SMOKE_INGRESS_THREAD,
      onReceipt: save,
    });
    if (receipt.capabilityOutcome === "passed" && slackConfig) {
      const saveSlack = async (slackCommand: SlackSmokeReceipt) =>
        save({
          ...receipt,
          capabilityOutcome: slackCommand.outcome === "passed" ? "passed" : "incomplete",
          slackCommand,
        });
      const slackCommand = await runSlackCommandSmoke({
        origin: process.env.SMOKE_INGRESS_ORIGIN ?? "",
        healthUrl,
        expectedCommit: process.env.SMOKE_EXPECTED_COMMIT!,
        userToken: process.env.SMOKE_SLACK_USER_TOKEN!,
        config: slackConfig,
        onReceipt: saveSlack,
      });
      if (slackCommand.outcome !== "passed") receipt.capabilityOutcome = "incomplete";
    }
    process.stdout.write(`Deployment capability acceptance: ${receipt.capabilityOutcome}.\n`);
    for (const row of receipt.scenarios) {
      const observation = row.observationError;
      const detail = observation
        ? ` (${observation.code}${observation.http ? `, HTTP ${observation.http.status}` : ""})`
        : "";
      process.stdout.write(`${row.id}: ${row.outcome}${detail}\n`);
    }
    process.stdout.write("Private draft-PR acceptance: unproven.\n");
    if (receipt.capabilityOutcome !== "passed") process.exitCode = 1;
  }
} catch {
  // The last receipt retains any admitted identity. Never print credentials or remote prose.
  process.stderr.write("Smoke incomplete; see receipt and configured disposable fixture requirements.\n");
  process.exitCode = 1;
}
