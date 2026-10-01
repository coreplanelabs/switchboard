// This source is part of the trusted build, never read from a model-writable
// checkout. All inspected bytes stay in this child; only the closed DTO leaves.
// Helpers are inspected as configuration, never invoked. A root model UID
// cannot attest its own interpreter and therefore cannot complete this probe.
export const CREDENTIAL_PROBE_SOURCE = String.raw`
import json, os, pwd, re, resource, selectors, signal, stat, subprocess, sys, time

LIMIT = 65536
APP = re.compile(rb"ghs_[A-Za-z0-9_]{8,}")
OTHER = re.compile(rb"(?:ghu_|gho_|ghp_|ghr_|github_pat_|sbr_)[A-Za-z0-9_.-]{8,}")
RUN_BEARER_PATTERN = re.compile(rb"sbr_([A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]{20,128}\Z")
HELPER = b'''!f() { test -n "$GH_ENTERPRISE_TOKEN" || exit 1; printf '%s\\n' 'username=x-access-token' "password=$GH_ENTERPRISE_TOKEN"; }; f'''

def empty():
    return dict(completed=False, bindingMatched=False, commandEnvironments=0,
                harnessEnvironments=0, filesChecked=0, helperEntries=0,
                appTokenMatches=0, unknownCount=0)

def classify(data, expected, out):
    out["appTokenMatches"] += len(APP.findall(data))
    if OTHER.search(APP.sub(b"", data).replace(expected, b"")):
        out["unknownCount"] += 1

def environment(env, expected, out):
    forbidden = {"GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITHUB_APP_PRIVATE_KEY",
                 "SWITCHBOARD_GIT_CREDENTIAL", "GIT_ASKPASS", "SSH_ASKPASS", "BASH_ENV", "ENV",
                 "LD_PRELOAD", "LD_LIBRARY_PATH"}
    for key, value in env.items():
        classify(os.fsencode(value), expected, out)
        if value and key in forbidden:
            out["unknownCount"] += 1

def helpers(data, expected, host, out):
    classify(data, expected, out)
    door = b"credential.https://" + os.fsencode(host) + b".helper"
    door_count = 0
    for entry in data.split(b"\0"):
        if not entry:
            continue
        key, sep, value = entry.partition(b"\n")
        if not sep:
            out["unknownCount"] += 1
            continue
        if key == b"credential.helper" or (key.startswith(b"credential.") and key.endswith(b".helper")):
            out["helperEntries"] += 1
            if key == door and value == HELPER:
                door_count += 1
            elif value:
                # A shell helper, store, cache or gh can hide another source.
                # Never execute it merely to obtain an absence receipt.
                out["unknownCount"] += 1
        elif key == b"core.askpass" and value:
            out["unknownCount"] += 1
    if door_count != 1:
        out["unknownCount"] += 1

def credential_file(data, expected, out):
    out["filesChecked"] += 1
    if data:
        classify(data, expected, out)
        # Nonempty credential files require their own format-aware proof.
        out["unknownCount"] += 1

def bounded_file(path):
    # Reject symlinks in every component, not just the leaf; refuse FIFOs.
    if not os.path.isabs(path) or any(p in (".", "..") for p in path.split("/")):
        raise ValueError()
    parts = [p for p in path.split("/") if p]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        leaf = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(leaf)
            if not stat.S_ISREG(before.st_mode) or before.st_size > LIMIT:
                raise ValueError()
            data = os.read(leaf, LIMIT + 1)
            after = os.fstat(leaf)
            if len(data) != before.st_size or (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise ValueError()
            return data
        finally:
            os.close(leaf)
    except FileNotFoundError:
        return b""
    finally:
        os.close(fd)

def trusted_binary(path):
    resolved = os.path.realpath(path)
    current = resolved
    while current != "/":
        info = os.lstat(current)
        if info.st_uid != 0 or info.st_mode & 0o022:
            return False
        current = os.path.dirname(current)
    return stat.S_ISREG(os.stat(resolved).st_mode)

def git(args):
    # Fixed read-only argv; bounded pipes, no helper, hook, pager or prompt.
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GIT_PAGER="cat", GIT_OPTIONAL_LOCKS="0")
    child = subprocess.Popen(["/usr/bin/git"] + args, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, start_new_session=True)
    buffers = [bytearray(), bytearray()]
    try:
        deadline = time.monotonic() + 2
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ, buffers[0])
            selector.register(child.stderr, selectors.EVENT_READ, buffers[1])
            while selector.get_map():
                left = deadline - time.monotonic()
                if left <= 0:
                    raise ValueError()
                for key, _ in selector.select(left):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        key.data.extend(chunk)
                        if len(key.data) > LIMIT:
                            raise ValueError()
        if child.wait(timeout=max(0.01, deadline - time.monotonic())) != 0 or buffers[1]:
            raise ValueError()
        return bytes(buffers[0])
    finally:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        child.wait(timeout=1)
        child.stdout.close()
        child.stderr.close()

def process_env(pid):
    path = "/proc/" + str(pid)
    if os.stat(path).st_uid != os.getuid():
        raise ValueError()
    with open(path + "/stat", "rb") as file:
        identity = file.read(LIMIT)
    with open(path + "/environ", "rb") as file:
        data = file.read(LIMIT + 1)
    if len(data) > LIMIT:
        raise ValueError()
    env = {}
    for entry in data.split(b"\0"):
        if entry:
            key, sep, value = entry.partition(b"=")
            if not sep or os.fsdecode(key) in env:
                raise ValueError()
            env[os.fsdecode(key)] = os.fsdecode(value)
    # starttime is field 22; comm can contain spaces or parentheses.
    return env, identity.rsplit(b")", 1)[1].split()[19]

def boot_id():
    # procfs reports a zero file size; regular-file size checks do not apply.
    with open("/proc/sys/kernel/random/boot_id", "rb") as file:
        value = file.read(80).strip()
    if not re.fullmatch(rb"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value):
        raise ValueError()
    return value

def inspect(ask, out):
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if os.getuid() == 0 or not trusted_binary("/usr/bin/python3") or not trusted_binary("/usr/bin/git"):
        raise ValueError()
    env = dict(os.environ)
    expected = os.fsencode(env.get("GH_ENTERPRISE_TOKEN", ""))
    match = RUN_BEARER_PATTERN.fullmatch(expected)
    if not match or os.fsdecode(match[1]) != ask["runId"]:
        raise ValueError()
    harness, identity = process_env(ask["pid"])
    birth = boot_id() + b":" + identity
    if birth != os.fsencode(ask["processBirth"]):
        raise ValueError()
    if harness.get("SWITCHBOARD_RUN_ID") != ask["runId"] or harness.get("GH_ENTERPRISE_TOKEN") != os.fsdecode(expected):
        raise ValueError()
    environment(env, expected, out)
    out["commandEnvironments"] = 1
    environment(harness, expected, out)
    out["harnessEnvironments"] = 1
    host = env.get("GH_HOST", "")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", host) or env.get("GH_REPO") != host + "/" + ask["repo"]:
        raise ValueError()
    def binding():
        return (git(["symbolic-ref", "--short", "HEAD"]).strip() == os.fsencode(ask["ref"])
                and git(["rev-parse", "HEAD"]).strip() == os.fsencode(ask["head"]))
    if not binding():
        raise ValueError()
    helpers(git(["config", "--null", "--list"]), expected, host, out)
    who = pwd.getpwuid(os.getuid())
    gitdir = os.fsdecode(git(["rev-parse", "--absolute-git-dir"]).strip())
    paths = {who.pw_dir + "/.git-credentials", who.pw_dir + "/.config/gh/hosts.yml",
             "/workspace/.git-credentials", "/workspace/.stage-" + who.pw_name + "/cred",
             gitdir + "/github-credentials"}
    for source in (env, harness):
        if source.get("HOME"):
            paths.add(source["HOME"] + "/.git-credentials")
            paths.add(source["HOME"] + "/.config/gh/hosts.yml")
        if source.get("GH_CONFIG_DIR"):
            paths.add(source["GH_CONFIG_DIR"] + "/hosts.yml")
        if source.get("XDG_CONFIG_HOME"):
            paths.add(source["XDG_CONFIG_HOME"] + "/gh/hosts.yml")
    for path in sorted(paths):
        try:
            credential_file(bounded_file(path), expected, out)
        except Exception:
            out["unknownCount"] += 1
    after_env, after_identity = process_env(ask["pid"])
    out["bindingMatched"] = binding() and identity == after_identity and after_env == harness
    out["completed"] = out["bindingMatched"] and out["unknownCount"] == 0

if __name__ == "__main__":
    out = empty()
    try:
        inspect(json.loads(sys.argv[1]), out)
    except BaseException:
        out["completed"] = False
        out["unknownCount"] += 1
    print(json.dumps(out, separators=(",", ":")))
`;
