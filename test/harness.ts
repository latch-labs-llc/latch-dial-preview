/**
 * LiteSVM harness running the DEPLOYED Latch binary (test/fixtures/latch.so,
 * fetched read-only from devnet by scripts/fetch-program.mjs and checked
 * against the published verified-build hash). All keypairs are generated
 * fresh per run and never written to disk.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { LiteSVM, FailedTransactionMetadata, Clock } from "litesvm";
import { getTransactionDecoder, address } from "@solana/kit";
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  MINT_SIZE,
  createInitializeMint2Instruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
} from "@solana/spl-token";
import { IDL as LATCH_IDL } from "@latch-labs/sdk";
import { PROGRAM_ID, TOKEN_PROGRAM } from "../src/lib/config";
import { decodeDeal, type Deal } from "../src/lib/deal";
import { decodeEventIx, type LatchEvent } from "../src/lib/events";

export const FIXTURE = new URL("./fixtures/latch.so", import.meta.url).pathname;
export const haveFixture = existsSync(FIXTURE);

/** sha256 of the fixture with trailing zero padding stripped (solana-verify's hash). */
export function fixtureHash(): string | null {
  if (!haveFixture) return null;
  const raw = readFileSync(FIXTURE);
  let end = raw.length;
  while (end > 0 && raw[end - 1] === 0) end--;
  return createHash("sha256").update(raw.subarray(0, end)).digest("hex");
}

export class Chain {
  svm: LiteSVM;
  maxTxSize = 0;
  /** Latch events emitted by the last successful send. */
  lastEvents: LatchEvent[] = [];
  /** getTransaction-shaped JSON of the last successful send (screenshot fixture). */
  lastTxJson: any = null;
  constructor() {
    this.svm = new LiteSVM().withSysvars().withBuiltins().withDefaultPrograms().withPrecompiles().withNativeMints();
    this.svm.addProgram(address(PROGRAM_ID.toBase58()), readFileSync(FIXTURE));
  }

  wallet(sol = 10): Keypair {
    const k = Keypair.generate();
    this.svm.airdrop(address(k.publicKey.toBase58()), BigInt(sol * 1e9) as any);
    return k;
  }

