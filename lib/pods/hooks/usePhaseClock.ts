"use client";

import { useEffect, useState } from "react";
import {
  ROUND_LOBBY_BUFFER_SECONDS,
  ROUND_RATING_SECONDS,
  TOTAL_ROUNDS,
} from "@/lib/pods/timing";
import type { PodPhase, PodStatus } from "./usePodStatus";

/**
 * Which "lobby moment" the user is currently sitting in, if any. This collapses
 * multiple server phases into the one user-facing question: "are they at the
 * lobby waiting for the next pod to open?"
 */
export type LobbyMoment =
  | "preopen"           // before round 1, lobby is open, round hasn't started
  | "between_rounds"    // rating just ended or round is mid-rating; next round is queued
  | "missed_round"      // round is live but user can't enter (entry window closed or left early); next round is queued
  | "live"              // a round is live and the user could/can be in it
  | "finished"          // pod night is over
  | "closed"            // not a pod day, or before launch
  | null;               // status not yet known

export type LobbyClock = {
  /** Server's authoritative phase + round (mirrors status). */
  phase: PodPhase | null;
  currentRound: number | null;
  /** Which lobby moment the user is sitting in. */
  moment: LobbyMoment;
  /**
   * True when a countdown to the *next round's start* should be displayed.
   * Combined into one flag so the JSX has a single condition to check.
   */
  showNextRoundCountdown: boolean;
  /** Whole seconds until the next round opens. Ticks down 1/s between status refreshes. */
  secondsUntilNextRound: number | null;
  /** "Round 2 opens in 0:45" — or null when no countdown is appropriate. */
  nextRoundCountdownLabel: string | null;
  /** Which round opens next (1 if preopen, 2 if between r1 and r2, etc.). Null if N/A. */
  upcomingRound: number | null;
  /** Whole seconds left in the *current* server phase. Mostly diagnostic; prefer secondsUntilNextRound. */
  secondsLeftInPhase: number | null;
};

const TRANSITION_SECONDS = ROUND_RATING_SECONDS + ROUND_LOBBY_BUFFER_SECONDS;

