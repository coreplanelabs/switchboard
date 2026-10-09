import { mkdtempSync, readFileSync, rmSync, writeFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { PACKAGE_ROOT, PACKAGE_SOURCE_FILE, packageVersion } from "../packageRoot.js";
import { cliVersionOnHost, OPERATOR_ROOT, workAreaNpmCiArgs } from "./host.js";
import { resolveOperatorRoot } from "./operatorRoot.js";
import { run, defaultSandboxGateDeps } from "./run.js";
import { TEST_PROFILE } from "./testing/profile.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

// Feature: docs/reference/specs/release-and-deploy.md item 25 — one version source
// for what the CLI copies and references: `cliVersionOnHost` is the root
// `package.json`'s in a checkout and `source.json`'s from the published package,
// and the command catalogue hands the deploy commands exactly that function.

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

describe("deployment command cancellation", () => {
  it("cancellation during whoami prevents token verification and the next capability or Git command", async ({
    signal,
    onTestFinished,
  }) => {
    for (const cancel of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "deploy-prechecks-"));
      const calls = join(dir, "calls");
      const ready = join(dir, "ready");
      const release = join(dir, "release-whoami");
      const written = join(dir, "written-configs.jsonl");
      let child: ReturnType<typeof spawn> | undefined;
      let done: Promise<{ code: number | null; signal: string | null }> | undefined;
      let readyWatch: ReturnType<typeof watch> | undefined;
      const stop = () => child?.kill("SIGTERM");
      signal.addEventListener("abort", stop);
      onTestFinished(async () => {
        readyWatch?.close();
        if (child && child.exitCode === null && child.signalCode === null) stop();
        if (done) await done;
      });
      try {
        writeFileSync(
          join(dir, "npx"),
          `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2).join(' ');if(args==='wrangler whoami'){const finish=()=>{if(fs.existsSync(process.env.FIXTURE_RELEASE)){held.close();console.log('no memberships');}};const held=fs.watch(process.env.TMPDIR,finish);fs.writeFileSync(process.env.FIXTURE_READY,'ready');finish();}else if(args==='wrangler containers list --json'){fs.appendFileSync(process.env.FIXTURE_CALLS,'capability\\n');console.log('[]');}else process.exit(99);`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(dir, "git"),
          `#!${process.execPath}
require('node:fs').appendFileSync(process.env.FIXTURE_CALLS,'git\\n');if(process.argv.slice(2).join(' ')==='rev-parse HEAD')console.log('a'.repeat(40));else process.exit(99);`,
          { mode: 0o755 },
        );
        const root = process.cwd();
        const file = join(dir, "runner.mts");
        writeFileSync(
          file,
          `
import {runDeployPlanOnHost,hostDeployFiles} from ${JSON.stringify(join(root, "src/deploy/run.ts"))};
import {planDeploy} from ${JSON.stringify(join(root, "src/deploy/plan.ts"))};
import {TEST_PROFILE} from ${JSON.stringify(join(root, "src/deploy/testing/profile.ts"))};
import {writeFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {OPERATOR_ROOT} from ${JSON.stringify(join(root, "src/deploy/host.ts"))};
import {workPath} from ${JSON.stringify(join(root, "src/deploy/operatorRoot.ts"))};
OPERATOR_ROOT.workArea=${JSON.stringify(dir)};
const write=hostDeployFiles.write;hostDeployFiles.write=async(path,text)=>{appendFileSync(${JSON.stringify(written)},JSON.stringify(workPath(OPERATOR_ROOT,path))+'\\n');await write(path,text);};
process.env.CLOUDFLARE_API_TOKEN='fixture';
const profile=${JSON.stringify(join(dir, "profile.json"))};writeFileSync(profile,JSON.stringify(TEST_PROFILE));process.env.SWITCHBOARD_DEPLOY_PROFILE=profile;
globalThis.fetch=async()=>{appendFileSync(${JSON.stringify(calls)},'http\\n');return Response.json({success:true,result:{status:'active'}});};
const plan=planDeploy({dryRun:false,force:false,allowBranch:true,only:['memory'],waitMaxMinutes:1,pollSeconds:1},{root:{mode:'checkout',path:${JSON.stringify(root)}},hasNodeModules:()=>true},{profile:TEST_PROFILE,origin:'profile',path:profile},{mode:'build'});
plan.checks.cleanTree=false;plan.checks.atOriginMain=false;mkdirSync(${JSON.stringify(join(dir, "deploy/cloudflare-memory/node_modules"))},{recursive:true});plan.steps[0].requiredEnv=[];plan.steps[0].capabilities=[{command:['wrangler','containers','list','--json'],needs:'fixture'}];plan.steps[0].command=[process.execPath,'-e',"console.log('Current Version ID: fixture')"];plan.steps[0].wakeUrl=undefined;
const result=await runDeployPlanOnHost(plan,{log:()=>{},warn:()=>{},stream:()=>{}});console.log(JSON.stringify(result));
`,
        );
        const readyObserved = new Promise<void>((resolve, reject) => {
          const watcher = watch(dir, () => {
            try {
              if (readFileSync(ready, "utf8") === "ready") resolve();
            } catch {
              // The watcher can see the new file before its contents are written.
            }
          });
          readyWatch = watcher;
          watcher.on("error", reject);
        });
        signal.throwIfAborted();
        child = spawn(process.execPath, ["--import", "tsx", file], {
          cwd: root,
          env: {
            PATH: `${dir}:${process.env.PATH}`,
            TMPDIR: dir,
            TMP: dir,
            TEMP: dir,
            FIXTURE_READY: ready,
            FIXTURE_CALLS: calls,
            FIXTURE_RELEASE: release,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += String(chunk);
        });
        child.stderr!.on("data", (chunk) => {
          output += String(chunk);
        });
        done = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
          child!.on("close", (code, signal) => resolve({ code, signal })),
        );
        await Promise.race([
          readyObserved,
          done.then(() => {
            throw new Error("fixture child closed before ready");
          }),
        ]);
        readyWatch?.close();
        if (cancel) child.kill("SIGTERM");
        else writeFileSync(release, "continue");
        expect(await done, output).toEqual({ code: 0, signal: null });
        const writtenPaths = readFileSync(written, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string);
        expect(writtenPaths).toContain(join(dir, "deploy/cloudflare-memory/wrangler.jsonc"));
        expect(writtenPaths.every((path) => path.startsWith(dir + "/"))).toBe(true);
        if (cancel) {
          expect(JSON.parse(output)).toEqual({ kind: "refused", problems: ["deployment cancelled"] });
          expect(() => readFileSync(calls, "utf8")).toThrow();
        } else {
          expect(JSON.parse(output)).toMatchObject({
            kind: "ran",
            ok: true,
            results: [{ name: "memory", status: "deployed (no version id in output?)" }],
            notAttempted: [],
          });
          expect(readFileSync(calls, "utf8")).toBe("http\ncapability\ngit\n");
        }
      } finally {
        signal.removeEventListener("abort", stop);
        readyWatch?.close();
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (done) await done;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("isolates fixture credentials, external tooling and HTTP before signal execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-isolation-"));
    try {
      writeFileSync(
        join(dir, "npx"),
        '#!/bin/sh\nif [ "$*" = "wrangler whoami" ]; then echo fixture-account; exit 0; fi\necho unexpected-external-tool >&2\nexit 99\n',
        { mode: 0o755 },
      );
      const opts = {
        cwd: dir,
        unset: Object.keys(process.env).filter((name) => name !== "PATH"),
        set: { PATH: `${dir}:${process.env.PATH}` },
      };
      expect(await run("npx", ["wrangler", "whoami"], opts)).toEqual({ code: 0, output: "fixture-account\n" });
      expect(await run("npx", ["wrangler", "deploy"], opts)).toEqual({
        code: 99,
        output: "unexpected-external-tool\n",
      });
      const probe = await run(
        process.execPath,
        [
          "-e",
          "process.env.CLOUDFLARE_API_TOKEN='fixture';globalThis.fetch=async()=>new Response(JSON.stringify({status:'fixture'}));fetch('https://never.example').then(r=>r.json()).then(b=>console.log(b.status+':'+Object.keys(process.env).filter(k=>k!=='PATH'&&k!=='CLOUDFLARE_API_TOKEN'&&k!=='__CF_USER_TEXT_ENCODING').length));",
        ],
        opts,
      );
      expect(probe).toEqual({ code: 0, output: "fixture:0\n" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["SIGINT", "SIGTERM", "SIGKILL"] as const)(
    "a real %s ends the host without later Worker work or false cleanup credit",
    async (requestedSignal) => {
      const dir = mkdtempSync(join(tmpdir(), "deploy-signal-"));
      const manifest = join(dir, "owned-configs.json");
      let ownedConfigs: string[] = [];
      let nativeDirs: string[] = [];
      const foreignTemp = mkdtempSync(join(tmpdir(), "deploy-foreign-"));
      writeFileSync(join(foreignTemp, "keep"), "foreign temporary bytes");
      const foreign = join(process.cwd(), "deploy/cloudflare-resident", `.wrangler-plan-${randomUUID()}.jsonc`);
      writeFileSync(foreign, "foreign fixture configuration", { flag: "wx" });
      try {
        writeFileSync(
          join(dir, "npx"),
          `#!/bin/sh\nif [ "$*" = "wrangler whoami" ]; then echo ${TEST_PROFILE.account}; exit 0; fi\necho unexpected-external-tool >&2\nexit 99\n`,
          { mode: 0o755 },
        );
        writeFileSync(
          join(dir, "git"),
          '#!/bin/sh\nif [ "$*" = "rev-parse HEAD" ]; then echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; exit 0; fi\nif [ "$1" = merge-base ]; then exit 1; fi\necho unexpected-git-tool >&2\nexit 99\n',
          { mode: 0o755 },
        );
        const file = join(dir, "runner.mts");
        const root = process.cwd();
        writeFileSync(
          file,
          `
import {runDeployPlanOnHost,defaultSandboxGateDeps} from ${JSON.stringify(join(root, "src/deploy/run.ts"))};
import {planDeploy} from ${JSON.stringify(join(root, "src/deploy/plan.ts"))};
import {TEST_PROFILE} from ${JSON.stringify(join(root, "src/deploy/testing/profile.ts"))};
import {writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
const nativeDirs=new Set();
import {OPERATOR_ROOT} from ${JSON.stringify(join(root, "src/deploy/host.ts"))};
OPERATOR_ROOT.workArea=${JSON.stringify(dir)};
process.env.CLOUDFLARE_API_TOKEN='fixture';
globalThis.fetch=async()=>{return new Response(JSON.stringify({success:true,result:{status:'active'},ok:true,build:{commit:'f'.repeat(40)}}));};
const profile=${JSON.stringify(join(dir, "profile.json"))};writeFileSync(profile,JSON.stringify(TEST_PROFILE));
process.env.SWITCHBOARD_DEPLOY_PROFILE=profile;
const plan=planDeploy({dryRun:false,force:false,allowBranch:true,only:['resident','sandbox'],waitMaxMinutes:1,pollSeconds:60},{root:{mode:'checkout',path:${JSON.stringify(root)}},hasNodeModules:()=>true},{profile:TEST_PROFILE,origin:'profile',path:profile},{mode:'build'});
plan.checks.cleanTree=false;plan.checks.atOriginMain=false;
for(const step of plan.steps){mkdirSync(join(OPERATOR_ROOT.workArea,step.dir,'node_modules'),{recursive:true});step.capabilities=[];step.requiredEnv=[];step.command=[process.execPath,'-e',"console.log('[resident-preflight] preflight REFUSED: fixture');process.exit(1)"];}
const result=await runDeployPlanOnHost(plan,{log:(line)=>{if(line.includes('retrying in'))writeFileSync(${JSON.stringify(manifest)},JSON.stringify({configs:plan.steps.flatMap(step=>readdirSync(join(OPERATOR_ROOT.workArea,step.dir)).filter(file=>file.startsWith('.wrangler-plan-')).map(file=>join(OPERATOR_ROOT.workArea,step.dir,file))),nativeDirs:[...nativeDirs],tempRoot:tmpdir()}));console.log(line);},warn:console.log,stream:(s)=>process.stdout.write(s)},{env:{RESIDENT_DRAIN_TOKEN:'fixture',RESIDENT_READ_TOKEN:'fixture'},now:Date.now,sleep:defaultSandboxGateDeps.sleep,readAppState:async(_dir,_app,config)=>{if(config)nativeDirs.add(dirname(config));return{value:{version:17,image:'registry.example/old'}};},readInstances:async()=>({value:[]}),readHealth:async()=>({status:200,body:{ok:true,build:{commit:'f'.repeat(40)}}}),probeExec:async()=>({error:'no probe'}),postJson:async(url)=>{if(url.endsWith('/undrain')){console.log('cleanup acknowledged');return{status:200,body:{cleared:true,draining:null}};}return{status:200,body:{draining:{since:'start',until:'later',by:'deploy all',reason:'fixture'}}};}});
console.log('terminal:'+result.kind+':'+(result.kind==='ran'?result.ok+':'+result.notAttempted.join(','):result.problems.join(',')));
`,
        );
        const result = await new Promise<{ code: number | null; signal: string | null; output: string }>(
          (resolve, reject) => {
            const child = spawn(process.execPath, ["--import", "tsx", file], {
              cwd: root,
              env: { PATH: `${dir}:${process.env.PATH}`, TMPDIR: dir, TMP: dir, TEMP: dir },
              stdio: ["ignore", "pipe", "pipe"],
            });
            let output = "";
            child.stdout.on("data", (chunk) => {
              const text = String(chunk);
              output += text;
              if (text.includes("retrying in")) child.kill(requestedSignal);
            });
            child.stderr.on("data", (chunk) => {
              output += String(chunk);
            });
            child.on("error", reject);
            child.on("close", (code, signal) => resolve({ code, signal, output }));
          },
        );
        const resources = JSON.parse(readFileSync(manifest, "utf8"));
        ownedConfigs = resources.configs;
        nativeDirs = resources.nativeDirs;
        expect(resources.tempRoot).toBe(dir);
        expect(nativeDirs).toHaveLength(1);
        expect(nativeDirs.every((path) => path.startsWith(dir + "/"))).toBe(true);
        expect(ownedConfigs).toHaveLength(2);
        if (requestedSignal === "SIGKILL") {
          expect(result).toMatchObject({ code: null, signal: "SIGKILL" });
          expect(result.output).not.toContain("cleanup acknowledged");
          expect(result.output).not.toContain("terminal:ran");
        } else {
          expect(result, result.output).toMatchObject({ code: 0, signal: null });
          expect(result.output).toContain("cleanup acknowledged");
          expect(result.output).toContain("terminal:ran:false:sandbox");
        }
        expect(result.output.match(/▶ resident/g)).toHaveLength(1);
        expect(result.output).not.toContain("▶ sandbox");
      } finally {
        for (const path of nativeDirs) rmSync(path, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
        try {
          expect(readFileSync(join(foreignTemp, "keep"), "utf8")).toBe("foreign temporary bytes");
          expect(readFileSync(foreign, "utf8")).toBe("foreign fixture configuration");
          for (const path of ownedConfigs) expect(() => readFileSync(path, "utf8")).toThrow();
        } finally {
          rmSync(foreign, { force: true });
          rmSync(foreignTemp, { recursive: true, force: true });
        }
      }
    },
  );

  it("readiness inventory refuses repeated cursors instead of returning a partial fleet", async () => {
    const savedEnv = process.env;
    for (const repeat of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "readiness-pages-"));
      const calls = join(dir, "calls");
      const app = `fixture-app-${randomUUID()}`;
      try {
        writeFileSync(
          join(dir, "npx"),
          `#!${process.execPath}
const fs=require('node:fs');const a=process.argv.slice(2);const file=process.env.FIXTURE_CALLS;
if(a.slice(0,3).join(' ')==='wrangler containers list'){console.log(JSON.stringify([{name:process.env.FIXTURE_APP,id:'owned-fixture-app'}]));}
else if(a.slice(0,3).join(' ')==='wrangler containers instances'){
const at=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').length:0;fs.appendFileSync(file,'page\\n');
console.log(JSON.stringify({instances:[{name:at===0?'first':'second',state:'running',version:12}],result_info:{next_page_token:at===0||process.env.FIXTURE_REPEAT==='yes'?'private-cursor':null}}));
}else process.exit(98);`,
          { mode: 0o755 },
        );
        // Only the owned shim is on PATH; no live credential or endpoint is inherited.
        process.env = {
          PATH: dir,
          CLOUDFLARE_API_TOKEN: "synthetic-no-access",
          FIXTURE_CALLS: calls,
          FIXTURE_APP: app,
          FIXTURE_REPEAT: repeat ? "yes" : "no",
        };
        const result = await defaultSandboxGateDeps.readInstances(
          "deploy/cloudflare-sandbox",
          app,
          undefined,
          new AbortController().signal,
        );
        if (repeat)
          expect(result).toEqual({ error: "instance inventory repeated a page token; completeness unverified" });
        else
          expect(result).toEqual({
            value: [
              { name: "first", state: "running", version: 12 },
              { name: "second", state: "running", version: 12 },
            ],
          });
        expect(readFileSync(calls, "utf8")).toBe("page\npage\n");
        expect(JSON.stringify(result)).not.toContain("private-cursor");
      } finally {
        process.env = savedEnv;
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("owned readiness command exits and uncertain group signalling retain truthful results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-results-"));
    const unset = Object.keys(process.env).filter((name) => name !== "PATH");
    try {
      expect(
        await run(process.execPath, ["-e", "process.stdout.write('diagnostic');process.exit(7)"], {
          cwd: dir,
          unset,
          ownedReadGroup: true,
        }),
      ).toEqual({ code: 7, output: "diagnostic" });
      const missing = await run(join(dir, "not-a-command"), [], { cwd: dir, unset, ownedReadGroup: true });
      expect(missing.code).toBe(127);
      expect(missing.output).toContain("ENOENT");
      const control = new AbortController();
      const kill = process.kill.bind(process);
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid < 0) {
          const err = new Error("synthetic group refusal") as NodeJS.ErrnoException;
          err.code = "EPERM";
          throw err;
        }
        return kill(pid, signal);
      });
      try {
        const result = await run(
          process.execPath,
          ["-e", "process.stdout.write('ready\\n');setInterval(()=>{},1000)"],
          {
            cwd: dir,
            unset,
            ownedReadGroup: true,
            signal: control.signal,
            stream: (text) => {
              if (text.includes("ready")) control.abort();
            },
          },
        );
        expect(result).toEqual({ code: 130, cancelled: true, output: "ready\n", cleanup: "unconfirmed" });
        expect(result).not.toHaveProperty("stopped");
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an already cancelled owned readiness command never spawns or writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "readiness-preabort-"));
    try {
      const marker = join(dir, "unexpected");
      const normal = await run(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1],'complete')", marker],
        {
          cwd: dir,
          ownedReadGroup: true,
          unset: Object.keys(process.env).filter((name) => name !== "PATH"),
        },
      );
      expect(normal).toEqual({ code: 0, output: "" });
      expect(readFileSync(marker, "utf8")).toBe("complete");
      rmSync(marker);
      const control = new AbortController();
      control.abort();
      const result = await run(
        process.execPath,
        ["-e", "require('node:fs').writeFileSync(process.argv[1],'unexpected')", marker],
        {
          cwd: dir,
          signal: control.signal,
          ownedReadGroup: true,
          unset: Object.keys(process.env).filter((name) => name !== "PATH"),
        },
      );
      expect(result).toEqual({ code: 130, output: "", cancelled: true });
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([false, true])(
    "an owned readiness group stops noncooperating descendants before later work, privateStdio=%s",
    async (privateStdio) => {
      const dir = mkdtempSync(join(tmpdir(), "readiness-owned-group-"));
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      try {
        const marker = join(dir, "later");
        const ids = join(dir, "ids");
        const readyFile = join(dir, "child-ready");
        const childFile = join(dir, "child ' quoted.cjs");
        writeFileSync(
          childFile,
          "const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.appendFileSync(process.argv[3],process.pid+'\\n');if(process.argv[5]==='private')fs.writeFileSync(process.argv[4],'ready');else process.stdout.write('child-ready\\n');setTimeout(()=>fs.writeFileSync(process.argv[2],'later'),250);setInterval(()=>{},1000);",
        );
        const script =
          "const fs=require('node:fs');const privateStdio=process.argv[5]==='private';fs.writeFileSync(process.argv[2],process.pid+'\\n');process.on('SIGTERM',()=>{});require('node:child_process').spawn(process.execPath,[process.argv[4],process.argv[1],process.argv[2],process.argv[3],process.argv[5]],{stdio:privateStdio?'ignore':['ignore','inherit','inherit']});if(privateStdio){const probe=setInterval(()=>{if(fs.existsSync(process.argv[3])){clearInterval(probe);process.stdout.write('child-ready\\n');}},5);}setInterval(()=>{},1000);";
        const control = new AbortController();
        let returned: Awaited<ReturnType<typeof run>> | undefined;
        let ready!: () => void;
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const pending = run(
          process.execPath,
          ["-e", script, marker, ids, readyFile, childFile, privateStdio ? "private" : "inherit"],
          {
            cwd: dir,
            unset: Object.keys(process.env).filter((name) => name !== "PATH"),
            signal: control.signal,
            ownedReadGroup: true,
            stream: (text) => {
              if (text.includes("child-ready")) ready();
            },
          } as Parameters<typeof run>[2],
        ).then((result) => {
          returned = result;
          return result;
        });
        try {
          await started;
          [parentPid, descendantPid] = readFileSync(ids, "utf8").trim().split("\n").map(Number);
          control.abort();
          // This delay observes the source's actual settlement; it is not a production grace timer.
          await new Promise<void>((resolve) => setTimeout(resolve, 300));
          expect(returned).toEqual({ code: 130, cancelled: true, output: "child-ready\n" });
          expect(() => readFileSync(marker, "utf8")).toThrow();
        } finally {
          for (const pid of [parentPid, descendantPid])
            if (Number.isSafeInteger(pid) && pid! > 0) {
              try {
                process.kill(pid!, "SIGKILL");
              } catch {
                /* The owned fixture may have already ended. */
              }
            }
          await pending;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("a parent close does not claim ending for a noncooperating descendant with private stdio", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-unconfirmed-"));
    try {
      const marker = join(dir, "later ' quoted");
      const childFile = join(dir, "child ' quoted.cjs");
      writeFileSync(
        childFile,
        "setTimeout(()=>{require('node:fs').writeFileSync(process.argv[2],'still active');},150);",
      );
      const script =
        "require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[1]],{stdio:'ignore'});process.stdout.write('ready\\n');setInterval(()=>{},1000);";
      const control = new AbortController();
      const result = await run(process.execPath, ["-e", script, marker, childFile], {
        cwd: dir,
        unset: Object.keys(process.env).filter((name) => name !== "PATH"),
        signal: control.signal,
        stream: (text) => {
          if (text.includes("ready")) control.abort();
        },
      } as Parameters<typeof run>[2]);
      expect(result).toEqual({ code: 130, cancelled: true, output: "ready\n" });
      await expect
        .poll(() => {
          try {
            return readFileSync(marker, "utf8");
          } catch {
            return "pending";
          }
        })
        .toBe("still active");
      expect(result).not.toHaveProperty("stopped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("awaits a cooperating command and its child instead of executing later work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deploy-cancel-"));
    try {
      const marker = join(dir, "later ' quoted");
      const child =
        "setTimeout(() => { require('node:fs').writeFileSync(process.argv[1], 'later'); process.stdout.write('later\\n'); }, 150);";
      const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(child)},process.argv[1]],{stdio:['ignore','inherit','inherit']}); let cancelled=false; process.on('SIGTERM',()=>{cancelled=true;child.kill('SIGTERM');}); child.on('close',()=>{process.stdout.write(cancelled?'settled\\n':'completed\\n');process.exit(0);}); process.stdout.write('ready\\n');`;
      const unset = Object.keys(process.env).filter((name) => name !== "PATH");
      const normal = await run(process.execPath, ["-e", script, marker], { cwd: dir, unset });
      expect(normal).toMatchObject({ code: 0, output: "ready\nlater\ncompleted\n" });
      expect(readFileSync(marker, "utf8")).toBe("later");
      rmSync(marker);
      const control = new AbortController();
      const result = await run(process.execPath, ["-e", script, marker], {
        cwd: dir,
        unset,
        signal: control.signal,
        stream: (text: string) => {
          if (text.includes("ready")) control.abort();
        },
      } as Parameters<typeof run>[2]);
      expect(result).toMatchObject({ code: 130, cancelled: true, output: "ready\nsettled\n" });
      expect(() => readFileSync(marker, "utf8")).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workAreaNpmCiArgs", () => {
  it("installs the root runtime closure with every selected Worker", () => {
    expect(workAreaNpmCiArgs(["deploy/cloudflare", "deploy/cloudflare-memory"])).toEqual([
      "ci",
      "--include-workspace-root",
      "--no-audit",
      "--no-fund",
      "--workspace",
      "deploy/cloudflare",
      "--workspace",
      "deploy/cloudflare-memory",
    ]);
  });
});

describe("cliVersionOnHost", () => {
  it("in a checkout is the root package.json's version — the same number packageVersion() reads", () => {
    expect(OPERATOR_ROOT.mode).toBe("checkout");
    const root = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string };
    expect(cliVersionOnHost()).toBe(packageVersion());
    expect(cliVersionOnHost()).toBe(root.version);
  });

  it("from the package is source.json's version, and a package without one throws naming the file", () => {
    const assets = mkdtempSync(join(tmpdir(), "switchboard-assets-"));
    temps.push(assets);
    const at = resolveOperatorRoot({ packageRoot: assets, published: true, cwd: join(assets, "op") });
    expect(() => cliVersionOnHost(at)).toThrow(`${PACKAGE_SOURCE_FILE}: no such file in the package's assets`);
    writeFileSync(
      join(assets, PACKAGE_SOURCE_FILE),
      JSON.stringify({ version: "9.9.9", commit: "c".repeat(40), builtAt: "2000-01-01T00:00:00.000Z" }),
    );
    expect(cliVersionOnHost(at)).toBe("9.9.9");
    expect(cliVersionOnHost(at)).not.toBe(packageVersion());
  });

  it("is what the command catalogue binds as deps.deploy.cliVersion — not packageVersion, which from the package would be the manifest's, not the stamp's", () => {
    const catalogue = readFileSync(join(PACKAGE_ROOT, "src/core/commandCatalogue.ts"), "utf8");
    expect(catalogue).toMatch(/cliVersion: cliVersionOnHost,/);
    expect(catalogue).not.toMatch(/cliVersion: packageVersion/);
  });
});
