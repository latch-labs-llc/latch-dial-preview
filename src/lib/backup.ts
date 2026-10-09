/**
 * Agreement copies — three layers (founder decision):
 *   1. Download: required before paying in (DealPage save gate).
 *   2. Encrypted backup file: anyone can keep it anywhere; only this wallet can open it.
 *   3. Encrypted service backup (optional, needs SERVICE_URL): uploaded silently after setup.
 * The key is derived from a wallet signature each session and kept in memory only.
 */
import { fromB64, toB64 } from "./claims";
import { KCV_MISMATCH } from "./backupCrypto";
import {
  fetchBackups,
  openPayload,
  registerBackupWriter,
  sealPayload,
  serviceOn,
  unlockBackupKeys,
  unlockWriter,
  uploadBackup,
  type BackupPayload,
  type BackupSession,
  type SignMessage,
} from "./service";
import { getLocal, updateLocal } from "./store";

let session: BackupSession | null = null;

export function backupUnlocked(owner: string | undefined): boolean {
  return !!owner && session?.owner === owner;
}

/** Unlock with the wallet; remembers the key-check value so a different key is caught next time. */
export async function unlockBackups(owner: string, signMessage: SignMessage): Promise<void> {
  const known = getLocal().backupKcv[owner];
  const keys = await unlockBackupKeys(owner, signMessage, known);
  if (!known) updateLocal((d) => void (d.backupKcv[owner] = keys.kcv));
  session = { owner, keys };
}

export async function ensureWriter(owner: string, signMessage: SignMessage) {
  if (!backupUnlocked(owner)) await unlockBackups(owner, signMessage);
  if (!session!.writer) {
    const known = getLocal().backupWriter[owner];
    session!.writer = await unlockWriter(owner, signMessage, known);
    if (!known) updateLocal((d) => void (d.backupWriter[owner] = session!.writer!.pk));
  }
}

/** Turn on service backups: unlock + writer key (separate signature) + register it (once). */
export async function enableServiceBackups(owner: string, signMessage: SignMessage): Promise<void> {
  await ensureWriter(owner, signMessage);
  await registerBackupWriter(session!, signMessage);
  updateLocal((d) => {
    if (!d.backupsFor.includes(owner)) d.backupsFor.push(owner);
  });
}

function payloads(): BackupPayload[] {
  const d = getLocal();
  return Object.entries(d.links).map(([deal, link]) => ({
    format: "latch-dial/agreement-backup@2" as const,
    deal,
    link,
    ...(d.attachments[deal] ? { attachment: d.attachments[deal] } : {}),
  }));
}

/** Upload any agreement copies not yet backed up (silent once enabled). */
export async function syncBackups(owner: string): Promise<number> {
  if (!serviceOn || !backupUnlocked(owner) || !session!.writer || !getLocal().backupsFor.includes(owner)) return 0;
  const done = new Set(getLocal().backedUp);
  let n = 0;
  for (const p of payloads()) {
    if (done.has(p.deal)) continue;
    await uploadBackup(session!, p);
    updateLocal((d) => void d.backedUp.push(p.deal));
    n++;
  }
  return n;
}

function restore(list: BackupPayload[]): number {
  let n = 0;
  updateLocal((d) => {
    for (const p of list) {
      if (!d.links[p.deal]) n++;
      d.links[p.deal] = p.link;
      if (p.attachment) d.attachments[p.deal] = p.attachment;
      if (!d.backedUp.includes(p.deal)) d.backedUp.push(p.deal);
    }
  });
  return n;
}

export async function restoreFromService(owner: string, signMessage: SignMessage): Promise<number> {
  await ensureWriter(owner, signMessage);
  return restore(await fetchBackups(session!));
}

export const BACKUP_FILE_FORMAT = "latch-dial/encrypted-backup@2";

/** A single encrypted file holding every agreement copy on this device. */
export function exportBackupFile(owner: string): string {
  if (!backupUnlocked(owner)) throw new Error("Unlock backups first");
  const items = payloads().map((p) => {
    const { id, sealed } = sealPayload(session!, p);
    return { id, ct: toB64(sealed) };
  });
  return JSON.stringify({ format: BACKUP_FILE_FORMAT, owner, kcv: session!.keys.kcv, items }, null, 2);
}

export function importBackupFile(owner: string, text: string): number {
  if (!backupUnlocked(owner)) throw new Error("Unlock backups first");
  const f = JSON.parse(text);
  if (f.format !== BACKUP_FILE_FORMAT) throw new Error("Not a Latch backup file (or an older format this version can't read).");
  if (f.owner !== owner) throw new Error("This backup belongs to a different wallet.");
  if (f.kcv !== session!.keys.kcv) throw new Error(KCV_MISMATCH);
  const list: BackupPayload[] = [];
  for (const it of f.items ?? []) {
    try {
      list.push(openPayload(session!, String(it.id), fromB64(String(it.ct))));
    } catch {
      /* tampered item: skip */
    }
  }
  return restore(list);
}
