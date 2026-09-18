import { applyLinearFiles, fileReferences } from "./files.js";
import type { ChannelIO, IncomingMessage } from "../../core/types.js";
import type { Clock } from "../../core/trace/types.js";
import { LINEAR_TIMING } from "../../core/budgets.js";
import { object, required, type LinearApi } from "./api.js";
import type { LinearDelivery } from "./inbox.js";
import { LinearChannelIO } from "./io.js";
import { linearMessage, type LinearInput } from "./session.js";
import type { LinearWebhookEvent } from "./webhook.js";

export interface LinearConsumerInbox {
  claim(): Promise<LinearDelivery | undefined>;
  begin(key: string, lease: string): Promise<boolean>;
  bind(key: string, lease: string, runId: string): Promise<boolean>;
  renew(key: string, lease: string): Promise<boolean>;
  retry(key: string, lease: string): Promise<boolean>;
  defer(key: string, lease: string): Promise<boolean>;
  complete(key: string, lease: string): Promise<boolean>;
}

export interface LinearConsumerDeps {
  inbox: LinearConsumerInbox;
  api(organizationId: string): LinearApi;
  clock: Clock;
  warn(message: string): void;
  maxStagedBytes?: number;
  dispatch(msg: IncomingMessage, io: ChannelIO): Promise<{ deferred?: true } | void>;
  stop(input: Extract<LinearInput, { kind: "stop" }>, io: ChannelIO): Promise<void>;
  /** Proves admission from the ledger/history, not merely the runStarted hook. */
  recover(delivery: LinearDelivery, msg: IncomingMessage): Promise<"handled" | "unknown">;
  other(event: LinearWebhookEvent): Promise<void>;
  leaseLost(runId: string): void;
}

const INTERRUPTED =
  "Switchboard restarted while accepting this request. I could not confirm its durable run, so I have not repeated it. Please check any effects and send a new request to continue.";

/** Intake stays independent of a dispatch's long lifetime: another session,
 * follow-up or stop can arrive while the first agent is working. The inbox
 * marker covers even inline commands that never create a run record. */
