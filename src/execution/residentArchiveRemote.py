"""Fixed, read-only thread-tree probe sent through the old resident /exec route.

Only its manifest scratch file under /tmp is written. No source-tree path is
written, followed through a symlink, or printed in an error response.
"""

import base64
import hashlib
import json
import os
import re
import stat
import sys
import tempfile

MAX_ENTRIES = 200_000
MAX_MANIFEST_BYTES = 32 * 1024 * 1024
MAX_CHUNK_BYTES = 60 * 1024
MAX_BATCH_BYTES = 32 * 1024
MAX_BATCH_FILES = 128
MAX_BATCH_PATH_CHARS = 12 * 1024
MAX_PAGE_CHARS = 88_000
SCRATCH = re.compile(r"^/tmp/resident-archive-[a-zA-Z0-9_-]+\.jsonl$")


def b64(value):
    return base64.b64encode(value).decode("ascii")


def unb64(value):
    if not isinstance(value, str):
        raise ValueError("invalid encoded path")
    data = base64.b64decode(value, validate=True)
    if b64(data) != value:
        raise ValueError("noncanonical encoded path")
    return data


def parts(value):
    if not value or value.startswith(b"/") or b"\x00" in value:
        raise ValueError("unsafe path")
    result = value.split(b"/")
    if any(part in (b"", b".", b"..") for part in result):
        raise ValueError("unsafe path")
    return result


def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id", "r", encoding="ascii") as source:
            return source.read().strip()
    except FileNotFoundError:
        # The local, non-Cloudflare test runner has no Linux /proc.
        if sys.platform != "linux" and os.environ.get("RESIDENT_ARCHIVE_TEST_BOOT_ID"):
            return os.environ["RESIDENT_ARCHIVE_TEST_BOOT_ID"]
        raise


def identity():
    return {"bootId": boot_id(), "root": os.getcwd()}


