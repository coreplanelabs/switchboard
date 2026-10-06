import type { MessagePort } from "node:worker_threads";
import type { ResponsesWorkerRequest } from "../responsesConsumer.js";
import { inspectResponsesGraph, packResponsesValue, unpackResponsesValue } from "../responsesResources.js";

/** Fixtures keep their independent failure/blocking behavior while using the
 * real full-value transport codec and graph statistics. */
export function responsesFixtureProtocol(port: MessagePort) {
  let value: unknown;
  return {
    control(request: ResponsesWorkerRequest): boolean {
      if (request.op === "parse") {
        const text =
          request.encoding === "utf8"
            ? new TextDecoder("utf8", { ignoreBOM: request.target === "request" }).decode(request.payload)
            : unpackResponsesValue(request.payload, request.target);
        value = JSON.parse(String(text));
        port.postMessage({
          id: request.id,
          op: "parse",
          target: request.target,
          permit: request.permit,
          phase: "prepared",
          stats: inspectResponsesGraph(value, request.target),
        });
        return true;
      }
      if (request.op === "serialize") {
        const payload = packResponsesValue(value, request.target);
        port.postMessage(
          {
            id: request.id,
            op: "parse",
            target: request.target,
            permit: request.permit,
            phase: "reply",
            ok: true,
            stats: inspectResponsesGraph(value, request.target),
            payload,
          },
          [payload],
        );
        return true;
      }
      return false;
    },
    event(request: Extract<ResponsesWorkerRequest, { op: "consume" }>): unknown {
      return unpackResponsesValue(request.payload, "frame");
    },
    accepted(request: ResponsesWorkerRequest, accepted: boolean): void {
      port.postMessage({
        id: request.id,
        op: request.op,
        target: "frame",
        permit: request.permit,
        phase: "reply",
        accepted,
      });
    },
  };
}
