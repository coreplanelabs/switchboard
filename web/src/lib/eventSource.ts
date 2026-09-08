import { inject, type InjectionKey } from "vue";

// The EventSource seam: pages open streams through this factory so tests can
// inject a fake and drive frames by hand. The shape is the subset the pages
// use (onopen/onmessage/onerror, named events, close, readyState). A named
// listener receives the frame's `data` string (or nothing, for a frame without
// one) — never the browser's MessageEvent — so the fake and the production
// adapter agree by construction.

export interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null;
  onerror: (() => void) | null;
  addEventListener(name: string, cb: (data?: string) => void): void;
  close(): void;
  readonly readyState: number;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const EVENT_SOURCE_CLOSED = 2;

export const EventSourceKey: InjectionKey<EventSourceFactory> = Symbol("sb-event-source");

/** The subset of the browser's `EventSource` the adapter needs, with the one
 *  listener shape it registers — so a test can drive the adapter with a stub
 *  that fires a real `MessageEvent` (or a bare `Event` for a frame without
 *  data). */
export type NativeEventSource = Pick<EventSource, "onopen" | "onmessage" | "onerror" | "close" | "readyState"> & {
  addEventListener(name: string, listener: (ev: Event & { data?: unknown }) => void): void;
};

/** Wrap a browser `EventSource` as an `EventSourceLike`: the only difference is
 *  that a named listener gets `ev.data` (a string, or undefined when the frame
 *  carried none) instead of the `MessageEvent`. */
export function wrapNativeEventSource(native: NativeEventSource): EventSourceLike {
  return {
    get onopen() {
      return native.onopen as (() => void) | null;
    },
    set onopen(cb) {
      native.onopen = cb;
    },
    get onmessage() {
      return native.onmessage as EventSourceLike["onmessage"];
    },
    set onmessage(cb) {
      native.onmessage = cb;
    },
    get onerror() {
      return native.onerror as (() => void) | null;
    },
    set onerror(cb) {
      native.onerror = cb;
    },
    addEventListener(name, cb) {
      native.addEventListener(name, (ev) => cb(typeof ev.data === "string" ? ev.data : undefined));
    },
    close() {
      native.close();
    },
    get readyState() {
      return native.readyState;
    },
  };
}

export function useEventSourceFactory(): EventSourceFactory {
  return inject(EventSourceKey, (url: string) => wrapNativeEventSource(new EventSource(url)));
}
