import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shellQuote.js";

// Feature: features/execution.md — shell quoting through the sandbox's
// `timeout -k 10 280 bash -c '<command>'` wrapper. Tests the exact module the
// worker ships. The timeout-binary cases need coreutils `timeout` (present on
// CI's ubuntu; absent on stock macOS — skipped there, CI is the gate).

const run = (cmd: string) => execSync(cmd, { shell: "/bin/bash" }).toString();
const status = (cmd: string): number => {
  try {
    execSync(cmd, { shell: "/bin/bash", stdio: "pipe" });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

describe("shellQuote survives bash -c round-trips", () => {
  const cases = [
    `echo hello`,
    `echo 'single quoted'`,
    `echo "double quoted"`,
    `echo "it's a mix" of 'quotes'`,
    `X="$(echo 'aGVsbG8=' | base64 -d)" && echo "$X world"`,
    `cat > /tmp/swb-qt-heredoc <<'EOF'
line with 'quotes' and "doubles" and $vars
EOF
cat /tmp/swb-qt-heredoc`,
    `false; echo exit=$?`,
  ];

  for (const c of cases) {
    it(`round-trips: ${c.split("\n")[0]}`, () => {
      expect(run(`bash -c ${shellQuote(c)}`)).toBe(run(c));
    });
  }

  it("passes exit codes through", () => {
    expect(status(`bash -c ${shellQuote("exit 42")}`)).toBe(42);
  });
});

const hasTimeout = status("command -v timeout >/dev/null") === 0;

describe.skipIf(!hasTimeout)("under the coreutils timeout wrapper (CI/Linux)", () => {
  // Mirrors the worker's production shape: timeout -k 10 <secs> bash -c '<cmd>'.
  const wrap = (c: string, secs = 280) => `timeout -k 10 ${secs} bash -c ${shellQuote(c)}`;

  it("quoted commands behave identically under the wrapper", () => {
    expect(run(wrap(`echo "it's fine" && echo done`))).toBe("it's fine\ndone\n");
  });

  it("a deadline kill is a genuine exit 124", () => {
    expect(status(wrap("sleep 5 && echo NOPE", 1))).toBe(124);
  });
});
