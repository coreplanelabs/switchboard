import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { MODEL_CAPACITY_BENCHMARK } from "../src/core/budgets.js";
import { modelCapacityWorkload, compareModelCapacity, type ModelCapacityReceipt } from "../src/load/modelCapacity.js";
import { systemClock } from "../src/core/trace/clock.js";

export function modelCapacityCommand(flags: Record<string, string | boolean | undefined>, results: string): number {
  for (const key of Object.keys(flags))
    if (!["profile", "image", "platform", "cpu", "memory-mib", "baseline"].includes(key))
      throw new Error(`model-capacity: unknown flag --${key}`);
  const profile = typeof flags.profile === "string" ? flags.profile : "team";
  modelCapacityWorkload(profile);
  const type = /"instance_type":\s*"([^"]+)"/.exec(
    readFileSync("deploy/cloudflare/wrangler.template.jsonc", "utf8"),
  )?.[1];
  const sizing: Record<string, { cpu: number; memoryMiB: number }> = {
    "standard-1": { cpu: 0.5, memoryMiB: 4096 },
    "standard-2": { cpu: 1, memoryMiB: 6144 },
    "standard-3": { cpu: 2, memoryMiB: 8192 },
    "standard-4": { cpu: 4, memoryMiB: 12288 },
  };
  if (!type || !sizing[type])
    throw new Error("model-capacity: unknown bot type; update its explicit CPU/memory mapping");
  const cpu = Number(flags.cpu ?? sizing[type].cpu),
    memoryMiB = Number(flags["memory-mib"] ?? sizing[type].memoryMiB);
  if (!Number.isFinite(cpu) || cpu <= 0 || !Number.isInteger(memoryMiB) || memoryMiB <= 0)
    throw new Error("model-capacity: positive CPU and memory limits are required");
  const platform = String(flags.platform ?? "linux/amd64");
  if (!["linux/amd64", "linux/arm64"].includes(platform))
    throw new Error("model-capacity: platform must be linux/amd64 or linux/arm64");
  const baseline =
    typeof flags.baseline === "string"
      ? (JSON.parse(readFileSync(flags.baseline, "utf8")) as ModelCapacityReceipt)
      : undefined;
  if (baseline && baseline.schemaVersion !== "model-capacity/1")
    throw new Error("model-capacity: unsupported baseline receipt");
  const runtimeImage = /^FROM\s+(node:\S+)/m.exec(readFileSync("Dockerfile", "utf8"))?.[1];
  if (!runtimeImage) throw new Error("model-capacity: Dockerfile does not name a pinned Node runtime");
  const image = String(
    flags.image ?? (baseline?.environment as { imageReference?: string } | undefined)?.imageReference ?? runtimeImage,
  );
  const imageInfo = execFileSync(
    "docker",
    ["image", "inspect", "--platform", platform, image, "--format", "{{.Id}} {{.Architecture}}"],
    {
      encoding: "utf8",
    },
  )
    .trim()
    .split(" ");
  const arch = platform.split("/")[1];
  if (imageInfo[1] !== arch)
    throw new Error(
      `model-capacity: cached image is ${imageInfo[1]}, requested ${arch}; pull a matching image explicitly`,
    );
  execFileSync("npm", ["run", "build"], { stdio: ["ignore", "ignore", "inherit"] });
  const args = [
    "run",
    "--rm",
    "--pull=never",
    "--platform",
    platform,
    `--cpus=${cpu}`,
    `--memory=${memoryMiB}m`,
    `--memory-swap=${memoryMiB}m`,
    "--network",
    "none",
  ];
  for (const path of ["dist", "node_modules", "package.json", "project.json", "deploy/secrets.manifest.json"])
    args.push("--mount", `type=bind,src=${resolve(path)},dst=/app/${path},readonly`);
  args.push(
    "--workdir",
    "/app",
    "--entrypoint",
    "node",
    image,
    "/app/dist/load/modelCapacity.js",
    "--model-capacity-child",
    profile,
  );
  const paths = [
    "src/core/budgets.ts",
    "src/channels/modelProxy.ts",
    "src/channels/modelProxyResponses.ts",
    "src/channels/responsesConsumer.ts",
    "src/channels/responsesConsumerWorker.ts",
    "src/channels/responsesResources.ts",
    "src/channels/responsesValidationCapacity.ts",
    "src/load/modelCapacity.ts",
    "scripts/model-capacity.ts",
    "package-lock.json",
    "Dockerfile",
    "deploy/cloudflare/wrangler.template.jsonc",
  ];
  const files = Object.fromEntries(
    paths.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
  const source = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "",
    fingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    files,
  };
  const child = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: MODEL_CAPACITY_BENCHMARK.deadlineMs + MODEL_CAPACITY_BENCHMARK.settleMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!child.stdout) {
    mkdirSync(results, { recursive: true });
    const stem = resolve(
      results,
      `model-capacity-${profile}-${new Date(systemClock()).toISOString().replace(/[-:.]/g, "")}`,
    );
    writeFileSync(
      `${stem}.json`,
      JSON.stringify(
        {
          schemaVersion: "model-capacity-failure/1",
          passed: false,
          scope: "benchmark process did not return a complete receipt",
          source,
          workload: modelCapacityWorkload(profile),
          requested: { image, platform, cpu, memoryMiB },
          failure: { status: child.status, signal: child.signal, code: child.error?.name },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    console.log(`model-capacity FAIL: ${stem}.json (no complete receipt)`);
    return 1;
  }
  const measured = JSON.parse(child.stdout) as ModelCapacityReceipt;
  const stable = paths.every((path) => files[path] === createHash("sha256").update(readFileSync(path)).digest("hex"));
  const receipt = {
    ...measured,
    passed: measured.passed && stable,
    checks: [...measured.checks, { name: "measured source stayed unchanged", pass: stable }],
    source,
    environment: {
      ...measured.environment,
      imageId: imageInfo[0],
      imageReference: image,
      hostArch: process.arch,
      hostCpu: cpus()[0]?.model,
      emulated: process.arch !== measured.environment.arch,
    },
  };
  const comparison = baseline ? compareModelCapacity(receipt, baseline) : undefined;
  const output = { ...receipt, ...(comparison ? { comparison } : {}) };
  mkdirSync(results, { recursive: true });
  const stem = resolve(
    results,
    `model-capacity-${profile}-${new Date(systemClock()).toISOString().replace(/[-:.]/g, "")}`,
  );
  writeFileSync(`${stem}.json`, JSON.stringify(output, null, 2) + "\n", { flag: "wx" });
  const markdown =
    `# Model capacity: ${profile}\n\n${receipt.scope}\n\nRevision: ${source.revision}; dirty: ${source.dirty}; fingerprint: ${source.fingerprint}.\n\n` +
    `Settings: ${receipt.settings.workers} active / ${receipt.settings.queued} queued / ${receipt.settings.parsers} parsing; queue wait ${receipt.settings.queueWaitMs}ms.\n\n` +
    `Workload: ${receipt.workload.clients} callers × ${receipt.workload.turns} calls, ${receipt.workload.requestKiB}KiB requests, ${receipt.workload.frameKiB}KiB frames, ${receipt.workload.providerDelayMs}ms synthetic provider delay.\n\n` +
    `Runtime: ${receipt.environment.node}, ${receipt.environment.arch}, CPU quota ${receipt.environment.cpuMax}, memory limit ${receipt.environment.memoryMax}, held baseline ${receipt.environment.heldBaselineMiB}MiB; emulated: ${receipt.environment.emulated}.\n\n` +
    `Result: ${receipt.passed ? "PASS" : "FAIL"}; ${receipt.metrics.exact}/${receipt.metrics.calls} exact responses, peak ${receipt.metrics.peakActive} active / ${receipt.metrics.peakQueued} queued; call p95 ${receipt.metrics.callMs.p95.toFixed(2)}ms, health p95 ${receipt.metrics.healthMs.p95.toFixed(2)}ms, cgroup peak ${receipt.metrics.cgroupPeakMiB?.toFixed(2)}MiB.\n\n` +
    receipt.checks.map((check) => `- ${check.pass ? "PASS" : "FAIL"}: ${check.name}`).join("\n") +
    "\n\n" +
    receipt.limitations.join("\n\n") +
    (comparison ? `\n\nComparison: ${JSON.stringify(comparison)}` : "") +
    "\n";
  writeFileSync(`${stem}.md`, markdown, { flag: "wx" });
  console.log(`model-capacity ${receipt.passed ? "PASS" : "FAIL"}: ${stem}.json\n${stem}.md`);
  if (comparison) console.log(JSON.stringify(comparison));
  return child.status === 0 && receipt.passed ? 0 : 1;
}
