import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ConfigDocumentClient } from "../src/configDocument.js";
import { consumerConfigKey, type ConfigConsumerIdentity } from "../src/configConsumer.js";
import type { DeploymentProfile, WorkerKind } from "../src/deploy/profile.js";
import { WORKER_DIRS, workersFor } from "../src/deploy/plan.js";
import {
  initializeStaging,
  nativeInventoryRows,
  initialMemoryConfig,
  hasFullMemoryBindings,
} from "../src/deploy/stagingBootstrap.js";
import { renderWorkerConfigs } from "../src/deploy/wranglerTemplate.js";
import { parseManifest, planSecretPuts } from "../src/deploy/secrets.js";
import {
  defaultSandboxGateDeps,
  publishedImagesOnHost,
  prepareConfigPublication,
  publishConfigPublication,
  confirmConsumerConfigPublication,
  waitUntilBotLive,
  waitUntilSandboxLive,
  type ConfigRead,
} from "../src/deploy/run.js";
import {
  memoryResourcesHash,
  memoryReceiptSelection,
  memoryDomainId,
  parseMemoryCreationReceipt,
  validateMemoryReceipt,
  type MemoryCreationReceipt,
} from "../src/deploy/stagingMemoryReceipt.js";
import { MINUTE_MS } from "../src/core/budgets.js";
import { RUN_STORE_KEY } from "../src/core/runStoreConstants.js";
import { LIVE_GATE_POLL_MS, LIVE_GATE_DEADLINE_MS, servedCommit } from "../src/deploy/liveGate.js";

