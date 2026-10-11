import type { HomeRepositories } from "./homeRepositories.js";
import type { HomeHistory, HomePipeline, HomeSnapshot, HomeUnit } from "../core/home/service.js";
import type { HomeCommandSeed, HomeSeed } from "./webSeed.js";

export interface HomePrimaryAction {
  label: string;
  text: string;
}
/** Only server-resolved identities and destinations enter this browser contract. */
export interface HomeDestination {
  kind: "broad" | "thread";
  label: string;
  thread: string | null;
  revision: number;
  canWrite: boolean;
  primaryAction?: HomePrimaryAction;
}
export interface HomeConfirmationOffer {
  id: string;
  line: string;
  actionLabel?: string;
  risk?: string;
  question?: string;
  expiresAt?: number;
}
export type HomeConfirmationChoice = { kind: "confirm" | "cancel"; id: string };
/** Readable display projection; author identity is resolved by the server. */
export interface HomeConversationEntry {
  id: string;
  role: "user" | "assistant" | "receipt";
  content: string;
  isViewer: boolean;
  authorLabel?: string;
  source?: string;
  sourceUrl?: string;
  at?: number;
  /** Only the server can offer removal of an owned private receipt. */
  deleteUrl?: string;
}
export interface HomeSession {
  version: 1;
  organization: string;
  actor: string;
  stream: string;
  bindingRevision: number;
  /** Opaque fingerprint of the current credential policy and every proved source. */
  accessEpoch: string;
  revision: number;
  entries: HomeConversationEntry[];
  offer?: HomeConfirmationOffer;
  history?: {
    cursor: number;
    hasMore: boolean;
    status: "complete" | "partial" | "unavailable";
    previousUrl?: string;
    latestUrl?: string;
  };
  turns?: HomeSeed["turns"];
  destination: HomeDestination;
  sendUrl: string;
  eventsUrl: string;
  commands: HomeCommandSeed[];
  repositories?: HomeRepositories;
  /** Minted before first admission; a retry keeps this same key and payload. */
  submissionKey: string;
}
export interface HomeAnswerTarget {
  thread: string;
  revision: number;
  question: string;
  primaryAction?: HomePrimaryAction;
}
export interface HomeMergeAction {
  kind: "merge";
  pr: string;
  head: string;
}
export interface HomeFleetSeed {
  page: "fleetHome";
  snapshot: HomeSnapshot;
  /** Only the current actor's exact recorded question, selected by the server. */
  answers?: Record<string, HomeAnswerTarget>;
  /** Current viewer command affordances; the command rechecks authority and head. */
  actions?: Record<string, HomeMergeAction>;
  /** Exact recipient resolved by the server, never inferred from browser context. */
  attentionRecipient?: string;
  /** Current directory-proved source identities for display only. */
  attentionRecipients?: string[];
}
export interface HomeHistorySeed {
  page: "fleetHistory";
  history: HomeHistory;
}
export interface HomePipelineSeed {
  page: "fleetPipeline";
  status?: HomeSnapshot["status"];
  attentionRecipient?: string;
  /** Current directory-proved source identities for display only. */
  attentionRecipients?: string[];
  pipeline: HomePipeline & { units: (HomeUnit & { activity?: "moving" })[] };
}
