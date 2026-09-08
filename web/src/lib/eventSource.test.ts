// Feature: features/live-view.md — the EventSource seam's production adapter.
import { describe, expect, it } from "vitest";
import { wrapNativeEventSource, type NativeEventSource } from "./eventSource";

function stubNative() {
  const listeners = new Map<string, Array<(ev: Event & { data?: unknown }) => void>>();
  const native: NativeEventSource & { fire(name: string, ev: Event): void; closed: boolean } = {
    onopen: null,
    onmessage: null,
    onerror: null,
    readyState: 0,
    closed: false,
    addEventListener(name, listener) {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
    close() {
      this.closed = true;
    },
    fire(name, ev) {
      for (const l of listeners.get(name) ?? []) l(ev);
    },
  };
  return native;
}

describe("wrapNativeEventSource — named listeners receive the frame's data string, never the MessageEvent", () => {
  it("hands a real MessageEvent's data to the listener; a frame without data hands undefined", () => {
    const native = stubNative();
    const es = wrapNativeEventSource(native);
    const got: Array<string | undefined> = [];
    es.addEventListener("replay_elided", (data) => got.push(data));
    es.addEventListener("end", (data) => got.push(data));
    native.fire("replay_elided", new MessageEvent("replay_elided", { data: '{"fromSeq":1,"toSeq":1000}' }));
    native.fire("end", new MessageEvent("end", { data: "{}" }));
    native.fire("end", new Event("end"));
    expect(got).toEqual(['{"fromSeq":1,"toSeq":1000}', "{}", undefined]);
  });

  it("delegates the handlers, close and readyState to the native source", () => {
    const native = stubNative();
    const es = wrapNativeEventSource(native);
    const onopen = () => {};
    const onerror = () => {};
    const onmessage = () => {};
    es.onopen = onopen;
    es.onerror = onerror;
    es.onmessage = onmessage;
    expect(native.onopen).toBe(onopen);
    expect(native.onerror).toBe(onerror);
    expect(native.onmessage).toBe(onmessage);
    expect(es.onmessage).toBe(onmessage);
    (native as { readyState: number }).readyState = 2;
    expect(es.readyState).toBe(2);
    es.close();
    expect(native.closed).toBe(true);
  });
});
