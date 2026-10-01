import { describe, expect, it } from "vitest";
import { residentPublicationCommand } from "./residentPublication.js";
import { githubDoorEdgeRoute } from "../channels/githubDoorPaths.js";

const next = "a".repeat(40);
const old = "b".repeat(40);
const input = {
  worktreePath: "/workspace/threads/owned",
  repo: "acme/api",
  doorOrigin: "https://door.example",
  branch: "plan/fix/u1",
  next,
  old,
  bearer: "effect-only",
};

describe("resident runner-owned Git publication", () => {
  it("constructs a repository URL accepted by the Git door for discovery and upload", () => {
    const url = residentPublicationCommand(input).argv.at(-2)!;
    expect(githubDoorEdgeRoute(new URL(`${url}/info/refs?service=git-receive-pack`), "GET", input.doorOrigin)).toBe(
      "door",
    );
    expect(githubDoorEdgeRoute(new URL(`${url}/git-receive-pack`), "POST", input.doorOrigin)).toBe("door");
  });
  it("uses the root-owned mirror and argv, never the model-owned shell or repository config", () => {
    const command = residentPublicationCommand(input);
    expect(command.argv).toEqual([
      "git",
      "-C",
      "/workspace/mirror",
      "push",
      `--force-with-lease=refs/heads/plan/fix/u1:${old}`,
      "https://door.example/git/acme/api.git",
      `${next}:refs/heads/plan/fix/u1`,
    ]);
    expect(command.env.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe("/workspace/threads/owned/.git/objects");
    expect(command.env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(command.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(command.env.GH_ENTERPRISE_TOKEN).toBe("effect-only");
    expect(JSON.stringify(command.argv)).not.toContain("effect-only");
    expect(Object.values(command.env)).toContain("/dev/null");
  });

  it("refuses an unbound remote, invalid ref or SHA before building a process", () => {
    expect(() => residentPublicationCommand({ ...input, doorOrigin: "http://door.example" })).toThrow();
    expect(() => residentPublicationCommand({ ...input, branch: "../main" })).toThrow();
    expect(() => residentPublicationCommand({ ...input, next: "HEAD" })).toThrow();
    expect(() => residentPublicationCommand({ ...input, repo: "other/repo;id" })).toThrow();
  });
});
