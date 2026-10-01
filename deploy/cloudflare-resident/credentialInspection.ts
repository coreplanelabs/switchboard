import {
  emptyCredentialInspection,
  runCredentialInspection,
  credentialInspectionInputSchema,
  type CredentialInspection,
  type CredentialProbeOptions,
} from "../../src/execution/credentialInspection.js";

/** The count-only boundary lives in the Worker. No shell text is accepted from
 * the caller and no raw command result or exception leaves this operation. */
export async function inspectResidentCredentials(
  input: unknown,
  env: Record<string, string>,
  doorHost: string | undefined,
  execute: (command: string, options: CredentialProbeOptions) => Promise<unknown>,
): Promise<CredentialInspection> {
  const parsed = credentialInspectionInputSchema.safeParse(input);
  if (
    !parsed.success ||
    !doorHost ||
    env.GH_HOST !== doorHost ||
    !/^sbr_[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]{20,128}$/.test(env.GH_ENTERPRISE_TOKEN ?? "") ||
    Object.keys(env).some(
      (key) => Boolean(env[key]) && (/^LD_/.test(key) || ["BASH_ENV", "ENV", "GCONV_PATH"].includes(key)),
    )
  )
    return emptyCredentialInspection();
  return runCredentialInspection(execute, parsed.data);
}
