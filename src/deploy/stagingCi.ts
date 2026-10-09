export interface StagingPull {
  number: number;
  state: string;
  user: { login: string };
  head: { sha: string; repo: { full_name: string } | null };
}

export interface ValidationCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  app: { slug: string };
}

export type StagingValidation =
  { kind: "ready" } | { kind: "waiting"; reason: string } | { kind: "refused"; reason: string };

const validationChecks = [
  ...["change plan", "bot", "web", "docs", "workers", "image", "package"].map((name) => ({
    name: `ci / ${name}`,
    app: "depot-code-access",
    allowed: ["success", ...(["web", "docs", "package"].includes(name) ? ["skipped"] : [])],
  })),
  { name: "pr-title / title", app: "depot-code-access", allowed: ["success"] },
  { name: "CodeQL", app: "github-advanced-security", allowed: ["success"] },
  { name: "zizmor", app: "github-actions", allowed: ["success"] },
];

export function stagingValidation(input: {
  repository: string;
  commit: string;
  pull: StagingPull;
  permission?: string;
  automatic?: boolean;
  checks: ValidationCheck[];
}): StagingValidation {
  if (input.pull.state !== "open") return { kind: "refused", reason: "closed" };
  if (input.pull.head.repo?.full_name !== input.repository) return { kind: "refused", reason: "fork" };
  if (!/^[a-f0-9]{40}$/.test(input.commit) || input.pull.head.sha !== input.commit)
    return { kind: "refused", reason: "head_changed" };
  if (!input.automatic && !["write", "maintain", "admin"].includes(input.permission ?? ""))
    return { kind: "refused", reason: "actor_not_trusted" };
  for (const gate of validationChecks) {
    const check = input.checks
      .filter((item) => item.name === gate.name && item.app.slug === gate.app)
      .sort((a, b) => b.id - a.id)[0];
    if (!check || check.status !== "completed") return { kind: "waiting", reason: gate.name };
    if (!check.conclusion || !gate.allowed.includes(check.conclusion))
      return { kind: "refused", reason: `validation_failed:${gate.name}` };
  }
  return { kind: "ready" };
}