export class LinearConsumer {
  private stopped = false;
  private started = false;
  private polling?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly active = new Set<Promise<void>>();
  private readonly sessionTurns = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: LinearConsumerDeps) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    const tick = async () => {
      await this.poll();
      if (!this.stopped) this.timer = setTimeout(() => void tick(), LINEAR_TIMING.progressMs);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  get pending(): number {
    return this.active.size;
  }

  async settled(): Promise<void> {
    await this.polling;
    await Promise.all([...this.active]);
  }

  poll(): Promise<void> {
    return (this.polling ??= this.claimAvailable().finally(() => {
      this.polling = undefined;
    }));
  }

  private async claimAvailable(): Promise<void> {
    try {
      // Bound one pass so a constantly replenished inbox yields to drain and
      // the event loop. The dispatcher owns model concurrency and admission.
      for (let count = 0; count < 32 && !this.stopped; count++) {
        const delivery = await this.deps.inbox.claim();
        if (!delivery) break;
        if (this.stopped) {
          await this.deps.inbox.retry(delivery.event.key, delivery.lease);
          break;
        }
        const work = this.consume(delivery).finally(() => this.active.delete(work));
        this.active.add(work);
      }
    } catch {
      this.deps.warn("[linear] event intake unavailable; will retry");
    }
  }

  private async consume(delivery: LinearDelivery): Promise<void> {
    const { inbox } = this.deps,
      { event, lease } = delivery;
    const sessionKey =
      event.payload.type === "AgentSessionEvent"
        ? `${event.payload.organizationId}:${String(object(event.payload.agentSession).id)}`
        : undefined;
    const isStop = object(event.payload.agentActivity).signal === "stop";
    const preceding = sessionKey && !isStop ? this.sessionTurns.get(sessionKey) : undefined;
    let release!: (ready: boolean) => void;
    let ready = false;
    let dispatchSettled = false;
    const admitted = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    if (sessionKey && !isStop) this.sessionTurns.set(sessionKey, admitted);
    let owned = true,
      runId = delivery.runId;
    let renewal: Promise<void> | undefined;
    let binding: Promise<unknown> = Promise.resolve();
    const lose = () => {
      owned = false;
      if (runId) this.deps.leaseLost(runId);
    };
    const heartbeat = setInterval(() => {
      if (renewal || !owned) return;
      renewal = inbox
        .renew(event.key, lease)
        .then((ok) => {
          if (!ok) lose();
        }, lose)
        .finally(() => {
          renewal = undefined;
        });
    }, LINEAR_TIMING.deliveryLeaseMs / 3);
    try {
      if (event.payload.type !== "AgentSessionEvent") {
        await this.deps.other(event);
      } else {
        // A runStarted hook follows the core's thread admission. Let the next
        // turn steer it then, rather than racing setup or waiting for its end.
        if (preceding && !(await preceding)) {
          if (owned) await inbox.retry(event.key, lease);
          return;
        }
        if (!owned) return;
        const api = this.deps.api(required(event.payload.organizationId));
        const session = await api.session(required(object(event.payload.agentSession).id));
        if (event.payload.action === "created" && session.managedChild) {
          // openThread's caller starts this child through the shared dispatcher.
          // The creation webhook is notification, not a second request to run it.
          if (owned) ready = await inbox.complete(event.key, lease);
          return;
        }
        if (session.unsupportedSurface && !(isStop && event.payload.action === "prompted")) {
          if (!session.dismissedAt)
            await api.activity(session.id, {
              type: "error",
              body: "This Linear conversation has no supported issue, project or document origin. Please mention or delegate Switchboard on an issue to continue.",
            });
          if (owned) ready = await inbox.complete(event.key, lease);
          return;
        }
        let input: LinearInput;
        try {
          input = linearMessage(event, session, session.appUserId);
        } catch {
          if (!session.dismissedAt)
            await api.activity(session.id, {
              type: "error",
              body: "Switchboard could not establish a supported request and its human sender. Please send a new mention or delegate this issue again.",
            });
          if (owned) ready = await inbox.complete(event.key, lease);
          return;
        }
        const io: ChannelIO = new LinearChannelIO({
          api,
          sessionId: session.id,
          appUserId: session.appUserId,
          ...(input.kind === "message" ? { triggeringActivityId: input.triggeringActivityId } : {}),
          initial: event.payload.action === "created",
          clock: this.deps.clock,
          warn: this.deps.warn,
        });
        io.runStarted = async ({ id }) => {
          const first = runId === undefined;
          runId = id;
          // Keep the first durable hint when the core replaces an interrupted
          // run; recovery also searches the request id. Every replacement must
          // still wait for that binding and stop if ownership was lost.
          if (first) {
            binding = inbox
              .bind(event.key, lease, id)
              .then((ok) => {
                if (!ok) lose();
              })
              .catch(() => {
                this.deps.warn("[linear] run binding unavailable");
                lose();
              });
          }
          await binding;
          if (!owned) {
            this.deps.leaseLost(id);
            return;
          }
          ready = true;
          release(true);
        };
        if (!owned) return;
        if (input.kind === "stop") {
          // Stopping is idempotent and must be retried when its acknowledgement
          // is lost. Its own handler resolves the actor and checks policy.
          await this.deps.stop(input, io);
        } else if (delivery.begun) {
          if ((await this.deps.recover(delivery, input.msg)) === "unknown")
            await api.activity(session.id, { type: "error", body: INTERRUPTED });
        } else {
          const urls = fileReferences(input.msg.text).map((ref) => ref.url);
          if (urls.length) {
            try {
              input.msg = applyLinearFiles(
                input.msg,
                await api.files(session.id, input.msg.userId, urls, false, this.deps.maxStagedBytes),
              );
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "linear_file_denied") throw error;
              // Dispatch still checks current access and issues the refusal. If
              // access returns in between, it must not claim the files were read.
              input.msg.text += "\n\n[Attachments not read: the requester could not access this session.]";
            }
          }
          if (!(await inbox.begin(event.key, lease))) return;
          if (!owned) return;
          const outcome = await this.deps.dispatch(input.msg, io);
          await binding;
          dispatchSettled = true;
          if (outcome?.deferred) {
            if (runId) throw new Error("linear_deferred_after_run_started");
            if (owned) await inbox.defer(event.key, lease);
            return;
          }
        }
      }
      // A dispatch that stopped after a failed binding still settled its work.
      // Complete with the original lease: the inbox CAS refuses a newer owner,
      // while a Stop-marked delivery we still own needs no uncertain replay.
      if (owned || dispatchSettled) ready = await inbox.complete(event.key, lease);
    } catch {
      this.deps.warn("[linear] delivery unfinished; retained for recovery");
      if (owned) await inbox.retry(event.key, lease).catch(() => {});
    } finally {
      release(ready);
      if (sessionKey && this.sessionTurns.get(sessionKey) === admitted) this.sessionTurns.delete(sessionKey);
      clearInterval(heartbeat);
      await renewal;
    }
  }
}
