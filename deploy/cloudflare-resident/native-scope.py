#!/usr/bin/python3
"""Trusted entry point. Requests arrive on stdin, never through a guest RPC."""
import ctypes
import base64
import errno
import shutil
import urllib.parse
import fcntl
import hashlib
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
    if not isinstance(value, dict):
        raise ValueError('invalid native reference')
    operator = value.get('kind') == 'operation'
    fields = {'version', 'kind', 'id', 'boot', 'owner'} if operator else {'version', 'id', 'boot', 'threadKey', 'owner'}
    if set(value) != fields:
        raise ValueError('invalid native reference')
    if value['version'] != 1 or value['boot'] != BOOT.read_text().strip():
        raise ValueError('original kernel is unavailable')
    identifier(value['id'])
    owner = value['owner']
    if operator:
        if (not isinstance(owner, dict) or set(owner) != {'opOwner'}
                or not isinstance(owner['opOwner'], str)
                or not re.fullmatch(r'op:[A-Za-z0-9_.:-]{1,124}', owner['opOwner'])):
            raise ValueError('invalid native operator')
    else:
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


def prepare_view(ref, role, user, archive=None):
    # No payload keeps a path or descriptor to the controller's writable
    # roots. The selected workspace remains the existing shared disk.
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.unshare(0x00020000) != 0:  # CLONE_NEWNS
        raise OSError(ctypes.get_errno(), 'private mount view refused')
    # Harness control files outlive individual exec views and generations.
    # A run gets its own sticky /var/tmp, never the host's shared directory.
    identity = ['operator', ref['owner']['opOwner']] if ref.get('kind') == 'operation' else [ref['threadKey'], ref['owner']['runId']]
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    harness = ROOT / ('harness-' + key)
    harness.mkdir(mode=0o1777, exist_ok=True)
    os.chmod(harness, 0o1777)
    mount_command('--make-rprivate', '/')
    mount_command('--rbind', '/', '/')
    mount_command('-o', 'remount,bind,ro', '/')
    if archive is not None:
        # Bind each existing workspace mount read-only in this private view.
        # Workloads have no mount capability. This uses the image's supported
        # mount API instead of requiring the newer mount_setattr syscall.
        mounts = {'/workspace'}
        for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
            path = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4])
            if path.startswith('/workspace/'): mounts.add(path)
        for path in sorted(mounts, key=len, reverse=True):
            mount_command('--bind', path, path)
            mount_command('-o', 'remount,bind,ro', path)
    allowed = [str(archive)] if archive is not None else ['/workspace']
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
    mount_command('--bind', str(harness), '/var/tmp')
    mount_command('-o', 'remount,bind,rw', '/var/tmp')
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


def archive_identity(request):
    ref = reference(request['ref'])
    attempt = identifier(request['attempt'])
    identity = request['identity']
    fields = {'version', 'ref', 'attempt', 'backupId', 'target', 'sizeBytes', 'etag'}
    if (ref.get('kind') != 'operation' or not isinstance(identity, dict) or set(identity) != fields
            or type(identity['version']) is not int or identity['version'] != 1
            or identity['ref'] != ref or identity['attempt'] != attempt):
        raise ValueError('invalid archive identity')
    identifier(identity['backupId'])
    target = identity['target']
    if target not in ('/workspace/mirror', '/workspace/checkout'):
        prefix = '/workspace/deps/.scratch-'
        if not isinstance(target, str) or not target.startswith(prefix):
            raise ValueError('invalid archive target')
        identifier(target[len(prefix):])
    if (type(identity['sizeBytes']) is not int or not 0 < identity['sizeBytes'] <= 9007199254740991
            or not isinstance(identity['etag'], str)
            or not re.fullmatch(r'[a-fA-F0-9]{32}(?:-[1-9][0-9]*)?', identity['etag'])):
        raise ValueError('invalid archive descriptor')
    return identity


def archive_directory(identity):
    return pathlib.Path('/workspace/.native-restore-' + identity['ref']['id'] + '-' + identity['attempt'])


def archive_paths(identity):
    ref = identity['ref']
    return (ROOT / (ref['id'] + '.json'), ROOT / (ref['id'] + '.lock'),
            CGROUP / ref['id'] / identity['attempt'],
            ROOT / (ref['id'] + '.' + identity['attempt'] + '.archive.json'))


def archive_parent(identity):
    workspace = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    selected = workspace
    try:
        for fd in [workspace]:
            info = os.fstat(fd)
            if info.st_uid != 0 or info.st_mode & 0o022 or 'system.posix_acl_access' in os.listxattr(fd):
                raise ValueError('archive parent ownership is unverified')
        if identity['target'].startswith('/workspace/deps/'):
            selected = os.open('deps', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=workspace)
            info = os.fstat(selected)
            if info.st_uid != 0 or info.st_mode & 0o022 or 'system.posix_acl_access' in os.listxattr(selected):
                raise ValueError('archive parent ownership is unverified')
        return selected, pathlib.PurePosixPath(identity['target']).name
    except Exception:
        if selected != workspace: os.close(selected)
        else: os.close(workspace)
        raise
    finally:
        if selected != workspace: os.close(workspace)