function formatMinutesSeconds(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Decide which round is "the next round" the user is waiting on, given the
 * server's phase + currentRound. This is the single answer the UI needs to
 * label its countdown.
 *
 *   preopen        → currentRound (round 1 hasn't started yet)
 *   live           → currentRound + 1 (only relevant if user can't enter this round)
 *   rating         → currentRound + 1 (rating belongs to the round that just played)
 *   between_rounds → currentRound (server flips currentRound forward in this phase)
 *   finished       → null (no next round tonight)
 *   closed         → null
 */
function computeUpcomingRound(
  phase: PodPhase | null,
  currentRound: number | null
): number | null {
  if (currentRound == null) return null;

  switch (phase) {
    case "preopen":
      return currentRound;
    case "live":
      return currentRound < TOTAL_ROUNDS ? currentRound + 1 : null;
    case "rating":
      return currentRound < TOTAL_ROUNDS ? currentRound + 1 : null;
    case "between_rounds":
      return currentRound;
    case "finished":
    case "closed":
    default:
      return null;
  }
}

function computeLobbyMoment(status: PodStatus): LobbyMoment {
  if (!status.isOpenDay || status.prelaunch) return "closed";

  switch (status.phase) {
    case "preopen":
      return "preopen";
    case "between_rounds":
    case "rating":
      // Rating is a transition for the lobby user; same UX as between_rounds.
      return "between_rounds";
    case "live":
      if (status.state === "matched") return "live";
      // "waiting" is the user's pod_queue row sitting open. If the entry window
      // is still open, they're actively being matched. If it's closed, the
      // window expired without a match — treat them as missed_round so the
      // lobby flips to "Round N+1 opens in 0:42" instead of forever-spinning.
      // (The server-side cleanup of stale waiting rows is a follow-up; this
      // is the client-side fallback.)
      if (status.state === "waiting") {
        return status.entryWindowOpen ? "live" : "missed_round";
      }
      if (status.canEnterRound) return "live";
      return "missed_round";
    case "finished":
      return "finished";
    case "closed":
      return "closed";
    default:
      return null;
  }
}

/**
 * Compute, from a freshly-fetched status, the integer seconds until the next
 * round opens. Uses only the status's integer fields (no Date math) so it's
 * pure with respect to React Compiler.
 */
function secondsUntilNextRoundFromStatus(status: PodStatus): number | null {
  switch (status.phase) {
    case "preopen":
      // Preopen ends at round 1 start.
      return status.secondsUntilRoundStart ?? status.secondsLeftInPhase ?? null;
    case "rating":
      // Rating ends, then a lobby buffer, then the next round opens.
      return status.secondsLeftInPhase != null
        ? status.secondsLeftInPhase + ROUND_LOBBY_BUFFER_SECONDS
        : null;
    case "between_rounds":
      // The between_rounds phase ends at the next round's start.
      return status.secondsLeftInPhase ?? null;
    case "live":
      // Time until the *next* round's start = time until this round ends + transition.
      // Only meaningful if the user is sitting at the lobby (missed_round).
      if (status.secondsUntilRoundEnd == null) return null;
      return status.secondsUntilRoundEnd + TRANSITION_SECONDS;
    case "finished":
    case "closed":
    default:
      return null;
  }
}

/**
 * Drives the visible lobby countdown. Reads the server-published whole-second
 * integers, re-anchors on each new status, and decrements 1/s locally between
 * polls. No `Date.now()` reads at render — the values come from a counter
 * that's a piece of state.
 */
export function usePhaseClock(status: PodStatus | null): LobbyClock {
  // Local copies of the server's seconds counters, decremented locally between
  // polls and re-anchored each time a new status arrives. Re-anchoring is done
  // with the "set state during render" idiom (a documented React pattern for
  // deriving state from a prop that changes), which keeps render pure for
  // React Compiler.
  const [trackedStatus, setTrackedStatus] = useState<PodStatus | null>(null);
  const [secondsLeftInPhase, setSecondsLeftInPhase] = useState<number | null>(
    null
  );
  const [secondsUntilNextRound, setSecondsUntilNextRound] = useState<
    number | null
  >(null);

  if (status !== trackedStatus) {
    setTrackedStatus(status);
    setSecondsLeftInPhase(status?.secondsLeftInPhase ?? null);
    setSecondsUntilNextRound(
      status ? secondsUntilNextRoundFromStatus(status) : null
    );
  }

  // 1Hz tick: decrement the local counters by 1 each second. The next status
  // poll will re-anchor and absorb any drift (max ~2.5s = poll interval).
  const phase = status?.phase ?? null;
  const isCountingDown =
    phase === "preopen" ||
    phase === "live" ||
    phase === "rating" ||
    phase === "between_rounds";

  useEffect(() => {
    if (!isCountingDown) return;
    const id = setInterval(() => {
      setSecondsLeftInPhase((v) => (v == null ? null : Math.max(0, v - 1)));
      setSecondsUntilNextRound((v) => (v == null ? null : Math.max(0, v - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [isCountingDown]);

  if (!status) {
    return {
      phase: null,
      currentRound: null,
      moment: null,
      showNextRoundCountdown: false,
      secondsUntilNextRound: null,
      nextRoundCountdownLabel: null,
      upcomingRound: null,
      secondsLeftInPhase: null,
    };
  }

  const upcomingRound = computeUpcomingRound(status.phase, status.currentRound);
  const moment = computeLobbyMoment(status);

  const showNextRoundCountdown =
    secondsUntilNextRound != null &&
    secondsUntilNextRound > 0 &&
    upcomingRound != null &&
    (moment === "preopen" ||
      moment === "between_rounds" ||
      moment === "missed_round");

  // Redundant null-checks here are for TypeScript's narrowing — it can't see
  // through `showNextRoundCountdown` even though we computed it from the same
  // fields just above.
  const nextRoundCountdownLabel =
    showNextRoundCountdown &&
    secondsUntilNextRound != null &&
    upcomingRound != null
      ? `Round ${upcomingRound} opens in ${formatMinutesSeconds(
          secondsUntilNextRound
        )}`
      : null;

  return {
    phase: status.phase,
    currentRound: status.currentRound,
    moment,
    showNextRoundCountdown,
    secondsUntilNextRound,
    nextRoundCountdownLabel,
    upcomingRound,
    secondsLeftInPhase,
  };
}
