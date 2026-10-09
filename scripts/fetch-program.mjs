// Downloads the DEPLOYED Latch program bytecode from devnet (read-only) into
// test/fixtures/latch.so so the LiteSVM tests run the exact on-chain binary.
// Verifies it against the published verified-build hash before writing.
// Never deploys anything.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = "BT8tr7YXYLQPsLMq3qCipY1fBKyjT3gmGQB5amV2v5yv";
// From the public latch README ("Verified hash"); solana-verify hashes the
// executable with trailing zero padding stripped.
const VERIFIED_HASH = "4e5fa0a61eaa89313d1015ed10c760a703dd0768c80f3e79fe0f81603715459d";

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result.value;
}

const bs58 = (await import("bs58")).default;
const prog = await rpc("getAccountInfo", [PROGRAM_ID, { encoding: "base64" }]);
const progData = Buffer.from(prog.data[0], "base64");
const programDataAddr = bs58.encode(progData.subarray(4, 36));
const pd = await rpc("getAccountInfo", [programDataAddr, { encoding: "base64" }]);
const raw = Buffer.from(pd.data[0], "base64").subarray(45); // UpgradeableLoaderState::ProgramData header
let end = raw.length;
while (end > 0 && raw[end - 1] === 0) end--;
const so = raw.subarray(0, end);
const hash = createHash("sha256").update(so).digest("hex");
console.log(`programdata ${programDataAddr}, ${so.length} bytes, sha256 ${hash}`);
if (hash !== VERIFIED_HASH) {
  console.error(`hash does not match the published verified build (${VERIFIED_HASH}); refusing to write`);
  process.exit(1);
}
mkdirSync("test/fixtures", { recursive: true });
// Write the full deployed bytes (ELF loaders need the original length).
writeFileSync("test/fixtures/latch.so", raw);
console.log("wrote test/fixtures/latch.so (matches verified build)");
