import type { Wire } from "./provider.js";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/** The one measured mismatch between the operator's emitted catalogue and
 * the Responses schema parser: ECMAScript lookahead/lookbehind syntax. This is
 * not an exhaustive validator vocabulary; an unmeasured mismatch is covered by
 * the operator's authenticated schema-rejection re-ask. Plain patterns stay
 * native, and this unsupported constraint degrades to the tool's validation. */
function responsesRejectsPattern(pattern: string): boolean {
  return /\(\?(?:[=!]|<[=!])/.test(pattern);
}

export interface ToolSchemaDegradation {
  tool: string;
  keyword: string;
  why: string;
}

function shapeResponsesSchema(
  value: unknown,
  tool: string,
  degradations: ToolSchemaDegradation[],
): { value: unknown; changed: boolean } {
  const schema = record(value);
  if (!schema) {
    if (!Array.isArray(value)) return { value, changed: false };
    let changed = false;
    const items = value.map((item) => {
      const shaped = shapeResponsesSchema(item, tool, degradations);
      changed ||= shaped.changed;
      return shaped.value;
    });
    return { value: changed ? items : value, changed };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [keyword, item] of Object.entries(schema)) {
    if (keyword === "pattern" && typeof item === "string" && responsesRejectsPattern(item)) {
      degradations.push({
        tool,
        keyword,
        why: "the Responses wire does not accept regular-expression lookaround",
      });
      changed = true;
      continue;
    }
    if ((keyword === "properties" || keyword === "$defs" || keyword === "definitions") && record(item)) {
      let mapChanged = false;
      const mapped: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(record(item)!)) {
        const shaped = shapeResponsesSchema(child, tool, degradations);
        mapChanged ||= shaped.changed;
        mapped[name] = shaped.value;
      }
      out[keyword] = mapChanged ? mapped : item;
      changed ||= mapChanged;
      continue;
    }
    if (
      ["additionalProperties", "allOf", "anyOf", "if", "items", "not", "oneOf", "then", "else"].includes(keyword) &&
      typeof item === "object" &&
      item !== null
    ) {
      const shaped = shapeResponsesSchema(item, tool, degradations);
      out[keyword] = shaped.value;
      changed ||= shaped.changed;
      continue;
    }
    out[keyword] = item;
  }
  return { value: changed ? out : value, changed };
}

/** Per-wire schema shaping. Other dialects retain their schemas byte for byte;
 * Responses loses only constructs its validator cannot parse, with one typed
 * degradation per tool and keyword for the run record. */
export function shapeToolSchemasForWire(
  shape: Wire,
  body: Record<string, unknown>,
): { body: Record<string, unknown>; degradations: ToolSchemaDegradation[] } {
  if (shape !== "openai-responses" || !Array.isArray(body.tools)) return { body, degradations: [] };
  const degradations: ToolSchemaDegradation[] = [];
  let changed = false;
  const tools = body.tools.map((item) => {
    const tool = record(item);
    if (!tool) return item;
    const name = typeof tool.name === "string" ? tool.name : "unnamed";
    const shaped = shapeResponsesSchema(tool.parameters, name, degradations);
    if (!shaped.changed) return item;
    changed = true;
    return { ...tool, parameters: shaped.value };
  });
  const unique = degradations.filter(
    (candidate, index, all) =>
      all.findIndex((other) => other.tool === candidate.tool && other.keyword === candidate.keyword) === index,
  );
  return { body: changed ? { ...body, tools } : body, degradations: unique };
}
