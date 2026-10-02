import type { MainTaskAuthority } from "./requesterAuthority.js";

/** Durable task identity shared by store clients and Worker record schemas. */
export interface MainTaskLink {
  instanceId: string;
  unit: string;
  /** Missing on legacy links, which cannot authorize a new Workflow create. */
  authority?: MainTaskAuthority;
}
