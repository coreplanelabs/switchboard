/** Persist uncertainty before asking the platform to destroy a resident VM.
 * A rejected or interrupted destroy leaves the fence in storage: callers may
 * retry destruction, but may not provision or assign a pool user on the old
 * disk. A failed clear is conservative too, even if the VM was destroyed. */
export async function destroyWithPersistentFence(
  fence: { mark(): Promise<void>; clear(): Promise<void> },
  destroy: () => Promise<void>,
): Promise<void> {
  await fence.mark();
  await destroy();
  await fence.clear();
}
