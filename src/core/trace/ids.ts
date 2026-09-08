/** Trace and span ids in the W3C shape: 16 and 8 random bytes as lowercase hex,
 *  never all zero. Bare `crypto.getRandomValues` so Node and the Workers share
 *  one implementation. */

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function newTraceId(): string {
  let id = randomHex(16);
  while (/^0+$/.test(id)) id = randomHex(16);
  return id;
}

export function newSpanId(): string {
  let id = randomHex(8);
  while (/^0+$/.test(id)) id = randomHex(8);
  return id;
}
