// Responses stream failures cross pi as flattened text. Sign only closed wire
// codes at the proxy, before that information is lost (model-proxy item 12c).
import {
  authenticateProxyProviderFailure,
  authenticateProxyUnknownTerminal,
} from "../core/modelProxy/providerFailureAuth.js";
import { ProviderFailure, renderProviderFailure, type ProviderFailureCause } from "../core/provider.js";
import { ResponsesConsumer } from "./responsesConsumer.js";

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
  private readonly decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  private readonly encoder = new TextEncoder();
  private readonly localToolsOnly: boolean;
  private hostedOutputSeen = false;
  private dataEnded = false;
  private readonly consumer: ResponsesConsumer;
  terminal: "completed" | "incomplete" | "failed" | undefined;
  failure: ProviderFailure | undefined;

  constructor(
    request: Record<string, unknown>,
    private readonly observe: (event: Record<string, unknown>) => void = () => {},
  ) {
    this.consumer = new ResponsesConsumer(typeof request.model === "string" ? request.model : "");
    this.localToolsOnly =
      request.previous_response_id === undefined &&
      request.conversation === undefined &&
      request.background !== true &&
      (request.tools === undefined ||
        (Array.isArray(request.tools) && request.tools.every((tool) => record(tool)?.type === "function"))) &&
      (!Array.isArray(request.input) || request.input.every((item) => record(item)?.type !== "mcp_approval_response"));
  }

  transform(): TransformStream<Uint8Array, Uint8Array> {
    const consume = async (text: string, controller: TransformStreamDefaultController<Uint8Array>, final = false) => {
      let output = "";
      for (const char of text) {
        if (this.afterCarriageReturn) {
          this.afterCarriageReturn = false;
          if (char === "\n") {
            // A CRLF may straddle chunks after an already-emitted blank line.
            // Keep its LF without treating it as another line or losing a byte.
            if (this.buffer) this.buffer += char;
            else output += char;
            continue;
          }
        }
        this.buffer += char;
        if (char === "\r" || char === "\n") {
          if (decodedLine(this.line) === "") {
            output += await this.frame(this.buffer);
            this.buffer = "";
          }
          this.line = "";
          this.afterCarriageReturn = char === "\r";
        } else this.line += char;
      }
      if (final && this.buffer) {
        // The SDK flushes the final line. A BOM-only line decodes empty and
        // dispatches the preceding data, even without a final newline.
        output += this.line !== "" && decodedLine(this.line) === "" ? await this.frame(this.buffer) : this.buffer;
        this.buffer = "";
      }
      if (output) controller.enqueue(this.encoder.encode(output));
    };
    return new TransformStream({
      transform: (chunk, controller) => consume(this.decoder.decode(chunk, { stream: true }), controller),
      flush: async (controller) => {
        await consume(this.decoder.decode(), controller, true);
        if (!(await this.consumer.close()) && this.terminal !== "failed") {
          this.terminal = "failed";
          this.failure = undefined;
        }
      },
    });
  }

  private async unknown(): Promise<string> {
    this.terminal = "failed";
    this.failure = undefined;
    this.dataEnded = true;
    await this.consumer.close();
    // Preserve the consumer's fatal ending, including for malformed thread
    // wrappers. Its replacement must not inherit the wrapper's event name.
    return `data: ${JSON.stringify({ type: "error", code: "unclassified_stream_failure", message: JSON.stringify(authenticateProxyUnknownTerminal()), param: null })}\n\n`;
  }

  private async frame(frame: string): Promise<string> {
    const lines = frame.split(/\r\n|\r|\n/);
    const fields = lines.map(fieldOf);
    const data = fields
      .filter((field) => field.name === "data")
      .map((field) => field.value)
      .join("\n");
    if (this.dataEnded) return frame;
    if (data.startsWith("[DONE]")) {
      this.dataEnded = true;
      return frame;
    }
    const eventName = fields.filter((field) => field.name === "event").at(-1)?.value;
    const hasData = fields.some((field) => field.name === "data");
    if (!hasData && !eventName) return frame;
    let value: unknown;
    let event: Record<string, unknown> | undefined;
    try {
      value = JSON.parse(data);
      event = record(value);
    } catch {
      return this.unknown();
    }
    // Valid thread wrappers are ignored by pi; malformed JSON still fails in
    // the SDK before it creates that wrapper.
    if (eventName?.startsWith("thread.")) return frame;
    if (!event) return (await this.consumer.consume(value)) ? frame : this.unknown();
    const response = record(event.response);
    const terminalOutputValid =
      response?.output === undefined ||
      response.output === null ||
      (Array.isArray(response.output) && response.output.every((item) => typeof record(item)?.type === "string"));
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      if (!localOutputItem(event.item)) this.hostedOutputSeen = true;
    }
    const sdkError = Boolean(event.error);
    if (
      !sdkError &&
      event.type === "response.completed" &&
      response?.status === "completed" &&
      terminalOutputValid &&
      this.terminal === undefined
    ) {
      if (!(await this.consumer.consume(event))) return this.unknown();
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
    if (!sdkError && event.type === "response.incomplete" && !incomplete && this.terminal === undefined) {
      if (!(await this.consumer.consume(event))) return this.unknown();
      this.terminal = "incomplete";
      this.observe(event);
      return frame;
    }
    const malformedCompletion = event.type === "response.completed";
    if (!sdkError && !failed && !incomplete && !malformedCompletion && event.type !== "error") {
      if (!(await this.consumer.consume(event))) return this.unknown();
      this.observe(event);
      return frame;
    }
    const firstTerminal = this.terminal === undefined;
    this.terminal = "failed";
    const error = failed ? record(response?.error) : event;
    const code = error?.code;
    const cause = typeof code === "string" && Object.hasOwn(CAUSES, code) ? CAUSES[code] : undefined;
    const output = response?.output;
    const localOutputOnly = output === undefined || (Array.isArray(output) && output.every(localOutputItem));
    const verified =
      firstTerminal &&
      !sdkError &&
      !malformedCompletion &&
      !this.hostedOutputSeen &&
      !incomplete &&
      cause &&
      this.localToolsOnly &&
      localOutputOnly &&
      (!failed || response?.status === "failed");
    let replacementCode = "unclassified_stream_failure";
    let message = JSON.stringify(authenticateProxyUnknownTerminal());
    if (verified) {
      this.failure = new ProviderFailure(cause);
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
      failed && !sdkError
        ? {
            type: "response.failed",
            response: {
              status: "failed",
              error: { code: replacementCode, message },
              ...(response?.usage !== undefined ? { usage: response.usage } : {}),
            },
          }
        : { type: "error", code: replacementCode, message, param: null };
    // This is the deliberately typed terminal failure, not an exception from
    // an earlier consumer event. Stop eligibility before any following tail.
    await this.consumer.consume(replacement);
    this.dataEnded = true;
    this.observe(replacement);
    let replaced = false;
    return lines
      .flatMap((line) => {
        if (fieldOf(line).name !== "data") return [line];
        if (replaced) return [];
        replaced = true;
        return [`data: ${JSON.stringify(replacement)}`];
      })
      .join(frame.includes("\r\n") ? "\r\n" : frame.includes("\r") ? "\r" : "\n");
  }
}
