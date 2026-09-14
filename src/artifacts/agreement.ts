// The one name two places must agree on (docs/reference/specs/execution.md item
// 20, record 0033): the bucket the bot's config points its S3 token at
// (`artifacts.r2.bucket`) and the bucket the bot's Worker binds for the copy
// route (the deployment profile's `artifacts.bucket`, reported by
// `GET /artifacts/copy`). A presigned URL for one bucket and a copy into
// another would leave every inbound file where no run can read it, so the
// operator's `artifacts check` holds them equal here — pure, so it is tested
// without a Worker.

/** Undefined when the two agree (or the Worker reports none yet); else the problem, naming both. */
export function bucketMismatch(configBucket: string, workerBucket: string | undefined): string | undefined {
  if (workerBucket === undefined) {
    return `the bot's Worker binds no artifacts bucket — the deployment profile's \`artifacts.bucket\` is unset or the Worker predates it; the config names ${configBucket}`;
  }
  if (workerBucket === configBucket) return undefined;
  return `the bot's config names bucket ${configBucket} but its Worker binds ${workerBucket} — the copy route would land inbound files where no presigned URL can read them; make deploy/profile.json \`artifacts.bucket\` and config \`artifacts.r2.bucket\` say one name`;
}
