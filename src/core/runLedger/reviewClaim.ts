import type { LiveRunMeta, ReviewHeadAdvanceRequest } from "./types.js";

const fullHead = (value: string) => /^[a-f0-9]{40}$/.test(value);

export function reviewSourceProvesHead(request: ReviewHeadAdvanceRequest, meta: LiveRunMeta): boolean {
  const { source } = request;
  return (
    meta.agent === "review" &&
    typeof meta.repo === "string" &&
    Number.isSafeInteger(meta.pr) &&
    fullHead(request.from) &&
    fullHead(request.to) &&
    request.from !== request.to &&
    source.kind === "diff" &&
    source.complete === true &&
    source.repo.toLowerCase() === meta.repo.toLowerCase() &&
    source.pr === meta.pr &&
    source.headSha === request.to &&
    fullHead(source.baseSha) &&
    (meta.baseSha === undefined || source.baseSha === meta.baseSha) &&
    /^[a-f0-9]{64}$/.test(source.sourceHash) &&
    Number.isSafeInteger(source.size) &&
    source.size >= 0 &&
    source.size <= 10 * 1024 * 1024
  );
}
