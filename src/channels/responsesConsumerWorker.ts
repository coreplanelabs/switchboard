import { parentPort, workerData } from "node:worker_threads";
import { ResponsesConsumer as SdkConsumer } from "./responsesSdkConsumer.js";
import { RESPONSES_VALIDATION_LIMITS as limits } from "../core/budgets.js";
import { ResponsesValidationInterrupted } from "./responsesValidationCapacity.js";
import {
  inspectResponsesGraph,
  packResponsesValue,
  unpackResponsesValue,
  validateResponsesPayload,
  type ResponsesJsonTarget,
  type ResponsesGraphStats,
} from "./responsesResources.js";
import type { ResponsesWorkerRequest } from "./responsesConsumer.js";
const port = parentPort;
if (!port) throw new Error("Responses validation requires a worker port");
const consumer = new SdkConsumer((workerData as { modelId: string }).modelId);
let prepared:
  { id: number; target: ResponsesJsonTarget; permit: number; value: unknown; stats: ResponsesGraphStats } | undefined;
let busy = false;
let failed = false;
const targetOf = (value: unknown): value is ResponsesJsonTarget =>
  value === "request" || value === "frame" || value === "buffered" || value === "error";
port.on("message", async (message: ResponsesWorkerRequest) => {
  try {
    if (failed) throw new ResponsesValidationInterrupted("protocol");
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message) ||
      !Number.isSafeInteger(message.id) ||
      message.id <= 0 ||
      !Number.isSafeInteger(message.permit) ||
      message.permit <= 0
    )
      throw new ResponsesValidationInterrupted("protocol");
    const keys =
      message.op === "parse"
        ? ["id", "permit", "op", "target", "encoding", "payload"]
        : message.op === "consume"
          ? ["id", "permit", "op", "target", "payload"]
          : ["id", "permit", "op", "target"];
    if (
      Object.keys(message).length !== keys.length ||
      Object.keys(message).some((key) => !keys.includes(key)) ||
      !targetOf(message.target)
    )
      throw new ResponsesValidationInterrupted("protocol");
    if (message.op === "serialize") {
      if (
        busy ||
        !prepared ||
        message.id !== prepared.id ||
        message.target !== prepared.target ||
        message.permit !== prepared.permit
      )
        throw new ResponsesValidationInterrupted("protocol");
      busy = true;
      const held = prepared;
      const stats = inspectResponsesGraph(held.value, held.target);
      if (stats.entries !== held.stats.entries || stats.depth !== held.stats.depth || stats.units !== held.stats.units)
        throw new ResponsesValidationInterrupted("protocol");
      const payload = packResponsesValue(held.value, held.target);
      held.value = undefined;
      prepared = undefined;
      port.postMessage(
        {
          id: held.id,
          op: "parse",
          target: held.target,
          permit: held.permit,
          phase: "reply",
          ok: true,
          payload,
          stats,
        },
        [payload],
      );
      busy = false;
      return;
    }
    if (busy || prepared) throw new ResponsesValidationInterrupted("protocol");
    busy = true;
    if (message.op === "parse") {
      if (!targetOf(message.target)) throw new ResponsesValidationInterrupted("protocol");
      validateResponsesPayload(message.payload, message.target);
      let data: string;
      if (message.encoding === "utf8") {
        const max = message.target === "request" ? 32 * 1024 * 1024 : limits.retainedFrameBytes;
        if (message.payload.byteLength > max) throw new ResponsesValidationInterrupted("ipc-bytes");
        data = new TextDecoder("utf8", { ignoreBOM: message.target === "request" }).decode(message.payload);
      } else if (message.encoding === "string") {
        const value = unpackResponsesValue(message.payload, message.target);
        if (typeof value !== "string") throw new ResponsesValidationInterrupted("protocol");
        data = value;
      } else throw new ResponsesValidationInterrupted("protocol");
      let value: unknown;
      try {
        value = JSON.parse(data) as unknown;
      } catch {
        port.postMessage({
          id: message.id,
          op: "parse",
          target: message.target,
          permit: message.permit,
          phase: "reply",
          ok: false,
        });
        busy = false;
        return;
      }
      const stats = inspectResponsesGraph(value, message.target);
      prepared = { id: message.id, target: message.target, permit: message.permit, value, stats };
      port.postMessage({
        id: message.id,
        op: "parse",
        target: message.target,
        permit: message.permit,
        phase: "prepared",
        stats,
      });
      busy = false;
      return;
    }
    if (message.op === "consume") {
      if (message.target !== "frame") throw new ResponsesValidationInterrupted("protocol");
      validateResponsesPayload(message.payload, "frame");
      const event = unpackResponsesValue(message.payload, "frame");
      const accepted = await consumer.consume(event);
      port.postMessage({
        id: message.id,
        op: "consume",
        target: "frame",
        permit: message.permit,
        phase: "reply",
        accepted,
      });
    } else if (message.op === "close") {
      if (message.target !== "frame") throw new ResponsesValidationInterrupted("protocol");
      const accepted = await consumer.close();
      port.postMessage({
        id: message.id,
        op: "close",
        target: "frame",
        permit: message.permit,
        phase: "reply",
        accepted,
      });
    } else throw new ResponsesValidationInterrupted("protocol");
    busy = false;
  } catch (error) {
    failed = true;
    const kind = error instanceof ResponsesValidationInterrupted ? error.kind : "protocol";
    port.postMessage({
      id: message?.id,
      op: message?.op === "serialize" ? "parse" : message?.op,
      target: message?.target ?? "frame",
      permit: message?.permit,
      phase: "failure",
      kind,
    });
    busy = false;
  }
});
port.postMessage({ ready: true });
