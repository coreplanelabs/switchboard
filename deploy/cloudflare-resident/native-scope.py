#!/usr/bin/python3
"""Trusted entry point. Requests arrive on stdin, never through a guest RPC."""
import ctypes
import fcntl
import json
import os
import pathlib
import platform
import pwd
import re
import subprocess
import stat
import sys
import time
import uuid

ROOT = pathlib.Path('/run/switchboard-native-v1')
CGROUP = pathlib.Path('/sys/fs/cgroup/switchboard-native-v1')
BOOT = pathlib.Path('/proc/sys/kernel/random/boot_id')
MAX_INPUT = 4 * 1024 * 1024
CONTROL_PORT = 3000


class Insn(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ubyte), ('regs', ctypes.c_ubyte), ('off', ctypes.c_short), ('imm', ctypes.c_int)]


class Load(ctypes.Structure):
    _fields_ = [('type', ctypes.c_uint), ('count', ctypes.c_uint), ('insns', ctypes.c_ulonglong),
                ('license', ctypes.c_ulonglong), ('log_level', ctypes.c_uint), ('log_size', ctypes.c_uint),
                ('log_buf', ctypes.c_ulonglong), ('kern_version', ctypes.c_uint), ('flags', ctypes.c_uint),
                ('name', ctypes.c_char * 16), ('ifindex', ctypes.c_uint), ('attach_type', ctypes.c_uint)]


class Attach(ctypes.Structure):
    _fields_ = [('target', ctypes.c_uint), ('program', ctypes.c_uint), ('type', ctypes.c_uint),
                ('flags', ctypes.c_uint), ('replace', ctypes.c_uint)]


def call_bpf(command, value):
    if platform.machine() != 'x86_64':
        raise ValueError('unsupported kernel architecture')
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.syscall(321, command, ctypes.byref(value), ctypes.sizeof(value))
    if result < 0:
        raise OSError(ctypes.get_errno(), 'kernel network guard refused')
    return result


