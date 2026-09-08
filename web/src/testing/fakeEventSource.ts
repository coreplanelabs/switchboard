import { EVENT_SOURCE_CLOSED, type EventSourceLike } from "../lib/eventSource";

// A hand-driven EventSource for tests: emit frames, open/close the stream,
// fire named events. One factory records every stream a page opened.

export class FakeEventSource implements EventSourceLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  closed = false;
  private listeners = new Map<string, Array<(data?: string) => void>>();

  constructor(readonly url: string) {}

  addEventListener(name: string, cb: (data?: string) => void): void {
    const list = this.listeners.get(name) ?? [];
    list.push(cb);
    this.listeners.set(name, list);
  }

  close(): void {
    this.closed = true;
    this.readyState = EVENT_SOURCE_CLOSED;
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(data: unknown, lastEventId = ""): void {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data), lastEventId });
  }

  /** Fire a named frame; `data` is the frame's payload string, as the
   *  production adapter hands it over (see `wrapNativeEventSource`). */
  emitNamed(name: string, data?: string): void {
    for (const cb of this.listeners.get(name) ?? []) cb(data);
  }

  emitError(closed = false): void {
    if (closed) this.readyState = EVENT_SOURCE_CLOSED;
    this.onerror?.();
  }
}

export function fakeEventSourceFactory(): { created: FakeEventSource[]; factory: (url: string) => FakeEventSource } {
  const created: FakeEventSource[] = [];
  return {
    created,
    factory: (url: string) => {
      const es = new FakeEventSource(url);
      created.push(es);
      return es;
    },
  };
}
