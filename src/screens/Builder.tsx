import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useMemo, useState } from "react";
import { Icon, ProgressStrip, Dial, Avatar, Button, Cell, KV, NavBar, Section, Sheet, download } from "../components/ui";
import { ASSETS, ASSET_IDS, RENT_ESTIMATE_SOL, TOKEN_PROGRAM, type Asset, type AssetId } from "../lib/config";
import { COPY } from "../lib/copy";
import { LIMITS, RULES, DISPUTE_CLOCK_ONLY, TIMED_RULES, clauseIndex, customFields, customProblems, customSpec, writes, type CustomTerms, type Section as ClauseNo } from "../lib/customTerms";
import { useData } from "../lib/data";
import type { DisputePolicyName, RuleName, TimerModeName } from "../lib/deal";
import { parseAddress } from "../lib/evidence";
import * as F from "../lib/flows";
import { money, parseAmount, short } from "../lib/format";
import { vetMint, type MintVetting } from "../lib/mintGuard";
import { appUrl, go } from "../lib/router";
import { getLocal, updateLocal, useLocal } from "../lib/store";
import { INCOTERMS, RISK_NAMES, encodeBlob, newNonce, renderAgreement, sealAttachment, sha256Hex, termsHash, uiAmount, type LinkBlob, type TemplateId } from "../lib/template";
import { messagingOn, messagingUnlocked, unlockMessaging } from "../lib/messaging";
import { proposalOf, proposeTerms } from "../lib/negotiation";
import { serviceOn } from "../lib/service";
import { detailsFromAttachment, fromCustomTerms, type TermsDraft } from "../lib/termsDraft";
import { nameFor } from "../lib/view";
import { explainError, useAgreementSend, useAllowedWallet } from "../lib/wallet";
import ShareSheet from "./ShareSheet";

/**
 * Custom agreements, clause by clause (v0.9 #4). The steps are the sections
 * of the signed text; every control says which sentence it writes, and the
 * live preview shows the exact bytes that will be hashed. Every parameter
 * the program accepts is here, validated with the program's own rules
 * (`customProblems`). Protected and Instant live in Pay.tsx and are unchanged.
 */

type Template = "general" | "goods" | "freelance" | "deposit" | "vehicle" | "trade";
const TEMPLATE_LABEL: Record<Template, string> = { general: "General", goods: "Goods sale", freelance: "Freelance work", deposit: "Deposit", vehicle: "Vehicle sale", trade: "Cross-border trade" };
const TEMPLATE_ID: Record<Template, TemplateId> = { general: "general@2", goods: "goods-sale@2", freelance: "freelance@2", deposit: "deposit@2", vehicle: "vehicle-sale@2", trade: "trade@2" };

interface Part {
  label: string;
  amount: string;
}
interface PartyRow {
  address: string;
  label: string;
}
interface Issue {
  section: ClauseNo;
  text: string;
}

const STEPS: { title: string; sections: ClauseNo[] }[] = [
  { title: "§1 · Subject", sections: [1] },
  { title: "§2 · Parties & approvals", sections: [2] },
  { title: "§3–4 · Money & parts", sections: [3, 4] },
  { title: "§5 · If there is a problem", sections: [5] },
  { title: "§6 · Recovery signers", sections: [6] },
  { title: "§7 · Token risks", sections: [7] },
  { title: "§8 · Private details", sections: [8] },
  { title: "Review & sign", sections: [] },
];

const INCOTERM_NAMES: Record<string, string> = {
  EXW: "Ex Works", FCA: "Free Carrier", CPT: "Carriage Paid To", CIP: "Carriage and Insurance Paid To", DAP: "Delivered at Place",
  DPU: "Delivered at Place Unloaded", DDP: "Delivered Duty Paid", FAS: "Free Alongside Ship", FOB: "Free on Board", CFR: "Cost and Freight", CIF: "Cost, Insurance and Freight",
};

/** v0.7.1 #4: the limit is cumulative — said on every choice that has one. */
const LIMIT_ADDS_UP = "The limit adds up every pause and never resets: once it's used up, any new pause ends that way straight away.";
const DISPUTE_CHOICES: { id: DisputePolicyName; title: string; subtitle: string }[] = [
  { id: "NeverExpire", title: "Hold until you all agree", subtitle: "No time limit. A pause holds the money until every party signs the same split." },
  { id: "ResumeRule", title: "Resume the clock", subtitle: `After the time limit, anyone can end the pause and the clock picks up where it stopped. ${LIMIT_ADDS_UP}` },
  { id: "Split", title: "Split", subtitle: `After the time limit, anyone can split what's left (your split above, otherwise 50/50). ${LIMIT_ADDS_UP}` },
  { id: "RefundPayer", title: "Return to payer", subtitle: `After the time limit, anyone can return what's left to the payer. ${LIMIT_ADDS_UP}` },
];

/** The six rules by their contract names (the text says "Rule: …"). */
const RULE_CHOICES: { id: RuleName; title: string; subtitle: string }[] = [
  { id: "TimeoutRelease", title: "Timeout release", subtitle: "If nothing is released by the end of the window, anyone may send what's left to the recipient." },
  { id: "TimeoutRefund", title: "Timeout refund", subtitle: "If nothing is released by the end of the window, anyone may return what's left to the payer." },
  { id: "AutoSplit", title: "Timed split", subtitle: "At the end of the window, anyone may split what's left at the share you set." },
  { id: "LongSunset", title: "Long sunset", subtitle: "Locked until the parties agree; if they never do, anyone may return it to the payer at the end of the window." },
  { id: "TieBreaker", title: "Named decider", subtitle: COPY.arbiterNoUnlock },
  { id: "TrueDeadlock", title: "No decider, no timer", subtitle: COPY.trueDeadlock },
];

const mono = { fontFamily: "var(--mono)", fontSize: 14 } as const;

