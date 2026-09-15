// The checked-in attach set of `load:route` (docs/reference/specs/
// load-harness.md item 17): the four production requests that named the
// `attach_file` tool and were routed to a preset without it — mostly read-only
// asks ("no code changes", a polling loop, a report) that end by asking for a
// file to be attached with the tool — plus one control, the one recurrence of
// the same shape that never named the tool, which stays a judgement for the
// model. The four are what the structural route in `route()` settles without
// the model (docs/reference/specs/routing-and-config.md item 21); they are kept
// verbatim except for the repository, which is neutral (acme/…): the public
// tree carries no private references.

import type { RouteImperativeFixture } from "./routeImperativeFixtures.js";

/** The attach set shares the imperative fixture's shape so `replayImperative`
 *  scores it: an `imperative` here is an ask that names the tool and expects
 *  the preset that holds it; the `decoy` is the control that names no tool and
 *  may land on either read-only preset the model picks. */
export type RouteAttachFixture = RouteImperativeFixture;

const HOLDER = ["coding"];
const READ_ONLY = ["research", "general", "explore"];

export const ROUTE_ATTACH_FIXTURES: readonly RouteAttachFixture[] = [
  {
    id: "a01",
    kind: "imperative",
    text: 'in acme/widgets: a live test of a large file dropped on a thread, no code changes — do not commit or push anything. The attached video is too large to be shown to you inline; it should be in ./attachments/ in your workspace. Report its path, size in bytes and sha256, then make a 4x3 contact sheet of it with ffmpeg (`ffmpeg -i <file> -vf "fps=12/80,scale=320:-1,tile=4x3" -frames:v 1 out/contact-sheet.png`) and attach the sheet here with attach_file. If the file is not in ./attachments/, say exactly what your turn\'s text said about it.',
    presets: HOLDER,
  },
  {
    id: "a02",
    kind: "imperative",
    text: "in acme/widgets: a live test of a file arriving mid-run, no code changes — do not commit or push anything. A file will be dropped on this thread while you work. Poll `ls -la ./attachments/ 2>/dev/null` every 20 seconds for up to 4 minutes (`sleep 20` between checks) until a file appears. Then write a one-line text file out/received.txt with its path, size in bytes and sha256, attach that file here with attach_file, quote the steer text you received about the dropped file verbatim in your reply, and stop. If nothing appears in 4 minutes, say so.",
    presets: HOLDER,
  },
  {
    id: "a03",
    kind: "imperative",
    text: "in acme/widgets: no code changes — do not commit or push anything. Call attach_file once on the path out/does-not-exist.txt (do not create the file), quote the tool result verbatim in your reply, and stop.",
    presets: HOLDER,
  },
  {
    id: "a04",
    kind: "imperative",
    text: "in acme/widgets: a live check of files on the run page, no code changes — do not commit or push anything. The attached file should be in ./attachments/; report its path and size. A second file will be dropped on this thread while you work: poll `ls -la ./attachments/` every 20 seconds for up to 3 minutes until it appears, then report its path and size too. Then write out/note.txt containing the line `join receipt` and render a small PNG with ffmpeg (`ffmpeg -y -f lavfi -i testsrc=size=320x180:rate=1 -frames:v 1 out/pattern.png`), attach both with attach_file, quote each tool result verbatim, and stop.",
    presets: HOLDER,
  },
  // The control: the same shape with no tool named — the model's call, as before.
  {
    id: "a05",
    kind: "decoy",
    text: "in acme/widgets: a live test of a file arriving mid-run, no code changes — do not commit or push anything. A file will be dropped on this thread while you work. Poll `ls -la ./attachments/ 2>/dev/null` every 20 seconds for up to 4 minutes (`sleep 20` between checks) until a file appears; then report its path, size in bytes and sha256, quote the steer text you received about it verbatim, and stop. If nothing appears in 4 minutes, say so.",
    presets: READ_ONLY,
  },
];
