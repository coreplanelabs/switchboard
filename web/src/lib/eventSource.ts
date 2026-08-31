import { inject, type InjectionKey } from "vue";

// The EventSource seam: pages open streams through this factory so tests can
// inject a fake and drive frames by hand. The shape is the subset the pages
// use (onopen/onmessage/onerror, named events, close, readyState).

export interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string; lastEventId: string }) => void) | null;
  onerror: (() => void) | null;
  addEventListener(name: string, cb: () => void): void;
  close(): void;
  readonly readyState: number;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

export const EVENT_SOURCE_CLOSED = 2;

export const EventSourceKey: InjectionKey<EventSourceFactory> = Symbol("sb-event-source");

export function useEventSourceFactory(): EventSourceFactory {
  return inject(EventSourceKey, (url: string) => new EventSource(url) as unknown as EventSourceLike);
}
