import { describe, expect, it } from "vitest";
import { prBatchOf } from "./prBatch.js";

describe("prBatchOf — explicit linked pull request batches", () => {
  it("reads Slack's linked cross-repository PR list and ignores malformed or quoted links", () => {
    const text =
      "<@U123|switchboard> ship these\n" +
      "- <https://github.com/acme/api/pull/7|API>\n" +
      "- <https://github.com/acme/web/pull/9|Web>\n" +
      "- https://github.com/acme/web/pull/9extra\n" +
      "`https://github.com/acme/other/pull/10`";
    expect(prBatchOf(text)).toEqual({
      kind: "ship",
      targets: [
        { repo: "acme/api", number: 7, url: "https://github.com/acme/api/pull/7" },
        { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
      ],
    });
  });

  it("takes only requested PRs, excluding negated and quoted links", () => {
    const text =
      "ship these:\n" +
      "- https://github.com/acme/api/pull/7\n" +
      "- https://github.com/acme/web/pull/9\n" +
      "- do not ship https://github.com/acme/web/pull/10\n" +
      "- https://github.com/acme/web/pull/13 (not for shipping)\n" +
      "- For context: https://github.com/acme/web/pull/14\n" +
      "- [Reference material](https://github.com/acme/web/pull/15)\n" +
      "- [Background](https://github.com/acme/web/pull/16)\n" +
      "- [#7 misleading title](https://github.com/acme/web/pull/17)\n" +
      "> - https://github.com/acme/web/pull/11\n" +
      "Do not ship https://github.com/acme/web/pull/12";
    expect(prBatchOf(text)?.targets.map((target) => target.number)).toEqual([7, 9]);
  });

  it("stops inline targets at an explicit exclusion", () => {
    expect(
      prBatchOf(
        "review these https://github.com/acme/api/pull/7, https://github.com/acme/web/pull/9; do not review https://github.com/acme/web/pull/10",
      )?.targets.map((target) => target.number),
    ).toEqual([7, 9]);
  });

  it("accepts a Markdown PR list with titles inside its links", () => {
    expect(
      prBatchOf(
        "ship these\n- [#7 proof harness](https://github.com/acme/api/pull/7)\n- [Provider #9 module](https://github.com/acme/provider/pull/9)",
      )?.targets.map((target) => `${target.repo}#${target.number}`),
    ).toEqual(["acme/api#7", "acme/provider#9"]);
  });

  it("does not grant Ship authority to a contextual inline Markdown link", () => {
    expect(
      prBatchOf(
        "ship these [Background](https://github.com/acme/api/pull/7), [#9 target](https://github.com/acme/web/pull/9)",
      ),
    ).toBeUndefined();
  });

  it("excludes a contextual inline PR after two requested targets", () => {
    expect(
      prBatchOf(
        "ship these https://github.com/acme/api/pull/7, https://github.com/acme/web/pull/8, [#9 reference only](https://github.com/acme/web/pull/9)",
      )?.targets.map((target) => target.number),
    ).toEqual([7, 8]);
  });

  it("reads a Slack link destination without treating a PR URL in its label as another target", () => {
    expect(
      prBatchOf(
        "ship these:\n" +
          "- <https://github.com/acme/api/pull/7|#7 https://github.com/acme/web/pull/9>\n" +
          "- <https://github.com/acme/web/pull/8|#8 Web>",
      )?.targets.map((target) => target.number),
    ).toEqual([7, 8]);
  });

  it("excludes contextual Slack labels from review batches too", () => {
    expect(
      prBatchOf(
        "review these:\n" +
          "- <https://github.com/acme/api/pull/7|API>\n" +
          "- <https://github.com/acme/web/pull/8|Web>\n" +
          "- <https://github.com/acme/web/pull/9|Background>",
      )?.targets.map((target) => target.number),
    ).toEqual([7, 8]);
  });
});
