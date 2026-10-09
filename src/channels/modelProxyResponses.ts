// Responses stream failures cross pi as flattened text. Sign only closed wire
// codes at the proxy, before that information is lost (model-proxy item 12c).
import {
  authenticateProxyProviderFailure,
  authenticateProxyUnknownTerminal,
  type ProxyUnknownTerminalReason,
  type ProxyRejectionObservation,
} from "../core/modelProxy/providerFailureAuth.js";
import { ProviderFailure, renderProviderFailure, type ProviderFailureCause } from "../core/provider.js";
import { setImmediate as yieldToIo } from "node:timers/promises";
import { RESPONSES_VALIDATION_LIMITS } from "../core/budgets.js";
import { ResponsesConsumer, type ResponsesConsumerOptions } from "./responsesConsumer.js";
import { responsesTextCharge } from "./responsesResources.js";
import {
  ResponsesValidationInterrupted,
  responsesValidationCapacity,
  type ResponsesStoragePermit,
  type ValidationInterruption,
} from "./responsesValidationCapacity.js";

interface ResponsesFailureBoundaryOptions extends ResponsesConsumerOptions {
  consumer?: ResponsesConsumer;
  onValidationInterruption?: (kind: ValidationInterruption) => void;
  onSourceSettled?: () => void;
  /** The proxy counted this source before any clone/decoder; direct callers count here. */
  responseInterruption?: () => ResponsesValidationInterrupted | undefined;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const CAUSES: Readonly<Record<string, ProviderFailureCause>> = {
  server_error: "transient",
  rate_limit_exceeded: "rate-limited",
  invalid_prompt: "request-rejected",
};
const LOCAL_OUTPUT = new Set(["message", "reasoning", "function_call"]);
const localOutputItem = (item: unknown): boolean => {
  const type = record(item)?.type;
  return typeof type === "string" && LOCAL_OUTPUT.has(type);
};
// The pinned SDK decodes UTF-8 separately for every line, stripping its BOM.
const decodedLine = (line: string): string => (line.startsWith("\uFEFF") ? line.slice(1) : line);
const fieldOf = (raw: string): { name: string; value: string } => {
  const line = decodedLine(raw);
  const colon = line.indexOf(":");
  return colon < 0
    ? { name: line, value: "" }
    : { name: line.slice(0, colon), value: line.slice(colon + 1).replace(/^ /, "") };
};

/** No streamed request is retried here. Only function-only requests may hand
 * a typed failure to the harness's existing retry window; hosted effects may
 * already have happened even when pi has executed no tool. */
export class ResponsesFailureBoundary {
  private buffer = "";
  private line = "";
  private afterCarriageReturn = false;
  private retainedBytes = 0;
  private responseBytes = 0;
  private fieldCount = 0;
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly encoder = new TextEncoder();
  private readonly localToolsOnly: boolean;
  private hostedOutputSeen = false;
  private dataEnded = false;
  private readonly consumer: ResponsesConsumer;
  terminal: "completed" | "incomplete" | "failed" | undefined;
  failure: ProviderFailure | undefined;
  private interrupted = false;
  private disposed = false;
  private readonly signal?: AbortSignal;
  private readonly onValidationInterruption?: (kind: ValidationInterruption) => void;
  private readonly onSourceSettled?: () => void;
  private readonly responseInterruption?: () => ResponsesValidationInterrupted | undefined;
  private readonly storageOwner: Pick<typeof responsesValidationCapacity, "reserveStorage">;
  private readonly reservationOwned: boolean;
  private readonly endingOwner?: ResponsesConsumerOptions["reservation"];
  private authenticatedEnding?: string;
  private endingStorage?: ResponsesStoragePermit;
  private endingSent = false;
  private frameStorage?: ResponsesStoragePermit;
  private readonly outputStorage = new Set<ResponsesStoragePermit>();
  private readonly outputPermits = new WeakMap<Uint8Array, readonly ResponsesStoragePermit[]>();

