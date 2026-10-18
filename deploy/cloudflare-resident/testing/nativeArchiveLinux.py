"""Exercise the installed archive controller in the disposable image only."""
import base64, hashlib, http.server, json, os, pathlib, shutil, ssl, subprocess, threading, time, uuid

HELPER = '/opt/switchboard/native-scope.py'
ROOT = pathlib.Path('/run/switchboard-native-v1')
boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
work = pathlib.Path('/workspace/archive-proof')
work.mkdir()
payload = work / 'source'
payload.mkdir()
(payload / 'expected.txt').write_text('original archive content')
(payload / 'outside').symlink_to('/workspace/archive-neighbor')
neighbor = pathlib.Path('/workspace/archive-neighbor')
neighbor.mkdir()
(neighbor / 'keep.txt').write_text('neighbor preserved')
archive = work / 'data.sqsh'
subprocess.run(['mksquashfs', str(payload), str(archive), '-noappend', '-processors', '1'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
data = archive.read_bytes()


def invoke(mode, ref, timeout=10, **values):
    return subprocess.run(['/usr/bin/python3', '-I', HELPER], input=json.dumps({'mode': mode, 'ref': ref, **values}), text=True, capture_output=True, timeout=timeout)


def ctl(mode, ref, **values):
    result = invoke(mode, ref, **values)
    assert result.returncode == 0, (mode, result.stdout, result.stderr)
    return json.loads(result.stdout)


def scope():
    ref = {'version': 1, 'kind': 'operation', 'id': str(uuid.uuid4()), 'boot': boot, 'owner': {'opOwner': 'op:' + str(uuid.uuid4())}}
    ctl('bootstrap', ref)
    return ref


def identity(ref, target=None):
    return {'version': 1, 'ref': ref, 'attempt': str(uuid.uuid4()), 'backupId': str(uuid.uuid4()),
            'target': target or '/workspace/deps/.scratch-' + str(uuid.uuid4()), 'sizeBytes': len(data), 'etag': hashlib.md5(data).hexdigest()}


def extra(item):
    return {'attempt': item['attempt'], 'identity': item}


def append(item):
    offset = 0
    for start in range(0, len(data), 65536):
        part = data[start:start + 65536]
        result = ctl('archive-append', item['ref'], **extra(item), data=base64.b64encode(part).decode(), offset=offset,
                     hash=hashlib.sha256(part).hexdigest(), appendId=str(uuid.uuid4()))
        offset += len(part)
        assert result['receivedBytes'] == offset


pathlib.Path('/workspace/deps').mkdir(mode=0o755, exist_ok=True)
assert pathlib.Path('/workspace').stat().st_uid == 0 and pathlib.Path('/workspace').stat().st_mode & 0o022 == 0
a = scope()
item = identity(a, "/workspace/mirror")
assert ctl('archive-prepare', a, **extra(item))['phase'] == 'receiving'
append(item)
result = ctl('archive-run', a, **extra(item))
assert result['receipt'] == {'identity': item, 'outcome': 'committed', 'cleanup': 'complete'}, result
assert pathlib.Path(item['target'], 'expected.txt').read_text() == 'original archive content'
assert not pathlib.Path('/workspace/.native-restore-' + a['id'] + '-' + item['attempt']).exists()
assert ctl('archive-read', a, **extra(item)) == result  # Lost reply reads the original, with no extraction.
assert (neighbor / 'keep.txt').read_text() == 'neighbor preserved'
changed = {**item, 'etag': 'f' * 32}
assert invoke('archive-read', a, **extra(changed)).returncode == 125
foreign = scope()
assert invoke('archive-read', foreign, **extra({**item, 'ref': foreign})).returncode == 125
assert invoke('archive-read', {**a, 'boot': str(uuid.uuid4())}, **extra(item)).returncode == 125

# An unexpected occupied target wins. None of its content is adopted or removed.
occupied = identity(a)
target = pathlib.Path(occupied['target'])
target.mkdir()
(target / 'keep.txt').write_text('target preserved')
ctl('archive-prepare', a, **extra(occupied)); append(occupied)
refusal = ctl('archive-run', a, **extra(occupied))
assert refusal['receipt']['reason'] == 'target-occupied', refusal
assert (target / 'keep.txt').read_text() == 'target preserved'

# Stop one UUID while its neighbor remains usable. Only its owned data is cleaned.
stopped = identity(a)
ctl('archive-prepare', a, **extra(stopped)); append(stopped)
ctl('kill-attempt', a, attempt=stopped['attempt'])
assert invoke('archive-run', a, **extra(stopped)).returncode == 125
assert invoke('archive-append', a, **extra(stopped), data=base64.b64encode(data[:1]).decode(), offset=0, hash=hashlib.sha256(data[:1]).hexdigest(), appendId=str(uuid.uuid4())).returncode == 125
cleaned = ctl('archive-clean', a, **extra(stopped))
assert cleaned['receipt']['outcome'] == 'aborted'
assert not pathlib.Path(stopped['target']).exists()
assert ctl('view', foreign)['closed'] is False

# Archive payloads cannot write a sibling even if an archive names a symlink.
# The explicit extraction mount is writable; all existing workspace submounts are read-only.
mount_target = neighbor / 'mounted'
mount_target.mkdir()
subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'none', str(mount_target)], check=True)
(mount_target / 'keep.txt').write_text('mounted neighbor preserved')
confined = identity(a)
ctl('archive-prepare', a, **extra(confined)); append(confined)
assert ctl('archive-run', a, **extra(confined))['receipt']['outcome'] == 'committed'
assert (mount_target / 'keep.txt').read_text() == 'mounted neighbor preserved'
# Service cleanup refuses an inherited mount before starting its payload.
refused = invoke('launch', a, attempt=str(uuid.uuid4()), role='trusted', workspacePaths=[str(neighbor)], argv=['rm', '-rf', str(neighbor)])
assert refused.returncode == 125 and (mount_target / 'keep.txt').exists()
subprocess.run(['umount', str(mount_target)], check=True)

