/** Retained bytes must not enter an exception message before it crosses RPC.
 * Keep JSON.parse's value semantics and error class; discard decoder prose. */
export function parseStoredJson(text: string): ReturnType<typeof JSON.parse> {
  try {
    return JSON.parse(text);
  } catch (error) {
    // Decoder messages, stacks and causes can quote retained private bytes.
    // eslint-disable-next-line preserve-caught-error -- The original cause must not cross RPC.
    if (error instanceof SyntaxError) throw new SyntaxError("Stored JSON is unreadable");
    throw error;
  }
}
