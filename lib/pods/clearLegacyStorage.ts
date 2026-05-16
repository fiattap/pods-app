/**
 * Sweep legacy sessionStorage keys written by the pre-refactor pods code.
 *
 * Before the lobby was rewritten to drive off /api/pods/status, the old
 * implementation used sessionStorage as ad-hoc state coordination between
 * the lobby, voice room, rating page, and reveal page. Keys included:
 *
 *   - pods_forward_handoff_round / pods_forward_handoff_at
 *   - pods_matched_room_handoff_room / pods_matched_room_handoff_at
 *   - pods_skip_restore_room / pods_skip_restore_round
 *   - pods_latest_round:YYYY-MM-DD (date-suffixed)
 *   - pods_refresh_attempts
 *   - pods_completed_night_pod_id
 *   - pods_has_seen_reveal
 *
 * The new lobby ignores all of these — they're dead weight. But session-
 * Storage doesn't auto-clean, so users who tested or used earlier builds
 * carry them around indefinitely (until they close the tab). That muddied
 * our debugging of the dismissed-reveal flag behavior recently, because
 * cross-run pollution looked like state asymmetry.
 *
 * Called once on lobby mount. Safe to call repeatedly — only removes keys
 * the new code never writes.
 *
 * IMPORTANT: this DOES NOT touch `pods_reveal_dismissed`. That one is
 * actively used by the new lobby/reveal flow.
 */

const LEGACY_KEY_PREFIXES = [
  "pods_forward_handoff_",
  "pods_matched_room_handoff_",
  "pods_skip_restore_",
  "pods_latest_round",
  "pods_refresh_attempts",
  "pods_completed_night_pod_id",
  "pods_has_seen_reveal",
] as const;

const ACTIVE_KEYS_KEEP = new Set<string>([
  "pods_reveal_dismissed",
]);

function storageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!window.sessionStorage;
  } catch {
    return false;
  }
}

export function clearLegacyPodsStorage(): void {
  if (!storageAvailable()) return;

  try {
    const toDelete: string[] = [];

    for (let i = 0; i < window.sessionStorage.length; i += 1) {
      const key = window.sessionStorage.key(i);
      if (!key) continue;
      if (ACTIVE_KEYS_KEEP.has(key)) continue;

      if (LEGACY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        toDelete.push(key);
      }
    }

    for (const key of toDelete) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    // Quota/private-browsing errors are harmless here — failing to clean
    // legacy state just means it stays around a bit longer.
  }
}
