/**
 * "Reveal dismissed" flag — remembers that the user has viewed the current
 * pod night's reveal page and explicitly clicked "Back to Lobby."
 *
 * Without this, the lobby's auto-redirect to /pods/done would fire every
 * time the user returns to /pods after round 3 (because the server keeps
 * reporting shouldGoToDone=true for the rest of the night), trapping them
 * in a loop.
 *
 * Storage strategy: **sessionStorage**, with the server's `podId` as the
 * stored value. The podId encodes both city and date (e.g.
 * `pods_nyc_2026-05-31`), so each pod night naturally has its own flag.
 * That gives us:
 *   - Persists across page refreshes within the tab (no redirect loop)
 *   - Cleared when the tab closes (fresh visit can show reveal again)
 *   - **Correct across same-day testing**: time-travel debug runs that
 *     simulate multiple pod nights in one calendar day each get their own
 *     flag, because each simulated night has a different podId date or
 *     city. Earlier date-only and value="1" implementations failed here.
 *   - Auto-resets across days for real users — yesterday's podId won't
 *     match today's, so the redirect works again on the next pod night.
 *
 * Both callers pass the podId from the canonical /api/pods/status response
 * (lobby reads `pod.podId`, done page reads it from its own status fetch).
 * If podId isn't available at write time (status hasn't loaded yet) the
 * write is a no-op, which means the next redirect fires once and the user
 * dismisses again — a benign degenerate case, not a bug.
 */

const REVEAL_DISMISSED_KEY = "pods_reveal_dismissed";

function storageAvailable(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return !!window.sessionStorage;
  } catch {
    return false;
  }
}

/** Record that the user has dismissed reveal for this specific pod night. */
export function markRevealDismissed(podId: string | null | undefined): void {
  if (!storageAvailable() || !podId) return;
  try {
    window.sessionStorage.setItem(REVEAL_DISMISSED_KEY, podId);
  } catch {
    // Quota errors, private browsing, etc. — failure here is harmless; it
    // just means the user might bounce to /pods/done once more.
  }
}

/**
 * True if the user has dismissed reveal for the given pod night. Returns
 * false for stored values from a different pod (different city or date),
 * so each pod night starts with a fresh dismissal state.
 */
export function isRevealDismissed(podId: string | null | undefined): boolean {
  if (!storageAvailable() || !podId) return false;
  try {
    const stored = window.sessionStorage.getItem(REVEAL_DISMISSED_KEY);
    return stored !== null && stored === podId;
  } catch {
    return false;
  }
}
