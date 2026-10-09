// Offline re-check of an evidence bundle the app exported (Evidence → "Download
// the bundle"): everything that can be verified from the file alone, without
// the app, a wallet or (unless --rpc is given) the network.
//
//   node scripts/recheck-evidence.mjs <latch-evidence-*.json> [--rpc <url>] [--expect-hash <hex>]
//
// Checks: the bundle's own SHA-256 (what the app printed), the agreement text
// against its fingerprint and the on-chain terms hash as captured, every
// document claim and acknowledgement for canonical bytes and this deal, the
// transaction rows and their events, and (with --rpc) that each signature is
// known to the network and the account is still owned by the program.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import canonicalize from "canonicalize";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Pure: returns { ok, findings: [{ level: "pass"|"fail"|"note", text }], bundleHash }. */
export function recheck(bundle, { expectHash } = {}) {
  const f = [];
  const pass = (t) => f.push({ level: "pass", text: t });
  const fail = (t) => f.push({ level: "fail", text: t });
  const note = (t) => f.push({ level: "note", text: t });

  if (!bundle || bundle.format !== "latch-evidence-bundle@1") {
    fail(`not a latch-evidence-bundle@1 (format: ${bundle?.format})`);
    return { ok: false, findings: f, bundleHash: null };
  }
  const bundleHash = sha256(canonicalize(bundle));
  if (expectHash) (expectHash.toLowerCase() === bundleHash ? pass : fail)(`bundle SHA-256 ${bundleHash}${expectHash.toLowerCase() === bundleHash ? " matches the expected hash" : ` does NOT match expected ${expectHash}`}`);
  else note(`bundle SHA-256 ${bundleHash} (compare with the hash the app printed, or the file name)`);

  const d = bundle.deal ?? {};
  if (!B58.test(String(d.address))) fail("deal.address is not a wallet-style address");
  else pass(`deal ${d.address} · state ${d.state}`);
  if (!HEX64.test(String(d.termsHash))) fail("deal.termsHash is not 64 hex characters");
  const parties = Array.isArray(d.parties) ? d.parties : [];
  if (parties.length < 2 || !parties.every((p) => B58.test(String(p)))) fail("deal.parties should be 2+ addresses");
  if (parties.length && (!parties.includes(d.payer) || !parties.includes(d.payee))) fail("payer/payee are not among the parties");

  const a = bundle.agreement ?? {};
  if (typeof a.text === "string") {
    const h = sha256(a.text);
    (h === a.sha256 ? pass : fail)(`agreement text hashes to ${h}${h === a.sha256 ? " = agreement.sha256" : ` but agreement.sha256 says ${a.sha256}`}`);
    (h === d.termsHash ? pass : fail)(h === d.termsHash ? "agreement fingerprint equals the on-chain terms hash as captured" : "agreement fingerprint does NOT equal the captured on-chain terms hash");
    if (a.matchesOnChain === true && h !== d.termsHash) fail("agreement.matchesOnChain claims true but the hashes differ");
    const first = a.text.split("\n")[0] ?? "";
    if (a.template && !first.includes(`template ${a.template}`)) fail(`agreement line 1 doesn't name template ${a.template}: ${JSON.stringify(first)}`);
    if (a.programHashStatedInText && !a.text.includes(a.programHashStatedInText)) fail("the program hash the record says the text states is not in the text");
    if (a.programHashStatedInText && bundle.programVerifiedBuildHash && a.programHashStatedInText !== bundle.programVerifiedBuildHash) note(`the text states program hash ${a.programHashStatedInText.slice(0, 12)}…, the bundle pins ${String(bundle.programVerifiedBuildHash).slice(0, 12)}… (an older build; see TEMPLATE-V2-SPEC.md §9)`);
  } else note(`no agreement text in the bundle (status: ${a.status ?? "unknown"})`);

  const txs = Array.isArray(bundle.transactions) ? bundle.transactions : [];
  const sigs = new Set();
  let ok = 0;
  for (const r of txs) {
    if (typeof r.signature !== "string" || r.signature.length < 80) fail(`transaction row without a signature: ${JSON.stringify(r).slice(0, 80)}`);
    if (sigs.has(r.signature)) fail(`duplicate transaction ${r.signature}`);
    sigs.add(r.signature);
    if (r.ok) ok++;
    for (const e of r.events ?? []) if (e?.data?.deal && e.data.deal !== d.address) fail(`event ${e.name} in ${r.signature.slice(0, 12)}… names another deal`);
  }
  pass(`${txs.length} transaction rows, ${ok} successful, ${txs.length - ok} failed attempts`);

  const docs = Array.isArray(bundle.documents) ? bundle.documents : [];
  for (const x of docs) {
    const claim = { v: "latch-doc@1", deal: x.deal, stage: x.stage, name: x.name, sha256: x.sha256 };
    const bad = x.v !== "latch-doc@1" || x.deal !== d.address || !Number.isInteger(x.stage) || x.stage < 0 || x.stage > 15 || typeof x.name !== "string" || !x.name || x.name.length > 40 || !HEX64.test(String(x.sha256)) || !parties.includes(x.presenter) || !sigs.has(x.signature);
    (bad ? fail : pass)(`document${bad ? " (invalid)" : ""}: stage ${Number(x.stage) + 1} · ${x.name} · ${String(x.sha256).slice(0, 16)}… by ${x.presenter} in ${String(x.signature).slice(0, 12)}…`);
    if (!bad && canonicalize(claim) !== JSON.stringify(claim)) note("claim re-encodes canonically (keys sorted)");
  }
  const acks = Array.isArray(bundle.acknowledgements) ? bundle.acknowledgements : [];
  for (const x of acks) {
    const bad = x.v !== "latch-doc-ack@1" || x.deal !== d.address || !Number.isInteger(x.stage) || !HEX64.test(String(x.sha256)) || !parties.includes(x.by) || !sigs.has(x.signature);
    const matched = docs.some((p) => p.sha256 === x.sha256 && p.stage === x.stage);
    (bad ? fail : pass)(`acknowledgement${bad ? " (invalid)" : ""}: stage ${Number(x.stage) + 1} · ${String(x.sha256).slice(0, 16)}… by ${x.by}${matched ? " · matches a presentation" : " · no matching presentation in this bundle"}`);
  }

  return { ok: !f.some((x) => x.level === "fail"), findings: f, bundleHash };
}

