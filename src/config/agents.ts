import { z } from "zod";
import BUILTIN from "../agents/defaults.json" with { type: "json" };
import { AGENTS, getAgent, conductorSystem, MACHINE_CLASSES, IDENTITIES, type AgentDef } from "../agents/registry.js";
import { runawayTurnCap } from "../core/budgets.js";
import { EFFORT_LEVELS, type Effort } from "../effort.js";
import type { AppConfig } from "../config.js";
import {
  resourceLifetimeSchema,
  resourceLifetimeOrRetained,
  sameResourceLifetime,
} from "../agents/resourceLifetime.js";

const limits = z.strictObject({
  maxTokens: z.number().int().positive().optional(),
  maxMinutes: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
});
const settings = {
  model: z
    .string()
    .regex(/^[^/\s]+\/[\s\S]+$/)
    .optional(),
  modelSettings: z
    .strictObject({
      reasoning: z.strictObject({ effort: z.enum(EFFORT_LEVELS).nullable().optional() }).optional(),
    })
    .optional(),
  harness: z.enum(["pi", "opencode"]).optional(),
};
const profile = z.strictObject({ extends: z.string().min(1).optional(), ...settings });
const agent = z.strictObject({
  profile: z.string().min(1).optional(),
  ...settings,
  limits: limits.optional(),
  description: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  tools: z.enum(["full", "readonly", "web", "assistant", "explore", "conductor", "orchestrator", "none"]).optional(),
  machine: z.enum(MACHINE_CLASSES).optional(),
  identity: z.enum(IDENTITIES).optional(),
  resourceLifetime: resourceLifetimeSchema.optional(),
  tiers: z.array(z.enum(["fast", "strong"])).optional(),
  routable: z.boolean().optional(),
});

/** Both shipped defaults and installation extensions use this schema. */
export const agentConfigSchema = z.strictObject({
  extends: z.literal("builtin").optional(),
  profiles: z.record(z.string().min(1), profile).optional(),
  agentDefaults: z.strictObject({ profile: z.string().min(1).optional(), ...settings }).optional(),
  agents: z.record(z.string().min(1), agent).optional(),
});
export type AgentConfiguration = z.infer<typeof agentConfigSchema>;
type Settings = z.infer<typeof agent>;
const shipped = agentConfigSchema.parse(BUILTIN);
export const AGENT_CONFIG_NAMES = Object.keys(shipped.agents!);

/** Maps merge recursively; scalars, arrays and explicit null replace. */
function merge<T>(base: T, overlay: Partial<T>): T {
  const result = structuredClone(base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overlay)) {
    const old = result[key];
    result[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      old &&
      typeof old === "object" &&
      !Array.isArray(old)
        ? merge(old, value)
        : structuredClone(value);
  }
  return result as T;
}

function resolveProfile(config: AgentConfiguration, name: string, path: string[] = []): Settings {
  if (path.includes(name)) throw new Error(`profiles: inheritance cycle ${[...path, name].join(" -> ")}`);
  const found = config.profiles?.[name];
  if (!found) throw new Error(`profiles: unknown profile "${name}"`);
  const { extends: parent, ...own } = found;
  return merge(parent ? resolveProfile(config, parent, [...path, name]) : {}, own);
}

function resolveSettings(config: AgentConfiguration, name: string): Settings {
  const defaults = config.agentDefaults ?? {};
  const own = config.agents?.[name] ?? {};
  const selected = own.profile ?? defaults.profile;
  const { profile: _defaultProfile, ...defaultSettings } = defaults;
  const { profile: _agentProfile, ...ownSettings } = own;
  return merge(merge(defaultSettings, selected ? resolveProfile(config, selected) : {}), ownSettings);
}

/** Compile once at the load boundary. Legacy fields below are a runtime
 * projection for existing consumers, never a second authoring source. */