  /** Sign and send as a real wallet would (v0 message, all signers). Throws with logs on failure. */
  send(ixs: TransactionInstruction[], feePayer: Keypair, extra: Keypair[] = []): void {
    const msg = new TransactionMessage({
      payerKey: feePayer.publicKey,
      recentBlockhash: this.svm.latestBlockhash() as unknown as string,
      instructions: ixs,
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([feePayer, ...extra]);
    const bytes = tx.serialize();
    this.maxTxSize = Math.max(this.maxTxSize, bytes.length);
    const res = this.svm.sendTransaction(getTransactionDecoder().decode(bytes) as any);
    this.svm.expireBlockhash();
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(`tx failed: ${res.toString()}\n${res.meta().logs().join("\n")}`);
    }
    // Latch events: the program's self-CPI inner instructions.
    const keys = msg.staticAccountKeys;
    // RPC-shaped record of this transaction (getTransaction JSON, v0), for the screenshot fixture.
    this.lastTxJson = {
      slot: 0,
      blockTime: this.now(),
      version: 0,
      transaction: {
        signatures: tx.signatures.map((s) => base58(s)),
        message: {
          header: msg.header,
          accountKeys: keys.map((k) => k.toBase58()),
          recentBlockhash: msg.recentBlockhash,
          instructions: msg.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: Array.from(ix.accountKeyIndexes), data: base58(ix.data) })),
          addressTableLookups: [],
        },
      },
      meta: {
        err: null,
        status: { Ok: null },
        fee: 5000,
        preBalances: keys.map(() => 0),
        postBalances: keys.map(() => 0),
        logMessages: [],
        loadedAddresses: { writable: [], readonly: [] },
        innerInstructions: (res as any).innerInstructions().map((group: any[], index: number) => ({
          index,
          instructions: group.map((ii: any) => ({ programIdIndex: ii.instruction().programIdIndex(), accounts: Array.from(ii.instruction().accounts()), data: base58(ii.instruction().data()), stackHeight: ii.stackHeight() })),
        })),
      },
    };
    this.lastEvents = (res as any)
      .innerInstructions()
      .flat()
      .map((ii: any) => ii.instruction())
      .filter((ix: any) => keys[ix.programIdIndex()]?.equals(PROGRAM_ID))
      .map((ix: any) => decodeEventIx(ix.data()))
      .filter(Boolean);
  }

  trySend(ixs: TransactionInstruction[], feePayer: Keypair, extra: Keypair[] = []): string | null {
    try {
      this.send(ixs, feePayer, extra);
      return null;
    } catch (e: any) {
      return String(e.message);
    }
  }

  raw(addr: PublicKey): Uint8Array | null {
    const a: any = this.svm.getAccount(address(addr.toBase58()));
    return a && a.exists ? Uint8Array.from(a.data) : null;
  }

  deal(addr: PublicKey): Deal {
    const data = this.raw(addr);
    if (!data) throw new Error("no deal account");
    return decodeDeal(addr, data);
  }

  lamports(addr: PublicKey): bigint {
    return BigInt((this.svm.getBalance(address(addr.toBase58())) as any) ?? 0);
  }

  tokenBalance(owner: PublicKey, mint: PublicKey): bigint {
    const data = this.raw(getAssociatedTokenAddressSync(mint, owner, true));
    if (!data) return 0n;
    return Buffer.from(data).readBigUInt64LE(64);
  }

  now(): number {
    return Number(this.svm.getClock().unixTimestamp);
  }

  warp(seconds: number) {
    const c = this.svm.getClock();
    this.svm.setClock(new Clock(c.slot + 1000n, c.epochStartTimestamp, c.epoch, c.leaderScheduleEpoch, c.unixTimestamp + BigInt(seconds)));
  }

  /** A fresh classic SPL mint WITH a freeze authority (to mirror Circle USDC's risk flag). */
  mint(authority: Keypair, decimals = 6): PublicKey {
    const m = Keypair.generate();
    const rent = this.svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE));
    this.send(
      [
        SystemProgram.createAccount({
          fromPubkey: authority.publicKey,
          newAccountPubkey: m.publicKey,
          lamports: Number(rent),
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM,
        }),
        createInitializeMint2Instruction(m.publicKey, decimals, authority.publicKey, authority.publicKey),
      ],
      authority,
      [m],
    );
    return m.publicKey;
  }

  mintTo(mint: PublicKey, authority: Keypair, owner: PublicKey, raw: bigint) {
    const ata = getAssociatedTokenAddressSync(mint, owner, true);
    this.send(
      [
        createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, owner, mint),
        createMintToInstruction(mint, ata, authority.publicKey, raw),
      ],
      authority,
    );
  }
}

export { getMinimumBalanceForRentExemptMint };

/** base64url(JSON) with NO validation — for crafting hostile link blobs in tests. */
export function rawBlob(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

/**
 * Assert a transaction failed with EXACTLY this Latch program error: the
 * Anchor log line names it and carries its IDL error number. Any other
 * failure (wrong error, wrong account, out of compute) fails the test.
 */
export function expectProgramError(err: string | null, name: string): void {
  const errors = (LATCH_IDL as unknown as { errors: { code: number; name: string }[] }).errors;
  const toPascal = (s: string) => s.replace(/(^|_)([a-z])/g, (_, __, c) => c.toUpperCase());
  const e = errors.find((x) => x.name === name || toPascal(x.name) === name);
  if (!e) throw new Error(`unknown program error ${name}`);
  if (err === null) throw new Error(`expected ${name} (${e.code}), but the transaction succeeded`);
  const m = /Error Code: (\w+)\. Error Number: (\d+)\./.exec(err);
  if (!m) throw new Error(`expected ${name} (${e.code}), got a non-program failure:\n${err.slice(0, 600)}`);
  if (m[1] !== name || Number(m[2]) !== e.code) throw new Error(`expected ${name} (${e.code}), got ${m[1]} (${m[2]})`);
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Plain base58 (signatures and instruction data aren't 32 bytes, so not via PublicKey). */
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