def protect_control(group):
    # The SDK control port is reserved in this image. A workload cannot ask
    # its outside server to create an unconfined process or write a control.
    import socket
    instructions = (Insn * 5)(Insn(0x61, 0x12, 24, 0), Insn(0xb7, 0, 0, 1),
                              Insn(0x55, 2, 1, socket.htons(CONTROL_PORT)),
                              Insn(0xb7, 0, 0, 0), Insn(0x95, 0, 0, 0))
    license = ctypes.create_string_buffer(b'GPL')
    log = ctypes.create_string_buffer(65536)
    target = os.open(group, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for kind in (10, 11):
            value = Load(18, len(instructions), ctypes.addressof(instructions), ctypes.addressof(license),
                         1, len(log), ctypes.addressof(log), 0, 0, b'run_control', 0, kind)
            program = call_bpf(5, value)
            try:
                call_bpf(8, Attach(target, program, kind, 0, 0))
            finally:
                os.close(program)
    finally:
        os.close(target)


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid native identifier')
    return value


def reference(value):
    if not isinstance(value, dict) or set(value) != {'version', 'id', 'boot', 'threadKey', 'owner'}:
        raise ValueError('invalid native reference')
    if value['version'] != 1 or value['boot'] != BOOT.read_text().strip():
        raise ValueError('original kernel is unavailable')
    identifier(value['id'])
    owner = value['owner']
    if (not isinstance(owner, dict) or set(owner) != {'runId', 'ownerGen', 'ownerFence'}
            or not isinstance(owner['ownerFence'], int) or isinstance(owner['ownerFence'], bool)
            or owner['ownerFence'] <= 0):
        raise ValueError('invalid native owner')
    for text in (value['threadKey'], owner['runId'], owner['ownerGen']):
        if not isinstance(text, str) or not text or len(text) > 256 or '\x00' in text:
            raise ValueError('invalid native owner')
    return value


def write_state(path, value):
    temporary = path.with_suffix('.pending')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    parent = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(parent)
    finally:
        os.close(parent)


def populated(group):
    fields = dict(line.split() for line in group.joinpath('cgroup.events').read_text().splitlines())
    return fields['populated'] == '1'


def frozen(group):
    return group.joinpath('cgroup.freeze').read_text().strip() == '1'


def paths(ref):
    ROOT.mkdir(mode=0o700, exist_ok=True)
    CGROUP.mkdir(mode=0o700, exist_ok=True)
    return ROOT / (ref['id'] + '.json'), ROOT / (ref['id'] + '.lock'), CGROUP / ref['id']


def locked(path):
    fd = os.open(path, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    handle = os.fdopen(fd, 'r')
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def original(state, ref):
    saved = json.loads(state.read_text())
    if saved.get('ref') != ref:
        raise ValueError('native owner mismatch')
    return saved


def bootstrap(ref):
    state, lock, group = paths(ref)
    with locked(lock):
        if group.exists() and frozen(group):
            raise ValueError('native scope is closed')
        if state.exists():
            if original(state, ref)['closed']:
                raise ValueError('native scope is closed')
            if not group.exists():
                raise ValueError('native scope is incomplete')
            return {'ref': ref, 'closed': False}
        if group.exists():
            raise ValueError('native creation outcome is unconfirmed')
        group.mkdir(mode=0o700)
        try:
            protect_control(group)
            write_state(state, {'ref': ref, 'closed': False})
        except BaseException:
            group.joinpath('cgroup.freeze').write_text('1')
            raise
    return {'ref': ref, 'closed': False}


def close(ref, attempt=None):
    state, lock, group = paths(ref)
    if state.exists():
        original(state, ref)
    target = group / identifier(attempt) if attempt is not None else group
    target.mkdir(mode=0o700, exist_ok=True)
    target.joinpath('cgroup.freeze').write_text('1')
    deadline = time.monotonic() + 1.5
    # The hold remains set even if a launcher held the filesystem lock when
    # closure began. Killing that admitted launcher releases its lock.
    fd = os.open(lock, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        while True:
            target.joinpath('cgroup.kill').write_text('1')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if not populated(target):
                    break
                fcntl.flock(fd, fcntl.LOCK_UN)
            except BlockingIOError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError('native closure is unconfirmed')
            time.sleep(.01)
        if attempt is None:
            write_state(state, {'ref': ref, 'closed': True})
    finally:
        os.close(fd)
    return {'ref': ref, 'closed': attempt is None, 'populated': False,
            **({'attempt': attempt} if attempt is not None else {})}


def view(ref):
    state, lock, group = paths(ref)
    fd = os.open(lock, os.O_RDONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        # An empty frozen group is insufficient while a launcher can still
        # cross admission. Observe under the same short controller lock.
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if state.exists():
            original(state, ref)
        if not group.exists():
            if state.exists():
                raise ValueError('native scope is incomplete')
            return {'ref': ref, 'closed': False, 'populated': False, 'present': False, 'ready': False}
        return {'ref': ref, 'closed': frozen(group), 'populated': populated(group), 'present': True, 'ready': state.exists()}
    finally:
        os.close(fd)


def mount_command(*args):
    subprocess.run(['/usr/bin/mount', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def prepare_view(ref, role, user):
    # No payload keeps a path or descriptor to the controller's writable
    # roots. The selected workspace remains the existing shared disk.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(0x00020000) != 0:  # CLONE_NEWNS
        raise OSError(ctypes.get_errno(), 'private mount view refused')
    mount_command('--make-rprivate', '/')
    mount_command('--rbind', '/', '/')
    mount_command('-o', 'remount,bind,ro', '/')
    allowed = ['/workspace']
    if user is not None:
        allowed.append(user.pw_dir)
    for path in allowed:
        if pathlib.Path(path).is_dir():
            mount_command('--bind', path, path)
            mount_command('-o', 'remount,bind,rw', path)
    scratch = ROOT / (ref['id'] + '.tmp')
    # Created by the outside launcher before entering the read-only view.
    mount_command('--bind', str(scratch), '/tmp')
    mount_command('-o', 'remount,bind,rw', '/tmp')
    mount_command('-t', 'tmpfs', '-o', 'mode=755', 'none', '/run')
    mount_command('--bind', '/sys/fs/cgroup', '/sys/fs/cgroup')
    mount_command('-o', 'remount,bind,ro', '/sys/fs/cgroup')


def provision_account(name):
    # The only command that may write the account database is fixed here.
    # Generic root payloads see /etc read-only and cannot change host loaders.
    if not isinstance(name, str) or not re.fullmatch(r'worker[1-9]\d*', name):
        raise ValueError('invalid workload account')
    number = int(name[6:])
    if number < 2 or number > 2147481647:
        raise ValueError('invalid workload account')
    uid = number + 2000
    home = pathlib.Path('/home') / name
    try:
        account = pwd.getpwnam(name)
    except KeyError:
        try:
            pwd.getpwuid(uid)
        except KeyError:
            pass
        else:
            raise ValueError('workload UID is occupied')
        if home.exists() or home.is_symlink():
            raise ValueError('workload home is occupied')
        subprocess.run(['/usr/sbin/useradd', '-m', '-U', '-K', 'UID_MAX=2147483647',
                        '-K', 'GID_MAX=2147483647', '-u', str(uid), '-s', '/bin/bash', name],
                       check=True, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
        account = pwd.getpwnam(name)
    if (account.pw_uid != uid or account.pw_dir != str(home) or home.is_symlink()
            or not home.is_dir() or home.stat().st_uid != uid):
        raise ValueError('workload account mismatch')
    home.chmod(0o700)
    print('account-ready')
    return 0


def payload(request, demoted=False):
    ref = request['ref']
    role = request.get('role')
    if role not in ('user', 'trusted', 'write'):
        raise ValueError('invalid native role')
    user = pwd.getpwnam(request['user']) if role == 'user' else None
    if user is not None and user.pw_uid < 2001:
        raise ValueError('invalid workload account')
    if not demoted:
        prepare_view(ref, role, user)
        # The setpriv loader receives only a trusted environment. Guest loader
        # and interpreter variables are applied by the already-demoted second
        # stage, with private data on stdin rather than argv or environment.
        capabilities = '-all' if user else '-all,+chown,+dac_override,+fowner,+setuid,+setgid'
        argv = ['/usr/bin/setpriv', '--bounding-set=' + capabilities, '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs']
        if user:
            argv += ['--reuid=' + str(user.pw_uid), '--regid=' + str(user.pw_gid), '--clear-groups']
        reader, writer = os.pipe()
        if os.fork() == 0:
            os.close(reader)
            with os.fdopen(writer, 'wb') as stream:
                stream.write(json.dumps(request).encode())
            os._exit(0)
        os.close(writer)
        os.dup2(reader, 0)
        os.close(reader)
        argv += ['/usr/bin/python3', '-I', '/opt/switchboard/native-scope.py', '--payload']
        for fd in os.listdir('/proc/self/fd'):
            if int(fd) > 2:
                try: os.close(int(fd))
                except OSError: pass
        os.execve(argv[0], argv, {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'})
    env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
           'NODE_OPTIONS': '--max-old-space-size=8192', 'NODE_PATH': '/usr/local/lib/node_modules',
           'PLAYWRIGHT_BROWSERS_PATH': '/opt/ms-playwright', 'HOME': user.pw_dir if user else '/root',
           'CI': '1', 'VITEST_MAX_WORKERS': '1', 'VITEST_MAX_THREADS': '1',
           'VITEST_MAX_FORKS': '1', 'VITEST_MIN_THREADS': '1', 'VITEST_MIN_FORKS': '1',
           'UV_THREADPOOL_SIZE': '4'}
    extra = request.get('env', {})
    if not isinstance(extra, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                       or '=' in k or '\x00' in k + v for k, v in extra.items()):
        raise ValueError('invalid payload environment')
    if role != 'user' and any(k.startswith('LD_') or k in ('BASH_ENV', 'ENV', 'GCONV_PATH', 'PYTHONPATH', 'PYTHONHOME') for k in extra):
        raise ValueError('trusted startup input refused')
    env.update(extra)
    argv = []
    if role == 'write':
        content = request.get('content')
        path = request.get('path')
        if not isinstance(content, str) or len(content.encode('utf-16-le')) > 1048576:
            raise ValueError('invalid private write')
        if not isinstance(path, str) or not path.startswith('/workspace/') or '..' in pathlib.Path(path).parts:
            raise ValueError('private write path refused')
        # Walk beneath the workspace with no symlinks. Do not truncate until
        # the opened inode is a sole-link regular file; the thread owns staging.
        directory = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            parts = pathlib.PurePosixPath(path).parts[2:]
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                         0o600, dir_fd=directory)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ValueError('private write target refused')
                os.ftruncate(fd, 0)
                with os.fdopen(fd, 'wb', closefd=False) as stream:
                    stream.write(content.encode())
            finally:
                os.close(fd)
        finally:
            os.close(directory)
        print('{}')
        return 0

    else:
        command = request.get('argv')
        if not isinstance(command, list) or not command or any(not isinstance(x, str) or '\x00' in x for x in command):
            raise ValueError('invalid payload command')
        if request.get('cwd') is not None:
            os.chdir(request['cwd'])
        argv += command
    # No directory, namespace, control or server socket survives into a payload.
    for fd in os.listdir('/proc/self/fd'):
        if int(fd) > 2:
            try:
                os.close(int(fd))
            except OSError:
                pass
    os.execvpe(argv[0], argv, env)


def launch(request):
    ref = reference(request['ref'])
    state, lock, group = paths(ref)
    attempt = identifier(request['attempt'])
    scratch = ROOT / (ref['id'] + '.tmp')
    scratch.mkdir(mode=0o1777, exist_ok=True)
    os.chmod(scratch, 0o1777)
    with locked(lock):
        if original(state, ref)['closed'] or frozen(group):
            raise ValueError('native scope is closed')
        child = group / attempt
        child.mkdir(mode=0o700)
        child.joinpath('cgroup.procs').write_text(str(os.getpid()))
    # A root command receives signal/PID separation. Ordinary user commands
    # retain their supported detached-child lifetime in the enclosing cgroup.
    if request.get('role') == 'provision':
        return provision_account(request['user'])
    if request.get('role') == 'inventory':
        user = request['user']
        if not isinstance(user, str) or not re.fullmatch(r'worker[1-9]\d*', user):
            raise ValueError('invalid inventory account')
        # Fixed observation in the original PID namespace, before payload
        # isolation. No caller command or environment enters this operation.
        return subprocess.run(['/usr/bin/pgrep', '-u', user],
                              env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}).returncode
    if request.get('role') != 'user':
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.unshare(0x20000000 | 0x00020000) != 0:  # CLONE_NEWPID | CLONE_NEWNS
            raise OSError(ctypes.get_errno(), 'private PID view refused')
        pid = os.fork()
        if pid:
            _, status = os.waitpid(pid, 0)
            return os.waitstatus_to_exitcode(status)
        # A fresh proc mount hides outside service and controller processes.
        mount_command('--make-rprivate', '/')
        mount_command('-t', 'proc', '-o', 'ro,nosuid,nodev,noexec', 'proc', '/proc')
    payload(request)


def main():
    if sys.argv[1:] == ['--payload']:
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT: raise ValueError('native input is too large')
        payload(json.loads(raw), demoted=True)
        return 0
    if os.geteuid() != 0:
        raise ValueError('native controller authority required')
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError('native input is too large')
    request = json.loads(raw)
    mode = request.get('mode')
    if mode == 'inspect':
        print(json.dumps({'version': 1, 'boot': BOOT.read_text().strip()}))
        return 0
    ref = reference(request['ref'])
    if mode == 'bootstrap':
        result = bootstrap(ref)
    elif mode == 'close':
        result = close(ref)
    elif mode == 'kill-attempt':
        result = close(ref, request['attempt'])
    elif mode == 'view':
        result = view(ref)
    elif mode == 'launch':
        return launch(request)
    else:
        raise ValueError('unknown native operation')
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    try:
        code = main()
    except Exception as error:
        # Do not echo a request, command, private write or credential.
        print(json.dumps({'nativeScopeRefused': type(error).__name__}), file=sys.stderr)
        code = 125
    raise SystemExit(code)