def canonical(entry):
    return json.dumps(entry, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii") + b"\n"


def safe_open(root_fd, relative):
    names = parts(relative)
    directory = os.dup(root_fd)
    try:
        for name in names[:-1]:
            next_fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = next_fd
        return os.open(names[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory)
    finally:
        os.close(directory)


def hash_regular(root_fd, relative):
    fd = safe_open(root_fd, relative)
    digest = hashlib.sha256()
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError("source file type changed")
        with os.fdopen(fd, "rb", closefd=False) as source:
            while True:
                block = source.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
    finally:
        os.close(fd)
    return digest.hexdigest()


def scan(root_fd):
    entries = []

    def visit(directory, prefix):
        with os.scandir(directory) as iterator:
            names = sorted((os.fsencode(item.name) for item in iterator))
        for name in names:
            if b"/" in name or b"\x00" in name:
                raise ValueError("unsafe directory entry")
            relative = prefix + name
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            entry = {"pathB64": b64(relative), "mode": stat.S_IMODE(info.st_mode)}
            if stat.S_ISDIR(info.st_mode):
                entry["type"] = "dir"
                entries.append((relative, entry))
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                try:
                    visit(child, relative + b"/")
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                entry.update(type="file", size=info.st_size, sha256=hash_regular(root_fd, relative))
                entries.append((relative, entry))
            elif stat.S_ISLNK(info.st_mode):
                entry.update(type="symlink", targetB64=b64(os.fsencode(os.readlink(name, dir_fd=directory))))
                entries.append((relative, entry))
            else:
                raise ValueError("unsupported source entry type")
            if len(entries) > MAX_ENTRIES:
                raise ValueError("manifest entry limit")

    visit(root_fd, b"")
    entries.sort(key=lambda pair: pair[0])
    digest = hashlib.sha256()
    length = 0
    byte_count = 0
    for _, entry in entries:
        line = canonical(entry)
        length += len(line)
        if length > MAX_MANIFEST_BYTES:
            raise ValueError("manifest byte limit")
        digest.update(line)
        if entry["type"] == "file":
            byte_count += entry["size"]
    return entries, digest.hexdigest(), byte_count


def scratch_file(path):
    if not isinstance(path, str) or not SCRATCH.fullmatch(path):
        raise ValueError("invalid scratch path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > MAX_MANIFEST_BYTES:
        os.close(fd)
        raise ValueError("invalid scratch file")
    return fd


def answer(document):
    output = json.dumps(document, separators=(",", ":"), ensure_ascii=True)
    if len(output) > MAX_PAGE_CHARS:
        raise ValueError("response cap")
    print(output)


def main(request):
    operation = request.get("op")
    root_fd = os.open(b".", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        common = identity()
        if operation in ("begin", "verify"):
            entries, digest, byte_count = scan(root_fd)
            result = {**common, "op": operation, "count": len(entries), "byteCount": byte_count, "manifestSha256": digest}
            if operation == "begin":
                fd, path = tempfile.mkstemp(prefix="resident-archive-", suffix=".jsonl", dir="/tmp")
                try:
                    os.fchmod(fd, 0o600)
                    with os.fdopen(fd, "wb") as target:
                        for _, entry in entries:
                            target.write(canonical(entry))
                    result["scratch"] = path
                except BaseException:
                    os.unlink(path)
                    raise
            try:
                answer(result)
            except BaseException:
                if operation == "begin":
                    os.unlink(result["scratch"])
                raise
        elif operation == "page":
            start = request.get("start")
            limit = request.get("limit")
            if not isinstance(start, int) or start < 0 or not isinstance(limit, int) or not 1 <= limit <= 100:
                raise ValueError("invalid page bounds")
            fd = scratch_file(request.get("scratch"))
            with os.fdopen(fd, "rb") as source:
                entries = [json.loads(line) for index, line in enumerate(source) if start <= index < start + limit]
            answer({**common, "op": "page", "start": start, "entries": entries})
        elif operation == "chunk":
            relative = unb64(request.get("pathB64"))
            offset = request.get("offset")
            length = request.get("length")
            size = request.get("size")
            if not all(isinstance(value, int) for value in (offset, length, size)) or offset < 0 or size < 0 or not 1 <= length <= MAX_CHUNK_BYTES or offset + length > size:
                raise ValueError("invalid chunk bounds")
            fd = safe_open(root_fd, relative)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                    raise ValueError("file changed during capture")
                os.lseek(fd, offset, os.SEEK_SET)
                data = os.read(fd, length)
                if len(data) != length:
                    raise ValueError("short source chunk")
            finally:
                os.close(fd)
            answer({**common, "op": "chunk", "pathB64": request["pathB64"], "offset": offset, "length": length, "size": size, "sha256": hashlib.sha256(data).hexdigest(), "data": b64(data)})
        elif operation == "batch":
            files = request.get("files")
            if not isinstance(files, list) or not 1 <= len(files) <= MAX_BATCH_FILES:
                raise ValueError("invalid batch count")
            if sum(len(item.get("pathB64", "")) for item in files if isinstance(item, dict)) > MAX_BATCH_PATH_CHARS:
                raise ValueError("batch path limit")
            total = 0
            answers = []
            for item in files:
                if not isinstance(item, dict) or not isinstance(item.get("pathB64"), str) or type(item.get("size")) is not int:
                    raise ValueError("invalid batch entry")
                size = item["size"]
                if size < 0 or total + size > MAX_BATCH_BYTES:
                    raise ValueError("batch byte limit")
                relative = unb64(item["pathB64"])
                fd = safe_open(root_fd, relative)
                try:
                    info = os.fstat(fd)
                    if not stat.S_ISREG(info.st_mode) or info.st_size != size:
                        raise ValueError("file changed during capture")
                    blocks = []
                    remaining = size
                    while remaining:
                        block = os.read(fd, remaining)
                        if not block:
                            raise ValueError("short source file")
                        blocks.append(block)
                        remaining -= len(block)
                    data = b"".join(blocks)
                    if os.fstat(fd).st_size != size:
                        raise ValueError("file changed during capture")
                finally:
                    os.close(fd)
                answers.append({"pathB64": item["pathB64"], "size": size, "sha256": hashlib.sha256(data).hexdigest(), "data": b64(data)})
                total += size
            answer({**common, "op": "batch", "files": answers})
        elif operation == "cleanup":
            if request.get("bootId") != common["bootId"] or request.get("root") != common["root"]:
                raise ValueError("resident identity changed before cleanup")
            fd = scratch_file(request.get("scratch"))
            info = os.fstat(fd)
            os.close(fd)
            named = os.stat(request["scratch"], follow_symlinks=False)
            if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
                raise ValueError("scratch file changed before cleanup")
            os.unlink(request["scratch"])
            answer({**common, "op": "cleanup"})
        else:
            raise ValueError("unknown operation")
    finally:
        os.close(root_fd)


if __name__ == "__main__":
    try:
        main(json.loads(sys.argv[1]))
    except Exception:
        # The operator sees only the named failure; the route and logs never
        # receive a source filename, its bytes, or a credential in traceback.
        print("resident archive probe refused", file=sys.stderr)
        sys.exit(1)