  constructor(
    request: Record<string, unknown>,
    private readonly observe: (event: Record<string, unknown>) => void = () => {},
    options: ResponsesFailureBoundaryOptions = {},
  ) {
    this.consumer =
      options.consumer ?? new ResponsesConsumer(typeof request.model === "string" ? request.model : "", options);
    this.signal = options.signal;
    this.onValidationInterruption = options.onValidationInterruption;
    this.onSourceSettled = options.onSourceSettled;
    this.responseInterruption = options.responseInterruption;
    this.storageOwner = options.reservation ?? options.capacity ?? responsesValidationCapacity;
    this.reservationOwned = options.reservation !== undefined;
    this.endingOwner = options.reservation;
    this.localToolsOnly =
      request.previous_response_id === undefined &&
      request.conversation === undefined &&
      request.background !== true &&
      (request.tools === undefined ||
        (Array.isArray(request.tools) && request.tools.every((tool) => record(tool)?.type === "function"))) &&
      (!Array.isArray(request.input) || request.input.every((item) => record(item)?.type !== "mcp_approval_response"));
  }

  pipe(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    const pair = this.createTransform(reader.closed);
    const input = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              reader.releaseLock();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            reader.releaseLock();
          }
        },
        cancel: async (reason) => {
          try {
            await reader.cancel(reason);
          } finally {
            reader.releaseLock();
          }
        },
      },
      { highWaterMark: 0 },
    );
    const settled = () => {
      this.buffer = "";
      this.line = "";
      this.frameStorage?.release();
      try {
        this.onSourceSettled?.();
      } catch {
        // A cleanup observer cannot replace the stream's settled outcome.
      }
    };
    const piping = input.pipeTo(pair.writable);
    void piping.then(settled, settled);
    return pair.readable;
  }

  transform(): ReadableWritablePair<Uint8Array, Uint8Array> {
    return this.createTransform();
  }
  releaseOutput(bytes: Uint8Array): void {
    const permits = this.outputPermits.get(bytes);
    if (!permits) return;
    for (const permit of permits) {
      permit.release();
      this.outputStorage.delete(permit);
    }
    this.outputPermits.delete(bytes);
  }

  private createTransform(sourceClosed?: Promise<void>): ReadableWritablePair<Uint8Array, Uint8Array> {
    let sourceFailed = false;
    const consume = async (
      bytes: Uint8Array,
      controller: TransformStreamDefaultController<Uint8Array>,
      final = false,
    ) => {
      const output: Array<{ text: string; permit: ResponsesStoragePermit }> = [];
      let outputBytes = 0;
      const appendOutput = (value: string | { text: string; permit: ResponsesStoragePermit }) => {
        const text = typeof value === "string" ? value : value.text;
        const size = Buffer.byteLength(text, "utf8");
        if (outputBytes + size > RESPONSES_VALIDATION_LIMITS.pendingOutputBytes)
          throw new ResponsesValidationInterrupted("output-bytes");
        if (typeof value === "string" && text === "\n" && output.length) {
          const previous = output[output.length - 1],
            old = previous.text;
          const encoded = Buffer.byteLength(old, "utf8") + size;
          // Preserve a CRLF received in one write. Reserve both live texts
          // and their joined copy before concatenating, then retire the old copy.
          previous.permit.resize(
            responsesTextCharge(old) +
              responsesTextCharge(text) +
              (old.length + text.length) * 2 +
              RESPONSES_VALIDATION_LIMITS.stringHeaderBytes +
              encoded,
          );
          const joined = old + text;
          previous.text = joined;
          if (old === this.authenticatedEnding) this.authenticatedEnding = joined;
          previous.permit.resize(responsesTextCharge(joined) + encoded);
          outputBytes += size;
          return;
        }
        const permit =
          typeof value === "string"
            ? this.storageOwner.reserveStorage(responsesTextCharge(text) + size, "pending-encoded-output")
            : value.permit;
        this.trackOutput(permit);
        output.push({ text, permit });
        outputBytes += size;
      };
      const flushOutput = () => {
        if (!output.length || sourceFailed) return;
        // All pieces already own their encoded bytes. Encode into one whole
        // backing without allocating a joined string or changing write boundaries.
        const encoded = new Uint8Array(outputBytes);
        let offset = 0;
        for (const piece of output) {
          const result = this.encoder.encodeInto(piece.text, encoded.subarray(offset));
          if (result.read !== piece.text.length) throw new ResponsesValidationInterrupted("protocol");
          offset += result.written;
        }
        if (offset !== outputBytes) throw new ResponsesValidationInterrupted("protocol");
        controller.enqueue(encoded);
        const permits = output.map((piece) => piece.permit);
        for (const piece of output) {
          piece.permit.transfer("response-output");
          if (piece.text === this.authenticatedEnding) {
            this.endingSent = true;
            this.authenticatedEnding = undefined;
            this.endingStorage = undefined;
          }
        }
        this.outputPermits.set(encoded, permits);
        output.length = 0;
        outputBytes = 0;
      };
      const charge = (size: number, retained: boolean) => {
        if (!this.responseInterruption && this.responseBytes + size > RESPONSES_VALIDATION_LIMITS.responseBytes)
          throw new ResponsesValidationInterrupted("stream-bytes");
        if (retained && this.retainedBytes + size > RESPONSES_VALIDATION_LIMITS.retainedFrameBytes)
          throw new ResponsesValidationInterrupted("frame-bytes");
        this.responseBytes += size;
        if (retained) this.retainedBytes += size;
        if (retained) {
          this.frameStorage ??= this.storageOwner.reserveStorage(0, "retained-frame-text");
          this.frameStorage.resize(this.retainedBytes * 4 + RESPONSES_VALIDATION_LIMITS.stringHeaderBytes * 2);
        }
      };
      try {
        const stopped = this.responseInterruption?.();
        if (stopped) throw stopped;
        for (let at = 0; at < bytes.length;) {
          if (this.disposed || this.signal?.aborted) throw new ResponsesValidationInterrupted("aborted");
          if (this.afterCarriageReturn) {
            this.afterCarriageReturn = false;
            if (bytes[at] === 10) {
              charge(1, this.buffer !== "");
              // The CR already dispatched its blank line. This LF is emitted
              // separately unless the frame is still retained.
              const newline = this.decoder.decode(bytes.subarray(at, at + 1), { stream: true });
              if (this.buffer) this.buffer += newline;
              else appendOutput(newline);
              at++;
              continue;
            }
          }
          const cr = bytes.indexOf(13, at),
            lf = bytes.indexOf(10, at);
          const end = cr < 0 ? lf : lf < 0 ? cr : Math.min(cr, lf);
          const stop = end < 0 ? bytes.length : end + 1;
          charge(stop - at, true);
          const text = this.decoder.decode(bytes.subarray(at, stop), { stream: true });
          this.buffer += text;
          this.line += end < 0 ? text : text.slice(0, -1);
          if (end >= 0) {
            if (decodedLine(this.line) === "") {
              appendOutput(await this.frame(this.buffer));
              this.buffer = "";
              this.retainedBytes = 0;
              this.frameStorage?.resize(0);
              this.fieldCount = 0;
            } else if (++this.fieldCount > RESPONSES_VALIDATION_LIMITS.sseFields) {
              throw new ResponsesValidationInterrupted("fields");
            }
            this.line = "";
            this.afterCarriageReturn = bytes[end] === 13;
          }
          at = stop;
        }
        await yieldToIo();
        if (final) {
          const stopped = this.responseInterruption?.();
          if (stopped) throw stopped;
          // EOF may flush pending UTF8 bytes; they were charged on arrival.
          const tail = this.decoder.decode();
          this.buffer += tail;
          this.line += tail;
          if (this.buffer) {
            const blank = this.line !== "" && decodedLine(this.line) === "";
            if (!blank && this.line !== "" && ++this.fieldCount > RESPONSES_VALIDATION_LIMITS.sseFields)
              throw new ResponsesValidationInterrupted("fields");
            appendOutput(blank ? await this.frame(this.buffer) : this.buffer);
            this.buffer = "";
            this.retainedBytes = 0;
            this.line = "";
            this.frameStorage?.resize(0);
            this.fieldCount = 0;
          }
        }
        flushOutput();
      } catch (error) {
        // A validated first failure must cross before a later local stop.
        try {
          flushOutput();
        } catch (outputError) {
          if (this.authenticatedEnding && this.endingOwner && !this.endingSent && !sourceFailed) {
            this.emitEnding(controller);
          } else throw outputError;
        }
        throw error;
      }
    };
    const interrupt = async (
      error: ResponsesValidationInterrupted,
      controller: TransformStreamDefaultController<Uint8Array>,
    ) => {
      this.interrupted = true;
      if (this.terminal === "failed") {
        await this.dispose();
        if (this.authenticatedEnding && !this.endingSent && !sourceFailed) this.emitEnding(controller);
        if (sourceFailed) return;
        this.notifyInterruption(error.kind);
        if (!this.endingSent) {
          controller.error(error);
          return;
        }
        controller.terminate();
        return;
      }
      await this.unknown("consumer_rejected", { phase: "response_validation", kind: error.kind });
      if (sourceFailed) return;
      this.notifyInterruption(error.kind);
      this.emitEnding(controller);
      controller.terminate();
    };
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        // PipeTo waits for a pending write before aborting its destination.
        // The same source reader observes failure without waiting for that write.
        void sourceClosed?.catch((error: unknown) => {
          sourceFailed = true;
          controller.error(error);
          return this.dispose();
        });
        void sourceClosed?.then(
          () => {
            if (this.responseInterruption?.()) return this.dispose();
          },
          () => {},
        );
      },
      transform: async (chunk, controller) => {
        if (this.interrupted) return;
        try {
          await consume(chunk, controller);
        } catch (error) {
          if (sourceFailed) return;
          if (!(error instanceof ResponsesValidationInterrupted)) throw error;
          await interrupt(error, controller);
        }
      },
      flush: async (controller) => {
        if (this.interrupted) return;
        try {
          await consume(new Uint8Array(), controller, true);
          if (this.terminal === "failed") await this.consumer.dispose();
          else await this.consumer.finish();
        } catch (error) {
          if (sourceFailed) return;
          if (!(error instanceof ResponsesValidationInterrupted)) throw error;
          await interrupt(error, controller);
        }
      },
    });
    // Cancellation does not invoke TransformStream.flush. Release the validator
    // independently of model completion, including an unfinished frame or event.
    const reader = transform.readable.getReader();
    const writer = transform.writable.getWriter();
    return {
      writable: new WritableStream<Uint8Array>({
        start: (controller) => {
          // Native abort notification precedes the sink abort callback, which
          // waits for an in-flight write. Stop its validator at notification.
          const abort = () => {
            void this.dispose();
          };
          controller.signal.addEventListener("abort", abort, { once: true });
          const detach = () => controller.signal.removeEventListener("abort", abort);
          void writer.closed.then(detach, detach);
          void writer.closed.catch((error: unknown) => {
            controller.error(error);
            return this.dispose();
          });
        },
        write: async (chunk) => {
          for (let at = 0; at < chunk.byteLength; at += RESPONSES_VALIDATION_LIMITS.framingSliceBytes) {
            await writer.write(chunk.subarray(at, at + RESPONSES_VALIDATION_LIMITS.framingSliceBytes));
          }
        },
        close: () => writer.close(),
        abort: async (reason) => {
          const aborted = writer.abort(reason);
          await this.dispose();
          await aborted;
          this.frameStorage?.release();
          if (!this.reservationOwned) for (const permit of this.outputStorage) permit.release();
        },
      }),
      readable: new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            try {
              const next = await reader.read();
              if (!this.reservationOwned && next.value) {
                this.releaseOutput(next.value);
              }
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) {
              await this.dispose();
              controller.error(error);
            }
          },
          cancel: async (reason) => {
            const cancelled = reader.cancel(reason);
            await this.dispose();
            await cancelled;
            this.frameStorage?.release();
            if (!this.reservationOwned) for (const permit of this.outputStorage) permit.release();
          },
        },
        { highWaterMark: 0 },
      ),
    };
  }

  private emitEnding(controller: TransformStreamDefaultController<Uint8Array>): void {
    const ending = this.authenticatedEnding;
    if (ending === undefined) throw new ResponsesValidationInterrupted("protocol");
    const charge = responsesTextCharge(ending) + Buffer.byteLength(ending, "utf8");
    if (this.endingStorage) this.endingStorage.resize(charge);
    else this.endingOwner?.claimEndingStorage(charge);
    const encoded = this.encoder.encode(ending);
    controller.enqueue(encoded);
    if (this.endingStorage) {
      this.outputPermits.set(encoded, [this.endingStorage]);
      this.endingStorage.transfer("response-output");
      this.endingStorage = undefined;
    }
    this.endingSent = true;
    this.authenticatedEnding = undefined;
  }

  private notifyInterruption(kind: ValidationInterruption): void {
    try {
      this.onValidationInterruption?.(kind);
    } catch {
      // Diagnostics cannot change the signed stream outcome.
    }
  }

  private async unknown(reason: ProxyUnknownTerminalReason, rejection?: ProxyRejectionObservation): Promise<string> {
    this.terminal = "failed";
    this.failure = undefined;
    this.dataEnded = true;
    if (this.interrupted) await this.dispose();
    else await this.consumer.dispose();
    // Preserve the first wire failure. Its signed replacement must not inherit
    // a provider-controlled wrapper event name.
    this.authenticatedEnding = `data: ${JSON.stringify({ type: "error", code: "unclassified_stream_failure", message: JSON.stringify(authenticateProxyUnknownTerminal(reason, rejection)), param: null })}\n\n`;
    return this.authenticatedEnding;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.consumer.dispose();
  }

  private trackOutput(permit: ResponsesStoragePermit): void {
    if (this.outputStorage.has(permit)) return;
    this.outputStorage.add(permit);
    permit.onRelease(() => this.outputStorage.delete(permit));
  }

  private checkFrameOutput(text: string): string {
    if (Buffer.byteLength(text, "utf8") > RESPONSES_VALIDATION_LIMITS.pendingOutputBytes)
      throw new ResponsesValidationInterrupted("output-bytes");
    return text;
  }

  private async frame(frame: string): Promise<{ text: string; permit: ResponsesStoragePermit }> {
    // The preceding data-line binding is already cleared at a complete
    // delimiter. Keep both remaining strings, including a BOM-only EOF line.
    this.frameStorage?.resize(responsesTextCharge(this.buffer) + responsesTextCharge(this.line));
    // Complete-frame output is admitted before fields, parsing, terminal or usage witness. Another owner cannot spend its delivery credit.
    const outputPermit = this.storageOwner.reserveStorage(
      3 * RESPONSES_VALIDATION_LIMITS.pendingOutputBytes + RESPONSES_VALIDATION_LIMITS.stringHeaderBytes,
      "frame-output-admission",
    );
    this.trackOutput(outputPermit);
    let fieldsPermit: ResponsesStoragePermit | undefined,
      delivered = false;
    try {
      fieldsPermit = this.storageOwner.reserveStorage(
        (this.fieldCount + 3) * RESPONSES_VALIDATION_LIMITS.graphEntryBytes + this.retainedBytes * 2,
        "frame-fields-and-data",
      );
      const text = this.checkFrameOutput(await this.frameOwned(frame, outputPermit));
      outputPermit.resize(responsesTextCharge(text) + Buffer.byteLength(text, "utf8"));
      outputPermit.transfer("validated-frame-output");
      if (text === this.authenticatedEnding) this.endingStorage = outputPermit;
      delivered = true;
      return { text, permit: outputPermit };
    } finally {
      fieldsPermit?.release();
      if (!delivered && this.endingStorage !== outputPermit) outputPermit.release();
    }
  }

  private async frameOwned(frame: string, outputPermit: ResponsesStoragePermit): Promise<string> {
    const lines = frame.split(/\r\n|\r|\n/);
    const fields = lines.map(fieldOf);
    const data = fields
      .filter((field) => field.name === "data")
      .map((field) => field.value)
      .join("\n");
    if (this.dataEnded) return this.checkFrameOutput(frame);
    if (data.startsWith("[DONE]")) {
      this.checkFrameOutput(frame);
      this.dataEnded = true;
      return frame;
    }
    const eventName = fields.filter((field) => field.name === "event").at(-1)?.value;
    const hasData = fields.some((field) => field.name === "data");
    if (!hasData && !eventName) return this.checkFrameOutput(frame);
    const parsed = await this.consumer.parseJSON(data);
    if (!parsed.ok) return this.unknown("malformed_json");
    try {
      const value = parsed.value;
      const event = record(value);
      // Thread wrappers are not model events; malformed JSON still fails before
      // any wire fact is admitted for forwarding.
      if (eventName?.startsWith("thread.")) return this.checkFrameOutput(frame);
      if (!event || typeof event.type !== "string") return this.unknown("unverified_terminal");
      const response = record(event.response);
      const terminalOutputValid =
        response?.output === undefined ||
        response.output === null ||
        (Array.isArray(response.output) && response.output.every((item) => typeof record(item)?.type === "string"));
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        if (!localOutputItem(event.item)) this.hostedOutputSeen = true;
      }
      const wireError = Boolean(event.error);
      if (
        !wireError &&
        event.type === "response.completed" &&
        response?.status === "completed" &&
        terminalOutputValid &&
        this.terminal === undefined
      ) {
        this.checkFrameOutput(frame);
        this.terminal = "completed";
        this.observe(event);
        return frame;
      }
      const failed = event.type === "response.failed";
      const incomplete =
        event.type === "response.incomplete" &&
        (response?.status !== "incomplete" ||
          !terminalOutputValid ||
          record(response?.incomplete_details)?.reason !== "max_output_tokens");
      if (!wireError && event.type === "response.incomplete" && !incomplete && this.terminal === undefined) {
        this.checkFrameOutput(frame);
        this.terminal = "incomplete";
        this.observe(event);
        return frame;
      }
      const malformedCompletion = event.type === "response.completed";
      if (!wireError && !failed && !incomplete && !malformedCompletion && event.type !== "error") {
        this.checkFrameOutput(frame);
        this.observe(event);
        return frame;
      }
      const firstTerminal = this.terminal === undefined;
      const error = failed ? record(response?.error) : event;
      const code = error?.code;
      const cause = typeof code === "string" && Object.hasOwn(CAUSES, code) ? CAUSES[code] : undefined;
      const output = response?.output;
      const localOutputOnly = output === undefined || (Array.isArray(output) && output.every(localOutputItem));
      const verified =
        firstTerminal &&
        !wireError &&
        !malformedCompletion &&
        !this.hostedOutputSeen &&
        !incomplete &&
        cause &&
        this.localToolsOnly &&
        localOutputOnly &&
        (!failed || response?.status === "failed");
      let replacementCode = "unclassified_stream_failure";
      let message = JSON.stringify(authenticateProxyUnknownTerminal("unverified_terminal"));
      const failure = verified ? new ProviderFailure(cause) : undefined;
      if (verified) {
        replacementCode = "provider_failure";
        message = JSON.stringify(
          authenticateProxyProviderFailure({
            type: "provider_failure",
            cause,
            message: renderProviderFailure(cause, "parked"),
          }),
        );
      }
      // Never relay provider error prose here: it could replay an earlier signed
      // envelope, which authenticates its origin but not this particular call.
      const replacement =
        failed && !wireError
          ? {
              type: "response.failed",
              response: {
                status: "failed",
                error: { code: replacementCode, message },
                ...(response?.usage !== undefined ? { usage: response.usage } : {}),
              },
            }
          : { type: "error", code: replacementCode, message, param: null };
      let replaced = false;
      const ending = lines
        .flatMap((line) => {
          if (fieldOf(line).name !== "data") return [line];
          if (replaced) return [];
          replaced = true;
          return [`data: ${JSON.stringify(replacement)}`];
        })
        .join(frame.includes("\r\n") ? "\r\n" : frame.includes("\r") ? "\r" : "\n");
      this.checkFrameOutput(ending);
      // The complete ending was pre-admitted before even parsing this frame.
      // Establish its witness only after its actual bounded output is known.
      this.endingStorage = outputPermit;
      this.authenticatedEnding = ending;
      this.terminal = "failed";
      this.failure = failure;
      this.dataEnded = true;
      this.observe(replacement);
      this.authenticatedEnding = ending;
      return ending;
    } finally {
      parsed.release?.();
    }
  }
}