export function normalizeAgentConfig(value: unknown): AppConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("config.yaml must be a mapping");
  const input = value as AppConfig;
  const keys = ["extends", "profiles", "agentDefaults", "agents"] as const;
  if (!keys.some((key) => Object.hasOwn(input, key))) return input;
  if (
    input.defaults?.models !== undefined ||
    input.defaults?.efforts !== undefined ||
    input.harness !== undefined ||
    input.intake?.model !== undefined ||
    input.intake?.effort !== undefined ||
    input.memory?.model !== undefined ||
    input.memory?.effort !== undefined
  )
    throw new Error("config.yaml: cannot mix agent DSL with legacy model, effort or harness settings");
  const extension = agentConfigSchema.parse(
    Object.fromEntries(keys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]])),
  );
  if (extension.extends !== "builtin") throw new Error("config.yaml: agent DSL requires extends: builtin");
  const effective = merge(shipped, extension);
  for (const name of Object.keys(effective.profiles ?? {})) resolveProfile(effective, name);
  for (const name of Object.keys(effective.agents ?? {})) {
    if (!AGENT_CONFIG_NAMES.includes(name)) throw new Error(`agents: unknown agent "${name}"`);
    if (
      name === "ship" &&
      ["instructions", "tools", "limits", "harness"].some((key) => Object.hasOwn(extension.agents?.ship ?? {}, key))
    )
      throw new Error("agents.ship: configure the deterministic workflow under ship, not as a model loop");
    // Placement and authority belong to registered capabilities, not a profile.
    for (const key of ["machine", "identity", "tiers", "routable"] as const)
      if (
        extension.agents?.[name]?.[key] !== undefined &&
        JSON.stringify(extension.agents[name]![key]) !== JSON.stringify(shipped.agents?.[name]?.[key])
      )
        throw new Error(`agents.${name}.${key}: registered capability cannot be changed`);
    if (
      extension.agents?.[name]?.resourceLifetime !== undefined &&
      !sameResourceLifetime(extension.agents[name]!.resourceLifetime, shipped.agents?.[name]?.resourceLifetime)
    )
      throw new Error(`agents.${name}.resourceLifetime: registered capability cannot be changed`);
  }
  const resolved: Record<string, Settings> = {};
  const models: Record<string, string> = {};
  const efforts: Record<string, Effort> = {};
  const harness: Record<string, "pi" | "opencode"> = {};
  for (const name of AGENT_CONFIG_NAMES) {
    const entry = resolveSettings(effective, name);
    if (!entry.model || !input.providers?.[entry.model.split("/")[0]!])
      throw new Error(`agents.${name}.model: declare the provider for ${entry.model ?? "missing model"}`);
    const builtin = AGENTS[name];
    if (entry.instructions?.startsWith("builtin:") && entry.instructions !== `builtin:${name}`)
      throw new Error(`agents.${name}.instructions: unknown builtin instruction reference`);
    if (builtin && (entry.limits?.maxMinutes ?? builtin.maxMinutes) > builtin.maxMinutes)
      throw new Error(`agents.${name}.limits.maxMinutes: cannot exceed the shipped lease`);
    if (!builtin && ["instructions", "tools", "description", "limits"].some((key) => Object.hasOwn(entry, key)))
      throw new Error(`agents.${name}: internal caller supports model settings only`);
    resolved[name] = { ...entry, profile: effective.agents?.[name]?.profile ?? effective.agentDefaults?.profile };
    if (builtin) models[name] = entry.model;
    if (builtin && entry.modelSettings?.reasoning?.effort != null) efforts[name] = entry.modelSettings.reasoning.effort;
    if (entry.harness && builtin) harness[name] = entry.harness;
  }
  const memory = resolved.memory!;
  const intake = resolved.intake!;
  return {
    ...input,
    ...effective,
    agents: resolved,
    defaults: { ...input.defaults, agent: input.defaults?.agent ?? "general", models, efforts },
    harness,
    intake: {
      ...input.intake,
      model: intake.model,
      ...(intake.modelSettings?.reasoning?.effort != null ? { effort: intake.modelSettings.reasoning.effort } : {}),
    },
    ...(input.memory
      ? {
          memory: {
            ...input.memory,
            model: memory.model,
            ...(memory.modelSettings?.reasoning?.effort != null
              ? { effort: memory.modelSettings.reasoning.effort }
              : {}),
          },
        }
      : {}),
  };
}

/** All model callers use this seam; legacy installations retain their original
 * fallback behavior until their source document is migrated. */
export function settingsForAgent(
  config: AppConfig,
  name: string,
  runModel?: string,
): { model?: string; effort?: Effort } {
  if (config.extends === "builtin") {
    const entry = config.agents?.[name];
    if (!entry) throw new Error(`Unknown agent "${name}"`);
    const effort = entry.modelSettings?.reasoning?.effort;
    return { model: entry.model, ...(effort != null ? { effort } : {}) };
  }
  const caller = name === "operator" ? "general" : name;
  const background = name === "intake" ? config.intake : name === "memory" ? config.memory : undefined;
  const model =
    name === "memory"
      ? (background?.model ?? runModel)
      : name === "intake"
        ? (background?.model ?? config.defaults.models.general)
        : (config.defaults.models[caller] ?? config.defaults.models.general);
  const effort = name === "intake" || name === "memory" ? background?.effort : config.defaults.efforts?.[caller];
  return { ...(model !== undefined ? { model } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/** A fresh definition per run. Literal instructions replace all prompt
 * variants, so resident dispatch cannot accidentally restore a builtin. */
export function configuredAgent(config: AppConfig, name: string): AgentDef {
  const builtin = getAgent(name);
  const entry = config.extends === "builtin" ? config.agents?.[name] : undefined;
  const resourceLifetime = resourceLifetimeOrRetained(builtin.resourceLifetime);
  if (!entry) return { ...builtin, tiers: [...builtin.tiers], resourceLifetime };
  const maxMinutes = entry.limits?.maxMinutes ?? builtin.maxMinutes;
  const result: AgentDef = {
    ...builtin,
    tiers: [...builtin.tiers],
    resourceLifetime,
    description: entry.description ?? builtin.description,
    toolset: entry.tools ?? builtin.toolset,
    maxTokens: entry.limits?.maxTokens ?? builtin.maxTokens,
    maxMinutes,
    maxTurns: Math.min(entry.limits?.maxTurns ?? runawayTurnCap(maxMinutes), runawayTurnCap(maxMinutes)),
  };
  if (name === "conductor" && (!entry.instructions || entry.instructions === "builtin:conductor"))
    result.system = conductorSystem(
      Object.keys(AGENTS)
        .filter((sibling) => sibling !== name)
        .map((sibling) => configuredAgent(config, sibling)),
    );
  if (entry.instructions && !entry.instructions.startsWith("builtin:")) {
    result.system = entry.instructions;
    delete result.residentSystem;
    delete result.seededSystem;
  }
  return result;
}