/** v0.14: a proposal from a conversation, opened for a counter — or (v0.16) a saved preset: the Builder's initial values. */
function draftInit(query: URLSearchParams, me: string | undefined) {
  const presetId = query.get("preset");
  const preset = presetId ? getLocal().presets[presetId] : null;
  const ref = query.get("draft");
  if ((!ref && !preset) || !me) return null;
  let d: TermsDraft;
  let counter: { thread: string; peer: string; version: number; hash: string; from: string } | null = null;
  if (preset) d = preset.draft;
  else {
    const [thread, hash] = ref!.split(":");
    const t = getLocal().threads[thread];
    const m = t?.messages.find((x) => x.body.kind === "proposal" && x.body.ref === hash);
    const p = m && proposalOf(m, thread);
    if (!p || !t) return null;
    d = p.draft;
    counter = { thread, peer: t.peer, version: d.version, hash: p.hash, from: m.from };
  }
  const tr = d.terms;
  const tpl = (Object.entries(TEMPLATE_ID).find(([, id]) => id === d.blob.t)?.[0] ?? "general") as Template;
  const assetMode: AssetId | "custom" = tr.mint === ASSETS.USDC.mint.toBase58() ? "USDC" : tr.mint === ASSETS.SOL.mint.toBase58() ? "SOL" : "custom";
  const payer = tr.parties[tr.payerIdx];
  const payee = tr.parties[tr.payeeIdx];
  const partiesRecovery = tr.recoverySigners.length === 2 && tr.recoverySigners.includes(payer) && tr.recoverySigners.includes(payee);
  const pv = d.blob.p as Record<string, any>;
  return {
    counter,
    tpl,
    subject: d.blob.s,
    condition: String(pv.condition ?? "used-good"),
    inspectDays: Number(pv.inspection_days ?? 2),
    revisions: Number(pv.revisions ?? 2),
    ipTransfer: pv.ip_transfer_on_final_payment !== false,
    purpose: String(pv.purpose ?? "booking"),
    notResidential: pv.not_residential_security_deposit === true,
    year: pv.year ? String(pv.year) : "",
    makeModel: String(pv.make_model ?? ""),
    mileage: String(pv.mileage_band ?? "50k-100k"),
    titleStatus: String(pv.title_status ?? "clean"),
    incoterm: String(pv.incoterm ?? "FOB"),
    origin: String(pv.origin ?? ""),
    destination: String(pv.destination ?? ""),
    documents: Array.isArray(pv.documents) ? pv.documents.join(", ") : "Commercial invoice, Packing list, Bill of lading",
    parties: tr.parties.map((address) => ({ address, label: "" })),
    payerIdx: tr.payerIdx,
    payeeIdx: tr.payeeIdx,
    threshold: tr.approvalThreshold,
    assetMode,
    customMint: assetMode === "custom" ? tr.mint : "",
    parts: tr.parts.map((x) => ({ label: x.label, amount: uiAmount(BigInt(x.amount), tr.decimals) })),
    rule: tr.rule,
    timerMode: tr.timerMode,
    windowDays: String(Math.floor(tr.timeoutSecs / 86400)),
    windowHours: String(Math.floor((tr.timeoutSecs % 86400) / 3600)),
    splitPct: String(tr.splitBps / 100),
    decider: tr.tieBreaker ?? "",
    disputePolicy: tr.disputePolicy,
    disputeDays: String(Math.floor(tr.disputeWindowSecs / 86400) || 14),
    consentTD: tr.consentTrueDeadlock,
    recoveryMode: (partiesRecovery ? "parties" : "custom") as "parties" | "custom",
    recovery: partiesRecovery ? ["", ""] : tr.recoverySigners,
    recoveryThreshold: tr.recoveryThreshold,
    noticeDays: String(Math.floor(tr.recoveryDelaySecs / 86400)),
    accepted: tr.acceptedRiskFlags,
    priceRiskTerm: String(tr.priceRiskTerm),
    details: d.attachment ? detailsFromAttachment(d.attachment) : "",
  };
}

