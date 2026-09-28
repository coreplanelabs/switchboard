/** Validate the root-owned scan before a pool UID can be handed to another run.
 * An older release may have removed a binding without removing its tree. */
export function hasUnexpectedOwnedThreadDir(output: string, root: string, allowed: readonly string[]): boolean {
  const pathOk = (path: string) => {
    if (!path.startsWith(`${root}/`)) return false;
    const name = path.slice(root.length + 1);
    return name.length > 0 && /^[A-Za-z0-9._-]+$/.test(name) && name !== "." && name !== "..";
  };
  if (allowed.some((path) => !pathOk(path))) return true;
  if (output === "") return false;
  if (!output.endsWith("\n")) return true;
  const paths = output.slice(0, -1).split("\n");
  return paths.some((path) => !pathOk(path) || !allowed.includes(path));
}
