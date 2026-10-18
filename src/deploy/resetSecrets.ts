import { readFileSync, writeFileSync, mkdirSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { DeploymentProfile } from "./profile.js";
import { DEFAULT_SECRETS_DIR } from "./secrets.js";

/** Materialize only the original declared Worker values, outside candidate code. */
export function prepareResetSecrets(profile: DeploymentProfile, raw: string | undefined) {
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !["staging", "production"].includes(process.env.RESET_ENVIRONMENT ?? "") ||
    process.env.RESET_ACCOUNT !== profile.account
  )
    throw new Error("reset secret preparation requires the selected original controller");
  const source = (profile.secretsSource ?? DEFAULT_SECRETS_DIR).replace(/^~\//, `${homedir()}/`);
  if (source.includes("://")) throw new Error("reset needs a local materialized original secret source");
  let secrets: Record<string, string>;
  try {
    secrets = z.record(z.string(), z.string().min(1)).parse(JSON.parse(raw ?? ""));
  } catch {
    throw new Error("original runtime secret bundle is missing or invalid");
  }
  const manifest = JSON.parse(readFileSync("deploy/secrets.manifest.json", "utf8")) as { secrets: { name: string }[] };
  if (Object.keys(secrets).some((name) => !manifest.secrets.some((entry) => entry.name === name)))
    throw new Error("runtime bundle includes an undeclared secret name");
  for (const name of ["MEMORY_TOKEN", "SANDBOX_TOKEN", "RESIDENT_READ_TOKEN", "RESIDENT_DRAIN_TOKEN"])
    if (!process.env[name] || secrets[name] !== process.env[name]) throw new Error("runtime bundle bearer differs");
  mkdirSync(source, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries(secrets)) {
    process.stdout.write(
      `::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}\n`,
    );
    const path = join(source, name);
    try {
      writeFileSync(path, value, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
      if (
        readFileSync(path, { encoding: "utf8", flag: constants.O_RDONLY | constants.O_NOFOLLOW }).trim() !==
        value.trim()
      )
        throw new Error("existing original secret differs", { cause: error });
    }
  }
  return { directory: source, names: Object.keys(secrets).length };
}
