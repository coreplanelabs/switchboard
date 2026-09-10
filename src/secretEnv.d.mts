import type { Rule } from "eslint";

export declare const MANIFEST_PATH: string;
export declare const CREDENTIAL_FALLBACKS: readonly string[];
export declare const SECRET_NAMES: ReadonlySet<string>;
export declare const PUBLIC_ENV_NAMES: ReadonlySet<string>;
export declare const PUBLIC_ENV_PREFIX: string;
export declare function isSecretName(name: string): boolean;
export declare function isPublicEnvName(name: string): boolean;
export declare const SECRET_ENV_FILES: readonly string[];
export declare const SECRET_ENV_EXEMPT: readonly string[];
export declare const HOST_TOOLING_FILES: readonly string[];
export declare const noRawEnv: Rule.RuleModule;
export declare const secretEnvPlugin: { rules: { "no-raw-env": Rule.RuleModule } };
