"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PodPhase =
  | "preopen"
  | "live"
  | "rating"
  | "between_rounds"
  | "finished"
  | "closed";

export type PodSessionState =
  | "none"
  | "waiting"
  | "matched"
  | "closedForTonight";

/**
 * Canonical pod status — the single source of truth, served by /api/pods/status.
 * Every field that drives lobby UI lives here. Pages MUST NOT recompute these
 * client-side; doing so is what made the previous lobby drift.
 */
export type PodStatus = {
  ok: boolean;

  // Identity
  signedIn: boolean;
  userId: string | null;
  firstName: string | null;
  city: string | null;

  // Session identity + which round the night is currently on
  podId: string | null;
  currentRound: number | null;
  phase: PodPhase;

  // User-specific state in the current round
  state: PodSessionState;
  roomId: string | null;
  roundNumber: number | null;
  hasActiveSession: boolean;

  // Matching gates for the current round
  canEnterRound: boolean;
  entryWindowOpen: boolean;
  shouldGoToDone: boolean;
  nextRound: number | null;
  reason: string | null;

  // Countdowns / wall-clock anchors (all from server's "now")
  secondsLeftInPhase: number | null;
  secondsUntilRoundStart: number | null;
  secondsUntilRoundEnd: number | null;
  secondsSinceRoundStart: number | null;
  roundStartAt: string | null;
  conversationEndsAt: string | null;
  roundEndAt: string | null;
  ratingEndsAt: string | null;
  nextRoundOpensAt: string | null;

  // Night-level flags
  isOpenDay: boolean;
  isPreopen: boolean;
  closedForTonight: boolean;

  // Pre-launch banner
  prelaunch: boolean;
  launchLabel: string | null;

  // Diagnostics
  serverNow: string | null;
  recoverableError?: string;
};

export type UsePodStatusResult = {
  /** Latest known status. Null until the first successful fetch. */
  status: PodStatus | null;
  /** True before the first response lands. */
  loading: boolean;
  /** Network or parse error from the last fetch, if any. Cleared on next success. */
  error: string | null;
  /** Force an immediate fetch (e.g., after the user clicks "Enter the Pod"). */
  refresh: () => Promise<PodStatus | null>;
};

type UsePodStatusOptions = {
  /** Poll cadence in ms while the document is visible. Default 2500. */
  intervalMs?: number;
  /**
   * If true, polling pauses when document.visibilityState === "hidden" and resumes on visibilitychange.
   * Default true.
   */
  pauseWhenHidden?: boolean;
  /** If false, the hook fetches once and does not poll. Default true. */
  enabled?: boolean;
};

function parseStatus(raw: unknown): PodStatus | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.ok !== "boolean" || typeof o.signedIn !== "boolean") return null;

  // Phase: prefer canonicalPhase when present (status route returns both).
  const phase = (o.canonicalPhase ?? o.phase ?? "closed") as PodPhase;
  const state = (o.state ?? "none") as PodSessionState;

  return {
    ok: o.ok,
    signedIn: o.signedIn,
    userId: (o.userId as string | null) ?? null,
    firstName: (o.firstName as string | null) ?? null,
    city: (o.city as string | null) ?? null,

    podId: (o.podId as string | null) ?? null,
    currentRound: (o.currentRound as number | null) ?? null,
    phase,

    state,
    roomId: (o.roomId as string | null) ?? null,
    roundNumber: (o.roundNumber as number | null) ?? null,
    hasActiveSession: Boolean(o.hasActiveSession),

    canEnterRound: Boolean(o.canEnterRound),
    entryWindowOpen: Boolean(o.entryWindowOpen),
    shouldGoToDone: Boolean(o.shouldGoToDone),
    nextRound: (o.nextRound as number | null) ?? null,
    reason: (o.reason as string | null) ?? null,

    secondsLeftInPhase: (o.secondsLeftInPhase as number | null) ?? null,
    secondsUntilRoundStart: (o.secondsUntilRoundStart as number | null) ?? null,
    secondsUntilRoundEnd: (o.secondsUntilRoundEnd as number | null) ?? null,
    secondsSinceRoundStart: (o.secondsSinceRoundStart as number | null) ?? null,
    roundStartAt: (o.roundStartAt as string | null) ?? null,
    conversationEndsAt: (o.conversationEndsAt as string | null) ?? null,
    roundEndAt: (o.roundEndAt as string | null) ?? null,
    ratingEndsAt: (o.ratingEndsAt as string | null) ?? null,
    nextRoundOpensAt: (o.nextRoundOpensAt as string | null) ?? null,

    isOpenDay: Boolean(o.isOpenDay),
    isPreopen: Boolean(o.isPreopen),
    closedForTonight: Boolean(o.closedForTonight),

    prelaunch: Boolean(o.prelaunch),
    launchLabel: (o.launchLabel as string | null) ?? null,

    serverNow: (o.serverNow as string | null) ?? null,
    recoverableError: (o.recoverableError as string | undefined) ?? undefined,
  };
}

async function fetchPodStatus(): Promise<{
  status: PodStatus | null;
  error: string | null;
}> {
  try {
    const res = await fetch("/api/pods/status", {
      method: "GET",
      cache: "no-store",
    });

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Non-JSON response — surface as error rather than crashing.
      return {
        status: null,
        error: `Pod status returned non-JSON (status ${res.status}).`,
      };
    }

    const parsed = parseStatus(body);
    if (!parsed) {
      return {
        status: null,
        error: `Pod status response shape unexpected (status ${res.status}).`,
      };
    }

    return { status: parsed, error: null };
  } catch (err) {
    return {
      status: null,
      error: err instanceof Error ? err.message : "Failed to fetch pod status.",
    };
  }
}

/**
 * Polls /api/pods/status on a fixed cadence and exposes the canonical pod
 * state to the lobby. This is the ONE place the lobby talks to the server
 * about timing/phase/queue state — everything else derives from this.
 */
export function usePodStatus(
  options: UsePodStatusOptions = {}
): UsePodStatusResult {
  const { intervalMs = 2500, pauseWhenHidden = true, enabled = true } = options;

  const [status, setStatus] = useState<PodStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Track the most recent in-flight fetch so a `refresh()` triggered while a
  // tick is in flight doesn't double-set state for a stale response.
  const requestSeqRef = useRef(0);

  const runFetch = useCallback(async (): Promise<PodStatus | null> => {
    const seq = ++requestSeqRef.current;
    const { status: next, error: nextError } = await fetchPodStatus();

    // Drop result if a newer request has started.
    if (seq !== requestSeqRef.current) return next;

    if (nextError) {
      setError(nextError);
    } else {
      setError(null);
    }

    if (next) {
      setStatus(next);
    }
    setLoading(false);
    return next;
  }, []);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      await runFetch();
      if (cancelled) return;

      const isHidden =
        pauseWhenHidden &&
        typeof document !== "undefined" &&
        document.visibilityState === "hidden";

      if (!isHidden) {
        timer = setTimeout(tick, intervalMs);
      }
    };

    void tick();

    const handleVisibility = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        void tick();
      } else if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    if (pauseWhenHidden && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      if (pauseWhenHidden && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [enabled, intervalMs, pauseWhenHidden, runFetch]);

  return { status, loading, error, refresh: runFetch };
}
