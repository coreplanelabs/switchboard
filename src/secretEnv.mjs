// The lint that makes src/secrets.ts a guarantee (docs/reference/specs/routing-and-config.md
// item 19): outside that module, production code under src/ may not read a
// credential from `process.env`. Plain JS so eslint.config.mjs can import it;
// the types live beside it in secretEnv.d.mts. Which names are credentials is
// deploy/secrets.manifest.json — read here at lint time — plus the two dev
// fallbacks the code reads by name; src/secrets.ts carries the same two and
// src/secretEnv.test.ts pins the lists equal.
//
// What the rule refuses, in a bot-process file:
//   process.env.SLACK_BOT_TOKEN, process.env["MEMORY_TOKEN"]   a secret by name → src/secrets.ts
//   process.env[apiKeyEnv]                                    a computed read can name any secret
//   f(process.env), { env: process.env }, { ...process.env }  the whole environment, secrets included → publicEnv()
//   const { GH_TOKEN } = process.env                          the same, destructured
//   process.env.SOMETHING_NEW                                 a name that is neither a secret nor on the
//                                                             public list below — add it here, deliberately
// A host-tooling file (`hostTooling: true` — src/deploy, src/agentEnv, src/setup,
// the operator's CLI spawning wrangler and `op` with the operator's own
// environment) keeps its bare and computed reads; only a secret read by name
// is refused there.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MANIFEST_PATH = "deploy/secrets.manifest.json";

/** @type {readonly string[]} */
export const CREDENTIAL_FALLBACKS = ["GH_TOKEN", "E2B_API_KEY"];

/** @returns {string[]} */
function manifestNames() {
  /** @type {{ secrets: Array<{ name: string }> }} */
  const manifest = JSON.parse(readFileSync(join(ROOT, MANIFEST_PATH), "utf8"));
  return manifest.secrets.map((s) => s.name);
}

/** Every environment variable that holds a credential. */
export const SECRET_NAMES = new Set([...manifestNames(), ...CREDENTIAL_FALLBACKS]);

/** The environment variables production code may read by name from `process.env`
 *  (the public ones: ports, URLs, paths, feature switches). Exact names, plus every
 *  `SWITCHBOARD_*` that is not a secret. */
export const PUBLIC_ENV_NAMES = new Set([
  "NODE_ENV",
  "PORT",
  "PUBLIC_BASE_URL",
  "STATE_WORKER_URL",
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
  "ACCESS_DEV_BYPASS",
]);
export const PUBLIC_ENV_PREFIX = "SWITCHBOARD_";

/** @param {string} name */
export function isSecretName(name) {
  return SECRET_NAMES.has(name);
}

/** @param {string} name */
export function isPublicEnvName(name) {
  if (isSecretName(name)) return false;
  return PUBLIC_ENV_NAMES.has(name) || name.startsWith(PUBLIC_ENV_PREFIX);
}

/** The production files the rule applies to, and the two that may read `process.env` for a credential. */
export const SECRET_ENV_FILES = ["src/**/*.ts"];
export const SECRET_ENV_EXEMPT = ["**/*.test.ts", "src/**/testing/**", "src/secrets.ts", "src/loadEnv.ts"];
/** The operator-side tooling: it spawns wrangler and `op` with the operator's whole environment. */
export const HOST_TOOLING_FILES = ["src/deploy/**/*.ts", "src/agentEnv/**/*.ts", "src/setup/**/*.ts"];

const SECRETS_MODULE = "src/secrets.ts";

/** @param {import('estree').Node} node */
function isProcessEnv(node) {
  if (node.type !== "MemberExpression") return false;
  if (node.object.type !== "Identifier" || node.object.name !== "process") return false;
  if (!node.computed) return node.property.type === "Identifier" && node.property.name === "env";
  return node.property.type === "Literal" && node.property.value === "env";
}

/** The static name a member access reads, or undefined for a computed one. @param {import('estree').MemberExpression} member */
function staticName(member) {
  if (!member.computed) return member.property.type === "Identifier" ? member.property.name : undefined;
  return member.property.type === "Literal" && typeof member.property.value === "string"
    ? member.property.value
    : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export const noRawEnv = {
  meta: {
    type: "problem",
    docs: { description: `credentials are read through ${SECRETS_MODULE}, never from process.env` },
    schema: [{ type: "object", properties: { hostTooling: { type: "boolean" } }, additionalProperties: false }],
    messages: {
      secret: `process.env.{{name}} is a credential: read it through ${SECRETS_MODULE} (secrets.get("{{name}}")).`,
      computed: `process.env[…] can name any credential: read a configured variable through ${SECRETS_MODULE} (secrets.named(x)).`,
      bare: `process.env carries every credential: pass publicEnv() (${SECRETS_MODULE}) for the public variables, secrets for the rest.`,
      unlisted: `process.env.{{name}} is not on the public list in src/secretEnv.mjs: add it there if it is public, to ${MANIFEST_PATH} if it is a credential.`,
    },
  },
  create(context) {
    const hostTooling = context.options[0]?.hostTooling === true;
    /** @param {import('estree').Node} node @param {string} messageId @param {Record<string, string>} [data] */
    const report = (node, messageId, data) => context.report({ node, messageId, data });
    return {
      MemberExpression(node) {
        if (!isProcessEnv(node)) return;
        const parent = /** @type {import('estree').Node & { parent?: import('estree').Node }} */ (node).parent;
        if (parent?.type === "MemberExpression" && parent.object === node) {
          const name = staticName(parent);
          if (name === undefined) {
            if (!hostTooling) report(parent, "computed");
          } else if (isSecretName(name)) report(parent, "secret", { name });
          else if (!hostTooling && !isPublicEnvName(name)) report(parent, "unlisted", { name });
          return;
        }
        if (parent?.type === "VariableDeclarator" && parent.init === node && parent.id.type === "ObjectPattern") {
          for (const prop of parent.id.properties) {
            if (prop.type !== "Property") continue;
            const name = prop.computed ? undefined : prop.key.type === "Identifier" ? prop.key.name : undefined;
            if (name !== undefined && isSecretName(name)) report(prop, "secret", { name });
          }
          if (!hostTooling) report(node, "bare");
          return;
        }
        if (!hostTooling) report(node, "bare");
      },
    };
  },
};

/** The plugin eslint.config.mjs registers as `secrets`. */
export const secretEnvPlugin = { rules: { "no-raw-env": noRawEnv } };
