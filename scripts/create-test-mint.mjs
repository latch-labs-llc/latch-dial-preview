// Creates the devnet TEST token used by the optional faucet.
// - Generates a fresh mint authority into .secrets/test-mint-authority.json
//   (gitignored). That key can only mint worthless devnet test tokens.
// - No freeze authority (so TEST carries no issuer-freeze risk flag).
// Fund the printed authority address with ~0.05 devnet SOL first
// (faucet.solana.com), then run this again to create the mint.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Connection, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMint2Instruction, getMinimumBalanceForRentExemptMint } from "@solana/spl-token";

const RPC = process.env.RPC_URL || "https://api.devnet.solana.com";
const file = ".secrets/test-mint-authority.json";
mkdirSync(".secrets", { recursive: true });
if (!existsSync(file)) writeFileSync(file, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(file, "utf8"))));
const conn = new Connection(RPC, "confirmed");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) {
  console.error(`${RPC} is not Solana devnet — refusing to create a mint there.`);
  process.exit(1);
}
const bal = await conn.getBalance(authority.publicKey);
console.log(`authority ${authority.publicKey.toBase58()} has ${bal / 1e9} devnet SOL`);
if (bal < 0.01e9) {
  console.log("Fund it with ~0.05 devnet SOL (https://faucet.solana.com), then run again.");
  process.exit(0);
}
const mint = Keypair.generate();
const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: authority.publicKey,
    newAccountPubkey: mint.publicKey,
    lamports: await getMinimumBalanceForRentExemptMint(conn),
    space: MINT_SIZE,
    programId: TOKEN_PROGRAM_ID,
  }),
  createInitializeMint2Instruction(mint.publicKey, 6, authority.publicKey, null),
);
const sig = await conn.sendTransaction(tx, [authority, mint]);
await conn.confirmTransaction(sig, "confirmed");
console.log(`TEST mint created: ${mint.publicKey.toBase58()}`);
console.log(`\nApp:    VITE_TEST_MINT=${mint.publicKey.toBase58()}`);
console.log(`Worker: TEST_MINT = "${mint.publicKey.toBase58()}"  and  wrangler secret put FAUCET_SECRET < ${file}`);
