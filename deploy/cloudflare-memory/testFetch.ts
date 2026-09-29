import { SELF } from "cloudflare:test";
import { recordMemoryTestRequest } from "./testDiagnostics.ts";

/** A request stays pending until the test has consumed its response body. */
export function fetchMemoryTest(url: string, init?: RequestInit): Promise<Response>;
export function fetchMemoryTest<T>(
  url: string,
  init: RequestInit | undefined,
  consume: (response: Response) => T | Promise<T>,
): Promise<T>;
export function fetchMemoryTest<T>(
  url: string,
  init?: RequestInit,
  consume?: (response: Response) => T | Promise<T>,
): Promise<Response | T> {
  const method = init?.method ?? "GET";
  const pathname = new URL(url).pathname;
  return consume
    ? recordMemoryTestRequest(`${method} ${pathname}`, () => SELF.fetch(url, init), consume)
    : recordMemoryTestRequest(`${method} ${pathname}`, () => SELF.fetch(url, init));
}
