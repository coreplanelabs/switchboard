import { readFile } from "node:fs/promises";
import { assertSmokeOriginMatchesPlan, smokeIngress } from "../src/deploy/ingressSmoke.js";

const planPath = process.argv[2];
if (!planPath) throw new Error("usage: smoke:ingress <deploy-plan.json>");
const plan: unknown = JSON.parse(await readFile(planPath, "utf8"));
const steps = (plan as { steps?: { name?: string; healthUrl?: string; liveGate?: { healthUrl?: string } }[] }).steps;
const bot = steps?.find((step) => step.name === "bot");
const healthUrl = bot?.healthUrl ?? bot?.liveGate?.healthUrl;
if (!healthUrl) throw new Error("deploy plan has no bot health URL");
const origin = process.env.SMOKE_INGRESS_ORIGIN ?? "";
assertSmokeOriginMatchesPlan(origin, healthUrl);
const receipt = await smokeIngress({
  origin,
  token: process.env.SMOKE_INGRESS_TOKEN ?? "",
  thread: `release-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
});
process.stdout.write(`Production ingress smoke passed; run ${receipt.runId}\n`);
