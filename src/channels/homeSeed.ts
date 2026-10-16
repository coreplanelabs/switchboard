import type { HomeHistory, HomePipeline, HomeSnapshot, HomeUnit } from "../core/home/service.js";
import type { HomeCommandSeed, HomeTurnSeed } from "./webSeed.js";

/** Only server-resolved identities and destinations enter this browser contract. */
export interface HomeDestination {
  kind: "broad" | "thread";
  label: string;
  thread: string | null;
  revision: number;
  canWrite: boolean;
}
export interface HomeConfirmationOffer {
  id: string;
  line: string;
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
}
export interface HomeSession {
  version: 1;
  organization: string;
  actor: string;
  stream: string;
  bindingRevision: number;
  revision: number;
  entries: HomeConversationEntry[];
  offer?: HomeConfirmationOffer;
  history?: { cursor: number; hasMore: boolean; status: "complete" | "partial" | "unavailable" };
  turns?: HomeTurnSeed[];
  destination: HomeDestination;
  sendUrl: string;
  eventsUrl: string;
  commands: HomeCommandSeed[];
  /** Minted before first admission; a retry keeps this same key and payload. */
  submissionKey: string;
}
export interface HomeFleetSeed {
  page: "fleetHome";
  snapshot: HomeSnapshot;
  /** Exact recipient resolved by the server, never inferred from browser context. */
  attentionRecipient?: string;
}
export interface HomeHistorySeed {
  page: "fleetHistory";
  history: HomeHistory;
}
export interface HomePipelineSeed {
  page: "fleetPipeline";
  status?: HomeSnapshot["status"];
  attentionRecipient?: string;
  pipeline: HomePipeline & { units: (HomeUnit & { activity?: "moving" })[] };
}
