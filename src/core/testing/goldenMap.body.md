Coding-agent PR bodies grew with the diff: a median of 6,800 characters with seven embedded code blocks, and an 80-file PR at 26,600. The body is now a capped map (TL;DR, why, at most seven linked pointers, feedback wanted, risk, verified) with decisions, proofs and agent notes collapsed under it.

**Why:** Reviewers spend their time understanding a change, and long descriptions predict fewer participants; a body that restates the diff spends that attention before the reader chooses where to look. Record [0050](https://github.com/acme/api/blob/main/docs/decisions/0050-the-pr-body-is-a-fixed-size-map-for-the-reader-and-everything-for-agents-sits-below-a-fold.md) argues the shape; this PR is its one unit.

**Where to look**

1. [The caps and the schema](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/core/prDescription.ts#L24-L47) Every map field is capped in visible characters and the pointers at seven; the tool refuses over the cap naming the field and the count. ⚠ A cap counts `[label]` only, so a link's URL is free; check the regex does not swallow prose.
2. [The renderer](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/core/prDescription.ts#L247-L281) The tldr with no heading, the bold labels, one numbered link row per pointer, then each fold as a `<details>` block, then the footer. ⚠ Never a bare permalink line: that is what GitHub embeds as code.
3. [The inverse parser](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/core/prDescription.ts#L341-L353) Reads the map by its labels and link rows, and a body in the previous contract by the old grammar, with `legacy Tour shape` as a problem.
4. [The skill](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/skills/pr-description/SKILL.md#L13-L20) `pr-description` replaces `pr-tour`: the map's fields and caps, how to choose seven pointers, the mechanical anchor rules, the fold.
5. [The artifact keeps reading old records](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/core/runEventLines.ts#L107-L116) `pr_description` carries `pointers` and `why`; a stored record that still says `tour` is accepted by the line parser.
6. [The tests](https://github.com/acme/api/blob/685c471f31feaadd725fb917b68a2eea31c0f81a/src/core/prDescription.test.ts#L177-L189) Caps and counts named in the error, no bare permalink, a maximal map under 3,800 visible characters, the golden round trip, a legacy body.

**Feedback wanted:** Whether seven pointers and the per-field caps are the right numbers, and whether the review agent needs anything the Tour carried that the map does not.

**Risk:** Every PR the coding agent opens from the next bot deploy renders the new shape; existing bodies are not rewritten and still parse. The change touches the type, both tool schemas, the prompt, the artifact and the run page's adapter; a miss shows up as a review run publishing `complete: false`.

**Verified:** `npm run verify` green at head; the golden is this PR's own body rendered through the pipeline.

<details>
<summary>Decisions (4)</summary>

- **A refusal, not a truncation.** A renderer that cut the surplus would publish a map the author never saw, which is the misaligned description the acceptance studies punish; a refusal costs one tool round-trip.
- **Inline links, never embeds.** Seven embedded permalinks at the median PR is about 150 lines of code in the body, duplicating the Files tab where the reviewer can comment; a link lands on the same highlighted lines one click away.
- **The collapsed half is capped too.** Otherwise the coverage instinct moves 14,000 characters into `<details>` and every reader of the whole body (the review agent, the artifact, `gh pr view`) pays anyway; the worst-case body is under 26,000 characters.
- **Remaining changes dropped.** A file catalog restates the Files tab; the studies say the description should say why, and the diff already says what.

</details>

<details>
<summary>Validation (9 criteria)</summary>

| Criterion | Proof |
|---|---|
| The schema refuses an eighth pointer and any field over its cap, naming the field and the count | `[unit]` `src/core/prDescription.test.ts::caps every map field…`, `::caps the pointers at seven…` |
| A rendered body contains no bare permalink line; every pointer is `N. [label](url) text`, ⚠ only with a risk | `[unit]` `::never writes a bare permalink line…`, `::a pointer is…` |
| A maximal object renders a map under 3,800 visible characters | `[unit]` `::a maximal object renders a map under 3,800 visible characters` |
| Decisions, validation and agent notes render as `<details>` after the map; footer last | `[unit]` `::renders the map in the contract order…`, `::the folds…` |
| Render then parse returns the same pointers with each anchor's render sha; the golden renders byte for byte | `[unit]` `::golden round trip…`, `golden: a full PR description rendered through the pipeline` |
| A legacy Tour body parses to pointers with `complete: false` and a `legacy Tour shape` problem | `[unit]` `::a legacy Tour body parses by the old grammar…` |
| The line parser accepts a stored artifact with `tour` and one with `pointers` | `[unit]` `src/core/runEventLines.test.ts::accepts a pr_description review_artifact…` |
| The `pr-description` skill pins the caps, the choice rule, the inline-link rule, the anchor rules and the fold | `[unit]` `src/skills/prDescriptionSkill.test.ts` |
| Both coding prompts name the map's fields and require loading `pr-description`; `pr-tour` appears nowhere | `[unit]` `src/agents/registry.test.ts` |

</details>

<details>
<summary>For agents</summary>

The golden fixture under `src/core/testing/` is this PR's own description rendered at the fixture repo `acme/api`; the Tour-shaped tests that pinned the previous contract were rewritten, not deleted, so every old assertion has a successor.

</details>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
