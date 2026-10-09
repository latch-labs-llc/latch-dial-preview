export interface Finding {
  level: "pass" | "fail" | "note";
  text: string;
}
export function recheck(bundle: unknown, opts?: { expectHash?: string }): { ok: boolean; findings: Finding[]; bundleHash: string | null };
export function recheckOnline(bundle: any, rpc: string, fetchFn?: typeof fetch): Promise<Finding[]>;
