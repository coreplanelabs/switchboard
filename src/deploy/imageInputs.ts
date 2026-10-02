import { createHash } from "node:crypto";

// Only the execution images can outlive a Worker release. The bot image embeds
// build.json and must keep following the release commit.
const EXECUTION_DIRS = {
  resident: "deploy/cloudflare-resident",
  sandbox: "deploy/cloudflare-sandbox",
} as const;

export type ExecutionImage = keyof typeof EXECUTION_DIRS;
export type ImageInputTags = Partial<Record<ExecutionImage, string>>;

/** Local Docker build inputs. An unfamiliar source falls back to a release tag,
 * which copies and rolls an image rather than reusing one with unknown contents. */
function localCopySources(dockerfile: string): string[] | undefined {
  const instructions = dockerfile.split("\n").filter((line) => !/^\s*#/.test(line));
  if (/--mount\s*=\s*type=bind/.test(instructions.join("\n"))) return undefined;
  const sources: string[] = [];
  for (const line of instructions) {
    const instruction = /^\s*(COPY|ADD)\s+(.+)$/i.exec(line);
    if (!instruction) continue;
    if (instruction[1].toUpperCase() === "ADD") return undefined;
    const words = instruction[2].trim().split(/\s+/);
    let fromStage = false;
    while (words[0]?.startsWith("--")) {
      if (words[0].startsWith("--from=")) fromStage = true;
      words.shift();
    }
    if (fromStage) continue;
    if (words.length !== 2) return undefined;
    const source = words[0].replace(/^\.\//, "");
    if (!/^[A-Za-z0-9._/-]+$/.test(source) || source === "." || source.startsWith("/") || source.includes(".."))
      return undefined;
    sources.push(source);
  }
  return sources;
}

/** The tag is based on the Dockerfile, every local COPY input and an optional
 * .dockerignore. An unchanged tag is an unchanged set of image instructions and
 * source files, even when Worker code or the release version moves. */
export async function executionImageInputTags(
  read: (path: string) => Promise<string | undefined>,
): Promise<ImageInputTags> {
  const tags: ImageInputTags = {};
  for (const kind of Object.keys(EXECUTION_DIRS) as ExecutionImage[]) {
    const dir = EXECUTION_DIRS[kind];
    const dockerfile = await read(`${dir}/Dockerfile`);
    const sources = dockerfile === undefined ? undefined : localCopySources(dockerfile);
    if (!sources) continue;
    const paths = [`${dir}/Dockerfile`, ...sources.map((source) => `${dir}/${source}`)].sort();
    if ((await read(`${dir}/.dockerignore`)) !== undefined) paths.push(`${dir}/.dockerignore`);
    const hash = createHash("sha256");
    let complete = true;
    for (const path of paths) {
      const contents = await read(path);
      // String-backed readers replace invalid UTF-8 bytes; never reuse an image
      // if two different binary inputs could hash to the same decoded text.
      if (contents === undefined || contents.includes("\ufffd")) {
        complete = false;
        break;
      }
      hash.update(path).update("\0").update(contents).update("\0");
    }
    if (complete) tags[kind] = `inputs-${hash.digest("hex")}`;
  }
  return tags;
}
