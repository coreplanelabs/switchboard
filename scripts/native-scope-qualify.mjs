import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const helper = `${root}deploy/cloudflare-resident/native-scope.py`;
const fixture = `${root}deploy/cloudflare-resident/testing/nativeScopeLinux.py`;
const docker = (args, options = {}) =>
  execFileSync("docker", args, { cwd: root, encoding: "utf8", timeout: 120_000, ...options });
const selectedImage = process.env.NATIVE_SCOPE_TEST_IMAGE ?? "switchboard-native-scope-test";
if (!process.env.NATIVE_SCOPE_TEST_IMAGE)
  docker(["build", "--platform", "linux/amd64", "-t", selectedImage, "deploy/cloudflare-resident"], {
    stdio: "inherit",
    timeout: 1_800_000,
  });
const image = docker(["image", "inspect", "--format", "{{.Id}}", selectedImage]).trim();
// Local Linux qualification uses a disposable private cgroup namespace and
// explicit capabilities. It is not a Cloudflare policy or deployment receipt.
const container = docker([
  "create",
  "--platform",
  "linux/amd64",
  "--network",
  "none",
  "--cgroupns",
  "private",
  "--cap-add",
  "ALL",
  "--security-opt",
  "apparmor=unconfined",
  "--entrypoint",
  "/bin/sleep",
  image,
  "300",
]).trim();
const temporary = mkdtempSync(join(tmpdir(), "native-harness-"));
try {
  // Render writes through the real harness consumer, then execute them in
  // the installed image. The local capture alone is not the behavior proof.
  const commands = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { ExecHarnessContainer } from "./src/core/harness/container.ts";
    import { piRunPaths } from "./src/core/harness/pi/process.ts";
    import { openCodeRunPaths } from "./src/core/harness/opencode/process.ts";
    const fixtures = [];
    for (const [id, paths] of [["a", piRunPaths("a")], ["b", openCodeRunPaths("b")]]) {
      const commands = [];
      const container = new ExecHarnessContainer({ execResult: async (command) => { commands.push(command); return { stdout: "", stderr: "", exitCode: 0 }; } });
      await container.writeFile(paths.dir + "/driver", "harness-state");
      fixtures.push({ id, root: paths.dir, commands });
    }
    console.log(JSON.stringify(fixtures));
  `,
    ],
    { cwd: root, encoding: "utf8" },
  );
  const commandFile = join(temporary, "commands.json");
  writeFileSync(commandFile, commands, { mode: 0o600 });
  docker(["cp", commandFile, `${container}:/tmp/harness-root-commands.json`]);
  docker(["cp", fixture, `${container}:/tmp/native-scope-test.py`]);
  docker(["start", container]);
  const helperSha256 = createHash("sha256").update(readFileSync(helper)).digest("hex");
  const installed = docker(["exec", container, "/usr/bin/sha256sum", "/opt/switchboard/native-scope.py"]).split(" ")[0];
  if (installed !== helperSha256) throw new Error("image does not contain the current native helper");
  const result = docker([
    "exec",
    container,
    "/usr/bin/python3",
    "-I",
    "/tmp/native-scope-test.py",
    "/tmp/harness-root-commands.json",
  ]);
  const receipt = JSON.parse(result.trim());
  docker([
    "cp",
    `${root}deploy/cloudflare-resident/testing/nativeArchiveLinux.py`,
    `${container}:/tmp/native-archive-test.py`,
  ]);
  const archiveReceipt = JSON.parse(
    docker(["exec", container, "/usr/bin/python3", "-I", "/tmp/native-archive-test.py"]).trim(),
  );
  if (archiveReceipt.productionArchive !== "passed") throw new Error("native archive assertions failed");
  if (receipt.productionHelper !== "passed") throw new Error("native scope assertions failed");
  console.log(
    JSON.stringify({
      environment: "local-disposable-linux",
      image,
      helperSha256,
      ...receipt,
      ...archiveReceipt,
    }),
  );
} finally {
  docker(["rm", "-f", container]);
  rmSync(temporary, { recursive: true, force: true });
}
