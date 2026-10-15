import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
  "120",
]).trim();
try {
  docker(["cp", fixture, `${container}:/tmp/native-scope-test.py`]);
  docker(["start", container]);
  const helperSha256 = createHash("sha256").update(readFileSync(helper)).digest("hex");
  const installed = docker(["exec", container, "/usr/bin/sha256sum", "/opt/switchboard/native-scope.py"]).split(" ")[0];
  if (installed !== helperSha256) throw new Error("image does not contain the current native helper");
  const result = docker(["exec", container, "/usr/bin/python3", "-I", "/tmp/native-scope-test.py"]);
  const receipt = JSON.parse(result.trim());
  if (receipt.productionHelper !== "passed") throw new Error("native scope assertions failed");
  console.log(
    JSON.stringify({
      environment: "local-disposable-linux",
      image,
      helperSha256,
      ...receipt,
    }),
  );
} finally {
  docker(["rm", "-f", container]);
}