def archive_load(path, identity):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size > 8192:
            raise ValueError('archive record ownership changed')
        saved = json.load(stream)
    if saved.get('identity') != identity:
        raise ValueError('archive record identity changed')
    return saved


def archive_owned_directory(saved):
    path = archive_directory(saved['identity'])
    info = path.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077
            or saved.get('directory') != {'dev': info.st_dev, 'ino': info.st_ino}):
        raise ValueError('archive directory ownership changed')
    return path


def archive_snapshot(saved):
    return {'identity': saved['identity'], 'phase': saved['phase'],
            'receivedBytes': saved.get('offset', 0),
            **({'append': saved['append']} if saved.get('append') else {}),
            **({'receipt': saved['receipt']} if saved.get('receipt') else {})}


def archive_prepare(request):
    identity = archive_identity(request)
    state, lock, child, record = archive_paths(identity)
    with locked(lock):
        scope = original(state, identity['ref'])
        if record.exists(): return archive_snapshot(archive_load(record, identity))
        if scope['closed'] or frozen(child.parent): raise ValueError('native scope is closed')
        parent, _ = archive_parent(identity)
        os.close(parent)
        child.mkdir(mode=0o700)
        child.joinpath('cgroup.procs').write_text(str(os.getpid()))
        saved = {'identity': identity, 'phase': 'reserving', 'offset': 0}
        write_state(record, saved)
        disk = os.statvfs('/workspace')
        if disk.f_bavail * disk.f_frsize < identity['sizeBytes'] + 128 * 1024 * 1024:
            return archive_finish(record, saved, 'aborted', 'disk-full')
    directory = archive_directory(identity)
    directory.mkdir(mode=0o700)
    info = directory.lstat()
    saved['directory'] = {'dev': info.st_dev, 'ino': info.st_ino}
    fd = os.open(directory / 'archive.sqsh', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try: os.fsync(fd)
    finally: os.close(fd)
    with locked(lock):
        if original(state, identity['ref'])['closed'] or frozen(child):
            raise ValueError('archive attempt is closed')
        saved['phase'] = 'receiving'
        write_state(record, saved)
    return archive_snapshot(saved)


def archive_append(request):
    identity = archive_identity(request)
    state, lock, child, record = archive_paths(identity)
    data = base64.b64decode(request['data'], validate=True)
    offset = request['offset']
    digest = request['hash']
    append = identifier(request['appendId'])
    if (not 0 < len(data) <= 65536 or type(offset) is not int or offset < 0
            or offset + len(data) > identity['sizeBytes'] or hashlib.sha256(data).hexdigest() != digest):
        raise ValueError('invalid archive chunk')
    with locked(lock):
        saved = archive_load(record, identity)
        if original(state, identity['ref'])['closed'] or frozen(child): raise ValueError('archive attempt is closed')
        if saved['phase'] != 'receiving' or saved['offset'] != offset:
            raise ValueError('archive chunk admission changed')
        child.joinpath('cgroup.procs').write_text(str(os.getpid()))
        directory = archive_owned_directory(saved)
        saved['phase'] = 'appending'
        write_state(record, saved)
    fd = os.open(directory / 'archive.sqsh', os.O_WRONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1 or info.st_size != offset:
            raise ValueError('archive chunk target changed')
        os.lseek(fd, offset, os.SEEK_SET)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0: raise ValueError('archive write incomplete')
            view = view[written:]
        os.fsync(fd)
    finally: os.close(fd)
    with locked(lock):
        if original(state, identity['ref'])['closed'] or frozen(child): raise ValueError('archive attempt is closed')
        saved['offset'] = offset + len(data)
        saved['append'] = {'id': append, 'offset': offset, 'size': len(data), 'hash': digest}
        saved['phase'] = 'receiving'
        write_state(record, saved)
    return archive_snapshot(saved)


def archive_remove(saved):
    directory = archive_owned_directory(saved)
    if not shutil.rmtree.avoids_symlink_attacks: raise ValueError('safe archive cleanup is unavailable')
    shutil.rmtree(directory)
    if directory.exists() or directory.is_symlink(): raise ValueError('archive cleanup is incomplete')


def archive_finish(record, saved, outcome, reason=None):
    receipt = {'identity': saved['identity'], 'outcome': outcome, 'cleanup': 'complete'}
    if reason: receipt['reason'] = reason
    if len(json.dumps(receipt, separators=(',', ':')).encode()) > 1024:
        raise ValueError('archive receipt is too large')
    saved['receipt'] = receipt
    saved['phase'] = 'done'
    write_state(record, saved)
    return archive_snapshot(saved)


def archive_read(request):
    identity = archive_identity(request)
    state, lock, child, record = archive_paths(identity)
    with locked(lock):
        original(state, identity['ref'])
        saved = archive_load(record, identity)
        result = archive_snapshot(saved)
        if saved['phase'] == 'running':
            directory = archive_owned_directory(saved)
            try: result['receivedBytes'] = (directory / 'archive.sqsh').stat().st_size
            except FileNotFoundError: pass
        return result


def archive_clean(request):
    identity = archive_identity(request)
    state, lock, child, record = archive_paths(identity)
    with locked(lock):
        original(state, identity['ref'])
        if not child.is_dir() or not (frozen(child) or original(state, identity['ref'])['closed']) or populated(child):
            raise ValueError('original archive attempt has not ended')
        if not record.exists():
            # Preparation records intent before it can create any workspace
            # resource. A closed original attempt cannot later cross that point.
            return archive_finish(record, {'identity': identity, 'offset': 0}, 'aborted', 'cancelled')
        saved = archive_load(record, identity)
        if saved['phase'] == 'done': return archive_snapshot(saved)
        if saved['phase'] in ('reserving', 'installing', 'cleaning'):
            raise ValueError('original archive effect is unverified')
        saved['phase'] = 'cleaning'
        write_state(record, saved)
    archive_remove(saved)
    with locked(lock):
        return archive_finish(record, saved, 'aborted', 'cancelled')


def archive_payload(request):
    identity = archive_identity(request)
    directory = archive_directory(identity)
    archive = directory / 'archive.sqsh'
    url = request.get('url')
    if url is not None:
        parsed = urllib.parse.urlsplit(url)
        if (not isinstance(url, str) or len(url) > 8192 or parsed.scheme != 'https'
                or not parsed.hostname or parsed.username or parsed.password or parsed.fragment):
            raise ValueError('archive URL refused')
        config = 'url = ' + json.dumps(url) + '\noutput = ' + json.dumps(str(archive)) + '\nheader = ' + json.dumps('If-Match: "' + identity['etag'] + '"') + '\n'
        result = subprocess.run(['/usr/bin/curl', '-q', '--proto', '=https', '--fail', '--silent', '--max-filesize', str(identity['sizeBytes']), '--write-out', '%{http_code}', '--config', '-'],
                                input=config, text=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        if result.stdout == '412': return 3
        if result.returncode != 0: return 1
    if archive.stat().st_size != identity['sizeBytes']: return 2
    result = subprocess.run(['/usr/bin/unsquashfs', '-n', '-no-xattrs', '-no-progress', '-processors', '1', '-d', str(directory / 'tree'), str(archive)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode != 0: return 2
    archive.unlink()
    fd = os.open(directory / 'extracted.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        json.dump({'identity': identity, 'extracted': True}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    return 0


def archive_run(request):
    identity = archive_identity(request)
    state, lock, child, record = archive_paths(identity)
    with locked(lock):
        saved = archive_load(record, identity)
        if saved['phase'] == 'done': return archive_snapshot(saved)
        if original(state, identity['ref'])['closed'] or frozen(child): raise ValueError('archive attempt is closed')
        if saved['phase'] != 'receiving' or (request.get('url') is None and saved['offset'] != identity['sizeBytes']):
            raise ValueError('archive transfer is incomplete')
        archive_owned_directory(saved)
        child.joinpath('cgroup.procs').write_text(str(os.getpid()))
        saved['phase'] = 'running'
        write_state(record, saved)
    parent, name = archive_parent(identity)
    work = os.open(archive_owned_directory(saved), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        code = launch({**request, 'role': 'archive'})
        directory = archive_owned_directory(saved)
        if code != 0:
            reason = 'source-changed' if code == 3 else 'download-failed' if code == 1 else 'archive-invalid'
            if os.statvfs(directory).f_bavail * os.statvfs(directory).f_frsize < 128 * 1024 * 1024:
                reason = 'disk-full'
            archive_remove(saved)
            with locked(lock): return archive_finish(record, saved, 'aborted', reason)
        proof = json.loads((directory / 'extracted.json').read_text())
        if proof != {'identity': identity, 'extracted': True} or (directory / 'archive.sqsh').exists():
            raise ValueError('archive extraction receipt changed')
        tree = os.open('tree', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=work)
        os.close(tree)
        with locked(lock):
            if original(state, identity['ref'])['closed'] or frozen(child): raise ValueError('archive attempt is closed')
            saved['phase'] = 'installing'
            write_state(record, saved)
        try: os.rmdir(name, dir_fd=parent)
        except FileNotFoundError: pass
        except OSError as error:
            if error.errno not in (errno.ENOTEMPTY, errno.EEXIST): raise
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.renameat2(work, b'tree', parent, os.fsencode(name), 1) != 0:
            failure = ctypes.get_errno()
            if failure != errno.EEXIST: raise OSError(failure, 'archive installation is unverified')
            archive_remove(saved)
            with locked(lock): return archive_finish(record, saved, 'aborted', 'target-occupied')
        os.fsync(parent)
        (directory / 'extracted.json').unlink()
        directory.rmdir()
        with locked(lock): return archive_finish(record, saved, 'committed')
    finally:
        os.close(work)
        os.close(parent)


def archive_dispatch(request):
    return {'archive-prepare': archive_prepare, 'archive-append': archive_append,
            'archive-run': archive_run, 'archive-read': archive_read, 'archive-clean': archive_clean}[request['mode']](request)


def payload(request, demoted=False):
    ref = request['ref']
    role = request.get('role')
    if role not in ('user', 'trusted', 'write', 'archive'):

        raise ValueError('invalid native role')
    user = pwd.getpwnam(request['user']) if role == 'user' else None
    if user is not None and user.pw_uid < 2001:
        raise ValueError('invalid workload account')
    if not demoted:
        prepare_view(ref, role, user, archive_directory(archive_identity(request)) if role == 'archive' else None)
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
    if role == 'archive':
        return archive_payload(request)
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


def refuse_mounted_mutation(paths):
    if (not isinstance(paths, list) or not 0 < len(paths) <= 16 or any(
            not isinstance(path, str) or len(path) > 512 or not path.startswith('/workspace/')
            or any(part in ('', '.', '..') for part in path.split('/')[1:])
            or re.search(r'[\x00-\x1f\x7f]', path) for path in paths)):
        raise ValueError('invalid workspace mutation')
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        mounted = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), line.split()[4])
        if any(mounted == path or mounted.startswith(path + '/') for path in paths):
            raise ValueError('selected workspace mutation contains an inherited mount')


def launch(request):
    ref = reference(request['ref'])
    state, lock, group = paths(ref)
    attempt = identifier(request['attempt'])
    if request.get('workspacePaths') is not None:
        refuse_mounted_mutation(request['workspacePaths'])
    scratch = ROOT / (ref['id'] + '.tmp')
    scratch.mkdir(mode=0o1777, exist_ok=True)
    os.chmod(scratch, 0o1777)
    with locked(lock):
        if original(state, ref)['closed'] or frozen(group):
            raise ValueError('native scope is closed')
        child = group / attempt
        if request.get('role') != 'archive':
            child.mkdir(mode=0o700)
            child.joinpath('cgroup.procs').write_text(str(os.getpid()))
        elif not child.is_dir() or frozen(child):
            raise ValueError('archive attempt is closed')
    # A root command receives signal/PID separation. Ordinary user commands
    # retain their supported detached-child lifetime in the enclosing cgroup.
    if request.get('role') == 'provision':
        return provision_account(request['user'])
    if request.get('role') == 'inventory':
        # Fixed observations in the original PID namespace. Caller argv and
        # environment cannot turn an inventory request into a host command.
        inventory = request.get('inventory')
        if inventory in ('users', 'pid-users'):
            argv = ['/usr/bin/ps', '-eo', 'user=' if inventory == 'users' else 'pid=,user=']
        else:
            user = request.get('user')
            if inventory is not None or not isinstance(user, str) or not re.fullmatch(r'worker[1-9]\d*', user):
                raise ValueError('invalid inventory account')
            argv = ['/usr/bin/pgrep', '-u', user]
        return subprocess.run(argv, env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin'}).returncode
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
        return payload(json.loads(raw), demoted=True)
    if os.geteuid() != 0:
        raise ValueError('native controller authority required')
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise ValueError('native input is too large')
    request = json.loads(raw)
    mode = request.get('mode')
    if mode == 'inspect':
        result = {'version': 1, 'boot': BOOT.read_text().strip()}
        if request.get('operator') is True: result['operatorScopes'] = 1
        if request.get('archive') is True: result['archiveRestores'] = 1
        print(json.dumps(result))
        return 0
    ref = reference(request['ref'])
    if mode in ('archive-prepare', 'archive-append', 'archive-run', 'archive-read', 'archive-clean'):
        print(json.dumps(archive_dispatch(request)))
        return 0
    if mode == 'bootstrap':
        result = bootstrap(ref)
    elif mode == 'close':
        result = close(ref)
    elif mode == 'kill-attempt':
        result = close(ref, request['attempt'])
    elif mode == 'view':
        result = view(ref)
    elif mode == 'launch':
        if request.get('role') == 'archive': raise ValueError('archive requires its original handle')
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
