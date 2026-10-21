import {
  nativeRetirementPermitSchema,
  nativeRetirementTargetSchema,
  type NativeRetirementTarget,
} from "./execution/nativeRetirement.js";
import { nativeScopeRefSchema } from "./execution/nativeScope.js";
import { RESIDENT_RETIRE_READ_TIMEOUT_MS, RESIDENT_RETIRE_WRITE_TIMEOUT_MS } from "./core/budgets.js";

const HASH = /^[a-f0-9]{64}$/;
const KEY = /^native-operation:.{1,495}$/;
const RESOURCE = /^repo:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_PAGES = 200;

type Row = {
  key: string;
  recordHash: string;
  journal?: Record<string, unknown>;
  recoveryReason: string;
  retirement?: unknown;
};

export interface ResidentRetireIO {
  fetcher: typeof fetch;
  readToken: string;
  controlToken?: string;
  write(line: string): void;
}

function options(argv: string[]) {
  const values = new Map<string, string>();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name === "--apply") {
      if (apply) throw new Error("--apply repeated");
      apply = true;
      continue;
    }
    if (!["--url", "--resource", "--key", "--record-hash", "--resident"].includes(name) || values.has(name))
      throw new Error("invalid resident retirement option");
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`missing ${name} value`);
    values.set(name, value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) throw new Error(`missing ${name}`);
    return value;
  };
  const url = new URL(required("--url"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("--url must be a bare HTTPS origin (or local HTTP origin)");
  const resource = required("--resource");
  const key = required("--key");
  if (!RESOURCE.test(resource) || !KEY.test(key)) throw new Error("invalid native operation target");
  const hash = values.get("--record-hash");
  if (apply !== !!hash || (hash !== undefined && !HASH.test(hash)))
    throw new Error("--apply requires an exact --record-hash; preview omits both");
  const residentText = values.get("--resident");
  const resident = residentText === undefined ? undefined : Number(residentText);
  if (residentText !== undefined && (!/^[1-9]\d*$/.test(residentText) || !Number.isSafeInteger(resident)))
    throw new Error("--resident must be a positive number");
  return { url, resource, key, hash, resident, apply };
}

function checkedRow(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native inventory row invalid");
  const row = value as Record<string, unknown>;
  if (
    typeof row.key !== "string" ||
    !KEY.test(row.key) ||
    typeof row.recordHash !== "string" ||
    !HASH.test(row.recordHash) ||
    typeof row.recoveryReason !== "string"
  )
    throw new Error("native inventory row invalid");
  return {
    key: row.key,
    recordHash: row.recordHash,
    recoveryReason: row.recoveryReason,
    ...(row.journal && typeof row.journal === "object" && !Array.isArray(row.journal)
      ? { journal: row.journal as Record<string, unknown> }
      : {}),
    ...(row.retirement === undefined ? {} : { retirement: row.retirement }),
  };
}

const scopeOf = (row: Row) => nativeScopeRefSchema.safeParse(row.journal?.scope);
const scopeValue = (row: Row) => {
  const parsed = scopeOf(row);
  return parsed.success ? parsed.data : undefined;
};

async function inventory(
  io: ResidentRetireIO,
  origin: URL,
  resource: string,
  resident: number | undefined,
): Promise<Row[]> {
  const rows: Row[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = await io
      .fetcher(new URL("/debug", origin), {
        method: "POST",
        headers: { authorization: `Bearer ${io.readToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          op: "native-operations",
          resource,
          ...(resident === undefined ? {} : { resident }),
          ...(cursor ? { cursor } : {}),
        }),
        signal: AbortSignal.timeout(RESIDENT_RETIRE_READ_TIMEOUT_MS),
      })
      .catch(() => {
        throw new Error("native inventory read failed");
      });
    if (!response.ok) throw new Error(`native inventory returned HTTP ${response.status}`);
    const body: unknown = await response.json().catch(() => undefined);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("native inventory invalid");
    const pageRows = (body as Record<string, unknown>).operations;
    const next = (body as Record<string, unknown>).cursor;
    if (
      !Array.isArray(pageRows) ||
      pageRows.length > 25 ||
      !(next === null || (typeof next === "string" && KEY.test(next)))
    )
      throw new Error("native inventory page invalid");
    for (const value of pageRows) {
      const row = checkedRow(value);
      if (rows.length && row.key <= rows[rows.length - 1]!.key) throw new Error("native inventory order invalid");
      rows.push(row);
    }
    if (next === null) return rows;
    if (pageRows.length !== 25 || next !== rows.at(-1)?.key || (cursor !== undefined && next <= cursor))
      throw new Error("native inventory cursor invalid");
    cursor = next;
  }
  throw new Error("native inventory page limit reached");
}

function closed(row: Row | undefined, target: NativeRetirementTarget, selected: NativeRetirementTarget): boolean {
  if (!row || row.recordHash !== target.recordHash || row.recoveryReason !== "original-runtime-retired") return false;
  const retirement = row.retirement;
  if (!retirement || typeof retirement !== "object" || Array.isArray(retirement)) return false;
  const saved = retirement as Record<string, unknown>;
  const records = saved.records;
  const permit = nativeRetirementPermitSchema.safeParse(saved.permit);
  return (
    saved.purpose === "terminal-native-scope" &&
    saved.state === "closed" &&
    saved.originalOperationOutcome === "unknown" &&
    permit.success &&
    JSON.stringify(permit.data.target) === JSON.stringify(selected) &&
    !!records &&
    typeof records === "object" &&
    !Array.isArray(records) &&
    (records as Record<string, unknown>)[target.key] === target.recordHash
  );
}

/** Source-checkout operator path. The server alone grants terminal authority. */
export async function runResidentRetire(argv: string[], io: ResidentRetireIO): Promise<void> {
  const target = options(argv);
  if (!io.readToken) throw new Error("missing RESIDENT_READ_TOKEN");
  if (target.apply && !io.controlToken) throw new Error("missing RESIDENT_RETIRE_TOKEN or RESIDENT_ADMIN_TOKEN");
  const rows = await inventory(io, target.url, target.resource, target.resident);
  const selected = rows.find((row) => row.key === target.key);
  if (!selected) throw new Error("selected native operation absent from complete inventory");
  const scope = scopeOf(selected);
  if (!scope.success || typeof selected.journal?.closed !== "boolean") throw new Error("selected native scope invalid");
  const parsed = nativeRetirementTargetSchema.safeParse({
    resource: target.resource,
    key: selected.key,
    recordHash: selected.recordHash,
    scope: scope.data,
  });
  if (!parsed.success) throw new Error("selected native scope invalid");
  if (target.hash !== undefined && target.hash !== selected.recordHash)
    throw new Error("record hash changed; preview again");
  const scopeRows = rows.filter((row) => JSON.stringify(scopeValue(row)) === JSON.stringify(scope.data));
  io.write(`${scope.data.owner.runId} ${selected.key} ${selected.recordHash}`);
  io.write(`scope ${scope.data.id}; ${scopeRows.length} saved operation(s); original result may be unknown`);
  for (const row of scopeRows) if (row.key !== selected.key) io.write(`${row.key} ${row.recordHash}`);
  if (!target.apply) {
    io.write("Preview only. Apply requires the exact record hash and a sealed terminal run.");
    return;
  }
  if (
    scopeRows.every((before) =>
      closed(before, { ...parsed.data, key: before.key, recordHash: before.recordHash }, parsed.data),
    )
  ) {
    io.write("already closed; original result unknown");
    return;
  }
  let status: number | undefined;
  try {
    const response = await io.fetcher(new URL("/retire-native-operation", target.url), {
      method: "POST",
      headers: { authorization: `Bearer ${io.controlToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...parsed.data, ...(target.resident === undefined ? {} : { resident: target.resident }) }),
      signal: AbortSignal.timeout(RESIDENT_RETIRE_WRITE_TIMEOUT_MS),
    });
    status = response.status;
  } catch {
    // The request may have committed. Read the original record once; never send another control here.
    io.write("retirement control reply unavailable; reading the saved receipt; original control outcome unknown");
  }
  let after: Row[];
  try {
    after = await inventory(io, target.url, target.resource, target.resident);
  } catch {
    throw new Error(
      "retirement result unverified; inventory read failed; do not repeat control without a fresh preview",
    );
  }
  if (
    scopeRows.every((before) =>
      closed(
        after.find((row) => row.key === before.key),
        {
          ...parsed.data,
          key: before.key,
          recordHash: before.recordHash,
        },
        parsed.data,
      ),
    ) &&
    after.filter((row) => JSON.stringify(scopeValue(row)) === JSON.stringify(scope.data)).length === scopeRows.length
  ) {
    io.write("closed; original result unknown; saved run and workspace remain");
    return;
  }
  if (status !== undefined && status !== 200)
    throw new Error(`retirement refused (HTTP ${status}); no closure receipt`);
  throw new Error("retirement result unverified; no closure receipt; do not repeat control without a fresh preview");
}
