const dispatchContext = Symbol("original-organization-dispatch");
export interface OriginalOrganizationDispatch {
  ingressRunId: string;
  organizationSequence: number;
  organizationRepo?: string;
}
export function withOriginalOrganizationDispatch<T extends object>(
  message: T,
  context: OriginalOrganizationDispatch,
): T {
  if (
    typeof context.ingressRunId !== "string" ||
    !context.ingressRunId ||
    context.ingressRunId.length > 2048 ||
    !Number.isSafeInteger(context.organizationSequence) ||
    context.organizationSequence < 1 ||
    (context.organizationRepo !== undefined &&
      (typeof context.organizationRepo !== "string" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.organizationRepo)))
  )
    throw new Error("Invalid original input owner");
  return {
    ...message,
    [dispatchContext]: {
      ingressRunId: context.ingressRunId,
      organizationSequence: context.organizationSequence,
      ...(context.organizationRepo ? { organizationRepo: context.organizationRepo } : {}),
    },
  };
}
export function originalOrganizationDispatchOf(message: object): OriginalOrganizationDispatch | undefined {
  return (message as { [dispatchContext]?: OriginalOrganizationDispatch })[dispatchContext];
}

export function withoutOriginalOrganizationDispatch<T extends object>(message: T): T {
  const copy = { ...message } as T & { [dispatchContext]?: OriginalOrganizationDispatch };
  delete copy[dispatchContext];
  return copy;
}
