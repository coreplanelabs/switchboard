import { readFile, rename, writeFile } from "node:fs/promises";
import {
  agentSmokeTransport,
  parseSmokeConfig,
  PRODUCT_ACCEPTANCE_GAP,
  runAgentSmoke,
} from "../src/deploy/agentSmoke.js";

const [planPath, receiptPath, mode] = process.argv.slice(2);
if (!planPath || !receiptPath || (mode !== undefined && mode !== "--check")) {
  throw new Error("usage: smoke:ingress <deploy-plan.json> <receipt.json> [--check]");
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
  const config = parseSmokeConfig(JSON.parse(process.env.SMOKE_INGRESS_CONFIG ?? "null"));
  const transport = agentSmokeTransport({
    origin: process.env.SMOKE_INGRESS_ORIGIN ?? "",
    healthUrl,
    token: process.env.SMOKE_INGRESS_TOKEN ?? "",
    config,
  });
  if (mode === "--check") {
    await save({
      version: 1,
      scope: "deployment-capability-smoke",
      capabilityOutcome: "incomplete",
      productAcceptance: PRODUCT_ACCEPTANCE_GAP,
      reason: "configured_not_executed",
    });
    process.stdout.write("Smoke configured; acceptance not executed.\n");
  } else {
    if (!process.env.SMOKE_INGRESS_THREAD)
      throw new Error("SMOKE_INGRESS_THREAD is not set; use a fresh disposable thread prefix");
    const receipt = await runAgentSmoke({
      config,
      transport,
      expectedCommit: process.env.SMOKE_EXPECTED_COMMIT || undefined,
      thread: process.env.SMOKE_INGRESS_THREAD,
      onReceipt: save,
    });
    process.stdout.write(
      `Deployment capability acceptance: ${receipt.capabilityOutcome}. Private draft-PR path remains unproven.\n`,
    );
    if (receipt.capabilityOutcome !== "passed") process.exitCode = 1;
  }
} catch {
  // The last receipt retains any admitted identity. Never print credentials or remote prose.
  process.stderr.write("Smoke incomplete; see receipt and configured disposable fixture requirements.\n");
  process.exitCode = 1;
}
