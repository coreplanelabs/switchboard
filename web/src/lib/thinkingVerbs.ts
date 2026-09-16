// The words a silent model's pending row rotates through (live-view item 18):
// a fixed list, a new word every 6 s in order — predictable, not twitchy — so
// the row is visibly alive without a spinner. The word is DERIVED from how
// long this silence has lasted, so every silence starts at "Thinking" and
// nothing rotates while no one is waiting. One list for the run page and a
// thread's assistant turn.

export const THINKING_VERBS: readonly string[] = [
  "Thinking",
  "Pondering",
  "Mulling it over",
  "Reasoning",
  "Cogitating",
  "Weighing options",
  "Puzzling",
  "Deliberating",
  "Noodling",
  "Chewing on it",
  "Ruminating",
  "Reticulating splines",
];

export function thinkingVerb(silenceMs: number): string {
  return THINKING_VERBS[Math.floor(Math.max(0, silenceMs) / 6000) % THINKING_VERBS.length];
}