/** With --rpc: every successful signature is known to the network and the deal account is owned by the program. */
export async function recheckOnline(bundle, rpc, fetchFn = fetch) {
  const f = [];
  const call = async (method, params) => {
    const r = await fetchFn(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return (await r.json()).result;
  };
  const acct = await call("getAccountInfo", [bundle.deal?.address, { encoding: "base64", commitment: "finalized" }]);
  if (!acct?.value) f.push({ level: "fail", text: "the deal account no longer exists on this cluster" });
  else f.push({ level: acct.value.owner === bundle.program ? "pass" : "fail", text: `deal account owner ${acct.value.owner}${acct.value.owner === bundle.program ? " = the Latch program" : ` ≠ the bundle's program ${bundle.program}`}` });
  const sigs = (bundle.transactions ?? []).filter((r) => r.ok).map((r) => r.signature);
  for (let i = 0; i < sigs.length; i += 100) {
    const chunk = sigs.slice(i, i + 100);
    const st = await call("getSignatureStatuses", [chunk, { searchTransactionHistory: true }]);
    chunk.forEach((s, j) => {
      const v = st?.value?.[j];
      f.push({ level: v ? "pass" : "note", text: v ? `${s.slice(0, 12)}… known to the network (slot ${v.slot})` : `${s.slice(0, 12)}… not found on this RPC (history may have expired; the snapshot still stands as captured)` });
    });
  }
  return f;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const file = args.find((x) => !x.startsWith("--"));
  if (!file) {
    console.error("usage: node scripts/recheck-evidence.mjs <bundle.json> [--rpc <url>] [--expect-hash <hex>]");
    process.exit(2);
  }
  const bundle = JSON.parse(readFileSync(file, "utf8"));
  const expectHash = args.includes("--expect-hash") ? args[args.indexOf("--expect-hash") + 1] : file.match(/-([0-9a-f]{8})\.json$/)?.[1];
  const r = recheck(bundle, { expectHash: expectHash && expectHash.length === 64 ? expectHash : undefined });
  if (expectHash && expectHash.length === 8) r.findings.unshift({ level: r.bundleHash?.startsWith(expectHash) ? "pass" : "fail", text: `file name hash prefix ${expectHash} ${r.bundleHash?.startsWith(expectHash) ? "matches" : "does NOT match"} the bundle's SHA-256` });
  const rpc = args.includes("--rpc") ? args[args.indexOf("--rpc") + 1] : null;
  const online = rpc ? await recheckOnline(bundle, rpc) : [];
  for (const x of [...r.findings, ...online]) console.log(`${x.level === "pass" ? "PASS" : x.level === "fail" ? "FAIL" : "NOTE"}  ${x.text}`);
  const failed = [...r.findings, ...online].some((x) => x.level === "fail");
  console.log(failed ? "\nRESULT: problems found" : "\nRESULT: the bundle is internally consistent");
  process.exit(failed ? 1 : 0);
}
