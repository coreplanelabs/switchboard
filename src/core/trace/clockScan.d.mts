export declare const ALLOWLIST_PATH: string;
export declare function productionFiles(root: string): string[];
export declare function countClockReads(path: string, text: string): Record<string, number>;
export declare function scan(root: string): Record<string, number>;
export declare const SCANNER_IDS: readonly string[];
export declare const RULE_IDS: readonly string[];
export declare function allowlistProblems(current: Record<string, number>, listed: Record<string, number>): string[];
