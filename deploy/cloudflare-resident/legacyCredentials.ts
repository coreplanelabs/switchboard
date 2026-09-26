/** Root-side cleanup for credentials left by an earlier resident release.
 * Open every directory component without following symlinks, then unlink
 * only the named file relative to its pinned directory descriptor. A model
 * owns the old tree and stage directory, so a pathname-based root `rm` can
 * otherwise traverse a replacement symlink outside that tree. */
export const LEGACY_CREDENTIAL_SCRUB = `import os, sys

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

def open_dir(path):
    fd = os.open('/', flags)
    try:
        for part in path.strip('/').split('/'):
            if not part:
                continue
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise

def remove(parent, name):
    try:
        fd = open_dir(parent)
    except FileNotFoundError:
        return
    try:
        try:
            os.unlink(name, dir_fd=fd)
        except FileNotFoundError:
            pass
    finally:
        os.close(fd)

remove(sys.argv[1], 'github-credentials')
remove(sys.argv[2], 'cred')
`;

export function legacyCredentialScrubCommand(worktreePath: string, stageDir: string): string[] {
  return ["python3", "-c", LEGACY_CREDENTIAL_SCRUB, `${worktreePath}/.git`, stageDir];
}
