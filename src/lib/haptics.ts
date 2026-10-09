/**
 * Haptics event map (R8 §4.6, Telegram's taxonomy). Web reality:
 * navigator.vibrate works on Chrome/Android only; Safari/iOS ignore it, so
 * iPhone haptics need a native shell later (R8 D16). Never fired in lists.
 */
import { getLocal } from "./store";

type Haptic = "selection" | "success" | "warning" | "error" | "impact";
const PATTERNS: Record<Haptic, number | number[]> = {
  selection: 8,
  success: [12, 40, 18],
  warning: [20, 60, 20],
  error: [30, 50, 30, 50, 30],
  impact: 16,
};

export function haptic(kind: Haptic): void {
  try {
    if (!getLocal().settings.haptics) return;
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(PATTERNS[kind]);
  } catch {
    /* unsupported */
  }
}
