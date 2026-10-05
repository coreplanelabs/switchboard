import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import { ResponsesConsumer } from "./responsesConsumer.js";

function* toolStream(args: string) {
  const item = { type: "function_call", id: "item", call_id: "call", name: "bash", arguments: "" };
  yield { type: "response.created", response: { id: "response" } };
  yield { type: "response.output_item.added", output_index: 0, item };
  for (let offset = 0; offset < args.length; offset += 64)
    yield { type: "response.function_call_arguments.delta", output_index: 0, delta: args.slice(offset, offset + 64) };
  yield { type: "response.function_call_arguments.done", output_index: 0, arguments: args };
  yield { type: "response.output_item.done", output_index: 0, item: { ...item, arguments: args } };
  yield { type: "response.completed", response: { status: "completed", output: [{ ...item, arguments: args }] } };
}

describe("Responses validation stays responsive", () => {
  it("lets an independent I/O callback run while accepting a ready tool stream", async () => {
    const consumer = new ResponsesConsumer("test");
    let callbackRan = false;
    setImmediate(() => {
      callbackRan = true;
    });
    for (const event of toolStream(JSON.stringify({ command: "x".repeat(4096) })))
      expect(await consumer.consume(event)).toBe(true);
    expect(await consumer.close()).toBe(true);
    expect(callbackRan).toBe(true);
  });
});
