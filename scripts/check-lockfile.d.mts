export const REQUIRED_VARIANTS: Record<string, string[]>;
export function missingVariants(
  packagePaths: string[],
  required?: Record<string, string[]>,
): { family: string; variant: string }[];