export default function Builder({ query }: { query: URLSearchParams }) {
  const { publicKey } = useAllowedWallet();
  const { signMessage } = useWallet();
  const { connection } = useConnection();
  const send = useAgreementSend();
  const { refresh } = useData();
  const local = useLocal((d) => d);
  const [init] = useState(() => draftInit(query, publicKey?.toBase58()));

  const [step, setStep] = useState(0);
  const [showText, setShowText] = useState(false);
  const [reviewView, setReviewView] = useState<"summary" | "text">("summary");
  /** Steps the user tried to leave: their problems are shown only after that first attempt. */
  const [tried, setTried] = useState<boolean[]>(STEPS.map(() => false));
  // §1
  // v0.10 #4: Protected categories that need another template or rule arrive here pre-filled.
  const qTpl = query.get("tpl") as Template | null;
  const qRule = query.get("rule") as RuleName | null;
  const [tpl, setTpl] = useState<Template>(init?.tpl ?? (qTpl && qTpl in TEMPLATE_ID ? qTpl : "general"));
  const [subject, setSubject] = useState(init?.subject ?? query.get("for") ?? "");
  const [condition, setCondition] = useState(init?.condition ?? "used-good");
  const [inspectDays, setInspectDays] = useState(init?.inspectDays ?? 2);
  const [revisions, setRevisions] = useState(init?.revisions ?? 2);
  const [ipTransfer, setIpTransfer] = useState(init?.ipTransfer ?? true);
  const [purpose, setPurpose] = useState(init?.purpose ?? "booking");
  const [notResidential, setNotResidential] = useState(init?.notResidential ?? false);
  const [year, setYear] = useState(init?.year ?? "");
  const [makeModel, setMakeModel] = useState(init?.makeModel ?? "");
  const [mileage, setMileage] = useState(init?.mileage ?? "50k-100k");
  const [titleStatus, setTitleStatus] = useState(init?.titleStatus ?? "clean");
  const [incoterm, setIncoterm] = useState<string>(init?.incoterm ?? "FOB");
  const [origin, setOrigin] = useState(init?.origin ?? "");
  const [destination, setDestination] = useState(init?.destination ?? "");
  const [documents, setDocuments] = useState(init?.documents ?? "Commercial invoice, Packing list, Bill of lading");
  // §2
  const [parties, setParties] = useState<PartyRow[]>(
    init?.parties ?? [
      { address: publicKey?.toBase58() ?? "", label: "" },
      { address: query.get("to") ?? "", label: "" },
    ],
  );
  const [payerIdx, setPayerIdx] = useState(init?.payerIdx ?? 0);
  const [payeeIdx, setPayeeIdx] = useState(init?.payeeIdx ?? 1);
  const [threshold, setThreshold] = useState(init?.threshold ?? 2);
  // §3–4
  const [assetMode, setAssetMode] = useState<AssetId | "custom">(init?.assetMode ?? ((query.get("asset") as AssetId) === "SOL" ? "SOL" : "USDC"));
  const [customMint, setCustomMint] = useState(init?.customMint ?? "");
  const [vetting, setVetting] = useState<{ mint: string; result: MintVetting | null; error: string | null; loading: boolean }>({ mint: "", result: null, error: null, loading: false });
  const [parts, setParts] = useState<Part[]>(
    init?.parts ?? (query.get("parts") === "2" ? [{ label: "First part", amount: query.get("amount") ?? "" }, { label: "Final part", amount: "" }] : [{ label: "", amount: query.get("amount") ?? "" }]),
  );
  // §5
  const [rule, setRule] = useState<RuleName>(init?.rule ?? (qRule && RULES.includes(qRule) ? qRule : "TimeoutRelease"));
  const [timerMode, setTimerMode] = useState<TimerModeName>(init?.timerMode ?? (qRule && DISPUTE_CLOCK_ONLY.includes(qRule) ? "FromDeadlock" : "FromActivation"));
  const [windowDays, setWindowDays] = useState(init?.windowDays ?? (/^\d{1,4}$/.test(query.get("days") ?? "") ? query.get("days")! : "10"));
  const [windowHours, setWindowHours] = useState(init?.windowHours ?? "0");
  const [splitPct, setSplitPct] = useState(init?.splitPct ?? "50");
  const [decider, setDecider] = useState(init?.decider ?? "");
  const [disputePolicy, setDisputePolicy] = useState<DisputePolicyName>(init?.disputePolicy ?? "NeverExpire");
  const [disputeDays, setDisputeDays] = useState(init?.disputeDays ?? "14");
  const [consentTD, setConsentTD] = useState(init?.consentTD ?? false);
  // §6
  const [recoveryMode, setRecoveryMode] = useState<"parties" | "custom">(init?.recoveryMode ?? "parties");
  const [recovery, setRecovery] = useState<string[]>(init?.recovery ?? ["", ""]);
  const [recoveryThreshold, setRecoveryThreshold] = useState(init?.recoveryThreshold ?? 2);
  const [noticeDays, setNoticeDays] = useState(init?.noticeDays ?? "3");
  // §7
  const [accepted, setAccepted] = useState<number>(init?.accepted ?? 0);
  const [priceRiskTerm, setPriceRiskTerm] = useState(init?.priceRiskTerm ?? "0");
  // §8
  const [details, setDetails] = useState(init?.details ?? "");
  const [saved, setSaved] = useState(false);
  const [attachment, setAttachment] = useState<{ text: string; hash: string } | null>(null);
  // create
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ url: string; deal: string } | null>(null);
  const [nonce] = useState(newNonce);
  const [dealId] = useState(() => F.newDealId(Date.now()));

  // ------------------------------------------------------------ custom mint vetting
  useEffect(() => {
    if (assetMode !== "custom") return;
    const key = parseAddress(customMint);
    if (!key) {
      setVetting({ mint: customMint, result: null, error: customMint.trim() ? "That isn't a valid address." : null, loading: false });
      return;
    }
    let live = true;
    setVetting({ mint: customMint, result: null, error: null, loading: true });
    vetMint(connection, key)
      .then((r) => live && setVetting({ mint: customMint, result: r, error: r ? null : "No token mint at that address on devnet.", loading: false }))
      .catch((e) => live && setVetting({ mint: customMint, result: null, error: explainError(e), loading: false }));
    return () => {
      live = false;
    };
  }, [assetMode, customMint, connection]);

  // ------------------------------------------------------------ derived terms
  const asset: Asset | null = assetMode === "custom" ? null : (ASSETS[assetMode] ?? null);
  const mint = asset ? asset.mint : (vetting.result?.mint ?? PublicKey.default);
  const tokenProgram = asset ? TOKEN_PROGRAM : (vetting.result?.tokenProgram ?? TOKEN_PROGRAM);
  const decimals = asset ? asset.decimals : (vetting.result?.decimals ?? 6);
  const detected = asset ? asset.knownRiskFlags : (vetting.result?.flags ?? 0);
  // Allowlisted assets: their known risks are pre-accepted (as Protected does); a custom mint starts at nothing accepted.
  const acceptedFlags = asset ? asset.knownRiskFlags | accepted : accepted;

  const partyKeys = parties.map((p) => parseAddress(p.address));
  const partyList = partyKeys.filter((k): k is PublicKey => !!k);
  const payerKey = partyKeys[payerIdx] ?? null;
  const payeeKey = partyKeys[payeeIdx] ?? null;
  const recoveryKeys = (recoveryMode === "parties" ? [parties[payerIdx]?.address ?? "", parties[payeeIdx]?.address ?? ""] : recovery).map(parseAddress);
  const recoveryList = recoveryKeys.filter((k): k is PublicKey => !!k);
  const amounts = parts.map((p) => parseAmount(p.amount, decimals));
  const total = amounts.reduce<bigint>((a, b) => a + (b ?? 0n), 0n);
  const timeoutSecs = (Math.floor(Number(windowDays)) || 0) * 86400 + (Math.floor(Number(windowHours)) || 0) * 3600;
  const splitBps = Math.round((Number(splitPct) || 0) * 100);

  const terms: CustomTerms | null = publicKey
    ? {
        creator: publicKey,
        dealId,
        parties: partyList,
        payerIdx: partyKeys.every(Boolean) ? payerIdx : -1,
        payeeIdx: partyKeys.every(Boolean) ? payeeIdx : -1,
        approvalThreshold: threshold,
        mint,
        tokenProgram,
        decimals,
        parts: parts.map((p, i) => ({ label: p.label, amount: amounts[i] ?? 0n })),
        rule,
        timerMode: DISPUTE_CLOCK_ONLY.includes(rule) ? "FromDeadlock" : timerMode,
        timeoutSecs,
        splitBps,
        tieBreaker: parseAddress(decider),
        disputePolicy: timerMode === "FromActivation" && !DISPUTE_CLOCK_ONLY.includes(rule) ? disputePolicy : "NeverExpire",
        disputeWindowSecs: (Math.floor(Number(disputeDays)) || 0) * 86400,
        consentTrueDeadlock: consentTD,
        recoverySigners: recoveryList,
        recoveryThreshold,
        recoveryDelaySecs: (Math.floor(Number(noticeDays)) || 0) * 86400,
        detectedRiskFlags: detected,
        acceptedRiskFlags: acceptedFlags,
        priceRiskTerm: Math.floor(Number(priceRiskTerm)) || 0,
      }
    : null;

  // Client-side gates the program can't see (addresses still being typed, subject, template fields, attachment).
  const clientIssues: Issue[] = [];
  if (!subject.trim()) clientIssues.push({ section: 1, text: "Give the agreement a one-line subject." });
  if (tpl === "deposit" && !notResidential) clientIssues.push({ section: 1, text: "Confirm this is not a residential security deposit." });
  if (tpl === "vehicle" && !(/^(19|20)\d\d$/.test(year) && makeModel.trim().length > 1)) clientIssues.push({ section: 1, text: "Year and make/model are needed." });
  const documentList = documents.split(",").map((s) => s.trim()).filter(Boolean);
  if (tpl === "trade" && !(origin.trim() && destination.trim() && documentList.length >= 1 && documentList.length <= 8 && documentList.every((d) => d.length <= 40)))
    clientIssues.push({ section: 1, text: "Origin, destination and 1 to 8 document names (40 characters each) are needed." });
  if (partyKeys.some((k) => !k)) clientIssues.push({ section: 2, text: "Every party needs a valid wallet address." });
  if (assetMode === "custom" && !vetting.result) clientIssues.push({ section: 3, text: vetting.error ?? "Enter a token mint and wait for its check." });
  if (assetMode === "custom" && vetting.result?.rejected) clientIssues.push({ section: 3, text: vetting.result.rejected });
  if (amounts.some((a) => a == null)) clientIssues.push({ section: 4, text: "Every part needs an amount." });
  if (rule === "TieBreaker" && decider && !parseAddress(decider)) clientIssues.push({ section: 5, text: "The decider's address isn't valid." });
  if (recoveryMode === "custom" && recovery.some((r) => !parseAddress(r))) clientIssues.push({ section: 6, text: "Every recovery signer needs a valid wallet address." });
  if (details.trim() && !saved) clientIssues.push({ section: 8, text: "Download the private details before signing (they're not on-chain; you keep the copy)." });

  const programIssues: Issue[] = terms ? customProblems(terms).map((p) => ({ section: p.section, text: p.text })) : [];
  const issues = [...clientIssues, ...programIssues];
  const issuesFor = (i: number) => issues.filter((x) => STEPS[i].sections.includes(x.section));

  // ------------------------------------------------------------ the text
  const labels = parts.map((p) => p.label);
  const params: LinkBlob["p"] =
    tpl === "goods"
      ? { condition, inspection_days: inspectDays, milestones: labels }
      : tpl === "freelance"
        ? { revisions, ip_transfer_on_final_payment: ipTransfer, milestones: labels }
        : tpl === "deposit"
          ? { purpose, not_residential_security_deposit: true, milestones: labels }
          : tpl === "trade"
            ? { incoterm, origin, destination, documents: documentList, inspection_days: inspectDays, milestones: labels }
            : tpl === "vehicle"
              ? { year: Number(year) || 0, make_model: makeModel, mileage_band: mileage, title_status: titleStatus, inspection_days: inspectDays, milestones: labels }
              : { milestones: labels };
  const blob: LinkBlob = { t: TEMPLATE_ID[tpl], p: params, s: subject, n: nonce, ...(attachment ? { a: attachment.hash } : {}) };
  const deal = publicKey ? F.dealAddress(publicKey, dealId) : null;
  const text = useMemo(() => {
    if (!terms || issues.length) return "";
    try {
      return renderAgreement(customFields(terms), blob);
    } catch {
      return "";
    }
  }, [JSON.stringify(blob), terms && JSON.stringify({ ...terms, creator: terms.creator.toBase58(), parties: terms.parties.map(String), mint: String(terms.mint), recoverySigners: terms.recoverySigners.map(String), tieBreaker: String(terms.tieBreaker ?? ""), dealId: String(terms.dealId), parts: terms.parts.map((p) => [p.label, String(p.amount)]) }), issues.length]);
  // Preview even while a step is incomplete: the parts of the text that can already be rendered.
  const preview = useMemo(() => {
    if (!terms) return "";
    try {
      return renderAgreement(customFields({ ...terms, parties: terms.parties.length >= 2 ? terms.parties : [terms.creator, PublicKey.default], payerIdx: Math.max(0, terms.payerIdx), payeeIdx: Math.max(1, terms.payeeIdx), parts: terms.parts.length ? terms.parts.map((p) => ({ ...p, amount: p.amount > 0n ? p.amount : 1n })) : [{ label: "", amount: 1n }], recoverySigners: terms.recoverySigners.length ? terms.recoverySigners : [terms.creator], tieBreaker: terms.tieBreaker ?? PublicKey.default, timeoutSecs: terms.timeoutSecs || 1 }), { ...blob, s: subject || "(subject)" });
    } catch {
      return "";
    }
  }, [text, JSON.stringify(blob), step]);
  const clauses = clauseIndex(preview);
  const clockFromStart = !DISPUTE_CLOCK_ONLY.includes(rule) && timerMode === "FromActivation";
  const policyLine = COPY.disputeLimit(clockFromStart ? disputePolicy : "NeverExpire", `${Math.floor(Number(disputeDays)) || 0} day${(Math.floor(Number(disputeDays)) || 0) === 1 ? "" : "s"}`, "the payer", "the recipient", rule === "AutoSplit" ? Number(splitPct) || 0 : 50);
  const w = (s: ClauseNo): string[] => {
    if (!terms) return [];
    try {
      return writes(s, terms, (raw) => money(raw, asset, decimals));
    } catch {
      return [];
    }
  };
  const summaryFor = (i: number): string => {
    switch (i) {
      case 0:
        return `${TEMPLATE_LABEL[tpl]} · ${subject.trim() || "no subject yet"}`;
      case 1:
        return `${parties.length} parties · ${threshold} of ${parties.length} approve each part`;
      case 2:
        return `${money(total, asset, decimals)} in ${parts.length} part${parts.length === 1 ? "" : "s"}`;
      case 3:
        return `${RULE_CHOICES.find((r) => r.id === rule)!.title}${TIMED_RULES.includes(rule) ? ` · ${windowDays} d ${windowHours} h` : ""}${clockFromStart && disputePolicy !== "NeverExpire" ? ` · pause limit ${disputeDays} d` : ""}`;
      case 4:
        return `${terms?.recoveryThreshold ?? 0} of ${terms?.recoverySigners.length ?? 0} signers · ${noticeDays} days' notice`;
      case 5:
        return detected ? `${RISK_NAMES.filter(([b]) => detected & b).length} token risk(s), ${RISK_NAMES.filter(([b]) => acceptedFlags & b & detected).length} accepted` : "No token risks";
      case 6:
        return details.trim() ? (saved ? "Private details attached" : "Private details not saved yet") : "No private details";
      default:
        return "";
    }
  };

  if (!publicKey) return null;

  const create = async () => {
    if (!terms || !deal || !text) return;
    setBusy(true);
    setError("");
    try {
      const s = { ...customSpec(terms), termsHash: termsHash(text) };
      await send(await F.createAndSign(s, rule === "TrueDeadlock" && consentTD));
      const k = encodeBlob(blob);
      updateLocal((d) => {
        d.links[deal.toBase58()] = k;
        if (attachment) d.attachments[deal.toBase58()] = attachment.text;
      });
      refresh();
      setResult({ url: appUrl(`/deal/${deal.toBase58()}?k=${k}`), deal: deal.toBase58() });
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  // v0.14: send the terms to the other party in chat instead of creating now (one wallet signature: the proposal).
  const owner = publicKey.toBase58();
  const chatPeer = partyList.length === 2 ? partyList.find((k) => !k.equals(publicKey))?.toBase58() ?? null : null;
  const canPropose = serviceOn && !!chatPeer && messagingOn(owner) && !!text && issues.length === 0;
  const propose = async () => {
    if (!terms || !text || !chatPeer || !signMessage) return;
    setBusy(true);
    setError("");
    try {
      if (!messagingUnlocked(owner)) await unlockMessaging(owner, signMessage);
      const prior = init?.counter && init.counter.peer === chatPeer ? init.counter : null;
      const draft = fromCustomTerms(terms, blob, (prior?.version ?? 0) + 1, prior?.hash, attachment?.text);
      await proposeTerms(owner, chatPeer, draft, signMessage);
      go(`/chat/${chatPeer}`);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const other = payeeKey && payerKey ? (payerKey.equals(publicKey) ? payeeKey : payerKey) : null;
    return (
      <>
        <NavBar title="Agreement created" right={<button className="navbtn" onClick={() => go(`/deal/${result.deal}`)}>Open</button>} />
        <div className="hero">
          <div style={{ width: 44, margin: "0 auto", color: "var(--custom)" }}>{Icon.doc}</div>
          <div className="amt">{money(total, asset, decimals)}</div>
          <div className="sub">Signed by you. Send the link so {other ? nameFor(other, local) : "the other parties"} can read and sign it.</div>
        </div>
        <ShareSheet inline url={result.url} text={`Agreement: ${subject.trim()}`} />
      </>
    );
  }

  const Writes = ({ s }: { s: ClauseNo }) => {
    const lines = w(s);
    return lines.length ? (
      <div className="caption" style={{ padding: "6px 16px 0", lineHeight: "16px" }}>
        <b>Writes:</b> {lines.join(" ")}
      </div>
    ) : null;
  };
  const Issues = ({ i }: { i: number }) => {
    const xs = issuesFor(i);
    return tried[i] && xs.length ? <div className="banner warn">{xs.map((x) => x.text).join(" ")}</div> : null;
  };
  const next = () => {
    if (issuesFor(step).length) return setTried(tried.map((x, i) => (i === step ? true : x)));
    setStep(step + 1);
  };
  const roleOf = (i: number) => (i === payerIdx ? "Payer" : i === payeeIdx ? "Recipient" : "Party");
  const textarea = (v: string, set: (s: string) => void, placeholder: string) => <input value={v} onChange={(e) => set(e.target.value)} placeholder={placeholder} />;

  return (
    <>
      <NavBar
        title="Agreement"
        left={
          <button className="navbtn" onClick={() => (step === 0 ? go("/") : setStep(step - 1))}>
            {step === 0 ? "Cancel" : "Back"}
          </button>
        }
        right={
          <button className="navbtn" onClick={() => setShowText(true)} aria-label="Show the agreement so far">
            Agreement · {step + 1}/{STEPS.length}
          </button>
        }
      />

      <ProgressStrip step={step} total={STEPS.length} />
      <div className="largetitle" style={{ fontSize: 26, lineHeight: "32px", paddingTop: 6 }}>{STEPS[step].title}</div>
      {step > 0 && step < STEPS.length - 1 && (
        <Section header="So far">
          {STEPS.slice(0, step).map((s, i) => (
            <Cell key={s.title} title={s.title} subtitle={summaryFor(i)} onClick={() => setStep(i)} chevron />
          ))}
        </Section>
      )}

      {/* ------------------------------------------------------------ §1 */}
      {step === 0 && (
        <>
          <div className="banner" style={{ margin: "8px 16px 0" }}>
            Eight short steps, one per section of the agreement you'll both sign: who, how much, what happens if there's a problem, who can step in, which token risks you accept. Each step tells you the sentence it writes; tap <b>Agreement</b> at any time to read the text so far.
          </div>
          {Object.keys(local.presets).length > 0 && !init && (
            <Section header="Start from a saved preset" footer="Presets live only on this device. Parties, amounts and rules load as saved; change anything before you sign.">
              {Object.entries(local.presets)
                .sort(([, a], [, b]) => b.at - a.at)
                .map(([id, p]) => (
                  <Cell key={id} title={p.name} subtitle={`${p.draft.blob.s} · saved ${new Date(p.at * 1000).toLocaleDateString()}`} wrap onClick={() => go(`/new-agreement?preset=${id}`)} chevron />
                ))}
            </Section>
          )}
          <Section header="§1 · What is this agreement for?" footer="The template adds its own sentences to section 8 of the text; everything else is the same contract.">
            <Cell title="General" subtitle="Any agreement: the subject, your private details and the rules below are the whole contract" wrap before={<span style={{ width: 24, color: "var(--custom)" }}>{Icon.doc}</span>} after={tpl === "general" ? <span>✓</span> : null} onClick={() => setTpl("general")} />
            <Cell title="Goods sale" subtitle="Selling or buying an item" before={<span style={{ width: 24, color: "var(--protected)" }}>{Icon.box}</span>} after={tpl === "goods" ? <span>✓</span> : null} onClick={() => setTpl("goods")} />
            <Cell title="Freelance work" subtitle="Work paid in parts as each part is delivered" before={<span style={{ width: 24, color: "var(--protected)" }}>{Icon.work}</span>} after={tpl === "freelance" ? <span>✓</span> : null} onClick={() => (setTpl("freelance"), parts.length === 1 && setParts([{ label: "First part", amount: parts[0].amount }, { label: "Final part", amount: "" }]))} />
            <Cell title="Deposit / reservation" subtitle="A booking or custom-order deposit (not residential security deposits)" wrap before={<span style={{ width: 24, color: "var(--paused)" }}>{Icon.bookmark}</span>} after={tpl === "deposit" ? <span>✓</span> : null} onClick={() => (setTpl("deposit"), setRule("TimeoutRefund"))} />
            <Cell title="Private vehicle sale" subtitle="Car, bike or boat between two people — payment only; title transfer is separate" wrap before={<span style={{ width: 24, color: "var(--instant)" }}>{Icon.car}</span>} after={tpl === "vehicle" ? <span>✓</span> : null} onClick={() => (setTpl("vehicle"), setWindowDays("14"))} />
            <Cell
              title="Cross-border trade"
              subtitle="Goods shipped between businesses — paid in stages against documents; an examiner you all name can decide"
              wrap
              before={<span style={{ width: 24, color: "var(--link)" }}>{Icon.ship}</span>}
              after={tpl === "trade" ? <span>✓</span> : null}
              onClick={() => (
                setTpl("trade"),
                setWindowDays("30"),
                setInspectDays(5),
                parts.length === 1 && !parts[0].label && setParts([{ label: "Deposit at order", amount: "" }, { label: "Documents presented", amount: "" }, { label: "Goods received and inspected", amount: parts[0].amount }])
              )}
            />
          </Section>
          <Section header="Subject" footer="One line, shared publicly in the link. Keep names, addresses and serial numbers out of it — put them in the private details (§8).">
            <div className="field">
              <input value={subject} maxLength={90} onChange={(e) => setSubject(e.target.value)} placeholder={{ general: "e.g. Consulting retainer, March", goods: "e.g. Used road bike, 56 cm frame", freelance: "e.g. Logo and brand kit", deposit: "e.g. Deposit for wedding photography, June 12", vehicle: "e.g. 2015 Honda Civic, silver", trade: "e.g. 1,200 oak desks, PO 4471" }[tpl]} />
            </div>
          </Section>
          {tpl === "goods" && (
            <Section header="Item">
              <div className="field">
                <label>Condition</label>
                <select value={condition} onChange={(e) => setCondition(e.target.value)}>
                  <option value="new">New</option>
                  <option value="like-new">Like new</option>
                  <option value="used-good">Used — good</option>
                  <option value="used-fair">Used — fair</option>
                  <option value="for-parts">For parts</option>
                </select>
              </div>
              <div className="field">
                <label>Inspect</label>
                <select value={inspectDays} onChange={(e) => setInspectDays(Number(e.target.value))}>
                  {[2, 3, 5, 7].map((d) => (
                    <option key={d} value={d}>{d} days after it arrives</option>
                  ))}
                </select>
              </div>
            </Section>
          )}
          {tpl === "deposit" && (
            <Section header="Deposit" footer="Residential security deposits have their own legal rules (for example, Michigan requires a regulated bank or a bond). Don't use this for them.">
              <div className="field">
                <label>Purpose</label>
                <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                  <option value="booking">Booking a service or date</option>
                  <option value="custom-order">Custom order</option>
                  <option value="event">Event or venue</option>
                  <option value="rental-equipment">Equipment rental</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <Cell title="This is not a residential security deposit" after={<input type="checkbox" checked={notResidential} onChange={(e) => setNotResidential(e.target.checked)} />} />
            </Section>
          )}
          {tpl === "vehicle" && (
            <Section header="Vehicle" footer="Put the VIN, plate and odometer reading in the private details (§8) — never in the public subject.">
              <div className="field">
                <label>Year</label>
                <input inputMode="numeric" value={year} maxLength={4} onChange={(e) => setYear(e.target.value.replace(/\D/g, ""))} placeholder="2015" />
              </div>
              <div className="field">
                <label>Make</label>
                <input value={makeModel} maxLength={40} onChange={(e) => setMakeModel(e.target.value)} placeholder="Make and model" />
              </div>
              <div className="field">
                <label>Mileage</label>
                <select value={mileage} onChange={(e) => setMileage(e.target.value)}>
                  {["under-25k", "25k-50k", "50k-100k", "100k-150k", "over-150k"].map((m) => (
                    <option key={m} value={m}>{m.replace("k", ",000").replace("-", " – ").replace("under", "under ").replace("over", "over ")} miles</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Title</label>
                <select value={titleStatus} onChange={(e) => setTitleStatus(e.target.value)}>
                  <option value="clean">Clean</option>
                  <option value="lien">Has a lien</option>
                  <option value="salvage">Salvage</option>
                  <option value="rebuilt">Rebuilt</option>
                </select>
              </div>
              <div className="field">
                <label>Inspect</label>
                <select value={inspectDays} onChange={(e) => setInspectDays(Number(e.target.value))}>
                  {[1, 2, 3, 7].map((d) => (
                    <option key={d} value={d}>{d} day{d > 1 ? "s" : ""} after handover</option>
                  ))}
                </select>
              </div>
            </Section>
          )}
          {tpl === "trade" && (
            <Section header="Shipment" footer="These go into the agreement text. Put part numbers, HS codes and contract references in the private details (§8).">
              <div className="field">
                <label>Incoterm</label>
                <select value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
                  {INCOTERMS.map((c) => (
                    <option key={c} value={c}>{c} — {INCOTERM_NAMES[c]}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>From</label>
                {textarea(origin, setOrigin, "Port or place of shipment")}
              </div>
              <div className="field">
                <label>To</label>
                {textarea(destination, setDestination, "Port or place of delivery")}
              </div>
              <div className="field">
                <label>Documents</label>
                {textarea(documents, setDocuments, "Comma-separated, up to 8")}
              </div>
              <div className="field">
                <label>Inspect</label>
                <select value={inspectDays} onChange={(e) => setInspectDays(Number(e.target.value))}>
                  {[3, 5, 7, 10, 14].map((d) => (
                    <option key={d} value={d}>{d} days after arrival</option>
                  ))}
                </select>
              </div>
            </Section>
          )}
          {tpl === "freelance" && (
            <Section header="Work">
              <div className="field">
                <label>Revisions</label>
                <select value={revisions} onChange={(e) => setRevisions(Number(e.target.value))}>
                  {[0, 1, 2, 3, 5].map((d) => (
                    <option key={d} value={d}>{d} per part</option>
                  ))}
                </select>
              </div>
              <Cell title="Rights pass to the payer on final payment" after={<input type="checkbox" checked={ipTransfer} onChange={(e) => setIpTransfer(e.target.checked)} />} />
            </Section>
          )}
          <Issues i={0} />
        </>
      )}

      {/* ------------------------------------------------------------ §2 */}
      {step === 1 && (
        <>
          <Section header={`§2 · Parties (${parties.length} of ${LIMITS.MAX_PARTIES})`} footer="Every party signs the same text. One pays, one is paid; any others are co-signers whose approvals count toward each part.">
            {parties.map((p, i) => {
              const k = partyKeys[i];
              return (
                <div key={i} className="stack" style={{ padding: "8px 16px", gap: 6 }}>
                  <div className="field" style={{ padding: 0 }}>
                    <label>{i === 0 ? "You" : `Party ${i + 1}`}</label>
                    <input value={p.address} disabled={i === 0} onChange={(e) => setParties(parties.map((x, j) => (j === i ? { ...x, address: e.target.value.trim() } : x)))} placeholder="Wallet address" spellCheck={false} style={mono} />
                    {i > 0 && parties.length > 2 && (
                      <button
                        className="navbtn"
                        style={{ color: "var(--destructive)" }}
                        aria-label="Remove party"
                        onClick={() => {
                          const next = parties.filter((_, j) => j !== i);
                          setParties(next);
                          const fix = (idx: number) => (idx === i ? 0 : idx > i ? idx - 1 : idx);
                          setPayerIdx(fix(payerIdx));
                          setPayeeIdx(fix(payeeIdx));
                          setThreshold(Math.min(threshold, next.length));
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {k && <Cell avatar before={<Avatar address={k.toBase58()} name={nameFor(k, local)} />} title={nameFor(k, local)} subtitle={short(k.toBase58())} />}
                  <div className="chips" style={{ margin: 0 }}>
                    <button className="chip" aria-pressed={payerIdx === i} onClick={() => (setPayerIdx(i), payeeIdx === i && setPayeeIdx(payerIdx))}>Pays</button>
                    <button className="chip" aria-pressed={payeeIdx === i} onClick={() => (setPayeeIdx(i), payerIdx === i && setPayerIdx(payeeIdx))}>Is paid</button>
                    {payerIdx !== i && payeeIdx !== i && <span className="caption">co-signer</span>}
                  </div>
                </div>
              );
            })}
            {parties.length < LIMITS.MAX_PARTIES && <Cell title="Add a party" link onClick={() => setParties([...parties, { address: "", label: "" }])} />}
            {Object.values(local.contacts).slice(0, 5).map((c) => (
              <Cell key={c.address} title={c.name} subtitle={short(c.address)} link onClick={() => setParties(parties.map((x, j) => (j === parties.findIndex((y, idx) => idx > 0 && !y.address) ? { ...x, address: c.address } : x)))} />
            ))}
          </Section>
          <Section header="Approvals" footer="Section 4 of the text: how many parties must approve a part before it is released.">
            <div className="field">
              <label>Needed</label>
              <select value={threshold} onChange={(e) => setThreshold(Number(e.target.value))}>
                {Array.from({ length: parties.length }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>{n} of {parties.length} parties</option>
                ))}
              </select>
            </div>
            <Writes s={2} />
          </Section>
          <Issues i={1} />
        </>
      )}

      {/* ------------------------------------------------------------ §3–4 */}
      {step === 2 && (
        <>
          <Section header="§3 · Paid in" footer={asset ? (asset.riskNote ? `${asset.riskNote} (accepted in §7.)` : undefined) : "Any SPL or Token-2022 mint on devnet. It is checked the way the program checks it; risks it carries are accepted in §7."}>
            <div className="field">
              <div className="chips" style={{ margin: 0 }}>
                {ASSET_IDS.map((a) => (
                  <button key={a} className="chip" aria-pressed={assetMode === a} onClick={() => (setAssetMode(a), setAccepted(0))}>{a}</button>
                ))}
                <button className="chip" aria-pressed={assetMode === "custom"} onClick={() => (setAssetMode("custom"), setAccepted(0))}>Other token</button>
              </div>
            </div>
            {assetMode === "custom" && (
              <div className="field">
                <label>Mint</label>
                <input value={customMint} onChange={(e) => setCustomMint(e.target.value.trim())} placeholder="Token mint address" spellCheck={false} style={mono} />
                {vetting.loading && <span className="spinner" />}
              </div>
            )}
            {assetMode === "custom" && vetting.result && (
              <Cell title={vetting.result.rejected ? "Refused by the program" : `${vetting.result.decimals} decimals · ${vetting.result.tokenProgram.equals(TOKEN_PROGRAM) ? "SPL Token" : "Token-2022"}`} subtitle={vetting.result.rejected ?? (vetting.result.flags ? "Carries risks — see §7" : "No risks detected")} wrap />
            )}
          </Section>
          <Section header={`§4 · Parts (${parts.length} of ${LIMITS.MAX_MILESTONES})`} footer={`Total ${money(total, asset, decimals)}. Released in this order, each part when ${threshold} of ${parties.length} parties approve it.`}>
            {parts.map((p, i) => (
              <div key={i} className="field">
                <label>{parts.length === 1 ? "Amount" : `Part ${i + 1}`}</label>
                {parts.length > 1 && <input style={{ flex: 2 }} value={p.label} maxLength={40} placeholder="Label (goes in the text)" onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />}
                <input style={{ flex: 1, textAlign: "right" }} inputMode="decimal" value={p.amount} placeholder={asset?.dollar ? "$0.00" : "0"} onChange={(e) => setParts(parts.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
                {parts.length > 1 && (
                  <button className="navbtn" style={{ color: "var(--destructive)" }} onClick={() => setParts(parts.filter((_, j) => j !== i))} aria-label="Remove part">
                    ✕
                  </button>
                )}
              </div>
            ))}
            {parts.length < LIMITS.MAX_MILESTONES && <Cell title="Add a part" link onClick={() => setParts([...parts, { label: "", amount: "" }])} />}
            <Writes s={4} />
          </Section>
          <Issues i={2} />
        </>
      )}

      {/* ------------------------------------------------------------ §5 */}
      {step === 3 && (
        <>
          <Section header="§5 · Rule" footer="Fixed when the agreement is created; every party signs it. The parties can always settle by all signing the same split.">
            {RULE_CHOICES.map((r) => (
              <Cell key={r.id} title={r.title} subtitle={r.subtitle} wrap after={rule === r.id ? <span>✓</span> : null} onClick={() => (setRule(r.id), DISPUTE_CLOCK_ONLY.includes(r.id) && setTimerMode("FromDeadlock"))} />
            ))}
          </Section>
          {rule === "AutoSplit" && (
            <Section header="Split" footer="Share that goes to the recipient at the end of the window (two decimals).">
              <div className="field">
                <input inputMode="decimal" value={splitPct} onChange={(e) => setSplitPct(e.target.value)} aria-label="Recipient share" />
                <span className="suffix num">% to the recipient</span>
              </div>
            </Section>
          )}
          {rule === "TieBreaker" && (
            <Section header="Who decides?" footer="Not one of the parties. Ask them first — they'll see this agreement and can set any split once a party reports a problem.">
              <div className="field">
                <label>Wallet</label>
                <input value={decider} onChange={(e) => setDecider(e.target.value.trim())} placeholder="Decider's wallet address" spellCheck={false} style={mono} />
              </div>
            </Section>
          )}
          <Section header="Clock" footer={DISPUTE_CLOCK_ONLY.includes(rule) ? "With a named decider, or with no decider and no timer, the clock can only start at a dispute — the program allows nothing else." : undefined}>
            <Cell title="From the start" subtitle="Runs once every party has confirmed ready; a reported problem pauses it." after={!DISPUTE_CLOCK_ONLY.includes(rule) && timerMode === "FromActivation" ? <span>✓</span> : null} onClick={() => !DISPUTE_CLOCK_ONLY.includes(rule) && setTimerMode("FromActivation")} wrap />
            <Cell title="From a dispute" subtitle="Starts only when a party reports a problem." after={DISPUTE_CLOCK_ONLY.includes(rule) || timerMode === "FromDeadlock" ? <span>✓</span> : null} onClick={() => setTimerMode("FromDeadlock")} wrap />
          </Section>
          {TIMED_RULES.includes(rule) && (
            <Section header="Window" footer="Up to 10 years.">
              <div className="field">
                <label>Days</label>
                <input inputMode="numeric" value={windowDays} onChange={(e) => setWindowDays(e.target.value.replace(/\D/g, ""))} />
                <label>Hours</label>
                <input inputMode="numeric" value={windowHours} onChange={(e) => setWindowHours(e.target.value.replace(/\D/g, ""))} style={{ maxWidth: 64 }} />
              </div>
            </Section>
          )}
          {!DISPUTE_CLOCK_ONLY.includes(rule) && timerMode === "FromActivation" && (
            <Section header="If a pause lasts" footer="Part of the signed text; set when the agreement is created and never changed afterwards.">
              {DISPUTE_CHOICES.map((c) => (
                <Cell key={c.id} title={c.title} subtitle={c.subtitle} wrap after={disputePolicy === c.id ? <span>✓</span> : null} onClick={() => setDisputePolicy(c.id)} />
              ))}
              {disputePolicy !== "NeverExpire" && (
                <div className="field">
                  <label htmlFor="dispute-days">Time limit</label>
                  <input id="dispute-days" inputMode="numeric" value={disputeDays} onChange={(e) => setDisputeDays(e.target.value.replace(/\D/g, ""))} aria-describedby="dispute-days-hint" />
                  <span className="suffix" id="dispute-days-hint">days in total (1–365)</span>
                </div>
              )}
            </Section>
          )}
          {rule === "TrueDeadlock" && (
            <label className="banner warn" style={{ display: "flex", gap: 10 }}>
              <input type="checkbox" checked={consentTD} onChange={(e) => setConsentTD(e.target.checked)} />
              <span>{COPY.trueDeadlock} I understand and agree. (Each party ticks this separately when signing.)</span>
            </label>
          )}
          <Section>
            <Writes s={5} />
          </Section>
          <Issues i={3} />
        </>
      )}

      {/* ------------------------------------------------------------ §6 */}
      {step === 4 && (
        <>
          <Section header="§6 · Who can step in" footer="For a lost key, incapacity or a court order. They can only divide the money between the payer and the recipient, never pay anyone else, and only after a public on-chain notice period. Choose carefully: they hold real power.">
            <Cell title="The payer and the recipient" subtitle="Both must sign the same division (2 of 2)." after={recoveryMode === "parties" ? <span>✓</span> : null} onClick={() => (setRecoveryMode("parties"), setRecoveryThreshold(2))} wrap />
            <Cell title="A list I choose" subtitle={`1 to ${LIMITS.MAX_RECOVERY_SIGNERS} wallets, any of them; how many must agree.`} after={recoveryMode === "custom" ? <span>✓</span> : null} onClick={() => (setRecoveryMode("custom"), recovery.every((r) => !r) && setRecovery([parties[payerIdx]?.address ?? "", parties[payeeIdx]?.address ?? ""]))} wrap />
          </Section>
          {recoveryMode === "custom" && (
            <Section header={`Signers (${recovery.length} of ${LIMITS.MAX_RECOVERY_SIGNERS})`}>
              {recovery.map((r, i) => (
                <div key={i} className="field">
                  <label>Signer {i + 1}</label>
                  <input value={r} onChange={(e) => setRecovery(recovery.map((x, j) => (j === i ? e.target.value.trim() : x)))} placeholder="Wallet address" spellCheck={false} style={mono} />
                  {recovery.length > 1 && (
                    <button className="navbtn" style={{ color: "var(--destructive)" }} aria-label="Remove signer" onClick={() => (setRecovery(recovery.filter((_, j) => j !== i)), setRecoveryThreshold(Math.min(recoveryThreshold, recovery.length - 1)))}>
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {recovery.length < LIMITS.MAX_RECOVERY_SIGNERS && <Cell title="Add a signer" link onClick={() => setRecovery([...recovery, ""])} />}
              <div className="field">
                <label>Needed</label>
                <select value={recoveryThreshold} onChange={(e) => setRecoveryThreshold(Number(e.target.value))}>
                  {Array.from({ length: recovery.length }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n} of {recovery.length}</option>
                  ))}
                </select>
              </div>
            </Section>
          )}
          <Section header="Notice" footer="A division they sign stays public on-chain for this long before anyone can carry it out — time for the parties to settle first.">
            <div className="field">
              <label>Days</label>
              <input inputMode="numeric" value={noticeDays} onChange={(e) => setNoticeDays(e.target.value.replace(/\D/g, ""))} />
            </div>
            <Writes s={6} />
          </Section>
          <Issues i={4} />
        </>
      )}

      {/* ------------------------------------------------------------ §7 */}
      {step === 5 && (
        <>
          <Section header="§7 · Risks this token carries" footer={detected ? "The program refuses to create the agreement unless every detected risk is accepted by the parties, on the record." : "Nothing detected: the text will say so."}>
            {RISK_NAMES.filter(([bit]) => detected & bit).map(([bit, name]) => (
              <Cell key={bit} title={name} after={<input type="checkbox" checked={(acceptedFlags & bit) !== 0} disabled={!!asset && (asset.knownRiskFlags & bit) !== 0} onChange={(e) => setAccepted(e.target.checked ? accepted | bit : accepted & ~bit)} />} wrap />
            ))}
            {!detected && <Cell title="No risks detected" subtitle="Freeze, seizure, fees, hooks, interest and closable mints are what the program looks for." wrap />}
          </Section>
          <Section header="Price-risk term" footer="A code from 0 to 255 recorded on the deal; 0 means none. Its meaning is whatever the private details say — the program never interprets it.">
            <div className="field">
              <label>Code</label>
              <input inputMode="numeric" value={priceRiskTerm} onChange={(e) => setPriceRiskTerm(e.target.value.replace(/\D/g, "").slice(0, 3))} style={{ maxWidth: 80 }} />
            </div>
            <Writes s={7} />
          </Section>
          <Issues i={5} />
        </>
      )}

      {/* ------------------------------------------------------------ §8 */}
      {step === 6 && (
        <>
          <Section header="§8 · Private details (optional)" footer="Names, addresses, serial numbers, scope of work, what the price-risk code means. Stays with the parties — never on-chain. Only its fingerprint is part of the agreement.">
            <div className="field">
              <textarea
                value={details}
                onChange={(e) => {
                  setDetails(e.target.value);
                  setAttachment(null);
                  setSaved(false);
                }}
                placeholder="Optional"
              />
            </div>
            {details.trim() && (
              <Cell
                title={saved ? "✓ Saved — download again" : "Download details (required before signing)"}
                link
                onClick={() => {
                  const a = attachment ?? sealAttachment(details);
                  setAttachment(a);
                  download(`latch-details-${a.hash.slice(0, 8)}.txt`, a.text);
                  setSaved(true);
                }}
              />
            )}
          </Section>
          <Issues i={6} />
        </>
      )}

      {/* ------------------------------------------------------------ review */}
      {step === 7 && (
        <>
          <Section header="Check before you sign">
            <KV k="Subject" v={subject.trim()} onChange={() => setStep(0)} />
            <KV k="Parties" v={`${parties.length} · ${payerKey ? nameFor(payerKey, local) : "?"} pays ${payeeKey ? nameFor(payeeKey, local) : "?"} · ${threshold} of ${parties.length} approve each part`} onChange={() => setStep(1)} />
            <KV k="Total" v={`${money(total, asset, decimals)} in ${parts.length} part${parts.length > 1 ? "s" : ""}`} onChange={() => setStep(2)} />
            <KV k="Rule" v={RULE_CHOICES.find((r) => r.id === rule)!.title + (TIMED_RULES.includes(rule) ? ` · ${windowDays} d ${windowHours} h, clock ${terms?.timerMode === "FromActivation" ? "from the start" : "from a dispute"}` : "")} onChange={() => setStep(3)} />
            {clockFromStart && <KV k="If a pause lasts" v={policyLine} onChange={() => setStep(3)} />}
            <KV k="Recovery" v={`${terms?.recoveryThreshold} of ${terms?.recoverySigners.length} signers · ${noticeDays} days' notice`} onChange={() => setStep(4)} />
            <KV k="Risks" v={detected ? `${RISK_NAMES.filter(([b]) => detected & b).length} accepted` : "none"} onChange={() => setStep(5)} />
            <KV k="Cost" v={COPY.costProtected(String(RENT_ESTIMATE_SOL))} />
          </Section>
          {issues.length > 0 && <div className="banner warn">{issues.map((x) => `§${x.section}: ${x.text}`).join(" ")}</div>}
          {text && (
            <Dial<"summary" | "text"> label="Read it as" value={reviewView} onChange={setReviewView} options={[{ id: "summary", label: "Summary" }, { id: "text", label: "Full text" }]} style={{ gridTemplateColumns: "1fr 1fr", marginBottom: 12 }} />
          )}
          {text && reviewView === "summary" && (
            <Section header="Sections" footer={`Fingerprint ${sha256Hex(text).slice(0, 16)}… — this goes on-chain; the text does not. Every other party regenerates it from the link and checks it matches before signing.`}>
              {clauseIndex(text).map((c) => (
                <Cell key={c.n} title={`${c.n}. ${c.title}`} subtitle={c.body.replace(/\s+/g, " ").slice(0, 120) + (c.body.length > 120 ? "…" : "")} wrap onClick={c.n <= 8 ? () => setStep(c.n === 3 || c.n === 4 ? 2 : c.n === 8 ? 6 : c.n <= 2 ? c.n - 1 : c.n - 2) : undefined} chevron={c.n <= 8} />
              ))}
            </Section>
          )}
          {text && reviewView === "text" && (
            <Section header="Agreement text" footer={`Fingerprint ${sha256Hex(text).slice(0, 16)}… — this goes on-chain; the text does not. Every other party regenerates it from the link and checks it matches before signing.`}>
              {clauseIndex(text).map((c) => (
                <div key={c.n} className="qa">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <b>{c.n}. {c.title}</b>
                    {c.n <= 8 && (
                      <button className="navbtn" onClick={() => setStep(c.n === 3 || c.n === 4 ? 2 : c.n === 8 ? 6 : c.n <= 2 ? c.n - 1 : c.n - 2)}>
                        Edit
                      </button>
                    )}
                  </div>
                  <div className="agreement" style={{ whiteSpace: "pre-wrap" }}>{c.body}</div>
                </div>
              ))}
            </Section>
          )}
          {text && (
            <div className="stack">
              <Button kind="secondary" onClick={() => download(`latch-agreement-${sha256Hex(text).slice(0, 8)}.txt`, text)}>
                Download agreement
              </Button>
              <Button
                kind="plain"
                onClick={() => {
                  if (!terms) return;
                  const name = window.prompt("Name this preset", subject.trim().slice(0, 40));
                  if (!name?.trim()) return;
                  const { a: _a, ...blobNoAttachment } = blob;
                  void _a;
                  const draft = fromCustomTerms(terms, blobNoAttachment, 1);
                  updateLocal((d) => void (d.presets[`${Date.now().toString(36)}`] = { name: name.trim().slice(0, 40), at: Math.floor(Date.now() / 1000), draft }));
                }}
              >
                Save as a preset on this device
              </Button>
            </div>
          )}
        </>
      )}

      {error && <div className="banner error">{error}</div>}
      <div className="stack">
        {step < STEPS.length - 1 ? (
          <Button onClick={next}>
            Continue
          </Button>
        ) : (
          <>
            <Button disabled={!text || issues.length > 0} busy={busy} onClick={create}>
              Sign & create agreement
            </Button>
            {serviceOn && chatPeer && (
              <Button kind="secondary" disabled={!canPropose} busy={busy} onClick={propose}>
                {init?.counter ? `Send counter-proposal (v${init.counter.version + 1})` : "Propose in chat first"}
              </Button>
            )}
            {serviceOn && chatPeer && !messagingOn(owner) && <div className="caption" style={{ textAlign: "center" }}>Turn on messages (Messages tab) to propose terms in chat before anyone signs.</div>}
          </>
        )}
      </div>

      <Sheet open={showText} onClose={() => setShowText(false)} title="The agreement so far">
        <p className="lead">The exact text every party signs. The section you're editing is highlighted; blanks show as placeholders until you fill them in.</p>
        <div className="agreement" style={{ maxHeight: "60vh", overflow: "auto" }}>
          {clauses.length ? (
            clauses.map((c) => (
              <div key={c.n} style={{ padding: "6px 0", background: STEPS[step].sections.includes(c.n as ClauseNo) ? "color-mix(in srgb, var(--link) 12%, transparent)" : undefined, borderRadius: 8 }}>
                <b>{c.n}. {c.title}.</b> {c.body}
              </div>
            ))
          ) : (
            <span className="caption">Fill in the subject and the parties to see the text.</span>
          )}
        </div>
      </Sheet>
    </>
  );
}
