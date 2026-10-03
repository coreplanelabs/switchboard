/** The `spawn` block of `config.yaml` (docs/reference/specs/agent-conductor.md item 5). */
export interface SpawnConfig {
  /** The most read children one run may have live at once (default 8, at least 1);
   * an exact-PR Ship batch starts independent durable units. */
  maxChildren?: number;
}

export const DEFAULT_MAX_CHILDREN = 8;

/** The fan-out cap in force: the knob, or the default. */
export function maxChildrenOf(cfg: SpawnConfig | undefined): number {
  return cfg?.maxChildren ?? DEFAULT_MAX_CHILDREN;
}
