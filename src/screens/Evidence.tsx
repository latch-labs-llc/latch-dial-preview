import { useConnection } from "@solana/wallet-adapter-react";
import { Connection, PublicKey } from "@solana/web3.js";
import canonicalize from "canonicalize";
import { useMemo } from "react";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Button, Cell, KV, NavBar, Section, download, useAsync } from "../components/ui";
import { CLUSTER, PROGRAM_ID, RPC_URL, VERIFIED_BUILD_HASH, assetForMint, explorerTx } from "../lib/config";
import { fetchDeal, observedProgramHash } from "../lib/chain";
import { COPY } from "../lib/copy";
import { decodeDeal } from "../lib/deal";
import { evidenceDealRecord, evidenceEventSentence } from "../lib/evidence";
import { eventsFromTx, type LatchEvent } from "../lib/events";
import { recordsFromTx, type AcknowledgedDocument, type PresentedDocument } from "../lib/documents";
import { money } from "../lib/format";
import { useLocal } from "../lib/store";
import { sha256Hex } from "../lib/template";
import { agreementStatus, evidenceAgreementRecord, evidenceSentence, statusLabel } from "../lib/agreementCheck";

const SECOND_RPC: string | undefined = (import.meta as any).env?.VITE_RPC_URL_2;

interface TxRow {
  signature: string;
  slot: number;
  blockTime: number | null;
  ok: boolean;
  err: string | null;
  /** Latch events emitted by this transaction (v0.7: e.g. PayeeRefunded). */
  events?: LatchEvent[];
  /** Document claims signed by a party in this transaction (v0.8 #6). */
  documents?: PresentedDocument[];
  /** Receipt acknowledgements signed by a party in this transaction (v0.15). */
  acknowledgements?: AcknowledgedDocument[];
}

/**
 * A9: evidence packet (court-readable), R6 P0 subset: full signatures,
 * `finalized` reads, failed transactions kept in an appendix, the RPC
 * endpoint(s) named, chain time instead of the device clock, a JCS bundle
 * anyone can recompute, and a limitations box. Latch Labs certifies nothing.
 */
