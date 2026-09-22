import { fetchDecisionRecordClaims } from "../execution/githubPulls.js";
import { DecisionRecordAllocator } from "./decisionRecordReservation.js";

/** One process-wide allocator shared by ship admissions and direct coding
 * admissions, so the interval before either child opens a pull request is
 * serialized across both doors. */
export const defaultDecisionRecordAllocator = new DecisionRecordAllocator(fetchDecisionRecordClaims);
