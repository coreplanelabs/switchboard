import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CREDENTIAL_PROBE_SOURCE } from "./credentialProbeSource.js";

/** Synthetic Python fixtures only: the live entrypoint never runs. */
function python(body: string): Record<string, number | boolean> {
  const code = `scope = {"__name__": "fixture"}\nexec(${JSON.stringify(CREDENTIAL_PROBE_SOURCE)}, scope)\nexec(${JSON.stringify(body)}, scope)`;
  return JSON.parse(
    execFileSync("/usr/bin/python3", ["-I", "-c", code], { encoding: "utf8", env: {}, timeout: 5_000 }),
  );
}

describe("credential probe source", () => {
  it("classifies synthetic App tokens without emitting their bytes", () => {
    const out = python(`out = empty()
expected = b"sbr_run-one.abcdefghijklmnopqrstuv"
environment({"GH_ENTERPRISE_TOKEN": expected.decode(), "GH_TOKEN": "ghs_SYNTHETICTOKENONLY"}, expected, out)
credential_file(b"ghs_SYNTHETICTOKENONLY", expected, out)
print(json.dumps(out))`);
    expect(out.appTokenMatches).toBe(2);
    expect(out.unknownCount).toBeGreaterThan(0);
    expect(Object.values(out).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
  });

  it("counts only the known Door helper and never invokes unknown helpers", () => {
    const clean = python(`out = empty()
helpers(b"credential.helper\\n\\0credential.https://door.example.helper\\n" + HELPER + b"\\0", b"sbr_run-one.abcdefghijklmnopqrstuv", "door.example", out)
print(json.dumps(out))`);
    expect(clean.helperEntries).toBe(2);
    expect(clean.unknownCount).toBe(0);
    const unknown = python(`out = empty()
helpers(b"credential.helper\\n!exit 99\\0", b"sbr_run-one.abcdefghijklmnopqrstuv", "door.example", out)
print(json.dumps(out))`);
    expect(unknown.unknownCount).toBeGreaterThan(0);
  });

  it("refuses symlinked, nonregular and oversized synthetic files without following them", () => {
    const out = python(`import tempfile
with tempfile.TemporaryDirectory() as root:
    root = os.path.realpath(root)
    with open(root + "/fixture", "wb") as file: file.write(b"ghs_SYNTHETICTOKENONLY")
    os.symlink(root + "/fixture", root + "/link")
    os.symlink(root, root + "/dirlink")
    os.mkfifo(root + "/pipe")
    with open(root + "/large", "wb") as file: file.write(b"x" * (LIMIT + 1))
    refused = 0
    for path in ["/link", "/dirlink/fixture", "/pipe", "/large"]:
        try: bounded_file(root + path)
        except (OSError, ValueError): refused += 1
    print(json.dumps({"refused": refused, "absent": bounded_file(root + "/absent") == b""}))`);
    expect(out).toEqual({ refused: 4, absent: true });
  });

  it("inspects both environments and known files with synthetic I/O and fences the head twice", () => {
    const out = python(`expected = "sbr_run-one.abcdefghijklmnopqrstuv"
env = {"GH_ENTERPRISE_TOKEN": expected, "GH_HOST": "door.example", "GH_REPO": "door.example/example/repo", "HOME": "/home/worker"}
os.environ = env
os.getuid = lambda: 1001
trusted_binary = lambda path: True
resource.setrlimit = lambda *args: None
process_env = lambda pid: ({**env, "SWITCHBOARD_RUN_ID": "run-one"}, b"123")
class User: pw_dir = "/home/worker"; pw_name = "worker"
pwd.getpwuid = lambda uid: User()
bounded_file = lambda path: b""
boot_id = lambda: b"11111111-1111-1111-1111-111111111111"
head_reads = 0
def git(args):
    global head_reads
    if args == ["symbolic-ref", "--short", "HEAD"]: return b"canary/test\\n"
    if args == ["rev-parse", "HEAD"]:
        head_reads += 1
        return b"a" * 40 + b"\\n"
    if args == ["rev-parse", "--absolute-git-dir"]: return b"/workspace/.git\\n"
    if args == ["config", "--null", "--list"]: return b"credential.helper\\n\\0credential.https://door.example.helper\\n" + HELPER + b"\\0"
    raise ValueError()
out = empty()
inspect({"runId": "run-one", "pid": 42, "processBirth": "11111111-1111-1111-1111-111111111111:123", "repo": "example/repo", "ref": "canary/test", "head": "a" * 40}, out)
out["headReads"] = head_reads
reused = empty()
try: inspect({"runId": "run-one", "pid": 42, "processBirth": "11111111-1111-1111-1111-111111111111:122", "repo": "example/repo", "ref": "canary/test", "head": "a" * 40}, reused)
except ValueError: reused["unknownCount"] += 1
out["reusedCompleted"] = reused["completed"]
print(json.dumps(out))`);
    expect(out).toMatchObject({
      completed: true,
      bindingMatched: true,
      commandEnvironments: 1,
      harnessEnvironments: 1,
      appTokenMatches: 0,
      unknownCount: 0,
    });
    expect(out.filesChecked).toBeGreaterThan(0);
    expect(out.headReads).toBe(2);
    expect(out.reusedCompleted).toBe(false);
  });

  it("rejects a reused PID even when both probe reads would see a stable matching environment", () => {
    const out = python(`os.getuid = lambda: 1001
trusted_binary = lambda path: True
resource.setrlimit = lambda *args: None
os.environ = {"GH_ENTERPRISE_TOKEN": "sbr_run-one.abcdefghijklmnopqrstuv"}
process_env = lambda pid: ({"SWITCHBOARD_RUN_ID": "run-one", **os.environ}, b"124")
boot_id = lambda: b"11111111-1111-1111-1111-111111111111"
out = empty()
try: inspect({"runId": "run-one", "pid": 42, "processBirth": "11111111-1111-1111-1111-111111111111:123"}, out)
except ValueError: out["unknownCount"] += 1
print(json.dumps(out))`);
    expect(out).toMatchObject({ completed: false, commandEnvironments: 0, harnessEnvironments: 0, unknownCount: 1 });
  });

  it("refuses a root runtime before reading any environment or file", () => {
    const out = python(`os.getuid = lambda: 0
resource.setrlimit = lambda *args: None
process_env = lambda pid: (_ for _ in ()).throw(AssertionError("must not read"))
out = empty()
try: inspect({}, out)
except ValueError: out["unknownCount"] += 1
print(json.dumps(out))`);
    expect(out).toMatchObject({ completed: false, commandEnvironments: 0, harnessEnvironments: 0, unknownCount: 1 });
  });
});
