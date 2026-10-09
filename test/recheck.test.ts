/** v0.17 #2: the offline evidence re-checker agrees with a consistent bundle and catches tampering. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import canonicalize from "canonicalize";
import { recheck, recheckOnline } from "../scripts/recheck-evidence.mjs";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const A = Keypair.generate().publicKey.toBase58();
const B = Keypair.generate().publicKey.toBase58();
const DEAL = Keypair.generate().publicKey.toBase58();
const SIG = "5".repeat(88);
const SIG2 = "6".repeat(88);
const text = `LATCH PROTECTED PAYMENT AGREEMENT · template goods-sale@2 · format c5\nProgram hash: ${"ab".repeat(32)}\n1. PARTIES. A pays B.\n9. ELECTRONIC SIGNATURE.`;
const bundle = () => ({
  format: "latch-evidence-bundle@1",
  cluster: "devnet",
  program: "BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv",
  programVerifiedBuildHash: "ab".repeat(32),
  deal: { address: DEAL, state: "Active", parties: [A, B], payer: A, payee: B, termsHash: sha(text) },
  agreement: { status: "verified", matchesOnChain: true, format: "c5", template: "goods-sale@2", text, sha256: sha(text), programHashStatedInText: "ab".repeat(32) },
  transactions: [
    { signature: SIG, slot: 1, blockTime: 1, ok: true, err: null, events: [{ name: "DealCreated", data: { deal: DEAL } }] },
    { signature: SIG2, slot: 2, blockTime: 2, ok: true, err: null, events: [] },
  ],
  documents: [{ v: "latch-doc@1", deal: DEAL, stage: 0, name: "Commercial invoice", sha256: sha("inv"), presenter: B, signature: SIG, slot: 1, blockTime: 1 }],
  acknowledgements: [{ v: "latch-doc-ack@1", deal: DEAL, stage: 0, sha256: sha("inv"), by: A, signature: SIG2, slot: 2, blockTime: 2 }],
});

describe("recheck-evidence", () => {
  it("passes a consistent bundle and reports its hash", () => {
    const b = bundle();
    const r = recheck(b);
    expect(r.ok).toBe(true);
    expect(r.bundleHash).toBe(sha(canonicalize(b) as string));
    expect(r.findings.filter((x) => x.level === "fail")).toEqual([]);
    expect(recheck(b, { expectHash: r.bundleHash! }).findings[0].level).toBe("pass");
    expect(recheck(b, { expectHash: "0".repeat(64) }).ok).toBe(false);
  });
  it("catches an edited agreement, a terms hash that doesn't match, a claim for another deal, a stranger's acknowledgement, and an unknown signature", () => {
    const edited = bundle();
    edited.agreement.text += " (edited)";
    expect(recheck(edited).findings.filter((x) => x.level === "fail").map((x) => x.text)).toEqual(expect.arrayContaining([expect.stringMatching(/does NOT equal the captured on-chain terms hash/)]));
    const hash = bundle();
    hash.deal.termsHash = "0".repeat(64);
    expect(recheck(hash).ok).toBe(false);
    const other = bundle();
    other.documents[0].deal = Keypair.generate().publicKey.toBase58();
    expect(recheck(other).findings.some((x) => x.level === "fail" && /document \(invalid\)/.test(x.text))).toBe(true);
    const stranger = bundle();
    stranger.acknowledgements[0].by = Keypair.generate().publicKey.toBase58();
    expect(recheck(stranger).findings.some((x) => x.level === "fail" && /acknowledgement \(invalid\)/.test(x.text))).toBe(true);
    const unknownSig = bundle();
    unknownSig.documents[0].signature = "7".repeat(88);
    expect(recheck(unknownSig).ok).toBe(false);
    expect(recheck({ format: "nope" }).ok).toBe(false);
  });
  it("online: account owner and signature statuses through an injected RPC", async () => {
    const b = bundle();
    const fetchFn = async (_url: string, init: any) => {
      const req = JSON.parse(init.body);
      const result = req.method === "getAccountInfo" ? { value: { owner: b.program } } : { value: [{ slot: 1 }, null] };
      return { json: async () => ({ result }) } as any;
    };
    const f = await recheckOnline(b, "https://rpc.test", fetchFn as any);
    expect(f.map((x) => x.level)).toEqual(["pass", "pass", "note"]);
  });
});
