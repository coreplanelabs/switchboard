// Types for the seams' one statement (docs/.vitepress/theme/seams.mjs). The
// shapes are the generator's (src/docs/diagrams.ts renders the four-seam
// diagram from this data), so they are declared once, there.
import type { Dispatcher, Seam } from "../../../src/docs/diagrams.js";

export const SEAMS: ReadonlyArray<Seam>;
export const DISPATCHER: Dispatcher;
export function listed(items: ReadonlyArray<string>): string;
