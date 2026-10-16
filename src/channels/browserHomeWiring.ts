import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { conversationRetentionFor } from "../config.js";
import type { ConfigStore } from "../config.js";
import { authorize } from "../core/authz/authorize.js";
import { matchesPredicate } from "../core/authz/predicate.js";
import type { Actor } from "../core/authz/types.js";
import type { CommandInvoker } from "../core/commandRegistry.js";
import { dispatch, dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import type { RunLedger } from "../core/runLedger/ledger.js";
import type { RunsService } from "../core/runsService.js";
import type { OrganizationExecutionRequest } from "../core/organization/runtime.js";
import type { OrganizationAdmissionInput, OrganizationMapping } from "../core/organization/service.js";
import type { OrganizationLimits, OrganizationResult, SourceDeletionAddress } from "../core/organization/contract.js";
import type { IngressConfig, OrganizationIngress } from "./http.js";
import { connectionIdentity } from "./mcpApproval.js";
import { SingleShotIO } from "./singleShotDispatch.js";
import type { Confirmation } from "../core/confirmations.js";
import type { PersonalTokenStore } from "../mcp/personalTokens.js";
import type { AccessConfig, AccessIdentity } from "./accessAuth.js";
import type { DashboardVerifier } from "./dashboardAuth.js";
import type { HomeRuntimeContext } from "./homeRuntime.js";
import { withChatActor } from "../core/authz/actor.js";
import { withOriginalOrganizationDispatch } from "../core/dispatch/originalOrganizationInput.js";
import type { ResumableRun } from "../core/boot.js";
import type { IncomingMessage as CoreMessage } from "../core/types.js";
import type { ChannelIO, SlackDirectAudience } from "../core/types.js";
import { createLegacySlackAudience } from "./legacySlackAudience.js";
import { identityKey } from "../core/identity/engine.js";
import type { IdentityNotice } from "../core/identity/linkContract.js";
import { WorkerOrganizationStore } from "../core/organization/worker.js";
import { createHomeRepositories } from "./homeRepositories.js";
import { createOriginalUnitRecipient } from "./originalUnitRecipient.js";
import { createBrowserHomeInstallation, type BrowserHomeInstallationOptions } from "./browserHomeInstallation.js";
import { createOrganizationAuthentication } from "./organizationAuthentication.js";
import { createOrganizationNativeSources, type OrganizationNativeSourcesOptions } from "./organizationNativeSources.js";
import { createIdentityRuntime } from "./identityRuntime.js";
import { FileEmojiStore, createSlackEmojiCache } from "./slackEmoji.js";
import type { PageSender } from "./webShell.js";
import type { PageSeed, ViewablePerson } from "./webSeed.js";
import { readableRuns } from "./liveView/viewer.js";
import { accessActor, resolveAccessActor } from "./commandHttp.js";
import { isServiceToken } from "./accessAuth.js";
import { holdsAll } from "../core/authz/viewAs.js";
import {
  hasWorkViewScope,
  resolveWorkViewScope,
  withWorkViewScope,
  workViewScopeOf,
  workViewModeFromCookie,
} from "./workViewScope.js";
import { viewAsFromCookie } from "./viewAs.js";
import { WebIO, turnsOf, historyOf } from "./web.js";
import { retentionPolicyOf } from "../core/runStore.js";
import { DAY_MS, ORG_RECONCILE_BATCH_MAX } from "../core/budgets.js";
import { LEASE_MS } from "../core/runLedger/types.js";
import { parseUnitKey } from "../core/coordinator/contract.js";
import type { UnitEventKey } from "../core/coordinator/instanceStore.js";

type OriginalBinding = NonNullable<Awaited<ReturnType<ReturnType<typeof createBrowserHomeWiring>["originalBinding"]>>>;

/** Completed intake does not mean a canonical hosted pipeline has finished. */
export function canRestoreOrganizationRun(run: ResumableRun, source: OriginalBinding | undefined): boolean {
  return (
    run.row.meta.organizationIngressRunId === run.row.runId &&
    !!source?.io.authoritativePrivateHistory &&
    source.runId === run.row.runId &&
    (source.originalStatus !== "completed" || run.kind === "rehost")
  );
}

/** A hosted card has no new request, but still uses its freshly guarded sink. */
export function organizationResumeIo(source: OriginalBinding, request?: CoreMessage): ChannelIO | undefined {
  if (request)
    Object.assign(
      request,
      withOriginalOrganizationDispatch(withChatActor(request, source.actor), {
        ingressRunId: source.runId,
        organizationSequence: source.receipt.revision,
        ...(source.envelope.sourceReference?.sourceRepository
          ? { organizationRepo: source.envelope.sourceReference.sourceRepository }
          : {}),
      }),
    );
  return source.io;
}

export interface BrowserHomeWiringOptions {
  config: ConfigStore;
  dashboard: DashboardVerifier;
  access: AccessConfig | null;
  slack: OrganizationNativeSourcesOptions["slack"] & {
    emoji: { list(): Promise<{ ok?: boolean; emoji?: Record<string, string> }> };
  };
  team(): Promise<string | undefined>;
  ledger: RunLedger | null;
  core: CoreDeps;
  runs: RunsService;
  commands: CommandInvoker;
  auth(): IngressConfig;
  personalTokens: PersonalTokenStore;
  readSecret(name: string): string | undefined;
  emojiDirectory: string;
  page: PageSender;
  people(): readonly ViewablePerson[];
  channelsOf(actorId: string): Promise<ReadonlySet<string> | "unknown">;
  now(): number;
  owner: string;
  limits: OrganizationLimits;
  privateWorkerLog?: Parameters<typeof createBrowserHomeInstallation>[0]["privateWorkerLog"];
  mergeLogin?: Parameters<typeof createBrowserHomeInstallation>[0]["mergeLogin"];
  mergeFacts?: Parameters<typeof createBrowserHomeInstallation>[0]["mergeFacts"];
  materializeNativeMedia?: BrowserHomeInstallationOptions["materializeNativeMedia"];
  launch(task: () => Promise<void>): void;
  nativeIo?(request: Omit<OrganizationExecutionRequest, "io">): ChannelIO | undefined;
  legacySlackIo?(audience: SlackDirectAudience): ChannelIO | undefined;
  deliverIdentityNotice?(notice: IdentityNotice): Promise<boolean>;
  publicBaseUrl?: string;
}
/** Durable/native readiness is separate from HTTP health readiness. */
export function createBrowserHomeWiring(options: BrowserHomeWiringOptions) {
  const org = options.config.config.organization;
  const repositoryChoices = options.core.githubApi
    ? createHomeRepositories({ config: options.config, github: options.core.githubApi })
    : undefined;
  const emoji = createSlackEmojiCache({ store: new FileEmojiStore(options.emojiDirectory) });
  let installation: ReturnType<typeof createBrowserHomeInstallation> | undefined;
  let native: ReturnType<typeof createOrganizationNativeSources> | undefined;
  let authentication: ReturnType<typeof createOrganizationAuthentication> | undefined;
  let identity: ReturnType<typeof createIdentityRuntime> | undefined;
  let legacyAudience: ReturnType<typeof createLegacySlackAudience> | undefined;
  const unavailable = "Organization storage or current source proof is unavailable.";
  const sourceId = (id: { issuer: string; tenant: string | null; subject: string }, team: string) =>
    native && id.issuer === native.browserIssuer && id.tenant === null
      ? `access:${id.subject}`
      : id.issuer === "https://slack.com" && id.tenant === team
        ? `slack:${id.subject}`
        : undefined;
  let slackTeam = "";
  const mappings: OrganizationMapping[] = [];
  let refreshingSources: Promise<void> | undefined;
  async function refreshNativeSources() {
    if (slackTeam) return;
    if (refreshingSources) return refreshingSources;
    const refresh = (async () => {
      const configured = options.config.config.dashboard?.identityLink?.slackTeamId;
      const verified = configured ?? (await options.team().catch(() => undefined));
      if (!verified || slackTeam) return;
      slackTeam = verified;
      if (native) mappings.push({ source: "slack", issuer: "https://slack.com", tenant: slackTeam, organization: org });
    })();
    refreshingSources = refresh;
    try {
      await refresh;
    } finally {
      refreshingSources = undefined;
    }
  }
  const viewerLabels = new WeakMap<Actor, string>();
  async function owners(context: HomeRuntimeContext): Promise<readonly string[]> {
    const selected = context.actor.viewingAs?.id ?? context.actor.id;
    if (!native || !installation) return [selected];
    const selectedIdentity = selected.startsWith("access:")
      ? { issuer: native.browserIssuer, tenant: null, subject: selected.slice(7) }
      : selected.startsWith("slack:")
        ? { issuer: "https://slack.com", tenant: slackTeam, subject: selected.slice(6) }
        : undefined;
    if (!selectedIdentity) return [selected];
    const binding = await installation.organization.resolve({
      source: selected.startsWith("access:") ? "browser" : "slack",
      identity: selectedIdentity,
      kind: "human",
    });
    const directory = await installationStore?.directory.resolve(selectedIdentity);
    if (directory?.status === "unavailable" || directory?.status === "invalid" || directory?.status === "conflict")
      throw new Error("Current identity directory is unavailable.");
    if (!binding || directory?.status !== "bound") return [selected];
    const result = await installationStore!.execute({
      action: "identities",
      organization: org,
      personId: directory.binding.personId,
    });
    if (result.status !== "identities") throw new Error("Current identity directory is unavailable.");
    const ids: string[] = [];
    for (const candidate of result.identities) {
      const peer = await installationStore!.directory.resolve(candidate);
      if (peer.status !== "bound" || peer.binding.personId !== directory.binding.personId) continue;
      const proof =
        candidate.issuer === native.browserIssuer
          ? await native.currentBrowser(candidate)
          : candidate.issuer === "https://slack.com" && candidate.tenant === slackTeam
            ? await native.currentSlack(candidate)
            : undefined;
      const id = sourceId(candidate, slackTeam);
      if (
        proof?.status === "verified" &&
        proof.kind === "human" &&
        proof.organizationMember &&
        id &&
        proof.actorId === id
      )
        ids.push(id);
    }
    return [...new Set([selected, ...ids])];
  }
  let installationStore: WorkerOrganizationStore | undefined;
  async function readProjection(fresh: HomeRuntimeContext, selected?: string): Promise<HomeRuntimeContext> {
    if (
      !selected ||
      fresh.actor.kind !== "user" ||
      !holdsAll(fresh.actor) ||
      !authorize(fresh.actor, "organization:read", { type: "organization", id: org }).allow
    )
      return fresh;
    // The real Access subject is already verified. This rebuilds only the
    // selected person's read ceiling, never their native session or source.
    const projected = await resolveAccessActor(
      { sub: fresh.authentication.identity.subject, viewAs: selected },
      {
        grantsFor: (id) => options.config.grantsFor(id),
        channelsOf: options.channelsOf,
        knownPerson: (id) => options.people().some((person) => person.id === id),
        personName: async (id) => options.people().find((person) => person.id === id)?.name,
      },
    );
    if (projected.id !== fresh.actor.id || !projected.viewingAs) return fresh;
    return {
      ...fresh,
      actor: {
        ...fresh.actor,
        onBehalfOf: projected.onBehalfOf,
        viewingAs: projected.viewingAs,
        asUser: projected.asUser,
      },
    };
  }
  async function attachScope(
    context: HomeRuntimeContext,
    mode: "mine" | "everyone" = "mine",
    originalActor = context.actor,
  ) {
    const ownerIds = await owners(context);
    withWorkViewScope(
      context.actor,
      resolveWorkViewScope(context.actor, { organization: org, ownerIds, mode, originalActor }),
    );
    return context;
  }
  async function canReadContext(
    context: HomeRuntimeContext,
    reference: Parameters<typeof createBrowserHomeInstallation>[0]["canReadContext"] extends (
      context: HomeRuntimeContext,
      reference: infer R,
    ) => unknown
      ? R
      : never,
  ) {
    if (!hasWorkViewScope(context.actor)) await attachScope(context);
    if (reference.kind === "repository")
      return (
        context.authentication.source === "browser" &&
        !!(await repositoryChoices?.authorize(context.actor, reference.key))
      );
    const predicate = readableRuns(context.actor);
    if (reference.kind === "run") {
      const result = await options.runs.getRun(reference.key);
      return result.ok && matchesPredicate(predicate, result.value);
    }
    if (reference.kind === "unit") return (await options.runs.listUnitRuns(reference.key, predicate)).ok;
    if (reference.kind === "pipeline")
      return (await options.runs.listInstanceUnits(reference.key, predicate)).length > 0;
    if (reference.kind === "thread")
      return (
        (await options.runs.listRuns({ status: "all", threadKey: reference.key, visibleTo: predicate, limit: 1 })).runs
          .length > 0
      );
    if (reference.kind === "pull-request") {
      const match = /^([^#]+)#([1-9][0-9]*)$/.exec(reference.key);
      return !!match && (await options.runs.listFindings({ repo: match[1]!, number: Number(match[2]) }, predicate)).ok;
    }
    return false;
  }
  async function sourceRepository(context: HomeRuntimeContext, input: OrganizationAdmissionInput) {
    const selected = input.context.filter((ref) => ref.kind === "repository");
    for (const reference of input.context) {
      if (!(await canReadContext(context, reference))) return;
    }
    if (selected.length) {
      const choices = new Set(selected.map((ref) => ref.key.toLowerCase()));
      if (choices.size !== 1 || context.authentication.source !== "browser") return;
      return repositoryChoices?.sourceChoice(context.actor, { selected: selected[0]!.key });
    }
    const ref = context.authentication.sourceReference;
    const repo = ref ? options.config.scopes(ref.channelId, ref.userId).channel.repo : undefined;
    return repo && options.config.canUseRepo(context.actor, repo) ? repo : undefined;
  }
  const originalBinding = (sourceRunId: string, expected?: { threadKey: string; userId: string }) =>
    installation?.originalBinding(sourceRunId, expected);
  async function originalIO(
    sourceRunId: string,
    expected: { threadKey: string; userId: string; unitKey?: UnitEventKey },
  ): Promise<ChannelIO | undefined> {
    const modern = await installation?.originalAudienceIO(sourceRunId, expected);
    return (
      modern ??
      (expected.unitKey ? legacyAudience?.restore({ ...expected, sourceRunId, unitKey: expected.unitKey }) : undefined)
    );
  }
  async function resolveQuestionRequester(unitKey: string, creditedRequester: string) {
    const key = parseUnitKey(unitKey);
    if (!key || !installation || !authentication || !options.core.coordinatorInstances)
      return { status: "unavailable" as const };
    const [instance, units] = await Promise.all([
      options.core.coordinatorInstances.get(key.instanceId),
      options.core.coordinatorInstances.listUnits(key.instanceId),
    ]);
    const matching = units.filter((row) => row.unit === key.unit);
    if (!instance || matching.length !== 1 || instance.userId !== creditedRequester)
      return { status: "fenced" as const };
    const unit = matching[0]!;
    const sourceRunId = unit.context?.handoff.source?.runId ?? instance.runId;
    if (sourceRunId) {
      const source = await installation.originalRequester(sourceRunId, {
        threadKey: unit.workBrief?.mainThreadKey ?? instance.threadKey,
        userId: instance.userId,
      });
      if (source.status === "resolved") return source;
      if (unit.workBrief && legacyAudience) {
        const legacy = await legacyAudience.recipient({
          sourceRunId,
          unitKey: key,
          threadKey: unit.workBrief.mainThreadKey,
          userId: unit.workBrief.requesterId,
        });
        if (legacy && (await legacy.verify()).ok) return { status: "resolved" as const, actor: legacy.actor };
      }
      if (unit.workBrief || instance.authenticatedAs || instance.postedBy) return source;
    }
    // Older native unit records carry their exact person and channel, but no
    // reusable credential. Resolve that source afresh; never reconstruct grants.
    const owner = await installation.questionOwner(unitKey);
    if (owner.status !== "proved") return { status: "unavailable" as const };
    const reference = owner.sourceReference;
    const source =
      owner.requester.issuer === "https://slack.com"
        ? ("slack" as const)
        : owner.requester.issuer === native?.browserIssuer
          ? ("browser" as const)
          : undefined;
    if (!source || reference.authenticatedAs || reference.postedBy) return { status: "unavailable" as const };
    const resolved = await authentication.resolveNative(
      {
        channelId: reference.channelId,
        userId: reference.userId,
        threadKey: reference.threadKey,
        text: "",
      },
      { source, identity: owner.requester },
    );
    return resolved.status === "resolved"
      ? { status: "resolved" as const, actor: resolved.actor }
      : { status: resolved.status === "fenced" ? ("fenced" as const) : ("unavailable" as const) };
  }

  async function initialize() {
    if (installation) return;
    const cfg = options.config.config.runHistory?.worker;
    const token = cfg ? options.readSecret(cfg.tokenEnv ?? "MEMORY_TOKEN") : undefined;
    if (!cfg || !token || !options.ledger || !options.core.coordinatorInstances) return;
    // An unavailable or slow Slack adapter cannot delay independent sources.
    void refreshNativeSources();
    const store = new WorkerOrganizationStore({ baseUrl: cfg.baseUrl, token, installation: org });
    const check = await store.execute({ action: "get", organization: org });
    if (check.status !== "state") return;
    installationStore = store;
    native = createOrganizationNativeSources({
      organization: org,
      dashboard: options.dashboard,
      access: options.access,
      slack: options.slack,
      slackTeamId: () => slackTeam || undefined,
    });
    mappings.splice(
      0,
      mappings.length,
      { source: "browser" as const, issuer: native.browserIssuer, tenant: null, organization: org },
      { source: "http" as const, issuer: `installation:${org}:http`, tenant: null, organization: org },
      { source: "mcp" as const, issuer: `installation:${org}:mcp`, tenant: null, organization: org },
      { source: "mcp" as const, issuer: native.mcpIssuer, tenant: null, organization: org },
      ...(slackTeam
        ? [{ source: "slack" as const, issuer: "https://slack.com", tenant: slackTeam, organization: org }]
        : []),
    );
    authentication = createOrganizationAuthentication({
      organization: org,
      mappings,
      grantsFor: (id) => options.config.grantsFor(id),
      auth: options.auth,
      personalTokens: options.personalTokens,
      ...(options.access && options.dashboard.mode === "access"
        ? { personalApproval: { issuer: `https://${options.access.teamDomain}`, audience: options.access.aud } }
        : {}),
      directory: store.directory,
      store,
      ledger: options.ledger,
      channelsOf: options.channelsOf,
      currentBrowser: native.currentBrowser,
      currentMcp: native.currentMcp,
      currentSlack: native.currentSlack,
      questionOwner: (key) =>
        installation ? installation.questionOwner(key) : Promise.resolve({ status: "unavailable" }),
    });
    if (options.core.runStore && options.legacySlackIo)
      legacyAudience = createLegacySlackAudience({
        organization: org,
        ledger: options.ledger,
        runs: options.core.runStore,
        instances: options.core.coordinatorInstances,
        authenticate: async (audience) =>
          authentication!.resolveNative(
            {
              channelId: audience.channelId,
              userId: audience.userId,
              threadKey: audience.threadKey,
              text: "",
              directAudience: audience,
            },
            {
              source: "slack",
              identity: {
                issuer: "https://slack.com",
                tenant: slackTeam,
                subject: audience.userId.slice("slack:".length),
              },
            },
          ),
        addressIO: options.legacySlackIo,
      });
    let sourceRecipient!: ReturnType<typeof createOriginalUnitRecipient>;
    installation = createBrowserHomeInstallation({
      organizationId: org,
      store,
      ledger: options.ledger,
      authentication,
      core: options.core,
      runs: options.runs,
      coordinator: options.core.coordinatorInstances,
      privateWorkerLog: options.privateWorkerLog,
      mergeLogin: options.mergeLogin,
      mergeFacts: options.mergeFacts,
      materializeNativeMedia: options.materializeNativeMedia,
      legacyRecipient: async (origin) => await legacyAudience?.recipient(origin),
      originalUnitRecipient: (key) => sourceRecipient.read(key),
      originalUnitRecipientPhase: (groups, phaseAuthentication) =>
        sourceRecipient.metadataPhase(groups, phaseAuthentication),
      commands: options.commands,
      mappings,
      limits: options.limits,
      retention: options.config.config.runHistory
        ? { retentionDays: retentionPolicyOf(options.config.config.runHistory).retentionDays }
        : null,
      intake: { listIntake: (query) => options.ledger!.listIntake(query) },
      owner: options.owner,
      leaseMs: LEASE_MS,
      batchSize: ORG_RECONCILE_BATCH_MAX,
      contentTtlMs: conversationRetentionFor(options.config.config).privateContentDays * DAY_MS,
      sourceSnapshotTtlMs: conversationRetentionFor(options.config.config).sourceSnapshotDays * DAY_MS,
      now: options.now,
      policyEpoch: () =>
        createHash("sha256")
          .update(JSON.stringify([options.config.config.grants ?? {}, options.config.config.restrict ?? {}]))
          .digest("hex"),
      launch: options.launch,
      sourceIo: (request) => {
        if (request.envelope.source !== "browser") {
          const nativeIo = options.nativeIo?.(request);
          if (!nativeIo) throw new Error("The original native transport is unavailable.");
          return nativeIo;
        }
        return new WebIO(
          async () =>
            historyOf(
              (
                await turnsOf(
                  { service: options.runs, registry: options.core.runRegistry ?? { getById: () => null } },
                  request.msg.threadKey,
                  request.actor,
                  { receipts: false },
                )
              ).turns,
            ),
          undefined,
          { threadKey: request.msg.threadKey, undeliverable: "Replies use the organization stream.", log: () => {} },
        );
      },
      canReadContext,
      sourceRepository,
      repositories: async (context) =>
        context.actor.kind === "user" &&
        !context.actor.viewingAs &&
        workViewScopeOf(context.actor).mode !== "person" &&
        repositoryChoices
          ? repositoryChoices.read(context.actor)
          : { status: "unavailable", repositories: [] },
      canWriteThread: async (context) =>
        !context.actor.viewingAs &&
        authorize(context.actor, "steer:write", { type: "command", id: "work.steer" }).allow,
      provedActorIds: owners,
      viewScope: async (context) => workViewScopeOf(context.actor).mode,
      refreshProjection: async (previous, fresh) => {
        if (!authentication) return;
        const originalActor = fresh.actor;
        if (previous.actor.viewingAs) {
          fresh = await readProjection(fresh, previous.actor.viewingAs.id);
          if (fresh.actor.viewingAs?.id !== previous.actor.viewingAs.id) return;
        }
        const label = viewerLabels.get(previous.actor);
        if (label) viewerLabels.set(fresh.actor, label);
        return attachScope(
          fresh,
          workViewScopeOf(previous.actor).mode === "everyone" ? "everyone" : "mine",
          originalActor,
        );
      },
      publicBaseUrl: options.publicBaseUrl,
    });
    sourceRecipient = createOriginalUnitRecipient({
      organizationId: org,
      store,
      ledger: options.ledger,
      organization: installation.organization,
      coordinator: options.core.coordinatorInstances,
      authentication,
      now: options.now,
    });
    identity = createIdentityRuntime({
      config: options.config.config.dashboard?.identityLink,
      organization: org,
      deliverNotice: async (notice) => {
        if (
          !options.deliverIdentityNotice ||
          notice.organization !== org ||
          notice.identity.issuer !== "https://slack.com" ||
          notice.identity.tenant !== slackTeam
        )
          return false;
        const proof = await native!.currentSlack(notice.identity);
        if (proof.status !== "verified" || proof.kind !== "human" || !proof.organizationMember) return false;
        return options.deliverIdentityNotice(notice);
      },
      directory: store.directory,
      access: options.access ?? undefined,
      publicBaseUrl: options.publicBaseUrl,
      now: options.now,
      page: sendPage,
      readSecret: options.readSecret,
      authorize: (actor) => authorize(actor, "identity:link", { type: "identity", id: actor.id }).allow,
      onChanged: () => installation?.runtime.invalidate(org),
    });
  }
  async function context(req: IncomingMessage, credential: AccessIdentity) {
    if (!native || !authentication || !installation) return;
    native.rememberBrowser(req, credential);
    const id = native.browserIdentity(credential);
    const channelId = `web:${id.subject}`;
    const binding = await installationStore!.directory.resolve(id);
    if (["unavailable", "invalid", "conflict"].includes(binding.status)) return;
    const stream = binding.status === "bound" ? binding.binding.personId : `browser:${identityKey(id)}`;
    const broad = `${channelId}:org-${createHash("sha256")
      .update(JSON.stringify([org, stream]))
      .digest("hex")}`;
    const msg = { channelId, userId: `access:${id.subject}`, threadKey: broad, text: "" };
    const actual = await authentication.resolveBrowser(id, msg);
    if (actual.status !== "resolved") return;
    const viewAs = viewAsFromCookie(req.headers.cookie);
    const viewed = await readProjection({ actor: actual.actor, authentication: actual.authentication }, viewAs);
    const selected = viewed.actor.viewingAs?.id;
    const label = selected ? options.people().find((person) => person.id === selected)?.name : credential.email;
    if (label) viewerLabels.set(viewed.actor, label);
    return attachScope(viewed, workViewModeFromCookie(req.headers.cookie), actual.actor);
  }
  /** A configured dashboard bearer may read as its own caller without proving
   * a human private stream or borrowing a linked person's authority. */
  function tokenPageActor(credential: AccessIdentity): Actor | undefined {
    if (options.dashboard.mode !== "token" || isServiceToken(credential) || !credential.sub) return;
    const resolved = accessActor(credential, (id) => options.config.grantsFor(id));
    const actor: Actor = { ...resolved, kind: "service", self: [resolved.id] };
    return withWorkViewScope(actor, resolveWorkViewScope(actor, { organization: org }));
  }
  async function currentTokenPageActor(req: IncomingMessage, credential: AccessIdentity) {
    if (options.dashboard.mode !== "token") return;
    const gate = await options.dashboard.verify(req);
    if (!gate.ok || gate.identity.sub !== credential.sub || isServiceToken(gate.identity)) return;
    return tokenPageActor(gate.identity);
  }
  async function approvalSource(row: Confirmation, viewer: Actor) {
    if (
      !installation ||
      !authentication ||
      !native ||
      viewer.kind !== "user" ||
      viewer.viewingAs ||
      workViewScopeOf(viewer).mode === "person"
    )
      return;
    if (row.originalOrganization) return installation.approvalSource(row, viewer);
    const connection = row.message.approvalConnection;
    if (connection) {
      const credential = await connectionIdentity(connection.id, {
        auth: options.auth(),
        personalTokens: options.personalTokens,
      });
      if (
        !credential ||
        credential.subject !== `personal:${viewer.id.slice("access:".length)}` ||
        credential.verifiedUserId !== viewer.id ||
        row.message.userId !== viewer.id
      )
        return;
      const source = await authentication.resolveNative(row.message, {
        source: "mcp",
        identity: credential,
        credentialDigest: connection.id,
      });
      if (source.status !== "resolved" || source.actor.onBehalfOf?.id !== viewer.id) return;
      return { actor: source.actor, io: new SingleShotIO([], row.message.threadKey) };
    }
    if (
      !viewer.id.startsWith("access:") ||
      (row.message.postedBy ?? row.message.authenticatedAs ?? row.message.userId) !== viewer.id
    )
      return;
    const source = await authentication.resolveBrowser(
      { issuer: native.browserIssuer, tenant: null, subject: viewer.id.slice("access:".length) },
      row.message,
    );
    return source.status === "resolved" && source.actor.id === viewer.id
      ? { actor: source.actor, io: new SingleShotIO([], row.message.threadKey) }
      : undefined;
  }
  const admit: OrganizationIngress = async (msg, _io, evidence, continuation) =>
    installation ? installation.admitNative(msg, evidence, continuation) : { status: "unavailable" };
  const dispatchSlack: typeof dispatch = async (core, msg, io, opts) => {
    if (!msg.channelId.startsWith("slack:D")) return dispatch(core, msg, io, opts);
    if (!installation || !native || !msg.directAudience || msg.postedBy || msg.authenticatedAs) {
      await io.reply("This private conversation is unavailable. No work started.");
      opts?.trace?.root.end("ok", { status: "refused" });
      return { status: "refused", cause: "system", refusal: "Current private source proof is unavailable." };
    }
    const result = await installation.admitNative(msg, {
      source: "slack",
      identity: { issuer: "https://slack.com", tenant: slackTeam, subject: msg.userId.slice("slack:".length) },
    });
    const accepted =
      result.status === "receipt" && (result.receipt.status === "pending" || result.receipt.status === "accepted");
    if (!accepted) await io.reply("This private request is unavailable. No new work started.");
    opts?.trace?.root.end("ok", accepted ? {} : { status: "refused" });
    return accepted
      ? { status: "completed", inputQueued: { runId: result.receipt.ownerRunId } }
      : { status: "refused", cause: "system", refusal: "Native admission is unavailable." };
  };
  const confirmSlack: typeof dispatchClick = async (core, click, opts) => {
    const address = await click.io.directAudience?.();
    if (!address) return dispatchClick(core, click, opts);
    if (
      !installation ||
      !native ||
      click.actor.kind !== "user" ||
      click.actor.viewingAs ||
      address.userId !== click.actor.id
    )
      return { status: "refused", cause: "system", refusal: "Current saved choice source is unavailable." };
    const result = await installation.admitNative(
      {
        channelId: address.channelId,
        userId: click.actor.id,
        threadKey: address.threadKey,
        text: "",
        messageId: `choice:${click.id}:${click.kind}`,
      },
      {
        source: "slack",
        identity: { issuer: "https://slack.com", tenant: slackTeam, subject: click.actor.id.slice("slack:".length) },
      },
      { kind: click.kind, id: click.id },
    );
    const accepted =
      result.status === "receipt" && (result.receipt.status === "pending" || result.receipt.status === "accepted");
    if (!accepted) await click.io.reply("The saved action is unavailable. No new work started.");
    return accepted
      ? { status: "completed", inputQueued: { runId: result.receipt.ownerRunId } }
      : { status: "refused", cause: "system", refusal: "Current saved choice source is unavailable." };
  };
  function sendPage(
    req: Parameters<PageSender>[0],
    res: ServerResponse,
    status: number,
    actor: Actor | undefined,
    title: string,
    seed: PageSeed,
  ) {
    const scope = actor ? workViewScopeOf(actor) : undefined;
    const enriched = {
      ...seed,
      ...(scope
        ? {
            dataView: { mode: scope.mode, canViewEveryone: scope.canEveryone },
            asUser: {
              ...(actor!.asUser ?? { id: actor!.id }),
              ...(viewerLabels.get(actor!) ? { name: viewerLabels.get(actor!) } : {}),
            },
            ...(scope.canEveryone ? { viewAs: { people: [...options.people()] } } : {}),
          }
        : {}),
      emoji: emoji.catalog(),
    };
    options.page(req, res, status, actor, title, enriched);
  }
  return {
    initialize,
    refreshNativeSources,
    deleteSlackSource: async (address: SourceDeletionAddress): Promise<OrganizationResult> => {
      if (address.source !== "slack" || address.issuer !== "https://slack.com") return { status: "fenced" };
      if (!installation) await initialize();
      if (!installation) return { status: "unavailable" };
      await refreshNativeSources();
      let currentTeam;
      try {
        currentTeam = await options.team();
      } catch {
        return { status: "unavailable" };
      }
      if (!currentTeam || !slackTeam) return { status: "unavailable" };
      if (address.tenant !== currentTeam || address.tenant !== slackTeam) return { status: "fenced" };
      return installation.runtime.deleteSource(
        org,
        address,
        Math.max(options.limits.contentTtlMs, options.limits.receiptTtlMs),
      );
    },
    admit,
    replayNativeChoice: (
      msg: Parameters<typeof admit>[0],
      evidence: Parameters<typeof admit>[2],
      choice: NonNullable<Parameters<typeof admit>[3]>,
    ) =>
      installation
        ? installation.replayNativeChoice(msg, evidence, choice)
        : Promise.resolve({ status: "unavailable" as const }),
    dispatchSlack,
    confirmSlack,
    context,
    tokenPageActor,
    currentTokenPageActor,
    attentionRecipients: owners,
    page: sendPage,
    emoji,
    current: () => installation,
    native: () => native,
    authentication: () => authentication,
    identity: () => identity,
    unavailable: () => unavailable,
    owners,
    canReadContext,
    originalIO,
    originalBinding,
    resolveQuestionRequester,
    approvalSource,
    guardOrganizationConfirmation: (
      row: Parameters<NonNullable<CoreDeps["guardOrganizationConfirmation"]>>[0],
      chooser?: Parameters<NonNullable<CoreDeps["guardOrganizationConfirmation"]>>[1],
      purpose?: Parameters<NonNullable<CoreDeps["guardOrganizationConfirmation"]>>[2],
    ) =>
      installation ? installation.guardOrganizationConfirmation(row, chooser, purpose) : Promise.resolve(undefined),
    revalidateNativeMediaSource: (
      dependency: Parameters<NonNullable<CoreDeps["revalidateNativeMediaSource"]>>[0],
      consumer: Parameters<NonNullable<CoreDeps["revalidateNativeMediaSource"]>>[1],
    ) => (installation ? installation.revalidateNativeMediaSource(dependency, consumer) : Promise.resolve(false)),
  };
}
