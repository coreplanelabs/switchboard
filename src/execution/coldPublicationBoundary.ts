// The SDK's getSandbox uses the supplied name as the Durable Object identity
// (without normalization). Reserve one entire namespace before any model route
// obtains a stub; the controller name is allocated here, never in a request.
const CONTROLLER_PREFIX = "controller-";
const MODEL_ROUTES = new Set(["/exec", "/read", "/write", "/seed", "/publish"]);

export function modelSandboxIdentity(route: string, threadKey: string | null): string | null {
  if (
    !MODEL_ROUTES.has(route) ||
    !threadKey ||
    threadKey.length > 63 ||
    threadKey !== threadKey.trim() ||
    [...threadKey].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    threadKey.toLowerCase().startsWith(CONTROLLER_PREFIX)
  )
    return null;
  return threadKey;
}

export function newControllerIdentity(): string {
  return `${CONTROLLER_PREFIX}${crypto.randomUUID()}`;
}

/** Do not return a success while teardown is still outstanding. Keep the
 * destroy promise alive on the Worker even if its bounded wait runs out. */
export async function disposeColdController(
  destroy: () => Promise<void>,
  keepAlive: (pending: Promise<void>) => void,
  deadlineMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopped = destroy().then(
      () => true,
      () => false,
    );
    keepAlive(stopped.then(() => undefined));
    return await Promise.race([
      stopped,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