# A local HTTPS fixture exercises the same fixed curl path as a presigned GET.
cert = work / 'fixture.crt'; key = work / 'fixture.key'
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
shutil.copyfile(cert, '/usr/local/share/ca-certificates/native-archive-fixture.crt')
subprocess.run(['update-ca-certificates'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
requests = []
started = threading.Event(); release = threading.Event()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.headers.get('If-Match'))
        if self.headers.get('If-Match') != '"' + hashlib.md5(data).hexdigest() + '"':
            self.send_response(412); self.end_headers(); return
        self.send_response(200); self.send_header('Content-Length', str(len(data))); self.end_headers()
        if self.path == '/stall':
            self.wfile.write(data[:1]); self.wfile.flush(); started.set(); release.wait(10)
            try: self.wfile.write(data[1:])
            except (BrokenPipeError, ConnectionResetError, ssl.SSLError): pass
        else: self.wfile.write(data)
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(cert, key)
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
signed = identity(foreign, "/workspace/checkout")
ctl('archive-prepare', foreign, **extra(signed))
assert ctl('archive-run', foreign, **extra(signed), url='https://localhost:' + str(server.server_port) + '/data.sqsh?signature=fixture')['receipt']['outcome'] == 'committed'
assert requests == ['"' + signed['etag'] + '"']
changed_source = {**identity(foreign), 'etag': 'b' * 32}
ctl('archive-prepare', foreign, **extra(changed_source))
assert ctl('archive-run', foreign, **extra(changed_source), url='https://localhost:' + str(server.server_port) + '/data.sqsh')['receipt']['reason'] == 'source-changed'
assert not pathlib.Path(changed_source['target']).exists()
downloading = identity(a)
ctl('archive-prepare', a, **extra(downloading))
process = subprocess.Popen(['/usr/bin/python3', '-I', HELPER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
process.stdin.write(json.dumps({'mode': 'archive-run', 'ref': a, **extra(downloading), 'url': 'https://localhost:' + str(server.server_port) + '/stall'})); process.stdin.close()
assert started.wait(5), 'fixed curl did not reach fixture'
ended = ctl('kill-attempt', a, attempt=downloading['attempt'])
assert ended['populated'] is False
process.wait(timeout=5)
release.set()
assert ctl('archive-clean', a, **extra(downloading))['receipt']['outcome'] == 'aborted'
assert not pathlib.Path(downloading['target']).exists()
assert (neighbor / 'keep.txt').read_text() == 'neighbor preserved'
server.shutdown(); server.server_close()

# Cleanup failure and the install-before-receipt crash window produce no receipt.
uncertain = identity(a)
ctl('archive-prepare', a, **extra(uncertain))
record = ROOT / (a['id'] + '.' + uncertain['attempt'] + '.archive.json')
saved = json.loads(record.read_text()); saved['phase'] = 'installing'; record.write_text(json.dumps(saved))
ctl('kill-attempt', a, attempt=uncertain['attempt'])
assert invoke('archive-clean', a, **extra(uncertain)).returncode == 125
assert 'receipt' not in ctl('archive-read', a, **extra(uncertain))
failed_cleanup = identity(a)
ctl('archive-prepare', a, **extra(failed_cleanup))
private = pathlib.Path('/workspace/.native-restore-' + a['id'] + '-' + failed_cleanup['attempt'])
blocked = private / 'blocked'; blocked.mkdir()
subprocess.run(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'none', str(blocked)], check=True)
ctl('kill-attempt', a, attempt=failed_cleanup['attempt'])
assert invoke('archive-clean', a, **extra(failed_cleanup)).returncode == 125
assert 'receipt' not in ctl('archive-read', a, **extra(failed_cleanup))
assert not pathlib.Path(failed_cleanup['target']).exists()
subprocess.run(['umount', str(blocked)], check=True)
ctl('close', a); ctl('close', foreign)
print(json.dumps({'productionArchive': 'passed', 'binding': True, 'presignedHttps': True, 'lostReplyReadback': True,
                  'foreignTargetPreserved': True, 'changedIdentityRefused': True, 'neighborPreserved': True,
                  'lateSubmissionRefused': True, 'unknownInstallHeld': True, 'legacyMountCleanupRefused': True, 'runningDownloadKilled': True, 'cleanupFailureHeld': True}))
