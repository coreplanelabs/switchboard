import type { InjectionKey, Ref } from "vue";

// The mark's pulse (docs/reference/specs/web-chat.md rule 6): a page that sends
// a message bumps this counter, and every BrandMark on the page plays the route
// once — the message entering the top plane and reaching the lanes. A page
// that provides nothing has a still mark. A plain module so the page, the mark
// and the tests share one key without importing a `.vue` file's exports.

export const MarkPulseKey: InjectionKey<Ref<number>> = Symbol("sb-mark-pulse");