/** First installation only: native absence replaces update preconditions, never a failed health read. */
export async function initializeOnHost(
  profile: DeploymentProfile,
  read: Extract<ConfigRead, { ok: true }>,
  options: { receiptPath?: string; resumeMemory?: string } = {},
) {
  const run = (cmd: string, args: string[], cwd = process.cwd(), env = process.env, capture = false) => {
    const result = spawnSync(cmd, args, {
      cwd,
      env,
      stdio: capture ? "pipe" : "inherit",
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (capture) {
      process.stdout.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    if (result.status !== 0) throw new Error(`${cmd} ${args[0]} failed; inspect the completed phases before any retry`);
    return result.stdout ?? "";
  };
  const git = (args: string[]) => {
    const r = spawnSync("git", args, { encoding: "utf8" });
    if (r.status !== 0) throw new Error("publishing checkout is unreadable");
    return r.stdout.trim();
  };
  if (git(["status", "--porcelain"])) throw new Error("first installation requires a clean checkout");
  const commit = git(["rev-parse", "HEAD"]);
  const identity: ConfigConsumerIdentity = { commit };
  const key = consumerConfigKey(identity);
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!token || process.env.SWITCHBOARD_DEPLOY_FORCE)
    throw new Error("first installation requires its staging token and refuses force");
  const source = profile.secretsSource?.replace(/^~\//, `${homedir()}/`);
  if (!source || source.includes("://") || !source.includes("staging"))
    throw new Error("first installation requires a staging secret directory");
  const manifest = parseManifest(JSON.parse(readFileSync("deploy/secrets.manifest.json", "utf8")));
  if (!manifest.ok) throw new Error(manifest.problems.join("\n"));
  const values: Record<string, string> = {};
  for (const secret of manifest.manifest.secrets) {
    try {
      values[secret.name] = readFileSync(join(source, secret.name), "utf8").trim();
    } catch {
      /* Optional names may be absent. */
    }
  }
  const required = [
    "OPENAI_API_KEY",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "SWITCHBOARD_INGRESS_TOKENS",
    "RESIDENT_OPERATOR_TOKEN",
    "RESIDENT_ADMIN_TOKEN",
    "MCP_CREDENTIAL_KEY",
    "ARTIFACTS_COPY_TOKEN",
    "ARTIFACTS_R2_ACCESS_KEY_ID",
    "ARTIFACTS_R2_SECRET_ACCESS_KEY",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
  ];
  for (const worker of ["memory", "bot", "resident", "sandbox"] as const) {
    const p = planSecretPuts(manifest.manifest, worker, new Set(Object.keys(values).filter((n) => values[n])));
    if (!p.ok) throw new Error(p.problem);
    required.push(...p.plan.missing);
  }
  const missing = [...new Set(required)].filter((n) => !values[n]);
  if (missing.length) throw new Error(`first installation missing credentials: ${missing.join(", ")}`);
  if (process.env.MEMORY_TOKEN !== values.MEMORY_TOKEN || process.env.SANDBOX_TOKEN !== values.SANDBOX_TOKEN)
    throw new Error("operator bearer values must match the staging secret directory");
  const receiptPath = options.receiptPath ?? options.resumeMemory ?? join(source, "INITIALIZE_MEMORY_RECEIPT.json");
  let memoryReceipt: MemoryCreationReceipt | undefined;
  if (options.resumeMemory) {
    try {
      memoryReceipt = parseMemoryCreationReceipt(JSON.parse(readFileSync(options.resumeMemory, "utf8")));
    } catch {
      throw new Error("provisional Memory receipt is unreadable or invalid");
    }
  } else if (existsSync(receiptPath))
    throw new Error("initialization receipt already exists; inspect it before further action");
  let memoryUploadVersion: string | undefined;
  const memoryToken = process.env.MEMORY_TOKEN!;
  const ingress = JSON.parse(values.SWITCHBOARD_INGRESS_TOKENS) as Record<string, { subject?: string }>;
  const deployers = Object.entries(ingress).filter(([, actor]) => actor?.subject === profile.restart?.deployer);
  if (!profile.restart?.deployer || deployers.length !== 1)
    throw new Error("first installation requires one bearer for the profile's restart deployer");
  const restartToken = deployers[0][0];
  run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  const published = await publishedImagesOnHost();
  if (!published.ok) throw new Error(published.problem);
  const rendered = renderWorkerConfigs(profile, (path) => readFileSync(path, "utf8"), published.images);
  if (!rendered.ok) throw new Error(rendered.problems.join("\n"));
  const directory = mkdtempSync(join(tmpdir(), "switchboard-initialize-"));
  const operation = basename(directory);
  const nativeConfig = join(directory, "account.json");
  writeFileSync(nativeConfig, JSON.stringify({ account_id: profile.account }), { mode: 0o600 });
  const configs: Partial<Record<WorkerKind, string>> = {};
  const provisional = join(WORKER_DIRS.memory, `.wrangler-plan-${operation}.jsonc`);
  const workers = workersFor(profile);
  const memoryUrl = `https://${profile.workers.memory!.hostname}`;
  const client = new ConfigDocumentClient({ baseUrl: memoryUrl, token: memoryToken });
  let publication: Awaited<ReturnType<typeof prepareConfigPublication>> | undefined;
  const io = { log: console.log, warn: console.warn, stream: (line: string) => process.stdout.write(line) };
  const deps = {
    ...defaultSandboxGateDeps,
    readAppState: (dir: string, app: string) => defaultSandboxGateDeps.readAppState(dir, app, nativeConfig),
    readInstances: (dir: string, app: string) => defaultSandboxGateDeps.readInstances(dir, app, nativeConfig),
  };
  interface MemoryNativeResult {
    id?: string;
    status?: string;
    metadata?: { author_id?: string };
    resources?: unknown;
    deployments?: { id?: string; versions?: { version_id?: string; percentage?: number }[] }[];
  }
  const nativeResult = async (path: string): Promise<MemoryNativeResult> => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${profile.account}/${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(MINUTE_MS),
    });
    if (!response.ok) throw new Error("Memory receipt native read failed");
    const body = (await response.json()) as { success?: boolean; result?: unknown };
    if (body.success !== true || !body.result || typeof body.result !== "object")
      throw new Error("Memory receipt native read is incomplete");
    return body.result as MemoryNativeResult;
  };
  const memoryScriptPath = `workers/scripts/${profile.workers.memory!.script}`;
  const memorySelection = memoryReceiptSelection(profile);
  const waitBuild = async (kind: WorkerKind, expected: string) => {
    const worker = workers.find((w) => w.name === kind)!;
    const started = deps.now();
    for (;;) {
      const health = await deps.readHealth(
        worker.healthUrl,
        worker.healthBearerEnv ? values[worker.healthBearerEnv] : undefined,
      );
      if (!("error" in health) && health.status === 200 && health.body && servedCommit(health.body) === expected)
        return;
      if (deps.now() - started >= LIVE_GATE_DEADLINE_MS)
        throw new Error(`${kind} has not served the exact initial commit; retain its receipt`);
      await deps.sleep(LIVE_GATE_POLL_MS);
    }
  };
  const checkMemory = async (receipt: MemoryCreationReceipt) => {
    const writer = await nativeResult("tokens/verify");
    if (writer.status !== "active" || writer.id !== receipt.authorId)
      throw new Error("Memory receipt does not belong to the current deployment credential");
    const history = await nativeResult(`${memoryScriptPath}/deployments`);
    const [upload, active, domains] = await Promise.all([
      nativeResult(`${memoryScriptPath}/versions/${receipt.uploadVersion}`),
      nativeResult(`${memoryScriptPath}/versions/${receipt.activeVersion}`),
      inventory("workers/domains"),
    ]);
    validateMemoryReceipt(receipt, memorySelection, history.deployments?.[0], upload, active, domains);
  };
  const inventory = async (path: string) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${profile.account}/${path}?per_page=100`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(MINUTE_MS),
      },
    );
    if (!response.ok) throw new Error(`native inventory ${path}: HTTP ${response.status}`);
    return nativeInventoryRows(await response.json());
  };
  try {
    for (const file of rendered.files) {
      const path = join(dirname(file.path), `.wrangler-plan-${operation}.jsonc`);
      writeFileSync(path, file.text, { flag: "wx", mode: 0o600 });
      configs[file.kind] = path;
    }
    // This is a new render for an explicit creation phase, not an edited installation config.
    const memory = initialMemoryConfig(rendered.files.find((f) => f.kind === "memory")!.text);
    const provisionalPath = provisional.replace(".jsonc", "-provisional.jsonc");
    writeFileSync(provisionalPath, memory, { flag: "wx", mode: 0o600 });
    const created: Partial<Record<WorkerKind, string>> = {};
    let fullMemory = false;
    const result = await initializeStaging(commit, {
      ...(options.resumeMemory
        ? {
            resumeMemory: async () => {
              if (!memoryReceipt) throw new Error("Memory receipt unavailable");
              await checkMemory(memoryReceipt);
              await waitBuild("memory", memoryReceipt.commit);
              const [legacy, target] = await Promise.all([client.readBase("base"), client.readBase(key)]);
              if (!legacy.ok || !target.ok || legacy.version !== 0 || target.version !== 0)
                throw new Error("Memory continuation requires empty legacy and candidate config slots");
            },
          }
        : {}),
      absent: async (kinds) => {
        const lists = await Promise.all([
          inventory("workers/scripts"),
          inventory("containers/applications"),
          inventory("workers/durable_objects/namespaces"),
          inventory("workflows"),
        ]);
        for (const [index, rows] of lists.entries()) {
          const field = index === 0 ? "id" : "name";
          if (
            rows.some(
              (r) =>
                typeof r[field] !== "string" ||
                !(r[field] as string).trim() ||
                (index === 2 && typeof r.script !== "string"),
            )
          )
            throw new Error("native inventory has unnamed resources");
          for (const kind of kinds) {
            const script = profile.workers[kind]!.script;
            const application = `${script}-${kind === "bot" ? "switchboardserver" : kind === "resident" ? "residentdo" : "switchboardsandbox"}`;
            const workflow =
              kind === "bot" ? `${script}-ship-coordinator` : kind === "resident" ? `${script}-refresh` : undefined;
            if (
              rows.some((r) =>
                index === 0
                  ? r.id === script
                  : index === 1
                    ? kind !== "memory" && r.name === application
                    : index === 2
                      ? r.script === script || (r.name as string).startsWith(`${script}_`)
                      : r.name === workflow || r.script_name === script,
              )
            )
              throw new Error(`${kind} already exists; first installation refuses partial or installed resources`);
          }
        }
      },
      upload: async (kind, temporary) => {
        if (git(["rev-parse", "HEAD"]) !== commit || git(["status", "--porcelain"]))
          throw new Error("publishing checkout changed");
        if (kind === "memory" && !temporary && memoryReceipt) await checkMemory(memoryReceipt);
        const config = temporary ? provisionalPath : configs[kind]!;
        const cwd = join(process.cwd(), WORKER_DIRS[kind]);
        const env: NodeJS.ProcessEnv = { ...process.env, SWITCHBOARD_DEPLOY_CONFIG: join(process.cwd(), config) };
        delete env.CLOUDFLARE_ACCOUNT_ID;
        // Update preflights require an installed serving process. This creation path has just proven native absence.
        if (kind === "bot") {
          run("node", ["ensure-bucket.mjs"], cwd, env);
          run("node", ["write-build.mjs"], cwd, env);
          run("npx", ["wrangler", "deploy", "--config", env.SWITCHBOARD_DEPLOY_CONFIG!], cwd, env);
        } else {
          const output = run(
            "node",
            ["../bin/build-stamp.mjs", "--config", env.SWITCHBOARD_DEPLOY_CONFIG!],
            cwd,
            env,
            kind === "memory",
          );
          if (kind === "memory" && temporary) {
            memoryUploadVersion = output.match(/Current Version ID:\s*([a-f0-9-]{36})/)?.[1];
            if (!memoryUploadVersion) throw new Error("Memory upload receipt is unavailable; do not replay");
          }
        }
        created[kind] = config;
        if (kind === "memory" && !temporary) fullMemory = true;
      },
      provision: async (kind) => {
        const secrets = Object.fromEntries(
          manifest.manifest.secrets
            .filter((s) => s.workers.includes(kind) && values[s.name])
            .map((s) => [s.name, values[s.name]]),
        );
        const path = join(directory, `${kind}-secrets.json`);
        writeFileSync(path, JSON.stringify(secrets), { mode: 0o600 });
        run(
          "npx",
          ["wrangler", "secret", "bulk", path, "--config", join(process.cwd(), created[kind]!)],
          join(process.cwd(), WORKER_DIRS[kind]),
        );
        rmSync(path);
        if (kind === "memory") {
          if (!memoryUploadVersion) throw new Error("Memory accepted upload identity is unavailable");
          const history = await nativeResult(`${memoryScriptPath}/deployments`);
          const activeVersion = history.deployments?.[0]?.versions?.[0]?.version_id;
          if (typeof activeVersion !== "string") throw new Error("Memory active version unavailable");
          const [upload, active, domains] = await Promise.all([
            nativeResult(`${memoryScriptPath}/versions/${memoryUploadVersion}`),
            nativeResult(`${memoryScriptPath}/versions/${activeVersion}`),
            inventory("workers/domains"),
          ]);
          memoryReceipt = {
            schema: 1,
            ...memorySelection,
            commit,
            uploadVersion: memoryUploadVersion,
            activeVersion,
            deploymentId: history.deployments?.[0]?.id ?? "",
            domainId: memoryDomainId(memorySelection, domains),
            authorId: upload.metadata?.author_id ?? "",
            resourcesHash: memoryResourcesHash(upload.resources),
          };
          memoryReceipt = parseMemoryCreationReceipt(memoryReceipt);
          validateMemoryReceipt(memoryReceipt, memorySelection, history.deployments?.[0], upload, active, domains);
          await checkMemory(memoryReceipt);
          writeFileSync(receiptPath, JSON.stringify(memoryReceipt), { flag: "wx", mode: 0o600 });
          console.log(`Private provisional Memory receipt: ${receiptPath}`);
        }
      },
      restartBot: async () => {
        // A cron or request may have started the new container before bulk secrets arrived.
        // The existing deployment-side route works even on the refusal-only server and uses no force.
        const response = await fetch(`https://${profile.workers.bot.hostname}/admin/restart`, {
          method: "POST",
          headers: { authorization: `Bearer ${restartToken}`, "content-type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(MINUTE_MS),
        });
        const result = (await response.json()) as { ok?: boolean; stopping?: boolean; forced?: boolean };
        if (
          ![200, 202].includes(response.status) ||
          result.ok !== true ||
          typeof result.stopping !== "boolean" ||
          result.forced === true
        )
          throw new Error("initial Bot secret activation restart is unconfirmed; inspect before retry");
      },
      prepare: async () => {
        if (!memoryReceipt) throw new Error("Memory receipt unavailable before config publication");
        await checkMemory(memoryReceipt);
        const legacy = await client.readBase("base");
        if (!legacy.ok) throw new Error(legacy.problem);
        if (legacy.version !== 0 || legacy.document) throw new Error("legacy configuration is not empty");
        publication = await prepareConfigPublication(read, {
          stateWorkerUrl: memoryUrl,
          key,
          consumer: identity,
          inputSourceKey: "base",
          env: process.env,
          onSnapshot: (id) => console.log(`Private initialization snapshot: ${id}`),
        });
        if (!publication.ok) throw new Error(publication.problem);
        const captured = publication.publication;
        return {
          key,
          priorVersion: captured.prior.version,
          legacyVersion: captured.inputSource!.version,
          send: async () => {
            const sent = await publishConfigPublication(captured, { env: process.env });
            if (!sent.ok) throw new Error(`initial config: ${sent.problem}; write=${sent.write}; do not retry`);
          },
        };
      },
      admission: async (phase) => {
        const response = await fetch(`${memoryUrl}/plane/deploy`, {
          method: "POST",
          headers: { authorization: `Bearer ${memoryToken}`, "content-type": "application/json" },
          body: JSON.stringify({ storeKey: RUN_STORE_KEY, phase, version: commit }),
          signal: AbortSignal.timeout(MINUTE_MS),
        });
        if (!response.ok) throw new Error(`initial deploy window ${phase}: HTTP ${response.status}`);
        const acknowledged = (await response.json()) as { ok?: boolean };
        if (acknowledged.ok !== true) throw new Error(`initial deploy window ${phase} acknowledgment is uncertain`);
      },
      verify: async (kind) => {
        const worker = workers.find((w) => w.name === kind)!;
        if (kind === "bot" && worker.liveGate?.kind === "bot") {
          const ready = await waitUntilBotLive({ name: "bot", dir: worker.dir }, worker.liveGate, commit, io, deps);
          if (!ready.live) throw new Error(ready.reason);
          if (!publication?.ok) throw new Error("initial config publication is unavailable");
          const [health, app, instances] = await Promise.all([
            deps.readHealth(worker.healthUrl),
            deps.readAppState(worker.dir, worker.liveGate.containerApp),
            deps.readInstances(worker.dir, worker.liveGate.containerApp),
          ]);
          const confirmed = await confirmConsumerConfigPublication(
            publication.publication,
            identity,
            health,
            app,
            instances,
            (slot) => client.readBase(slot),
          );
          const canonical = await client.readBase(key);
          if (
            !confirmed.ok ||
            !canonical.ok ||
            canonical.version !== 1 ||
            canonical.document?.sha256 !== publication.publication.candidate.sha256
          )
            throw new Error("initial Bot did not install the exact canonical configuration");
        } else if (kind === "sandbox" && worker.liveGate?.kind === "sandbox") {
          const ready = await waitUntilSandboxLive(
            { name: "sandbox", dir: worker.dir },
            worker.liveGate,
            commit,
            { before: { error: "native absence proved before creation" }, target: null },
            io,
            deps,
          );
          if (!ready.live) throw new Error(ready.reason);
        } else {
          await waitBuild(kind, kind === "memory" && !fullMemory && memoryReceipt ? memoryReceipt.commit : commit);
        }
        console.log(`Initial ${kind}: exact commit ${commit} verified`);
        if (kind === "memory" && fullMemory) {
          if (
            !memoryReceipt ||
            memoryDomainId(memorySelection, await inventory("workers/domains")) !== memoryReceipt.domainId
          )
            throw new Error("final Memory hostname ownership changed");
          const canonical = await client.readBase(key);
          if (
            !publication?.ok ||
            !canonical.ok ||
            canonical.version !== 1 ||
            canonical.document?.sha256 !== publication.publication.candidate.sha256
          )
            throw new Error("final Memory does not retain the exact candidate configuration");
          const response = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${profile.account}/workers/scripts/${profile.workers.memory!.script}/settings`,
            {
              headers: { authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(MINUTE_MS),
            },
          );
          if (!response.ok) throw new Error("final Memory bindings are unreadable");
          const settings = (await response.json()) as { success?: boolean; result?: { bindings?: unknown } };
          if (
            settings.success !== true ||
            !hasFullMemoryBindings(settings.result?.bindings, profile.workers.bot.script)
          )
            throw new Error("final Memory Bot/Workflow bindings are incomplete");
        }
      },
    });
    console.log(JSON.stringify(result));
  } finally {
    for (const path of Object.values(configs)) rmSync(path, { force: true });
    rmSync(provisional.replace(".jsonc", "-provisional.jsonc"), { force: true });
    rmSync(directory, { recursive: true, force: true });
  }
}