export default function Evidence({ address }: { address?: string }) {
  const { connection } = useConnection();
  const local = useLocal((d) => d);
  const key = useMemo(() => {
    try {
      return address ? new PublicKey(address) : null;
    } catch {
      return null;
    }
  }, [address]);

  const q = useAsync(async () => {
    if (!key) return null;
    const fin = new Connection(RPC_URL, "finalized");
    const info = await fin.getAccountInfo(key, "finalized");
    const deal = info ? decodeDeal(key, info.data) : await fetchDeal(connection, key);
    const sigs = await fin.getSignaturesForAddress(key, { limit: 1000 }, "finalized");
    const rows: TxRow[] = sigs
      .map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, ok: !s.err, err: s.err ? JSON.stringify(s.err) : null }))
      .reverse();
    for (const r of rows) {
      if (!r.ok) continue;
      const tx = await fin.getTransaction(r.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" }).catch(() => null);
      r.events = tx ? eventsFromTx(tx) : [];
      const recs = tx && deal ? recordsFromTx(tx, deal) : { presented: [], acknowledged: [] };
      r.documents = recs.presented;
      r.acknowledgements = recs.acknowledged;
    }
    const slot = await fin.getSlot("finalized");
    const chainTime = await fin.getBlockTime(slot).catch(() => null);
    const genesis = await fin.getGenesisHash();
    const observed = await observedProgramHash(fin).catch(() => null);
    let crossCheck: string | null = null;
    if (SECOND_RPC) {
      try {
        const other = new Connection(SECOND_RPC, "finalized");
        const o = await other.getAccountInfo(key, "finalized");
        crossCheck = o && info && Buffer.from(o.data).equals(Buffer.from(info.data)) ? "match" : "MISMATCH";
      } catch {
        crossCheck = "unavailable";
      }
    }
    return { deal, rows, slot, chainTime, genesis, crossCheck, finalized: !!info, observed };
  }, [key?.toBase58()]);

  if (!q.data?.deal) return <><NavBar title="Evidence" backTo="/" /><div className="empty">{q.loading ? <span className="spinner" /> : q.error ?? "Not found."}</div></>;
  const { deal: d, rows, slot, chainTime, genesis, crossCheck, finalized, observed } = q.data;
  const hashMatches = observed?.hash === VERIFIED_BUILD_HASH;
  const asset = assetForMint(d.mint);
  const blobStr = local.links[d.address.toBase58()];
  const status = agreementStatus(d, blobStr, asset?.decimals ?? 6);
  const ok = rows.filter((r) => r.ok);
  const failed = rows.filter((r) => !r.ok);

  const bundle = {
    format: "latch-evidence-bundle@1",
    cluster: CLUSTER,
    genesisHash: genesis,
    program: PROGRAM_ID.toBase58(),
    programVerifiedBuildHash: VERIFIED_BUILD_HASH,
    programObserved: observed
      ? { programDataAccount: observed.programData, deployedSlot: observed.slot, bytecodeSha256: observed.hash, matchesVerifiedBuild: observed.hash === VERIFIED_BUILD_HASH }
      : null,
    rpc: [RPC_URL, ...(SECOND_RPC ? [SECOND_RPC] : [])],
    commitment: "finalized",
    asOfSlot: slot,
    asOfChainTime: chainTime,
    deal: evidenceDealRecord(d),
    agreement: evidenceAgreementRecord(status),
    transactions: rows,
    documents: rows.flatMap((r) => r.documents ?? []),
    acknowledgements: rows.flatMap((r) => r.acknowledgements ?? []),
    methodology:
      "Account state and signatures read at 'finalized' commitment from the RPC endpoint(s) listed. The agreement text is regenerated from on-chain fields plus the share-link parameters with template v2 (TEMPLATE-V2-SPEC.md); its SHA-256 is compared with the on-chain terms hash. Documents presented: Memo instructions in the deal's own transactions whose single account is a signing party, carrying a latch-doc@1 claim (stage, name, SHA-256 of the file) for this deal; acknowledgements are latch-doc-ack@1 memos signed the same way by the receiving party (stage, SHA-256). The files themselves are held by the parties, and anyone holding a copy can hash it and compare. Anyone can repeat every step with public data.",
  };
  const bundleJson = canonicalize(bundle) as string;
  const bundleHash = sha256Hex(bundleJson);

  return (
    <>
      <NavBar title="Evidence" backTo={`/deal/${d.address.toBase58()}`} right={<button className="navbtn" onClick={() => window.print()}>Print</button>} />
      <div className="banner">{COPY.evidenceLimits}</div>

      <Section header="In plain words">
        <div className="cell">
          <div className="body">
            <div className="t wrap" style={{ fontSize: 15, lineHeight: "20px" }}>
              A payment of {money(d.totalAmount, asset)} from {d.parties[d.payerIdx].toBase58()} to {d.parties[d.payeeIdx].toBase58()} was set up on Solana {CLUSTER} under the Latch program. Its current state is <b>{d.state}</b>. {ok.length} successful transaction{ok.length === 1 ? "" : "s"} touched it
              {failed.length ? `, and ${failed.length} failed attempt${failed.length === 1 ? "" : "s"} are listed in the appendix` : ""}.{" "}
              {evidenceSentence(status)}
              {evidenceEventSentence(rows.flatMap((r) => r.events ?? []), d)}
            </div>
          </div>
        </div>
      </Section>

      <Section header="Provenance">
        <KV k="Cluster" v={`${CLUSTER} (genesis ${genesis})`} />
        <KV k="Program" v={<span className="mono">{PROGRAM_ID.toBase58()}</span>} />
        <KV k="Expected build" v={<span className="mono caption">{VERIFIED_BUILD_HASH}</span>} />
        <KV
          k="Observed now"
          v={
            observed ? (
              <>
                <span className="mono caption">{observed.hash}</span>
                <div className="caption">{hashMatches ? "✓ matches the verified build" : "✗ differs from the expected build — the program was upgraded"} · deployed at slot {observed.slot}</div>
              </>
            ) : (
              "couldn't read the program bytes"
            )
          }
        />
        <KV k="Read from" v={<span className="mono caption">{RPC_URL}</span>} />
        <KV k="Commitment" v={finalized ? "finalized" : "confirmed (not yet finalized)"} />
        <KV k="As of" v={`slot ${slot}${chainTime ? ` · chain time ${new Date(chainTime * 1000).toISOString()}` : ""}`} />
        {SECOND_RPC && <KV k="Second RPC" v={crossCheck} />}
      </Section>

      <Section header="Agreement">
        <KV k="Fingerprint" v={<span className="mono caption">{bytesToHex(d.termsHash)}</span>} />
        <KV k="Status" v={statusLabel(status)} />
        <KV
          k="Dispute policy"
          v={d.timerMode === "FromActivation" ? `${d.disputePolicy}${d.disputeWindowSecs ? ` · time limit ${d.disputeWindowSecs} s` : " · no time limit"} · paused so far ${d.disputedSecs} s` : "not applicable (clock starts at a dispute)"}
        />
      </Section>

      {(() => {
        const docs = rows.flatMap((r) => r.documents ?? []);
        const acks = rows.flatMap((r) => r.acknowledgements ?? []);
        return docs.length || acks.length ? (
          <Section header={`Documents presented (${docs.length})`} footer="Each line is a claim signed on-chain by a party: this file, with this SHA-256, for this stage. The file itself is not on-chain; a holder can hash their copy and compare.">
            {docs.map((x, i) => (
              <Cell
                key={`${x.signature}-${i}`}
                title={`Stage ${x.stage + 1} · ${x.name}`}
                subtitle={`SHA-256 ${x.sha256} · by ${x.presenter}${x.blockTime ? ` · ${new Date(x.blockTime * 1000).toISOString()}` : ""}`}
                wrap
                href={explorerTx(x.signature)}
              />
            ))}
            {acks.map((a, i) => (
              <Cell
                key={`ack-${a.signature}-${i}`}
                title={`Stage ${a.stage + 1} · received, says ${a.by}`}
                subtitle={`SHA-256 ${a.sha256}${a.blockTime ? ` · ${new Date(a.blockTime * 1000).toISOString()}` : ""}`}
                wrap
                href={explorerTx(a.signature)}
              />
            ))}
          </Section>
        ) : null;
      })()}
      <Section header={`Transactions (${ok.length})`}>
        {ok.map((r) => (
          <Cell key={r.signature} title={<span className="mono" style={{ fontSize: 12 }}>{r.signature}</span>} subtitle={`slot ${r.slot}${r.blockTime ? ` · ${new Date(r.blockTime * 1000).toISOString()}` : ""}${r.events?.length ? ` · ${r.events.map((e) => e.name).join(", ")}` : ""}`} wrap href={explorerTx(r.signature)} />
        ))}
      </Section>
      {failed.length > 0 && (
        <Section header={`Appendix — failed attempts (${failed.length})`}>
          {failed.map((r) => (
            <Cell key={r.signature} title={<span className="mono" style={{ fontSize: 12 }}>{r.signature}</span>} subtitle={`slot ${r.slot} · ${r.err}`} wrap href={explorerTx(r.signature)} />
          ))}
        </Section>
      )}

      <Section header="How this record was produced">
        <div className="qa">
          <ol className="method">
            <li>
              Every fact above was read from Solana {CLUSTER} at deal account <span className="mono">{d.address.toBase58()}</span> over the RPC endpoint(s) listed under Provenance, at finalized commitment, at the slot and chain time shown. Nothing comes from a private database or from Latch Labs; the operator of this page holds no information a third party cannot retrieve independently.
            </li>
            <li>
              The deal record is the account's on-chain state. The transaction list is every signature that references the account; each row links to the public transaction, and the events are decoded from its inner instructions. Documents presented are signed memo claims inside those same transactions (TEMPLATE-V2-SPEC.md §10).
            </li>
            <li>
              The agreement text is regenerated from the on-chain fields plus the share link's parameters (template v2) and its SHA-256 is compared with the terms hash the parties signed. Result: <b>{statusLabel(status)}</b>.
            </li>
            <li>
              The program that enforced these rules is open source (Apache-2.0). Its deployed bytecode is reproducible from source; the hash observed on-chain now is listed under Provenance and {hashMatches ? "matches" : "does not match"} the verified build.
            </li>
          </ol>
        </div>
      </Section>

      <Section header="Declaration of the person producing this packet" footer="For use when this printout is given to a court, arbitrator or auditor; the person who generated it completes it by hand. Demonstration only on devnet; this instance creates no legal obligations.">
        <div className="qa decl">
          <p>
            I, ______________________________________, state that on the date below I retrieved this record using the method described above, over public Solana RPC, and that this printout accurately reflects what was displayed; the agreement check reported the result shown.
          </p>
          <p>Signature: ______________________________________ &nbsp;&nbsp; Date: ______________________</p>
        </div>
      </Section>

      <Section header="Bundle" footer="A canonical JSON file (RFC 8785) of everything above. Its SHA-256 lets anyone confirm they hold the same bundle.">
        <KV k="SHA-256" v={<span className="mono caption">{bundleHash}</span>} />
      </Section>
      <div className="stack no-print">
        <Button kind="secondary" onClick={() => download(`latch-evidence-${d.address.toBase58().slice(0, 8)}-${bundleHash.slice(0, 8)}.json`, bundleJson, "application/json")}>
          Download bundle (JSON)
        </Button>
      </div>
      <Section header="Limitations">
        <div className="qa">
          <span>
            Wallet addresses are not identities: this record shows which keys signed, not who held them. Times come from Solana block times. A separate tool to re-check the bundle offline is planned, not built yet.
          </span>
        </div>
      </Section>
    </>
  );
}
