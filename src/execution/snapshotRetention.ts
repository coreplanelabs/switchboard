// A resident keeps two snapshot generations (docs/reference/specs/resident-repos.md
// item 7). The refresh cycle that writes a new stamped pair used to delete the
// pair it replaced at once; a seeded sandbox that read the checkout handle from
// `/status` seconds earlier would then restore from objects that are gone, and
// a rotation lands exactly when a release train merges — the burst the seeded
// tier exists for. So the replaced pair is RETIRED instead, and the pair
// retired before it is what the rotation deletes: a handle read from `/status`
// resolves for at least one more cycle (ten minutes) after it stops being the
// current one. Offboard and rebuild delete every recorded generation. This is
// the decision, pure and imported by the resident Worker like
// `residentDiskBudget.ts`.

/** The two SDK backup handles a snapshot generation is made of. */
export interface SnapshotHandles {
  mirror: { id: string };
  checkout: { id: string };
}

/** How many generations a resident keeps: the current pair and the one it replaced. */
export const SNAPSHOT_GENERATIONS = 2;

/** The storage key of the retired generation (the current one is the Worker's `resident:snapshot`). */
export const RETIRED_SNAPSHOT_KEY = "resident:snapshot:retired";

export interface Rotation<T extends SnapshotHandles> {
  /** The generation to record as retired after this rotation. */
  retired: T | undefined;
  /** The backup ids whose objects this rotation deletes. */
  deleteIds: string[];
}

const idsOf = (h: SnapshotHandles): string[] => [h.mirror.id, h.checkout.id];

const sameHandles = (a: SnapshotHandles, b: SnapshotHandles) =>
  a.mirror.id === b.mirror.id && a.checkout.id === b.checkout.id;

/** A new pair was committed: the pair it `replaced` (the record read when the
 *  step began) becomes the retired generation, and the pair `retired` before
 *  it is deleted. The first snapshot ever replaces nothing and changes
 *  nothing; a rotation whose replaced pair is the retired one already (a
 *  re-fired step) deletes nothing, since those are the objects being kept. */
export function rotateSnapshots<T extends SnapshotHandles>(input: {
  replaced: T | undefined;
  retired: T | undefined;
}): Rotation<T> {
  const { replaced, retired } = input;
  if (!replaced) return { retired, deleteIds: [] };
  if (retired && sameHandles(retired, replaced)) return { retired, deleteIds: [] };
  return { retired: replaced, deleteIds: retired ? idsOf(retired) : [] };
}

/** Every recorded generation's backup ids, each once, in the order given
 *  (current first): what offboard and rebuild delete, and what their dry runs
 *  itemize. */
export function backupIdsOf(records: ReadonlyArray<SnapshotHandles | undefined>): string[] {
  const ids: string[] = [];
  for (const record of records) {
    if (!record) continue;
    for (const id of idsOf(record)) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}
