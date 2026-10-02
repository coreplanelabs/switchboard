// Artifact metadata is shared with durable Workers. Keep these shapes
// independent of catalogue reads, staging executors and dispatch services.

/** A file the thread received on an earlier message, as a prior run's record
 *  names it and as the thread's catalogue read (`readThreadAssets`) answers:
 *  `held` says whether the store still has it — false once its retention
 *  passed, undefined when the store could not be asked. */
export interface ThreadArtifact {
  key: string;
  name: string;
  size: number;
  contentType: string;
  held?: boolean;
}

/** One file of the thread: received on one of its messages (`in`) or produced
 *  by one of its runs (`out`), as the run records name it, and whether the
 *  store still holds it (`held`, from `ThreadArtifact`). */
export interface ThreadAsset extends ThreadArtifact {
  direction: "in" | "out";
  /** The run whose record first names the key (a re-pulled file is named again by later runs). */
  runId: string;
  /** The run's `artifact` event's position in its record, when the record has one. */
  seq?: number;
}
