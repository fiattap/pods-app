"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import {
  TOTAL_ROUNDS,
  PODS_LAUNCH_AT,
  PODS_LAUNCH_LABEL,
  clampRound,
  formatCountdown,
  formatLaunchCountdown,
  getCurrentLobbyRoundForNow,
  getNextPodOpenLabel,
  getPodIdForCurrentSession,
  getPreopenLobbySecondsLeft,
  getRoundTiming,
  getSecondsUntilNextPodOpen,
  hasNightFinished,
  isPodNightOver,
  isPodsOpenDay,
  isPreLaunch,
  normalizeCity,
} from "@/lib/pods/timing";

const FINALIZING_MATCH_LABEL = "Finalizing your pod...";
const MATCH_POLL_INTERVAL_MS = 2000;
const SEARCH_WINDOW_MS = 45_000;
const RETRY_WINDOW_MS = 20_000;
const AUTO_ADVANCE_AFTER_MS = SEARCH_WINDOW_MS + RETRY_WINDOW_MS;
const ROOM_FULL_SESSION_SECONDS = 5 * 60; // 300
const ROOM_FULL_SESSION_GRACE_SECONDS = 10;
const FORWARD_HANDOFF_MAX_AGE_MS = 60_000;
const FORWARD_HANDOFF_ROUND_KEY = "pods_forward_handoff_round";
const FORWARD_HANDOFF_AT_KEY = "pods_forward_handoff_at";
const MATCHED_ROOM_HANDOFF_ROOM_KEY = "pods_matched_room_handoff_room";
const MATCHED_ROOM_HANDOFF_AT_KEY = "pods_matched_room_handoff_at";
const SKIP_RESTORE_ROOM_KEY = "pods_skip_restore_room";
const SKIP_RESTORE_ROUND_KEY = "pods_skip_restore_round";
const AUTH_RESTORE_RETRY_MESSAGE =
  "We hit a temporary sign-in restore conflict. Please try again.";

type MatchedResponse = {
  status: "matched";
  roomId: string;
  roundNumber: number;
};

type WaitingResponse = {
  status: "waiting";
  message?: string;
};

type NoMatchResponse = {
  status: "no_match";
  message?: string;
  roundNumber?: number;
  nextRound: number | null;
  reveal?: boolean;
};

type ErrorResponse = {
  status?: "error";
  error?: string;
  message?: string;
  raw?: string;
};

type MatchResponse =
  | MatchedResponse
  | WaitingResponse
  | NoMatchResponse
  | ErrorResponse
  | null;

type PodStatusResponse = {
  ok: boolean;
  signedIn: boolean;
  state: "none" | "waiting" | "matched" | "closedForTonight";
  canonicalPhase?: PodPhase;
  phase?: PodPhase;
  canEnterRound?: boolean;
  entryWindowOpen?: boolean;
  secondsSinceRoundStart?: number | null;
  secondsUntilRoundStart?: number | null;
  secondsUntilRoundEnd?: number | null;
  nextRound?: number | null;
  reason?: string | null;
  hasActiveSession?: boolean;
  roundNumber: number | null;
  roomId: string | null;
  podId: string | null;
  queueId?: number;
  createdAt?: string;
  error?: string;
  prelaunch?: boolean;
  launchLabel?: string;
  closedForTonight?: boolean;
  currentRound?: number | null;
  roundStartAt?: string | null;
  roundEndAt?: string | null;
  secondsLeftInPhase?: number | null;
  isOpenDay?: boolean;
  isPreopen?: boolean;
  serverNow?: string;
};

type CanonicalPodStatus = {
  signedIn: boolean;
  state: PodStatusResponse["state"] | null;
  phase: PodPhase | null;
  canEnterRound: boolean;
  entryWindowOpen: boolean;
  podId: string | null;
  roundNumber: number | null;
  nextRound: number | null;
  reason: string | null;
  hasActiveSession: boolean;
  serverNow: string | null;
};

type PodPhase =
  | "preopen"
  | "live"
  | "rating"
  | "between_rounds"
  | "finished"
  | "closed";

type ProfileRow = {
  id: string;
  first_name: string | null;
  city: string | null;
  onboarding_complete: boolean | null;
};

type ParsedApiError = {
  error?: string;
  message?: string;
  raw?: string;
};

type DebugSnapshot = {
  userId: string | null;
  city: string | null;
  podId: string;
  currentRound: number;
  requestedRound: number | null;
  secondsToStart: number | null;
  isBeforeRoundStart: boolean;
  isAfterRoundEnd: boolean;
  isNightOver: boolean;
  isMatching: boolean;
  isWaiting: boolean;
};

type RecoveryAttemptResult =
  | "success"
  | "login_required"
  | "recovery_failed";

type RecoveryPhase =
  | "bootstrapping"
  | "ready"
  | "retryable_error"
  | "login_required"
  | "navigating";

type RestorableSessionState =
  | {
      ok: true;
      round: number;
      roundTiming: ReturnType<typeof getRoundTiming>;
    }
  | {
      ok: false;
      reason:
        | "prelaunch"
        | "not_open_day"
        | "night_over"
        | "round_over"
        | "matched_before_round_start"
        | "round_not_open_yet";
      round: number;
      roundTiming: ReturnType<typeof getRoundTiming> | null;
    };

type RequestedRoundPinOptions = {
  canonicalRound?: number | null;
  activeSessionRound?: number | null;
  recentForwardHandoff?: boolean;
  source?: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logPodsDebug(label: string, snapshot: DebugSnapshot) {
  console.log(`[pods/page][debug] ${label}`, snapshot);
}

function isRecoverableAuthLockError(error: {
  name?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
}) {
  const name = (error.name || "").toLowerCase();
  const message = (error.message || "").toLowerCase();
  const details = (error.details || "").toLowerCase();
  const hint = (error.hint || "").toLowerCase();

  const combined = `${name} ${message} ${details} ${hint}`;

  return (
    combined.includes("navigatorlockacquiretimeouterror") ||
    combined.includes("lock broken by another request") ||
    combined.includes("another request stole it") ||
    combined.includes("released because another request stole it") ||
    (combined.includes("lock") && combined.includes("stole it")) ||
    (combined.includes("aborterror") && combined.includes("lock"))
  );
}

function isPreopenLobbyWindow(targetCity: string | null, round: number) {
  if (round !== 1) return false;
  if (isPreLaunch()) return false;
  if (!isPodsOpenDay(targetCity)) return false;

  const roundTiming = getRoundTiming(targetCity, round);

  return (
    roundTiming.isBeforeRoundStart &&
    getPreopenLobbySecondsLeft(targetCity) === 0
  );
}

function canStayInLobbyBeforeRoundStart(targetCity: string | null, round: number) {
  return isPreopenLobbyWindow(targetCity, round);
}

function getTimingSafeLobbyRound(targetCity: string | null) {
  if (isPreLaunch()) return 1;
  if (!isPodsOpenDay(targetCity)) return 1;
  if (isPodNightOver(targetCity)) return 1;

  return clampRound(getCurrentLobbyRoundForNow(targetCity));
}

function getRestorableSessionState(
  targetCity: string | null,
  round: number,
  state: "waiting" | "matched"
): RestorableSessionState {
  const safeRound = clampRound(round);

  if (isPreLaunch()) {
    return {
      ok: false as const,
      reason: "prelaunch" as const,
      round: safeRound,
      roundTiming: null,
    };
  }

  if (isPodNightOver(targetCity)) {
    return {
      ok: false as const,
      reason: "night_over" as const,
      round: safeRound,
      roundTiming: null,
    };
  }

  const roundTiming = getRoundTiming(targetCity, safeRound);

  if (roundTiming.isAfterRoundEnd) {
    return {
      ok: false as const,
      reason: "round_over" as const,
      round: safeRound,
      roundTiming,
    };
  }

  if (roundTiming.isBeforeRoundStart) {
    if (state === "matched") {
      return {
        ok: false as const,
        reason: "matched_before_round_start" as const,
        round: safeRound,
        roundTiming,
      };
    }

    if (!canStayInLobbyBeforeRoundStart(targetCity, safeRound)) {
      return {
        ok: false as const,
        reason: "round_not_open_yet" as const,
        round: safeRound,
        roundTiming,
      };
    }
  }

  return {
    ok: true as const,
    round: safeRound,
    roundTiming,
  };
}

function getPinnedRequestedRound(
  targetCity: string | null,
  requestedRound: number | null,
  options?: RequestedRoundPinOptions
) {
  if (requestedRound === null) return null;

  const safeRequestedRound = clampRound(requestedRound);
  const recentForwardHandoff = options?.recentForwardHandoff === true;

  if (recentForwardHandoff) {
    return safeRequestedRound;
  }

  if (!targetCity) {
    return null;
  }

  if (isPodNightOver(targetCity)) {
    return null;
  }

  const canonicalRound =
    options?.canonicalRound !== null && options?.canonicalRound !== undefined
      ? clampRound(options.canonicalRound)
      : getTimingSafeLobbyRound(targetCity);
  const activeSessionRound =
    options?.activeSessionRound !== null &&
    options?.activeSessionRound !== undefined
      ? clampRound(options.activeSessionRound)
      : null;

  if (activeSessionRound === safeRequestedRound) {
    if (options?.source) {
      console.log("[pods/page] requested round accepted from active session", {
        source: options.source,
        requestedRound: safeRequestedRound,
        activeSessionRound,
        canonicalRound,
      });
    }

    return safeRequestedRound;
  }

  if (safeRequestedRound !== canonicalRound) {
    if (options?.source) {
      console.warn("[pods/page] requested round rejected as stale", {
        source: options.source,
        requestedRound: safeRequestedRound,
        canonicalRound,
        activeSessionRound,
      });
    }

    return null;
  }

  return safeRequestedRound;
}

function formatCountdownShort(seconds: number | null) {
  if (seconds === null) return "";

  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function parseApiResponse(res: Response): Promise<MatchResponse> {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  if (!text) return null;

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error("FAILED TO PARSE JSON RESPONSE", error, text);
      return { raw: text, error: "Invalid JSON response from server." };
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    return {
      raw: text,
      error:
        text.startsWith("<!DOCTYPE") || text.startsWith("<html")
          ? "Server returned HTML instead of JSON."
          : "Server returned a non-JSON response.",
    };
  }
}

async function parsePodStatusResponse(
  res: Response
): Promise<PodStatusResponse | null | ParsedApiError> {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  if (!text) return null;

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as PodStatusResponse;
    } catch (error) {
      console.error("FAILED TO PARSE POD STATUS JSON RESPONSE", error, text);
      return { raw: text, error: "Invalid JSON response from pod status." };
    }
  }

  try {
    return JSON.parse(text) as PodStatusResponse;
  } catch {
    return {
      raw: text,
      error:
        text.startsWith("<!DOCTYPE") || text.startsWith("<html")
          ? "Pod status returned HTML instead of JSON."
          : "Pod status returned a non-JSON response.",
    };
  }
}

async function fetchPodStatus(): Promise<{
  res: Response;
  data: PodStatusResponse | null | ParsedApiError;
}> {
  try {
    const res = await fetch("/api/pods/status", {
      method: "GET",
      cache: "no-store",
    });

    const data = await parsePodStatusResponse(res);

    console.log("[pods/page][debug] fetchPodStatus returned", {
      status: res.status,
      statusText: res.statusText,
      data,
    });

    if (!res.ok) {
      console.error("[pods/page] fetchPodStatus non-200 response", {
        status: res.status,
        statusText: res.statusText,
        data,
      });
    }

    return { res, data };
  } catch (error) {
    console.error("[pods/page] fetchPodStatus request failed", error);

    return {
      res: new Response(null, {
        status: 500,
        statusText: "FETCH_FAILED",
      }),
      data: {
        error:
          error instanceof Error
            ? error.message
            : "Failed to fetch pod status.",
      },
    };
  }
}

function getFriendlyApiError(data: MatchResponse, fallback: string) {
  if (!data) return fallback;

  if ("error" in data && typeof data.error === "string" && data.error.trim()) {
    return data.error;
  }

  if (
    "message" in data &&
    typeof data.message === "string" &&
    data.message.trim()
  ) {
    return data.message;
  }

  if ("raw" in data && typeof data.raw === "string" && data.raw.trim()) {
    if (data.raw.startsWith("<!DOCTYPE") || data.raw.startsWith("<html")) {
      return "The server returned an HTML page instead of match data.";
    }
    return data.raw.length > 180 ? `${data.raw.slice(0, 180)}...` : data.raw;
  }

  return fallback;
}

function getFriendlyPodStatusError(
  data: PodStatusResponse | null | ParsedApiError,
  fallback: string
) {
  if (!data) return fallback;

  if ("error" in data && typeof data.error === "string" && data.error.trim()) {
    return data.error;
  }

  if (
    "message" in data &&
    typeof data.message === "string" &&
    data.message.trim()
  ) {
    return data.message;
  }

  if ("raw" in data && typeof data.raw === "string" && data.raw.trim()) {
    if (data.raw.startsWith("<!DOCTYPE") || data.raw.startsWith("<html")) {
      return "The server returned an HTML page instead of pod status data.";
    }
    return data.raw.length > 180 ? `${data.raw.slice(0, 180)}...` : data.raw;
  }

  return fallback;
}

function isMatchedResponse(data: MatchResponse): data is MatchedResponse {
  return (
    !!data &&
    data.status === "matched" &&
    "roomId" in data &&
    typeof data.roomId === "string" &&
    data.roomId.trim().length > 0 &&
    "roundNumber" in data &&
    typeof data.roundNumber === "number"
  );
}

function isWaitingResponse(data: MatchResponse): data is WaitingResponse {
  return !!data && data.status === "waiting";
}

function isNoMatchResponse(data: MatchResponse): data is NoMatchResponse {
  return !!data && data.status === "no_match";
}

function isPodStatusResponse(
  data: PodStatusResponse | null | ParsedApiError
): data is PodStatusResponse {
  return (
    !!data &&
    "ok" in data &&
    typeof data.ok === "boolean" &&
    "signedIn" in data &&
    typeof data.signedIn === "boolean" &&
    "state" in data &&
    (data.state === "none" ||
      data.state === "waiting" ||
      data.state === "matched" ||
      data.state === "closedForTonight")
  );
}

function getPodStatusCanonicalPhase(data: PodStatusResponse) {
  return data.canonicalPhase ?? data.phase ?? null;
}

function isMatchablePodPhase(phase: PodPhase | null | undefined) {
  return phase === "live";
}

function getPodStatusRoundNumber(data: PodStatusResponse) {
  return data.currentRound ?? data.roundNumber ?? null;
}

function canPostMatchForStatus(
  data: PodStatusResponse,
  expectedPodId: string,
  expectedRound: number
) {
  const canonicalPhase = getPodStatusCanonicalPhase(data);
  const canonicalRound = getPodStatusRoundNumber(data);

  return (
    data.signedIn === true &&
    data.state === "none" &&
    isMatchablePodPhase(canonicalPhase) &&
    data.canEnterRound === true &&
    data.entryWindowOpen === true &&
    data.podId === expectedPodId &&
    canonicalRound === expectedRound
  );
}

function hasCanonicalActiveQueueState(
  data: PodStatusResponse,
  expectedPodId: string,
  expectedRound: number
) {
  return (
    (data.state === "waiting" || data.state === "matched") &&
    data.podId === expectedPodId &&
    data.roundNumber === expectedRound
  );
}

function getSkipRestoreMarker() {
  if (typeof window === "undefined") return null;

  const roomId = window.sessionStorage.getItem(SKIP_RESTORE_ROOM_KEY);
  const rawRound = window.sessionStorage.getItem(SKIP_RESTORE_ROUND_KEY);
  const roundNumber = Number(rawRound);

  if (!roomId || !Number.isFinite(roundNumber) || roundNumber <= 0) {
    return null;
  }

  return {
    roomId,
    roundNumber: clampRound(roundNumber),
  };
}

function setSkipRestoreMarker(roomId: string, roundNumber: number) {
  if (typeof window === "undefined") return;

  window.sessionStorage.setItem(SKIP_RESTORE_ROOM_KEY, roomId);
  window.sessionStorage.setItem(
    SKIP_RESTORE_ROUND_KEY,
    String(clampRound(roundNumber))
  );
}

function clearSkipRestoreMarker() {
  if (typeof window === "undefined") return;

  window.sessionStorage.removeItem(SKIP_RESTORE_ROOM_KEY);
  window.sessionStorage.removeItem(SKIP_RESTORE_ROUND_KEY);
}

function writeForwardHandoffMarker(roundNumber: number) {
  if (typeof window === "undefined") return;

  const safeRound = clampRound(roundNumber);

  window.sessionStorage.setItem(FORWARD_HANDOFF_ROUND_KEY, String(safeRound));
  window.sessionStorage.setItem(FORWARD_HANDOFF_AT_KEY, String(Date.now()));
}

function getEmptyCanonicalStatus(): CanonicalPodStatus {
  return {
    signedIn: false,
    state: null,
    phase: null,
    canEnterRound: false,
    entryWindowOpen: false,
    podId: null,
    roundNumber: null,
    nextRound: null,
    reason: null,
    hasActiveSession: false,
    serverNow: null,
  };
}

function areCanonicalStatusesEqual(
  current: CanonicalPodStatus,
  next: CanonicalPodStatus
) {
  return (
    current.signedIn === next.signedIn &&
    current.state === next.state &&
    current.phase === next.phase &&
    current.canEnterRound === next.canEnterRound &&
    current.entryWindowOpen === next.entryWindowOpen &&
    current.podId === next.podId &&
    current.roundNumber === next.roundNumber &&
    current.nextRound === next.nextRound &&
    current.reason === next.reason &&
    current.hasActiveSession === next.hasActiveSession
  );
}

export default function PodsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const roundFromUrlRaw = searchParams.get("round");
  const roundFromUrl = Number(roundFromUrlRaw);
  const requestedRound =
    Number.isFinite(roundFromUrl) && roundFromUrl > 0
      ? Math.min(roundFromUrl, TOTAL_ROUNDS)
      : null;

  const [currentRound, setCurrentRound] = useState(1);
  const [authChecked, setAuthChecked] = useState(false);
  const [recoveryPhase, setRecoveryPhase] =
    useState<RecoveryPhase>("bootstrapping");

  const [firstName, setFirstName] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [secondsToStart, setSecondsToStart] = useState<number | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [podId, setPodId] = useState<string>("");
  const [nowTick, setNowTick] = useState(0);

  const [isMatching, setIsMatching] = useState(false);
  const [isWaiting, setIsWaiting] = useState(false);
  const [hasStartedMatchAttempt, setHasStartedMatchAttempt] = useState(false);
  const [refreshAttempts, setRefreshAttempts] = useState(0);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [enteredAt, setEnteredAt] = useState<number | null>(null);
  const [showRetry, setShowRetry] = useState(false);
  const [, setHasSeenReveal] = useState(false);
  const [secondsToNextPod, setSecondsToNextPod] = useState<number | null>(null);
  const [canonicalStatus, setCanonicalStatus] = useState<CanonicalPodStatus>(
    getEmptyCanonicalStatus
  );
  const canonicalStatusRef = useRef<CanonicalPodStatus>(
    getEmptyCanonicalStatus()
  );

  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [isSubmittingSupport, setIsSubmittingSupport] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState(false);
  const [supportError, setSupportError] = useState("");

  const redirectedRef = useRef(false);
  const requestInFlightRef = useRef(false);
  const enterAttemptActiveRef = useRef(false);
  const enterAttemptCommittedRef = useRef(false);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRequestInFlightRef = useRef(false);
  const backgroundStatusPollRef = useRef(false);
  const unmatchedAutoAdvanceInFlightRef = useRef(false);
  const autoForwardInFlightRef = useRef(false);
  const retryWindowOpenedRef = useRef(false);
  const matchedRoomCommittedRef = useRef(false);
  const isNavigatingToRoomRef = useRef(false);
  const acceptedForwardHandoffRoundRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const bootstrapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapStartedRef = useRef(false);
  const bootstrapInFlightRef = useRef(false);
  const hasLoggedAuthRestoreSkipRef = useRef(false);
  const latestPodStatusRef = useRef<{
    canonicalPhase: PodPhase | null;
    canEnterRound: boolean;
    signedIn: boolean;
    state: PodStatusResponse["state"] | null;
    entryWindowOpen: boolean;
    podId: string | null;
    roundNumber: number | null;
    nextRound: number | null;
    reason: string | null;
    serverNow: string | null;
  }>({
    canonicalPhase: null,
    canEnterRound: false,
    signedIn: false,
    state: null,
    entryWindowOpen: false,
    podId: null,
    roundNumber: null,
    nextRound: null,
    reason: null,
    serverNow: null,
  });

  function applyCanonicalPodStatus(data: PodStatusResponse) {
    const canonicalPhase = getPodStatusCanonicalPhase(data);
    const canonicalRound = getPodStatusRoundNumber(data);
    const skipRestoreMarker = getSkipRestoreMarker();

    if (skipRestoreMarker) {
      const requestedOrAcceptedForwardRound =
        requestedRound ?? acceptedForwardHandoffRoundRef.current;
      const statusMatchedRound = data.roundNumber ?? canonicalRound;
      const statusIsSkippedMatch =
        data.state === "matched" &&
        data.roomId === skipRestoreMarker.roomId &&
        statusMatchedRound === skipRestoreMarker.roundNumber;

      if (
        requestedOrAcceptedForwardRound !== null &&
        canonicalRound === requestedOrAcceptedForwardRound &&
        !statusIsSkippedMatch
      ) {
        console.log("[pods/page] clearing skipped matched restore marker", {
          skippedRoomId: skipRestoreMarker.roomId,
          skippedRound: skipRestoreMarker.roundNumber,
          confirmedRound: canonicalRound,
          state: data.state,
        });
        clearSkipRestoreMarker();
      }
    }

    latestPodStatusRef.current = {
      canonicalPhase,
      canEnterRound: data.canEnterRound === true,
      signedIn: data.signedIn === true,
      state: data.state,
      entryWindowOpen: data.entryWindowOpen === true,
      podId: data.podId ?? null,
      roundNumber: canonicalRound,
      nextRound: data.nextRound ?? null,
      reason: data.reason ?? null,
      serverNow: data.serverNow ?? null,
    };

    const nextCanonicalStatus: CanonicalPodStatus = {
      signedIn: data.signedIn === true,
      state: data.state,
      phase: canonicalPhase,
      canEnterRound: data.canEnterRound === true,
      entryWindowOpen: data.entryWindowOpen === true,
      podId: data.podId ?? null,
      roundNumber: canonicalRound,
      nextRound: data.nextRound ?? null,
      reason: data.reason ?? null,
      hasActiveSession: data.hasActiveSession === true,
      serverNow: data.serverNow ?? null,
    };

    if (
      !areCanonicalStatusesEqual(
        canonicalStatusRef.current,
        nextCanonicalStatus
      )
    ) {
      canonicalStatusRef.current = nextCanonicalStatus;
      setCanonicalStatus(nextCanonicalStatus);
    }
  }

  function clearCanonicalPodStatus() {
    const emptyCanonicalStatus = getEmptyCanonicalStatus();

    latestPodStatusRef.current = {
      canonicalPhase: null,
      canEnterRound: false,
      signedIn: false,
      state: null,
      entryWindowOpen: false,
      podId: null,
      roundNumber: null,
      nextRound: null,
      reason: null,
      serverNow: null,
    };

    if (
      !areCanonicalStatusesEqual(
        canonicalStatusRef.current,
        emptyCanonicalStatus
      )
    ) {
      canonicalStatusRef.current = emptyCanonicalStatus;
      setCanonicalStatus(emptyCanonicalStatus);
    }
  }

  const isBootstrapping = recoveryPhase === "bootstrapping";
  const requiresLogin = recoveryPhase === "login_required";

  const safeCurrentRound = clampRound(currentRound);
  const currentRoundTiming = city ? getRoundTiming(city, safeCurrentRound) : null;
  const timingSafeLobbyRound = city ? getTimingSafeLobbyRound(city) : 1;
  const hasAcceptedForwardHandoff =
    requestedRound !== null &&
    acceptedForwardHandoffRoundRef.current === requestedRound;
  const validatedRequestedRound = getPinnedRequestedRound(city, requestedRound, {
    canonicalRound: Math.max(safeCurrentRound, timingSafeLobbyRound),
    recentForwardHandoff: hasAcceptedForwardHandoff,
  });

  const syncUrlToCanonicalRound = useCallback(
    (canonicalRound: number, source: string) => {
      const safeCanonicalRound = clampRound(canonicalRound);

      if (safeCanonicalRound <= 1) {
        if (requestedRound === null) return;

        console.log("[pods/page] removing stale round query", {
          source,
          requestedRound,
          canonicalRound: safeCanonicalRound,
        });
        router.replace("/pods");
        return;
      }

      if (requestedRound === safeCanonicalRound) return;

      console.log("[pods/page] syncing URL to canonical round", {
        source,
        requestedRound,
        canonicalRound: safeCanonicalRound,
      });
      router.replace(`/pods?round=${safeCanonicalRound}`);
    },
    [requestedRound, router]
  );

  const clearForwardHandoffMarker = useCallback(
    (
      reason: "expired" | "invalid",
      details: {
        source: string;
        requestedRound: number | null;
        markerRound?: number | null;
        ageMs?: number | null;
      }
    ) => {
      if (typeof window === "undefined") return;

      const storedRound = window.sessionStorage.getItem(FORWARD_HANDOFF_ROUND_KEY);
      const storedAt = window.sessionStorage.getItem(FORWARD_HANDOFF_AT_KEY);

      if (storedRound === null && storedAt === null) {
        return;
      }

      if (reason === "expired") {
        console.log("[pods/page] clearing expired forward handoff marker", {
          source: details.source,
          requestedRound: details.requestedRound,
          markerRound: details.markerRound ?? null,
          ageMs: details.ageMs ?? null,
        });
      } else {
        console.log("[pods/page] clearing invalid forward handoff marker", {
          source: details.source,
          requestedRound: details.requestedRound,
          markerRound: details.markerRound ?? null,
          ageMs: details.ageMs ?? null,
        });
      }

      window.sessionStorage.removeItem(FORWARD_HANDOFF_ROUND_KEY);
      window.sessionStorage.removeItem(FORWARD_HANDOFF_AT_KEY);
    },
    []
  );

  const consumeRecentForwardHandoff = useCallback(
    (targetRequestedRound: number | null, source: string) => {
      if (targetRequestedRound === null) {
        clearForwardHandoffMarker("invalid", {
          source,
          requestedRound: null,
        });
        return false;
      }

      if (acceptedForwardHandoffRoundRef.current === targetRequestedRound) {
        return true;
      }

      if (typeof window === "undefined") {
        return false;
      }

      const rawMarkerRound = window.sessionStorage.getItem(FORWARD_HANDOFF_ROUND_KEY);
      const rawMarkerAt = window.sessionStorage.getItem(FORWARD_HANDOFF_AT_KEY);

      if (rawMarkerRound === null && rawMarkerAt === null) {
        return false;
      }

      const parsedMarkerRound = Number(rawMarkerRound);
      const parsedMarkerAt = Number(rawMarkerAt);

      if (
        !Number.isFinite(parsedMarkerRound) ||
        parsedMarkerRound <= 0 ||
        !Number.isFinite(parsedMarkerAt) ||
        parsedMarkerAt <= 0
      ) {
        clearForwardHandoffMarker("invalid", {
          source,
          requestedRound: targetRequestedRound,
        });
        return false;
      }

      const markerRound = clampRound(parsedMarkerRound);
      const ageMs = Date.now() - parsedMarkerAt;

      if (ageMs < 0 || ageMs > FORWARD_HANDOFF_MAX_AGE_MS) {
        clearForwardHandoffMarker("expired", {
          source,
          requestedRound: targetRequestedRound,
          markerRound,
          ageMs,
        });
        return false;
      }

      if (markerRound !== targetRequestedRound) {
        clearForwardHandoffMarker("invalid", {
          source,
          requestedRound: targetRequestedRound,
          markerRound,
          ageMs,
        });
        return false;
      }

      console.log("[pods/page] accepting recent forward handoff to requested round", {
        source,
        requestedRound: targetRequestedRound,
        ageMs,
      });

      acceptedForwardHandoffRoundRef.current = targetRequestedRound;
      window.sessionStorage.removeItem(FORWARD_HANDOFF_ROUND_KEY);
      window.sessionStorage.removeItem(FORWARD_HANDOFF_AT_KEY);
      return true;
    },
    [clearForwardHandoffMarker]
  );

  const safeStatusMsg =
    !isPreLaunch() && statusMsg === PODS_LAUNCH_LABEL ? null : statusMsg;

  const isNightOver = isPodNightOver(city);
  const debugEnabled =
    process.env.NEXT_PUBLIC_PODS_DEBUG === "1" ||
    process.env.NEXT_PUBLIC_PODS_DEBUG === "true";

  const debugSnapshot: DebugSnapshot = {
    userId,
    city,
    podId,
    currentRound: safeCurrentRound,
    requestedRound,
    secondsToStart,
    isBeforeRoundStart: currentRoundTiming?.isBeforeRoundStart ?? false,
    isAfterRoundEnd: currentRoundTiming?.isAfterRoundEnd ?? false,
    isNightOver,
    isMatching,
    isWaiting,
  };

  const isFinalizingMatch =
    matchedRoomCommittedRef.current ||
    safeStatusMsg === FINALIZING_MATCH_LABEL ||
    isNavigatingToRoomRef.current;

  const canonicalStatusAllowsMatchPost =
    canonicalStatus.signedIn &&
    canonicalStatus.state === "none" &&
    isMatchablePodPhase(canonicalStatus.phase) &&
    canonicalStatus.canEnterRound &&
    canonicalStatus.entryWindowOpen &&
    canonicalStatus.podId === podId &&
    canonicalStatus.roundNumber === safeCurrentRound;
  const canonicalStatusAllowsManualEntry = canonicalStatusAllowsMatchPost;
  const effectiveIsNightOver =
    isNightOver && !canonicalStatusAllowsManualEntry;

  useEffect(() => {
    autoForwardInFlightRef.current = false;
    setStatusMsg((prev) =>
      prev === "Moving you forward..." ? null : prev
    );
  }, [currentRound]);

  const handleEntryWindowClosedAutoForward = useCallback(() => {
    if (!canonicalStatus.signedIn) return undefined;
    if (canonicalStatus.state !== "none") return undefined;
    if (canonicalStatus.phase !== "live") return undefined;
    if (canonicalStatus.entryWindowOpen) return undefined;
    if (canonicalStatus.podId !== podId) return undefined;
    if (canonicalStatus.roundNumber !== safeCurrentRound) return undefined;
    if (isWaiting || isMatching) return undefined;
    if (isNavigatingToRoomRef.current) return undefined;
    if (isFinalizingMatch) return undefined;
    if (recoveryPhase !== "ready") return undefined;
    if (autoForwardInFlightRef.current) return undefined;

    autoForwardInFlightRef.current = true;
    let cancelled = false;

    void (async () => {
      console.log("[pods/page] auto-forward due to entry window closed", {
        currentRound: safeCurrentRound,
        nextRound: latestPodStatusRef.current.nextRound,
        canonicalPhase: canonicalStatus.phase,
        state: canonicalStatus.state,
      });

      setStatusMsg("Moving you forward...");

      await sleep(400);

      if (cancelled) return;

      const latestStatus = latestPodStatusRef.current;

      if (
        !latestStatus.signedIn ||
        latestStatus.state !== "none" ||
        latestStatus.canonicalPhase !== "live" ||
        latestStatus.entryWindowOpen ||
        latestStatus.podId !== podId ||
        latestStatus.roundNumber !== safeCurrentRound ||
        isNavigatingToRoomRef.current ||
        matchedRoomCommittedRef.current
      ) {
        return;
      }

      clearMatchAttemptState();
      setIsWaiting(false);
      setIsMatching(false);
      resetRetryState();

      if (latestStatus.nextRound) {
        const nextRound = latestStatus.nextRound;
        acceptedForwardHandoffRoundRef.current = nextRound;
        writeForwardHandoffMarker(nextRound);
        syncLobbyStateForRound(nextRound, city);
        return;
      }

      router.replace("/pods/done");
    })();

    return () => {
      cancelled = true;
    };
  }, [
    city,
    canonicalStatus,
    isFinalizingMatch,
    isMatching,
    isWaiting,
    podId,
    recoveryPhase,
    router,
    safeCurrentRound,
  ]);

  useEffect(() => handleEntryWindowClosedAutoForward(), [
    handleEntryWindowClosedAutoForward,
  ]);

  const handleSupportSubmit = async () => {
    if (!supportMessage.trim()) {
      setSupportError("Please enter a message.");
      return;
    }

    setSupportError("");
    setIsSubmittingSupport(true);

    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: supportMessage.trim(),
          email: supportEmail.trim() || null,
          page: "/pods",
          city,
          podId,
          roundNumber: safeCurrentRound,
          userId,
          debug_context: {
            isWaiting,
            pathname:
              typeof window !== "undefined" ? window.location.pathname : "/pods",
            timestamp: new Date().toISOString(),
          },
        }),
      });

      const data = await res.json();

      if (data.ok) {
        setSupportSuccess(true);
        setSupportMessage("");
        setSupportEmail("");
      } else {
        setSupportError(data.error || "Something went wrong. Please try again.");
      }
    } catch (error) {
      console.error("SUPPORT SUBMIT ERROR", error);
      setSupportError("Something went wrong. Please try again.");
    } finally {
      setIsSubmittingSupport(false);
    }
  };

  async function loadProfileForUser(profileUserId: string) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, first_name, city, onboarding_complete")
      .eq("id", profileUserId)
      .maybeSingle();

    const profile = (data as ProfileRow | null) ?? null;

    if (error) {
      const recoverable = isRecoverableAuthLockError(error);

      if (recoverable) {
        console.warn("LOAD PROFILE QUERY RECOVERABLE LOCK ERROR", {
          profileUserId,
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });

        return {
          ok: false as const,
          reason: "recoverable_auth_lock" as const,
        };
      }

      console.error("LOAD PROFILE QUERY ERROR", {
        profileUserId,
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
      });

      return {
        ok: false as const,
        reason: "query_error" as const,
      };
    }

    if (!profile) {
      console.warn("PROFILE NOT FOUND", { profileUserId });
      return {
        ok: false as const,
        reason: "missing_profile" as const,
      };
    }

    if (!profile.onboarding_complete) {
      console.warn("PROFILE INCOMPLETE", {
        profileUserId,
        onboarding_complete: profile.onboarding_complete,
      });

      return {
        ok: false as const,
        reason: "incomplete_profile" as const,
      };
    }

    return {
      ok: true as const,
      profile,
    };
  }

  function clearPollingTimeout() {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
  }

  function scheduleNextPoll(run: () => Promise<void>) {
    clearPollingTimeout();
    pollTimeoutRef.current = setTimeout(() => {
      void run();
    }, MATCH_POLL_INTERVAL_MS);
  }

  function resetRetryState() {
    setEnteredAt(null);
    setShowRetry(false);
    retryWindowOpenedRef.current = false;
  }

  const resetRecoveryFlow = useCallback(() => {
    setRecoveryPhase("ready");
  }, []);

  function markMatchAttemptStarted() {
    setHasStartedMatchAttempt(true);
  }

  function clearMatchAttemptState() {
    if (enterAttemptCommittedRef.current || enterAttemptActiveRef.current) {
      enterAttemptCommittedRef.current = false;
      enterAttemptActiveRef.current = false;
      console.log("[pods/page] enter attempt cleared on terminal reset");
    }
    setHasStartedMatchAttempt(false);
  }

  const setExpiredRecoveryState = useCallback(() => {
    clearMatchAttemptState();
    setRecoveryPhase("login_required");
    setStatusMsg("Your session expired or couldn't be verified.");
  }, []);

  const setRecoveryFailureState = useCallback(() => {
    clearMatchAttemptState();
    setRecoveryPhase("retryable_error");
    setStatusMsg("We couldn't reconnect you yet.");
  }, []);

  function clearTransientStatus() {
    setStatusMsg((prev) => {
      if (
        prev === "Checking your session..." ||
        prev === "Checking your pod status..." ||
        prev === "Finding your pod for round 1..." ||
        prev === "Finding your pod for round 2..." ||
        prev === "Finding your pod for round 3..." ||
        prev === "Waiting for your match..." ||
        prev === "Retrying..." ||
        prev === FINALIZING_MATCH_LABEL ||
        prev === "Reconnecting your session..." ||
        prev === "Restoring your session..."
      ) {
        return null;
      }

      return prev;
    });
  }

  function stopLobbyActivity() {
    clearPollingTimeout();
    pollRequestInFlightRef.current = false;
    backgroundStatusPollRef.current = false;
    requestInFlightRef.current = false;
    matchedRoomCommittedRef.current = false;
    clearMatchAttemptState();
    setIsWaiting(false);
    setIsMatching(false);
    resetRetryState();
  }

  function syncLobbyStateForRound(nextRound: number, _targetCity: string | null) {
    void _targetCity;
    const safeNextRound = clampRound(nextRound);

    acceptedForwardHandoffRoundRef.current = safeNextRound;
    writeForwardHandoffMarker(safeNextRound);
    clearPollingTimeout();
    matchedRoomCommittedRef.current = false;
    clearMatchAttemptState();
    isNavigatingToRoomRef.current = false;
    setCurrentRound(safeNextRound);
    setIsWaiting(false);
    setIsMatching(false);
    setRecoveryPhase("ready");
    setErrorMsg(null);
    resetRetryState();
    clearTransientStatus();
    router.replace(`/pods?round=${safeNextRound}`);
  }

  const routeToDone = useCallback(
    (targetCity?: string | null) => {
      stopLobbyActivity();
      isNavigatingToRoomRef.current = false;
      setCurrentRound(1);
      setRecoveryPhase("ready");
      setErrorMsg(null);
      setStatusMsg(`Next pod opens ${getNextPodOpenLabel(targetCity ?? city)}`);
    },
    [city]
  );

  const finalizeMatchedNavigation = useCallback(
    (stableRoomId: string, stableRoundNumber: number) => {
      if (matchedRoomCommittedRef.current && isNavigatingToRoomRef.current) {
        console.log(
          "[pods/page] matched navigation already committed, skipping duplicate lobby updates"
        );
        return;
      }

      logPodsDebug("before routing to /pods/[roomId]", {
        ...debugSnapshot,
        currentRound: stableRoundNumber,
      });

      matchedRoomCommittedRef.current = true;
      clearPollingTimeout();
      pollRequestInFlightRef.current = false;
      backgroundStatusPollRef.current = false;
      requestInFlightRef.current = false;
      clearMatchAttemptState();
      isNavigatingToRoomRef.current = true;
      setRecoveryPhase("navigating");
      setCurrentRound(stableRoundNumber);
      setIsWaiting(false);
      setIsMatching(false);
      setErrorMsg(null);
      resetRetryState();
      setStatusMsg("Match found. Entering your pod...");

      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(
          MATCHED_ROOM_HANDOFF_ROOM_KEY,
          stableRoomId
        );
        window.sessionStorage.setItem(
          MATCHED_ROOM_HANDOFF_AT_KEY,
          new Date().toISOString()
        );
      }

      router.push(`/pods/${stableRoomId}?round=${stableRoundNumber}`);
    },
    [debugSnapshot, router]
  );

  const handleMatched = useCallback(
    async (
      candidateRoomId: string,
      matchedRoundNumber: number,
      options?: { allowOlderRoundRestore?: boolean; canonical?: boolean }
    ) => {
      if (matchedRoomCommittedRef.current) {
        console.log(
          "[pods/page] matched navigation already committed, skipping duplicate lobby updates"
        );
        return true;
      }

      if (isNavigatingToRoomRef.current) return true;

      const allowOlderRoundRestore = options?.allowOlderRoundRestore ?? true;
      const forwardHandoffRound =
        validatedRequestedRound ?? acceptedForwardHandoffRoundRef.current;
      const skipRestoreMarker = getSkipRestoreMarker();
      const shouldSkipMarkedRestore =
        skipRestoreMarker?.roomId === candidateRoomId &&
        skipRestoreMarker.roundNumber === matchedRoundNumber;
      const shouldIgnoreOldMatch =
        !allowOlderRoundRestore &&
        forwardHandoffRound !== null &&
        forwardHandoffRound > matchedRoundNumber;

      if (shouldSkipMarkedRestore || shouldIgnoreOldMatch) {
        setSkipRestoreMarker(candidateRoomId, matchedRoundNumber);
        console.log("[pods/page] skipping matched room restore during handoff", {
          candidateRoomId,
          matchedRoundNumber,
          forwardHandoffRound,
          shouldSkipMarkedRestore,
          shouldIgnoreOldMatch,
        });
        isNavigatingToRoomRef.current = false;
        if (forwardHandoffRound !== null) {
          setCurrentRound(forwardHandoffRound);
        }
        setIsWaiting(false);
        setIsMatching(false);
        setErrorMsg(null);
        resetRetryState();
        clearTransientStatus();
        setRecoveryPhase("ready");
        return false;
      }

      if (hasNightFinished(matchedRoundNumber) || isPodNightOver(city)) {
        routeToDone(city);
        return true;
      }

      console.log("[pods/page] canonical matched room found, routing immediately");
      finalizeMatchedNavigation(candidateRoomId, matchedRoundNumber);
      return true;
    },
    [city, finalizeMatchedNavigation, validatedRequestedRound, routeToDone]
  );

  const checkForMatchedStatus = useCallback(
    async (
      expectedPodId: string,
      fallbackRound: number,
      options?: { allowOlderRoundRestore?: boolean; canonical?: boolean }
    ) => {
      void expectedPodId;

      if (matchedRoomCommittedRef.current || isNavigatingToRoomRef.current) {
        return true;
      }

      const { res, data } = await fetchPodStatus();

      if (!res.ok || !isPodStatusResponse(data) || !data.ok) {
        clearCanonicalPodStatus();
        return false;
      }
      applyCanonicalPodStatus(data);
      if (!data.signedIn) return false;

      if (data.state === "matched" && data.roomId) {
        return await handleMatched(
          data.roomId,
          data.roundNumber ?? fallbackRound,
          {
            ...options,
            canonical: true,
          }
        );
      }

      return false;
    },
    [handleMatched]
  );

  const hydratePodState = useCallback(
    async (
      nextPodId: string,
      targetCity?: string | null
    ): Promise<RecoveryAttemptResult> => {
      try {
        const { res, data } = await fetchPodStatus();

        if (!res.ok || !isPodStatusResponse(data) || !data.ok) {
          console.error("PODS STATUS FAILED", {
            status: res.status,
            statusText: res.statusText,
            data,
            message: getFriendlyPodStatusError(
              data,
              `Could not load pod status. (${res.status})`
            ),
          });

          setCurrentRound(1);
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          clearTransientStatus();
          setRecoveryPhase("retryable_error");
          return "recovery_failed";
        }

        applyCanonicalPodStatus(data);

        if (!data.signedIn) {
          setCurrentRound(1);
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          clearTransientStatus();
          setExpiredRecoveryState();
          return "login_required";
        }

        if (data.state === "closedForTonight" || data.closedForTonight) {
          routeToDone(targetCity ?? city);
          return "success";
        }

        if (data.prelaunch || isPreLaunch()) {
          setCurrentRound(1);
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          setStatusMsg(data.launchLabel || PODS_LAUNCH_LABEL);
          setRecoveryPhase("ready");
          return "success";
        }

        const serverPodId = data.podId ?? null;
        const effectiveCity = targetCity ?? city;
        const timingSafeLobbyRound = getTimingSafeLobbyRound(effectiveCity);
        const canonicalServerRound = clampRound(
          data.currentRound ?? data.roundNumber ?? timingSafeLobbyRound
        );
        const activeSessionRound =
          data.hasActiveSession && (data.state === "waiting" || data.state === "matched")
            ? clampRound(data.roundNumber ?? canonicalServerRound)
            : null;
        const recentForwardHandoff =
          acceptedForwardHandoffRoundRef.current === requestedRound ||
          consumeRecentForwardHandoff(requestedRound, "hydratePodState");
        const pinnedRequestedRound = getPinnedRequestedRound(
          effectiveCity,
          requestedRound,
          {
            canonicalRound: canonicalServerRound,
            activeSessionRound,
            recentForwardHandoff,
            source: "hydratePodState",
          }
        );
        const pinnedForwardRequestedRound =
          pinnedRequestedRound !== null &&
          pinnedRequestedRound > (activeSessionRound ?? canonicalServerRound)
            ? pinnedRequestedRound
            : null;
        const serverRound = activeSessionRound ?? canonicalServerRound;

        if (hasNightFinished(serverRound) || isPodNightOver(effectiveCity)) {
          routeToDone(effectiveCity);
          return "success";
        }

        if (
          data.hasActiveSession &&
          serverPodId &&
          serverPodId === nextPodId &&
          (data.state === "waiting" || data.state === "matched")
        ) {
          if (pinnedForwardRequestedRound !== null) {
            if (data.state === "matched" && data.roomId) {
              setSkipRestoreMarker(data.roomId, serverRound);
            }

            console.warn(
              "[pods/page] preserving requested forward handoff over stale active session",
              {
                state: data.state,
                serverPodId,
                nextPodId,
                serverRound,
                pinnedForwardRequestedRound,
              }
            );

            clearMatchAttemptState();
            isNavigatingToRoomRef.current = false;
            setCurrentRound(pinnedForwardRequestedRound);
            setIsWaiting(false);
            setIsMatching(false);
            resetRetryState();
            clearTransientStatus();
            setRecoveryPhase("ready");
            return "success";
          }

          const resolvedRound = serverRound;
          const restorableSession = getRestorableSessionState(
            effectiveCity,
            resolvedRound,
            data.state
          );

          if (hasNightFinished(resolvedRound) || isPodNightOver(effectiveCity)) {
            routeToDone(effectiveCity);
            return "success";
          }

          if (!restorableSession.ok) {
            console.warn("[pods/page] rejected stale restored active session", {
              state: data.state,
              serverPodId,
              nextPodId,
              serverRound,
              resolvedRound,
              reason: restorableSession.reason,
              timingSafeLobbyRound,
            });

            if (
              pinnedRequestedRound === null &&
              requestedRound !== null &&
              requestedRound !== canonicalServerRound &&
              !recentForwardHandoff
            ) {
              syncUrlToCanonicalRound(canonicalServerRound, "hydratePodState");
            }

            clearMatchAttemptState();
            isNavigatingToRoomRef.current = false;
            setCurrentRound(
              pinnedRequestedRound !== null
                ? pinnedRequestedRound
                : canonicalServerRound
            );
            setIsWaiting(false);
            setIsMatching(false);
            resetRetryState();
            clearTransientStatus();
            setRecoveryPhase("ready");
            return "success";
          }

          setCurrentRound(restorableSession.round);

          if (data.state === "matched" && data.roomId) {
            await handleMatched(data.roomId, restorableSession.round, {
              allowOlderRoundRestore: false,
              canonical: true,
            });
            return "success";
          }

          if (data.state === "waiting") {
            const waitingRoundTiming = restorableSession.roundTiming;

            if (
              waitingRoundTiming.isBeforeRoundStart &&
              !canStayInLobbyBeforeRoundStart(
                effectiveCity,
                restorableSession.round
              )
            ) {
              clearMatchAttemptState();
              setIsWaiting(false);
              setIsMatching(false);
              resetRetryState();
              clearTransientStatus();
              setRecoveryPhase("ready");
              return "success";
            }

            markMatchAttemptStarted();
            setIsWaiting(true);
            setEnteredAt((prev) => prev ?? Date.now());
            setStatusMsg(
              canStayInLobbyBeforeRoundStart(
                effectiveCity,
                restorableSession.round
              )
                ? "Entering tonight's lobby..."
                : "Waiting for your match..."
            );
            setRecoveryPhase("ready");
            return "success";
          }

          clearMatchAttemptState();
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          clearTransientStatus();
          setRecoveryPhase("ready");
          return "success";
        }

        if (pinnedRequestedRound !== null) {
          clearMatchAttemptState();
          setCurrentRound(pinnedRequestedRound);
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          clearTransientStatus();
          setRecoveryPhase("ready");

          return "success";
        }

        if (
          requestedRound !== null &&
          requestedRound !== canonicalServerRound &&
          !recentForwardHandoff
        ) {
          console.log("[pods/page] falling back to canonical timing round", {
            source: "hydratePodState",
            requestedRound,
            canonicalRound: canonicalServerRound,
            timingSafeLobbyRound,
          });
          syncUrlToCanonicalRound(canonicalServerRound, "hydratePodState");
        }

        clearMatchAttemptState();
        setCurrentRound(canonicalServerRound);
        setIsWaiting(false);
        setIsMatching(false);
        resetRetryState();
        clearTransientStatus();
        setRecoveryPhase("ready");
        return "success";
      } catch (error) {
        console.error("PODS STATUS ERROR", error);
        setCurrentRound(targetCity ? getTimingSafeLobbyRound(targetCity) : 1);
        setIsWaiting(false);
        setIsMatching(false);
        resetRetryState();
        clearTransientStatus();
        setRecoveryPhase("retryable_error");
        return "recovery_failed";
      }
    },
    [
      city,
      requestedRound,
      routeToDone,
      router,
      setExpiredRecoveryState,
      handleMatched,
      consumeRecentForwardHandoff,
      syncUrlToCanonicalRound,
    ]
  );

  const resolveAuthAndProfile = useCallback(async (): Promise<RecoveryAttemptResult> => {
    if (bootstrapInFlightRef.current) {
      console.warn("[pods/page] bootstrap skipped because another restore is active");
      return "success";
    }

    bootstrapInFlightRef.current = true;
    setErrorMsg(null);

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const {
            data: { user },
            error: userError,
          } = await supabase.auth.getUser();

          if (userError) {
            if (isRecoverableAuthLockError(userError)) {
              console.warn("[pods/page] recoverable auth lock contention", {
                message: userError.message,
                name: userError.name,
              });

              if (attempt < 2) {
                await sleep(300);
                continue;
              }

              setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
              return "recovery_failed";
            }

            console.error("PODS USER ERROR", userError);
          }

          if (user) {
            const profileResult = await loadProfileForUser(user.id);

            if (!profileResult.ok && profileResult.reason === "recoverable_auth_lock") {
              console.warn("[pods/page] recoverable profile load lock contention", {
                userId: user.id,
              });

              if (attempt < 2) {
                await sleep(300);
                continue;
              }

              setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
              return "recovery_failed";
            }

            if (!profileResult.ok) {
              if (!redirectedRef.current) {
                redirectedRef.current = true;
                router.replace("/signup");
              }
              return "recovery_failed";
            }

            const nextCity = profileResult.profile.city ?? null;
            const nextPodId = getPodIdForCurrentSession(nextCity);

            setUserId(user.id);
            setFirstName(profileResult.profile.first_name ?? null);
            setCity(nextCity);
            setPodId(nextPodId);
            setAuthChecked(true);

            logPodsDebug("after auth/profile bootstrap", {
              userId: user.id,
              city: nextCity,
              podId: nextPodId,
              currentRound: 1,
              requestedRound,
              secondsToStart: getRoundTiming(nextCity, requestedRound ?? 1)
                .secondsUntilRoundStart,
              isBeforeRoundStart: getRoundTiming(nextCity, requestedRound ?? 1)
                .isBeforeRoundStart,
              isAfterRoundEnd: getRoundTiming(nextCity, requestedRound ?? 1)
                .isAfterRoundEnd,
              isNightOver: isPodNightOver(nextCity),
              isMatching: false,
              isWaiting: false,
            });

            return await hydratePodState(nextPodId, nextCity);
          }
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            isRecoverableAuthLockError(error as {
              name?: string | null;
              message?: string | null;
              details?: string | null;
              hint?: string | null;
              code?: string | null;
            })
          ) {
            console.warn("[pods/page] recoverable auth restore abort", error);

            if (attempt < 2) {
              await sleep(300);
              continue;
            }

            setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
            return "recovery_failed";
          }

          throw error;
        }

        if (attempt < 2) {
          await sleep(300);
        }
      }

      return "login_required";
    } finally {
      bootstrapInFlightRef.current = false;
    }
  }, [hydratePodState, requestedRound, router]);

  const handleRestoreStall = useCallback(() => {
    if (isNavigatingToRoomRef.current) return;

    if (!authChecked || !userId) {
      setExpiredRecoveryState();
      return;
    }

    setRecoveryFailureState();
  }, [authChecked, setExpiredRecoveryState, setRecoveryFailureState, userId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPollingTimeout();
      if (bootstrapTimeoutRef.current) {
        clearTimeout(bootstrapTimeoutRef.current);
        bootstrapTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const storedValue = window.sessionStorage.getItem("pods_refresh_attempts");
    const parsedValue = storedValue ? Number(storedValue) : 0;

    if (Number.isFinite(parsedValue) && parsedValue >= 0) {
      setRefreshAttempts(parsedValue);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    if (window.sessionStorage.getItem("pods_has_seen_reveal") === "1") {
      setHasSeenReveal(true);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.sessionStorage.setItem(
      "pods_refresh_attempts",
      String(refreshAttempts)
    );
  }, [refreshAttempts]);

  useEffect(() => {
    if (!isBootstrapping) {
      if (bootstrapTimeoutRef.current) {
        clearTimeout(bootstrapTimeoutRef.current);
        bootstrapTimeoutRef.current = null;
      }
      return;
    }

    if (bootstrapTimeoutRef.current) {
      clearTimeout(bootstrapTimeoutRef.current);
    }

    bootstrapTimeoutRef.current = setTimeout(() => {
      console.warn("[pods/page] bootstrap watchdog forcing lobby render");
      handleRestoreStall();
    }, 4000);

    return () => {
      if (bootstrapTimeoutRef.current) {
        clearTimeout(bootstrapTimeoutRef.current);
        bootstrapTimeoutRef.current = null;
      }
    };
  }, [handleRestoreStall, isBootstrapping]);

  useEffect(() => {
    if (isBootstrapping || userId) return;

    setStatusMsg(
      requiresLogin
        ? "Your session expired or couldn't be verified."
        : "We couldn't reconnect you yet."
    );
  }, [isBootstrapping, requiresLogin, userId]);

  useEffect(() => {
    void consumeRecentForwardHandoff(requestedRound, "requestedRoundPrime");
  }, [consumeRecentForwardHandoff, requestedRound]);

  const handleIdleRoundSync = useCallback(() => {
    if (requestedRound === null) return;
    if (isFinalizingMatch || isNavigatingToRoomRef.current) return;
    if (
      isWaiting ||
      isMatching ||
      hasStartedMatchAttempt ||
      requestInFlightRef.current
    ) {
      return;
    }

    const recentForwardHandoff =
      acceptedForwardHandoffRoundRef.current === requestedRound ||
      consumeRecentForwardHandoff(requestedRound, "idleRoundSync");
    const pinnedRequestedRound = getPinnedRequestedRound(city, requestedRound, {
      canonicalRound: Math.max(safeCurrentRound, timingSafeLobbyRound),
      recentForwardHandoff,
      source: "idleRoundSync",
    });

    if (pinnedRequestedRound === null) {
      if (recentForwardHandoff) {
        setCurrentRound(requestedRound);
        setRecoveryPhase("ready");
        isNavigatingToRoomRef.current = false;
        return;
      }
      syncUrlToCanonicalRound(safeCurrentRound, "idleRoundSync");
      return;
    }
    if (pinnedRequestedRound === safeCurrentRound) return;

    setCurrentRound(pinnedRequestedRound);
    isNavigatingToRoomRef.current = false;
  }, [
    city,
    requestedRound,
    safeCurrentRound,
    timingSafeLobbyRound,
    isFinalizingMatch,
    isWaiting,
    isMatching,
    hasStartedMatchAttempt,
    consumeRecentForwardHandoff,
    syncUrlToCanonicalRound,
  ]);

  useEffect(() => {
    handleIdleRoundSync();
  }, [handleIdleRoundSync]);

  useEffect(() => {
    const interval = setInterval(() => {
      setNowTick((prev) => prev + 1);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!city) {
      setSecondsToStart(null);
      return;
    }

    const updatePodIdentity = () => {
      setPodId(getPodIdForCurrentSession(city));
    };

    updatePodIdentity();

    const interval = setInterval(updatePodIdentity, 1000);
    return () => clearInterval(interval);
  }, [city]);

  useEffect(() => {
    if (!city || isPreLaunch()) return;
    if (effectiveIsNightOver) return;

    const roundTiming = getRoundTiming(city, safeCurrentRound);

    if (
      roundTiming.isBeforeRoundStart &&
      isWaiting &&
      !canStayInLobbyBeforeRoundStart(city, safeCurrentRound)
    ) {
      clearMatchAttemptState();
      setIsWaiting(false);
      setIsMatching(false);
      resetRetryState();
      clearTransientStatus();
    }
  }, [city, safeCurrentRound, isWaiting, nowTick, effectiveIsNightOver]);

  useEffect(() => {
    if (!isPreLaunch() && statusMsg === PODS_LAUNCH_LABEL) {
      setStatusMsg(null);
    }
  }, [statusMsg]);

  useEffect(() => {
    if (!effectiveIsNightOver) return;
    stopLobbyActivity();
    setCurrentRound(1);
    setStatusMsg(`Next pod opens ${getNextPodOpenLabel(city)}`);
  }, [city, effectiveIsNightOver]);

  useEffect(() => {
    if (!city) return;

    const update = () => {
      const secs = getSecondsUntilNextPodOpen(city);
      setSecondsToNextPod(secs);

      if (secs <= 0) {
        setIsWaiting(false);
        setIsMatching(false);
      }
    };

    update();

    const interval = setInterval(update, 1000);

    return () => clearInterval(interval);
  }, [city]);

  useEffect(() => {
    if (
      (!enterAttemptCommittedRef.current &&
        !enterAttemptActiveRef.current &&
        !isWaiting &&
        !isMatching &&
        !hasStartedMatchAttempt) ||
      !enteredAt
    ) {
      setShowRetry(false);
      return;
    }

    const updateRetryWindow = () => {
      const elapsed = Date.now() - enteredAt;

      const shouldShowRetryWindow =
        elapsed >= SEARCH_WINDOW_MS && elapsed < AUTO_ADVANCE_AFTER_MS;

      if (shouldShowRetryWindow && !retryWindowOpenedRef.current) {
        retryWindowOpenedRef.current = true;
        console.log("[pods/page] retry window opened");
      }

      setShowRetry(shouldShowRetryWindow);
    };

    updateRetryWindow();

    const interval = setInterval(() => {
      updateRetryWindow();
    }, 1000);

    return () => clearInterval(interval);
  }, [isWaiting, isMatching, hasStartedMatchAttempt, enteredAt]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (bootstrapStartedRef.current) return;
      bootstrapStartedRef.current = true;
      setRecoveryPhase("bootstrapping");

      try {
        const resolved = await resolveAuthAndProfile();

        if (cancelled) return;

        if (resolved === "success" || isNavigatingToRoomRef.current) {
          return;
        }

        if (resolved === "login_required") {
          setExpiredRecoveryState();
          return;
        }

        setRecoveryFailureState();
      } catch (error) {
        if (!cancelled) {
          console.error("PODS BOOTSTRAP ERROR", error);
          setErrorMsg("Could not load your pod session.");
          setRecoveryFailureState();
        }
      }
    }

    void bootstrap();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (cancelled || isNavigatingToRoomRef.current) return;

      if (event === "SIGNED_OUT") {
        setUserId(null);
        setFirstName(null);
        setCity(null);
        setSecondsToStart(null);
        setPodId("");
        setAuthChecked(false);
        stopLobbyActivity();
        setExpiredRecoveryState();
        return;
      }

      if (!session?.user) {
        setExpiredRecoveryState();
        setUserId(null);
        setFirstName(null);
        setCity(null);
        setSecondsToStart(null);
        setPodId("");
        setAuthChecked(false);
        stopLobbyActivity();
        return;
      }

      if (bootstrapInFlightRef.current) {
        if (!hasLoggedAuthRestoreSkipRef.current) {
          hasLoggedAuthRestoreSkipRef.current = true;
          console.warn(
            "[pods/page] auth state restore skipped because another restore is active",
            { event }
          );
        }
        return;
      }

      bootstrapInFlightRef.current = true;

      try {
        const profileResult = await loadProfileForUser(session.user.id);

        if (!profileResult.ok && profileResult.reason === "recoverable_auth_lock") {
          console.warn("[pods/page] recoverable profile load lock contention", {
            userId: session.user.id,
          });
          setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
          setRecoveryFailureState();
          return;
        }

        if (!profileResult.ok) {
          if (!redirectedRef.current) {
            redirectedRef.current = true;
            router.replace("/signup");
          }
          return;
        }

        const nextCity = profileResult.profile.city ?? null;
        const nextPodId = getPodIdForCurrentSession(nextCity);

        setUserId(session.user.id);
        setFirstName(profileResult.profile.first_name ?? null);
        setCity(nextCity);
        setPodId(nextPodId);
        setAuthChecked(true);

        await hydratePodState(nextPodId, nextCity);
      } catch (error) {
        if (cancelled) return;

        if (
          error &&
          typeof error === "object" &&
          isRecoverableAuthLockError(error as {
            name?: string | null;
            message?: string | null;
            details?: string | null;
            hint?: string | null;
            code?: string | null;
          })
        ) {
          console.warn("[pods/page] auth state change restore lock contention", error);
          setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
          setRecoveryFailureState();
          return;
        }

        console.error("[pods/page] auth state restore failed", error);
        setErrorMsg("Could not restore your pod session.");
        setRecoveryFailureState();
      } finally {
        bootstrapInFlightRef.current = false;
      }
    });

    return () => {
      cancelled = true;
      clearPollingTimeout();
      subscription.unsubscribe();
    };
  }, [hydratePodState, resolveAuthAndProfile, router, setExpiredRecoveryState, setRecoveryFailureState]);

  useEffect(() => {
    if (isBootstrapping) return;
    if (!authChecked || !podId) return;
    if (isNavigatingToRoomRef.current) return;
    if (isFinalizingMatch) return;
    if (effectiveIsNightOver) return;

    let cancelled = false;

    const recoverMatchedSession = async () => {
      try {
        const { res, data } = await fetchPodStatus();

        if (cancelled) return;

        if (
          res.ok &&
          isPodStatusResponse(data) &&
          data.ok &&
          data.signedIn &&
          data.state === "matched" &&
          data.roomId
        ) {
          await handleMatched(data.roomId, data.roundNumber ?? safeCurrentRound, {
            allowOlderRoundRestore: false,
            canonical: true,
          });
        }
      } catch (error) {
        if (!cancelled) {
          console.error("[pods/page] post-bootstrap matched recovery failed", error);
        }
      }
    };

    void recoverMatchedSession();

    return () => {
      cancelled = true;
    };
  }, [
    authChecked,
    handleMatched,
    isBootstrapping,
    isFinalizingMatch,
    effectiveIsNightOver,
    podId,
    safeCurrentRound,
    validatedRequestedRound,
  ]);

  useEffect(() => {
    if (isPreLaunch()) {
      clearPollingTimeout();
      return;
    }

    if (!authChecked || !userId || !isWaiting || !podId || !city) {
      clearPollingTimeout();
      return;
    }

    if (isFinalizingMatch || isNavigatingToRoomRef.current || effectiveIsNightOver) {
      clearPollingTimeout();
      return;
    }

    let cancelled = false;

    const pollOnce = async () => {
      if (isFinalizingMatch) {
        clearPollingTimeout();
        return;
      }

      if (cancelled || isNavigatingToRoomRef.current) return;
      if (pollRequestInFlightRef.current) return;

      if (isPodNightOver(city)) {
        clearPollingTimeout();
        routeToDone(city);
        return;
      }

      pollRequestInFlightRef.current = true;

      try {
        const matchedFromStatus = await checkForMatchedStatus(
          podId,
          safeCurrentRound,
          { allowOlderRoundRestore: false }
        );

        if (cancelled || matchedFromStatus || isNavigatingToRoomRef.current) {
          return;
        }

        const latestStatus = latestPodStatusRef.current;
        const latestStatusAllowsMatchPost =
          ((latestStatus.state === "waiting" &&
            latestStatus.podId === podId &&
            latestStatus.roundNumber === safeCurrentRound) ||
            (isMatchablePodPhase(latestStatus.canonicalPhase) &&
              latestStatus.signedIn &&
              latestStatus.state === "none" &&
              latestStatus.canEnterRound &&
              latestStatus.entryWindowOpen &&
          latestStatus.podId === podId &&
              latestStatus.roundNumber === safeCurrentRound));

        if (!latestStatusAllowsMatchPost) {
          console.warn("[pods/page] match poll blocked by canonical status", {
            podId,
            roundNumber: safeCurrentRound,
            statusPodId: latestStatus.podId,
            statusRoundNumber: latestStatus.roundNumber,
            canonicalPhase: latestStatus.canonicalPhase,
            canEnterRound: latestStatus.canEnterRound,
            entryWindowOpen: latestStatus.entryWindowOpen,
            state: latestStatus.state,
            serverNow: latestStatus.serverNow,
          });

          clearPollingTimeout();
          clearMatchAttemptState();
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          clearTransientStatus();
          return;
        }

        const res = await fetch("/api/pods/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId,
            roundNumber: safeCurrentRound,
            podId,
          }),
          cache: "no-store",
        });

        const data = await parseApiResponse(res);

        if (cancelled || isNavigatingToRoomRef.current) return;

        if (!res.ok) {
          console.error("MATCH POLL FAILED", {
            status: res.status,
            statusText: res.statusText,
            data,
            currentRound: safeCurrentRound,
            podId,
          });

          const matchedAfterError = await checkForMatchedStatus(
            podId,
            safeCurrentRound,
            { allowOlderRoundRestore: false }
          );

          if (cancelled || matchedAfterError || isNavigatingToRoomRef.current) {
            return;
          }

          setStatusMsg("Waiting for your match...");
          scheduleNextPoll(pollOnce);
          return;
        }

        if (isMatchedResponse(data)) {
          const shouldIgnoreOldMatch =
            validatedRequestedRound !== null &&
            validatedRequestedRound > data.roundNumber;

          if (!shouldIgnoreOldMatch) {
            await handleMatched(data.roomId, data.roundNumber, {
              allowOlderRoundRestore: false,
            });
            return;
          }
        }

        const matchedAfterPoll = await checkForMatchedStatus(
          podId,
          safeCurrentRound,
          { allowOlderRoundRestore: false }
        );

        if (cancelled || matchedAfterPoll || isNavigatingToRoomRef.current) {
          return;
        }

        if (isNoMatchResponse(data)) {
          clearPollingTimeout();
          if (data.reveal) {
            routeToDone(city);
            return;
          }

          if (data.nextRound) {
            syncLobbyStateForRound(data.nextRound, city);
            return;
          }

          setIsMatching(false);
          setIsWaiting(false);
          setErrorMsg(null);
          setStatusMsg(data.message ?? null);
          return;
        }

        if (isWaitingResponse(data)) {
          const newestTiming = getRoundTiming(city, safeCurrentRound);

          if (
            newestTiming.isBeforeRoundStart &&
            !canStayInLobbyBeforeRoundStart(city, safeCurrentRound)
          ) {
            clearMatchAttemptState();
            setIsWaiting(false);
            setIsMatching(false);
            resetRetryState();
            clearTransientStatus();
            return;
          }

          markMatchAttemptStarted();
          setEnteredAt((prev) => prev ?? Date.now());
          setIsWaiting(true);
          setIsMatching(false);
          setStatusMsg(
            canStayInLobbyBeforeRoundStart(city, safeCurrentRound)
              ? "Entering tonight's lobby..."
              : "Waiting for your match..."
          );
          scheduleNextPoll(pollOnce);
          return;
        }

        console.error("MATCH POLL UNEXPECTED RESPONSE", data);
        scheduleNextPoll(pollOnce);
      } catch (error) {
        if (cancelled || isNavigatingToRoomRef.current) return;
        console.error("MATCH POLL ERROR", error);

        const matchedAfterCatch = await checkForMatchedStatus(
          podId,
          safeCurrentRound,
          { allowOlderRoundRestore: false }
        );

        if (cancelled || matchedAfterCatch || isNavigatingToRoomRef.current) {
          return;
        }

        scheduleNextPoll(pollOnce);
      } finally {
        pollRequestInFlightRef.current = false;
      }
    };

    clearPollingTimeout();
    void pollOnce();

    return () => {
      cancelled = true;
      clearPollingTimeout();
      pollRequestInFlightRef.current = false;
    };
  }, [
    authChecked,
    city,
    handleMatched,
    isFinalizingMatch,
    effectiveIsNightOver,
    isWaiting,
    podId,
    requestedRound,
    routeToDone,
    safeCurrentRound,
    userId,
  ]);

  useEffect(() => {
    if (isPreLaunch()) return;
    if (!authChecked || !userId || !podId) return;
    if (isFinalizingMatch || isNavigatingToRoomRef.current || effectiveIsNightOver) return;

    let cancelled = false;

    const interval = setInterval(async () => {
      if (cancelled || isNavigatingToRoomRef.current || isFinalizingMatch) return;
      if (backgroundStatusPollRef.current) return;
      if (isPodNightOver(city)) return;

      backgroundStatusPollRef.current = true;
      try {
        await checkForMatchedStatus(podId, safeCurrentRound, {
          allowOlderRoundRestore: false,
        });
      } catch (error) {
        if (!cancelled) {
          console.error("[pods/page] background matched-status poll failed", error);
        }
      } finally {
        backgroundStatusPollRef.current = false;
      }
    }, 1500);

    return () => {
      cancelled = true;
      clearInterval(interval);
      backgroundStatusPollRef.current = false;
    };
  }, [
    authChecked,
    city,
    handleMatched,
    isFinalizingMatch,
    effectiveIsNightOver,
    podId,
    safeCurrentRound,
    userId,
  ]);

  useEffect(() => {
    if (!authChecked || !userId || !podId || !city) return;
    if (recoveryPhase !== "ready") return;
    if (isPreLaunch() || effectiveIsNightOver) return;
    if (isFinalizingMatch || isNavigatingToRoomRef.current) return;
    if (unmatchedAutoAdvanceInFlightRef.current) return;
    if (
      (!enterAttemptCommittedRef.current &&
        !enterAttemptActiveRef.current &&
        !hasStartedMatchAttempt &&
        !isWaiting &&
        !isMatching) ||
      !enteredAt
    ) {
      return;
    }

    const roundTiming = getRoundTiming(city, safeCurrentRound);

    if (roundTiming.isBeforeRoundStart) {
      return;
    }

    const elapsed = Date.now() - enteredAt;

    if (elapsed < AUTO_ADVANCE_AFTER_MS) {
      return;
    }

    let cancelled = false;

    const advanceUnmatchedUser = async () => {
      unmatchedAutoAdvanceInFlightRef.current = true;

      try {
        console.log("[pods/page] unmatched attempt reached auto-advance threshold");

        const matched = await checkForMatchedStatus(podId, safeCurrentRound, {
          allowOlderRoundRestore: false,
        });

        if (cancelled || isNavigatingToRoomRef.current) return;

        if (matched) {
          console.log(
            "[pods/page] canonical match found during retry/advance window"
          );
          return;
        }

        if (safeCurrentRound >= TOTAL_ROUNDS) {
          routeToDone(city);
          return;
        }

        console.log("[pods/page] auto-advancing unmatched user to next round");
        syncLobbyStateForRound(safeCurrentRound + 1, city);
      } finally {
        unmatchedAutoAdvanceInFlightRef.current = false;
      }
    };

    void advanceUnmatchedUser();

    return () => {
      cancelled = true;
    };
  }, [
    authChecked,
    checkForMatchedStatus,
    city,
    isFinalizingMatch,
    effectiveIsNightOver,
    isMatching,
    isWaiting,
    nowTick,
    podId,
    recoveryPhase,
    routeToDone,
    safeCurrentRound,
    syncLobbyStateForRound,
    enteredAt,
    hasStartedMatchAttempt,
    userId,
  ]);

  const handleEnterPod = useCallback(async () => {
    logPodsDebug("before handleEnterPod runs", debugSnapshot);

    if (isPreLaunch()) {
      clearMatchAttemptState();
      setErrorMsg(null);
      setStatusMsg(PODS_LAUNCH_LABEL);
      return;
    }

    if (enterAttemptCommittedRef.current) {
      console.log("[pods/page] duplicate enter click ignored");
      return;
    }

    if (
      requestInFlightRef.current ||
      isMatching ||
      isNavigatingToRoomRef.current
    ) {
      return;
    }

    if (effectiveIsNightOver) {
      stopLobbyActivity();
      setCurrentRound(1);
      setErrorMsg(null);
      setStatusMsg(`Next pod opens ${getNextPodOpenLabel(city)}`);
      return;
    }

    if (!userId) {
      setErrorMsg(AUTH_RESTORE_RETRY_MESSAGE);
      setRecoveryFailureState();
      return;
    }

    if (!podId && !city) {
      clearMatchAttemptState();
      setErrorMsg("Could not determine tonight’s pod session.");
      return;
    }

    enterAttemptCommittedRef.current = true;
    enterAttemptActiveRef.current = true;
    console.log("[pods/page] first enter click committed");

    markMatchAttemptStarted();
    setErrorMsg(null);
    setIsMatching(true);
    setEnteredAt((prev) => prev ?? Date.now());
    setShowRetry(false);
    requestInFlightRef.current = true;

    try {
      setStatusMsg("Checking your pod status...");
      const nextCity = city ?? null;
      const nextPodId = podId || getPodIdForCurrentSession(nextCity);

      if (nextPodId !== podId) {
        setPodId(nextPodId);
      }

      const { res: statusRes, data: statusData } = await fetchPodStatus();

      if (!statusRes.ok || !isPodStatusResponse(statusData) || !statusData.ok) {
        console.error("PRE-ENTER POD STATUS FAILED", {
          status: statusRes.status,
          statusText: statusRes.statusText,
          statusData,
          currentRound: safeCurrentRound,
          nextPodId,
          message: getFriendlyPodStatusError(
            statusData,
            `Could not load pod status. (${statusRes.status})`
          ),
        });

        clearMatchAttemptState();
        setIsMatching(false);
        setIsWaiting(false);
        resetRetryState();
        clearTransientStatus();
        setErrorMsg(
          getFriendlyPodStatusError(
            statusData,
            "Could not confirm pod timing. Please try again."
          )
        );
        return;
      }

      applyCanonicalPodStatus(statusData);

      if (!statusData.signedIn) {
        setExpiredRecoveryState();
        setIsMatching(false);
        setUserId(null);
        setAuthChecked(false);
        return;
      }

      if (
        statusData.state === "closedForTonight" ||
        statusData.closedForTonight
      ) {
        routeToDone(nextCity);
        return;
      }

      if (statusData.prelaunch) {
        clearMatchAttemptState();
        setIsMatching(false);
        setIsWaiting(false);
        resetRetryState();
        setStatusMsg(statusData.launchLabel || PODS_LAUNCH_LABEL);
        return;
      }

      const serverRound = getPodStatusRoundNumber(statusData) ?? safeCurrentRound;

      if (statusData.state === "matched" && statusData.roomId) {
        await handleMatched(statusData.roomId, serverRound, {
          allowOlderRoundRestore: false,
          canonical: true,
        });
        return;
      }

      if (statusData.state === "waiting") {
        setCurrentRound(serverRound);
        markMatchAttemptStarted();
        setIsWaiting(true);
        setIsMatching(false);
        setEnteredAt((prev) => prev ?? Date.now());
        setShowRetry(false);
        setStatusMsg("Waiting for your match...");
        return;
      }

      if (!canPostMatchForStatus(statusData, nextPodId, safeCurrentRound)) {
        console.warn("[pods/page] match request blocked by canonical status", {
          podId: nextPodId,
          roundNumber: safeCurrentRound,
          statusPodId: statusData.podId,
          statusRoundNumber: getPodStatusRoundNumber(statusData),
          canonicalPhase: getPodStatusCanonicalPhase(statusData),
          canEnterRound: statusData.canEnterRound === true,
          entryWindowOpen: statusData.entryWindowOpen === true,
          state: statusData.state,
          reason: statusData.reason ?? null,
          serverNow: statusData.serverNow ?? null,
        });

        clearMatchAttemptState();
        setIsMatching(false);
        setIsWaiting(false);
        resetRetryState();
        clearTransientStatus();
        setErrorMsg(null);
        return;
      }

      setStatusMsg(`Finding your pod for round ${safeCurrentRound}...`);

      if (!isWaiting && !isMatching) {
        console.log("[pods] forcing match attempt for round", safeCurrentRound);
      }

      const res = await fetch("/api/pods/match", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          userId,
          roundNumber: safeCurrentRound,
          podId: nextPodId,
        }),
        cache: "no-store",
      });

      const data = await parseApiResponse(res);

      if (!res.ok) {
        console.error("MATCH REQUEST FAILED", {
          status: res.status,
          statusText: res.statusText,
          data,
          currentRound: safeCurrentRound,
          podId: nextPodId,
        });

        const matchedAfterError = await checkForMatchedStatus(
          nextPodId,
          safeCurrentRound,
          { allowOlderRoundRestore: false }
        );
        if (matchedAfterError) return;

        const friendlyError = getFriendlyApiError(
          data,
          `Could not enter the pod right now. (${res.status})`
        );

        clearMatchAttemptState();
        setErrorMsg(friendlyError);
        setStatusMsg(null);
        setIsWaiting(false);
        resetRetryState();
        return;
      }

      if (isMatchedResponse(data)) {
        const shouldIgnoreOldMatch =
          validatedRequestedRound !== null &&
          validatedRequestedRound > data.roundNumber;

        if (!shouldIgnoreOldMatch) {
          await handleMatched(data.roomId, data.roundNumber, {
            allowOlderRoundRestore: false,
          });
          return;
        }
      }

      const matchedAfterEnter = await checkForMatchedStatus(
        nextPodId,
        safeCurrentRound,
        { allowOlderRoundRestore: false }
      );
      if (matchedAfterEnter) return;

      if (isNoMatchResponse(data)) {
        if (data.reveal) {
          routeToDone(nextCity);
          return;
        }

        if (data.nextRound) {
          syncLobbyStateForRound(data.nextRound, nextCity);
          return;
        }

        clearMatchAttemptState();
        setIsWaiting(false);
        setIsMatching(false);
        setErrorMsg(null);
        setStatusMsg(data.message ?? null);
        return;
      }

      if (isWaitingResponse(data)) {
        const { res: confirmRes, data: confirmData } = await fetchPodStatus();

        if (!confirmRes.ok || !isPodStatusResponse(confirmData) || !confirmData.ok) {
          clearMatchAttemptState();
          setIsWaiting(false);
          setIsMatching(false);
          resetRetryState();
          setStatusMsg(null);
          setErrorMsg("We couldn't confirm your queue state. Please try again.");
          return;
        }

        applyCanonicalPodStatus(confirmData);

        if (!confirmData.signedIn) {
          setExpiredRecoveryState();
          setIsMatching(false);
          setUserId(null);
          setAuthChecked(false);
          return;
        }

        if (confirmData.state === "matched" && confirmData.roomId) {
          await handleMatched(confirmData.roomId, confirmData.roundNumber ?? safeCurrentRound, {
            allowOlderRoundRestore: false,
            canonical: true,
          });
          return;
        }

        if (
          !hasCanonicalActiveQueueState(confirmData, nextPodId, safeCurrentRound) ||
          confirmData.state !== "waiting"
        ) {
          setIsWaiting(false);
          setIsMatching(false);
          setErrorMsg(null);
          requestInFlightRef.current = false;
          return;
        }

        markMatchAttemptStarted();
        setIsWaiting(true);
        setEnteredAt((prev) => prev ?? Date.now());
        setShowRetry(false);
        setIsMatching(false);
        setStatusMsg("Waiting for your match...");
        return;
      }

      console.error("UNEXPECTED MATCH RESPONSE", data);
      setErrorMsg(
        getFriendlyApiError(
          data,
          "Something unexpected happened. The match response was not valid."
        )
      );
      clearMatchAttemptState();
      setStatusMsg(null);
      setIsWaiting(false);
      resetRetryState();
    } catch (error) {
      console.error("ENTER POD ERROR", error);
      clearMatchAttemptState();
      setErrorMsg("Something went wrong entering the pod.");
      setStatusMsg(null);
      setIsWaiting(false);
      resetRetryState();
    } finally {
      requestInFlightRef.current = false;
    }
  }, [
    city,
    debugSnapshot,
    handleMatched,
    isMatching,
    isNavigatingToRoomRef,
    effectiveIsNightOver,
    canonicalStatusAllowsMatchPost,
    routeToDone,
    safeCurrentRound,
    syncLobbyStateForRound,
    userId,
    podId,
  ]);

  const isOpenDay = isPodsOpenDay(city);
  const nextPodOpenLabel = getNextPodOpenLabel(city);
  const roundOneTiming = city ? getRoundTiming(city, 1) : null;
  const podNightOver = effectiveIsNightOver;
  const nightHasStarted =
    !podNightOver && !!roundOneTiming && !roundOneTiming.isBeforeRoundStart;
  const isPreopenLobbyActive = isPreopenLobbyWindow(city, safeCurrentRound);
  const isBeforeCurrentRoundStart = !!currentRoundTiming?.isBeforeRoundStart;
  const shouldShowNightStartCountdown =
    !nightHasStarted &&
    !podNightOver &&
    safeCurrentRound === 1 &&
    isBeforeCurrentRoundStart &&
    !isPreopenLobbyActive;
  const hasPreopenLobbyActivity =
    isPreopenLobbyActive &&
    (isWaiting || isMatching || hasStartedMatchAttempt);
  const shouldShowWaiting =
    !podNightOver &&
    !!currentRoundTiming &&
    (nightHasStarted || !currentRoundTiming.isBeforeRoundStart) &&
    isWaiting;

  const shouldShowMatching =
    !podNightOver &&
    !!currentRoundTiming &&
    (nightHasStarted || !currentRoundTiming.isBeforeRoundStart) &&
    isMatching;

  const allowEnterCurrentRound =
    !podNightOver &&
    !isPreLaunch() &&
    canonicalStatusAllowsManualEntry;

  const isReadyForCurrentRound =
    !podNightOver &&
    !isPreLaunch() &&
    isOpenDay &&
    canonicalStatusAllowsManualEntry;

  const sessionHeading = podNightOver
    ? "Next Session"
    : isPreLaunch()
      ? "Launching Soon"
      : allowEnterCurrentRound
        ? "Tonight's Session"
        : !isOpenDay || (!nightHasStarted && shouldShowNightStartCountdown)
          ? "Next Session"
          : "Tonight's Session";

  const showLoadingUi = recoveryPhase === "bootstrapping";
  const showRecoveryUi =
    recoveryPhase === "retryable_error" || recoveryPhase === "login_required";
  const showStuckUi = showRecoveryUi;
  const showNormalLobbyUi = recoveryPhase === "ready";
  const needsLogin = recoveryPhase === "login_required";
  const isForwardLobbyHandoff =
    showLoadingUi &&
    validatedRequestedRound !== null &&
    validatedRequestedRound > 1 &&
    !showRecoveryUi;

  const recoveryStatusText = needsLogin
    ? "Your session expired or couldn't be verified."
    : isForwardLobbyHandoff
      ? `Entering the Round ${validatedRequestedRound} lobby...`
      : showLoadingUi
        ? "Restoring your session..."
        : "We couldn't reconnect you yet.";

  const handleRefresh = useCallback(() => {
    if (typeof window === "undefined") return;

    setRefreshAttempts((prev) => {
      const next = prev + 1;
      window.sessionStorage.setItem("pods_refresh_attempts", String(next));
      return next;
    });

    window.location.reload();
  }, []);

  const handleRetryPodEntry = useCallback(() => {
    if (
      requestInFlightRef.current ||
      isNavigatingToRoomRef.current ||
      isMatching ||
      effectiveIsNightOver
    ) {
      return;
    }

    clearMatchAttemptState();
    setIsWaiting(false);
    setIsMatching(false);
    resetRetryState();
    setErrorMsg(null);
    void handleEnterPod();
  }, [handleEnterPod, isMatching, effectiveIsNightOver]);

  const hasActiveMatchAttempt =
    enterAttemptCommittedRef.current ||
    enterAttemptActiveRef.current ||
    hasStartedMatchAttempt ||
    isMatching ||
    isWaiting;
  const statusWaiting = shouldShowWaiting || (isPreopenLobbyActive && isWaiting);
  const statusMatching =
    shouldShowMatching ||
    (isPreopenLobbyActive && isMatching) ||
    (hasActiveMatchAttempt &&
      !statusWaiting &&
      !isNavigatingToRoomRef.current &&
      !errorMsg &&
      !showRecoveryUi &&
      !effectiveIsNightOver);
  const isAutoForwarding =
    autoForwardInFlightRef.current || safeStatusMsg === "Moving you forward...";
  const canonicalStatusText =
    canonicalStatus.state === "matched"
      ? "Entering your pod..."
      : canonicalStatus.state === "waiting"
        ? showRetry
          ? "Still finding your pod..."
          : "Waiting for your match..."
        : isAutoForwarding
          ? "Moving you forward..."
        : canonicalStatusAllowsManualEntry
          ? `Ready for round ${safeCurrentRound}`
          : canonicalStatus.phase === "preopen"
            ? `Round ${safeCurrentRound} opens in ${formatCountdown(
                currentRoundTiming?.secondsUntilRoundStart ?? 0
              )}`
            : canonicalStatus.phase === "between_rounds"
              ? `Round ${safeCurrentRound} opens in ${formatCountdown(
                  currentRoundTiming?.secondsUntilRoundStart ?? 0
                )}`
              : canonicalStatus.phase === "finished"
                ? secondsToNextPod !== null
                  ? `Next pod opens ${nextPodOpenLabel} (${formatCountdownShort(
                      secondsToNextPod
                    )})`
                  : `Next pod opens ${nextPodOpenLabel}`
                : canonicalStatus.phase === "closed"
                  ? `Next pod opens ${nextPodOpenLabel}`
                  : canonicalStatus.reason === "entry_window_closed"
                    ? "Moving you forward..."
                  : statusMatching
                    ? showRetry
                      ? "Still finding your pod..."
                      : `Finding your pod for round ${safeCurrentRound}...`
                    : statusWaiting
                      ? showRetry
                        ? "Still finding your pod..."
                        : "Waiting for your match..."
                      : `Round ${safeCurrentRound} entry is closed.`;

  const derivedLiveStatusText =
    showLoadingUi
      ? recoveryStatusText
      : showRecoveryUi
        ? recoveryStatusText
        : isPreLaunch()
          ? `${PODS_LAUNCH_LABEL}. Starting in ${formatLaunchCountdown(
              PODS_LAUNCH_AT
            )}`
          : effectiveIsNightOver
            ? secondsToNextPod !== null
              ? `Next pod opens ${nextPodOpenLabel} (${formatCountdownShort(
                  secondsToNextPod
                )})`
              : `Next pod opens ${nextPodOpenLabel}`
            : isBeforeCurrentRoundStart &&
                !isPreopenLobbyActive &&
                canonicalStatus.phase !== "live"
              ? `Next pod opens in ${formatCountdown(
                  currentRoundTiming?.secondsUntilRoundStart ?? 0
                )}`
              : canonicalStatusText;

  const transientStatusMsg =
    !isPreLaunch() &&
    (safeStatusMsg === "Match found. Entering your pod..." ||
      safeStatusMsg === FINALIZING_MATCH_LABEL ||
      safeStatusMsg === "Moving you forward...")
      ? safeStatusMsg
      : null;

  const effectiveLiveStatusText = transientStatusMsg ?? derivedLiveStatusText;
  const hasStickyPendingStatusMsg =
    safeStatusMsg === "Checking your pod status..." ||
    safeStatusMsg === "Entering tonight's lobby..." ||
    safeStatusMsg === "Waiting for your match..." ||
    safeStatusMsg === FINALIZING_MATCH_LABEL ||
    safeStatusMsg === "Match found. Entering your pod..." ||
    safeStatusMsg === "Moving you forward..." ||
    safeStatusMsg?.startsWith("Finding your pod for round ") === true;
  const hasStickyPendingAttempt =
    enterAttemptCommittedRef.current ||
    enterAttemptActiveRef.current ||
    requestInFlightRef.current ||
    hasStartedMatchAttempt ||
    isMatching ||
    isWaiting ||
    matchedRoomCommittedRef.current ||
    isNavigatingToRoomRef.current ||
    hasStickyPendingStatusMsg;
  const stickyPendingButtonLabel =
    matchedRoomCommittedRef.current ||
    isNavigatingToRoomRef.current ||
    isFinalizingMatch
      ? "Entering your pod..."
      : isWaiting
        ? "Waiting for your match..."
        : "Finding your pod...";
  const canRetryActiveAttempt =
    showRetry &&
    hasStartedMatchAttempt &&
    !errorMsg &&
    !isMatching &&
    !isFinalizingMatch &&
    !requestInFlightRef.current &&
    !isNavigatingToRoomRef.current &&
    !showStuckUi &&
    !effectiveIsNightOver &&
    !isPreLaunch();

  const buttonLabel =
    isNavigatingToRoomRef.current ||
    matchedRoomCommittedRef.current ||
    isFinalizingMatch ||
    canonicalStatus.state === "matched"
      ? "Entering your pod..."
      : canonicalStatus.state === "waiting" || isWaiting
        ? "Waiting for your match..."
        : isMatching || hasStartedMatchAttempt
          ? "Finding your pod..."
          : isAutoForwarding
            ? "Moving you forward..."
            : canonicalStatusAllowsManualEntry
              ? "Enter the Pod"
              : isPreLaunch()
                ? `Starts in ${formatLaunchCountdown(PODS_LAUNCH_AT)}`
                : isBeforeCurrentRoundStart &&
                    !isPreopenLobbyActive &&
                    canonicalStatus.phase !== "live"
                  ? `Starts in ${formatCountdown(
                      currentRoundTiming?.secondsUntilRoundStart ?? 0
                    )}`
                  : canonicalStatus.reason === "entry_window_closed"
                    ? "Moving you forward..."
                    : podNightOver ||
                        canonicalStatus.phase === "closed" ||
                        canonicalStatus.phase === "finished"
                      ? `Next pod ${nextPodOpenLabel}`
                      : hasStickyPendingAttempt
                        ? stickyPendingButtonLabel
                        : "Enter the Pod";

  const isButtonDisabled =
    (effectiveIsNightOver && (secondsToNextPod ?? 0) > 0) ||
    isPreLaunch() ||
    safeCurrentRound > TOTAL_ROUNDS ||
    isNavigatingToRoomRef.current ||
    enterAttemptCommittedRef.current ||
    enterAttemptActiveRef.current ||
    isAutoForwarding ||
    hasStickyPendingAttempt ||
    !userId ||
    !canonicalStatusAllowsManualEntry ||
    (isBeforeCurrentRoundStart &&
      !isPreopenLobbyActive &&
      canonicalStatus.phase !== "live");

  void nowTick;
  void mountedRef.current;
  void secondsToStart;
  void resetRecoveryFlow;
  void ROOM_FULL_SESSION_SECONDS;
  void ROOM_FULL_SESSION_GRACE_SECONDS;

  return (
    <>
      <main
        className="min-h-screen bg-black text-white flex items-center justify-center px-4 py-6 md:py-12"
        style={{
          background:
            "radial-gradient(circle at top, #1a1024 0%, #05030a 55%, #020106 100%)",
        }}
      >
        <div className="w-full max-w-sm md:max-w-3xl flex flex-col items-center gap-6">
          <div className="text-[9px] md:text-xs tracking-[0.35em] text-pink-400 uppercase">
            THEPODS
          </div>

          <div className="text-center">
            <h1 className="text-lg sm:text-2xl md:text-4xl font-semibold mb-2">
              {firstName ? `Welcome, ${firstName}` : "Your pod lobby"}
            </h1>
            <p className="text-[10px] sm:text-[13px] md:text-sm text-zinc-400">
              No photos. No swiping. Just intentional conversation.
            </p>
            <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-500 mt-2">
              Current round: {safeCurrentRound} of {TOTAL_ROUNDS}
            </p>
            {city && (
              <p className="text-[10px] uppercase tracking-[0.25em] text-zinc-600 mt-1">
                City: {normalizeCity(city)}
              </p>
            )}
          </div>

          <div className="w-full max-w-sm md:max-w-xl">
            <div className="bg-zinc-900 rounded-2xl md:rounded-3xl border border-zinc-800 p-4 md:p-7 shadow-[0_0_40px_rgba(255,20,147,0.25)]">
              <p className="text-[10px] md:text-xs tracking-[0.25em] text-zinc-500 mb-2 uppercase">
                {sessionHeading}
              </p>

              <h2 className="text-base md:text-xl font-semibold mb-2">
                Blind Voice Pods
              </h2>

              <p className="text-[11px] md:text-sm text-zinc-400 mb-4 md:mb-6">
                Short voice dates. Real conversations. See if there's a vibe.
              </p>

              <p className="text-[11px] md:text-sm mb-4">
                <span className="text-zinc-400">Status: </span>
                <span className="text-emerald-400 font-medium">
                  {effectiveLiveStatusText}
                </span>
              </p>

              {debugEnabled && (
                <div className="mb-4 rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    Debug
                  </p>
                  <pre className="whitespace-pre-wrap break-words text-[10px] leading-relaxed text-zinc-400">
                    {JSON.stringify(debugSnapshot, null, 2)}
                  </pre>
                </div>
              )}

              {showRetry &&
                (statusWaiting ||
                  statusMatching ||
                  hasPreopenLobbyActivity) &&
                !errorMsg && (
                  <p className="mb-4 text-[11px] md:text-sm text-zinc-400">
                    We're still finding your pod.
                  </p>
                )}

              {errorMsg && (
                <p className="mb-4 text-[11px] md:text-sm text-red-300">
                  {errorMsg}
                </p>
              )}

              {showStuckUi ? (
                <>
                  {refreshAttempts >= 2 ? (
                    <>
                      <button
                        type="button"
                        onClick={() => router.push("/login")}
                        className="block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center bg-pink-500 hover:bg-pink-400 shadow-[0_0_26px_rgba(255,20,147,0.45)] transition"
                      >
                        Log in again
                      </button>

                      <button
                        type="button"
                        onClick={handleRefresh}
                        className="mt-3 w-full rounded-xl px-4 py-2 text-[12px] md:text-sm border border-pink-500/40 text-pink-300 hover:bg-pink-500/10 transition"
                      >
                        Refresh
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={handleRefresh}
                      className="block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center bg-pink-500 hover:bg-pink-400 shadow-[0_0_26px_rgba(255,20,147,0.45)] transition"
                    >
                      Refresh
                    </button>
                  )}
                </>
              ) : showNormalLobbyUi ? (
                effectiveIsNightOver && secondsToNextPod !== null && secondsToNextPod > 0 ? (
                  <button
                    type="button"
                    disabled
                    className="block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center bg-pink-500/25 text-pink-200/70 shadow-none cursor-not-allowed"
                  >
                    {buttonLabel}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void handleEnterPod();
                      }}
                      disabled={isButtonDisabled}
                      className={`block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center transition ${
                        isButtonDisabled
                          ? "bg-pink-500/25 text-pink-200/50 shadow-none cursor-not-allowed"
                          : "bg-pink-500 hover:bg-pink-400 text-white shadow-[0_0_26px_rgba(255,20,147,0.45)]"
                      }`}
                    >
                      {buttonLabel}
                    </button>

                    {canRetryActiveAttempt && (
                      <button
                        type="button"
                        onClick={handleRetryPodEntry}
                        className="mt-3 block w-full rounded-xl border border-pink-500/40 px-4 py-2 text-[12px] md:text-sm font-semibold text-pink-300 hover:bg-pink-500/10 transition"
                      >
                        Try again
                      </button>
                    )}

                    {isBeforeCurrentRoundStart &&
                      !isPreopenLobbyActive &&
                      !isReadyForCurrentRound && (
                        <p className="mt-3 text-center text-[11px] text-zinc-500">
                          Available when this countdown reaches 0.
                        </p>
                      )}
                  </>
                )
              ) : (
                <button
                  type="button"
                  disabled
                  className="block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center bg-pink-500 transition disabled:opacity-40"
                >
                  Entering your pod...
                </button>
              )}
            </div>
          </div>

          <p className="text-center text-zinc-500 text-[10px] md:text-xs max-w-md">
            {effectiveIsNightOver
              ? `Next pod opens ${nextPodOpenLabel}${
                  secondsToNextPod != null
                    ? ` (${formatCountdownShort(secondsToNextPod)})`
                    : ""
                }.`
              : "You'll go through 3 short pods, then finish for the night."}
          </p>

          <div className="mt-10 flex justify-center">
            <button
              type="button"
              onClick={() => setShowSupportModal(true)}
              className="text-[11px] text-white/30 hover:text-white/60 cursor-pointer transition tracking-wide"
            >
              Get Support
            </button>
          </div>
        </div>
      </main>

      {showSupportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111114] p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold text-white">Get support</h2>
                <p className="mt-1 text-sm text-white/55">
                  Having trouble entering a pod or matching? Send us a message
                  and we'll look into it.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowSupportModal(false);
                  setSupportError("");
                  setSupportSuccess(false);
                }}
                className="text-white/40 hover:text-white/70 transition"
                aria-label="Close support modal"
              >
                ✕
              </button>
            </div>

            {!supportSuccess ? (
              <div className="mt-4 space-y-3">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-white/40">
                    Message
                  </label>
                  <textarea
                    value={supportMessage}
                    onChange={(e) => setSupportMessage(e.target.value)}
                    rows={5}
                    placeholder="Tell us what's happening..."
                    className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25 outline-none focus:border-fuchsia-500/50"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs uppercase tracking-[0.2em] text-white/40">
                    Email (optional)
                  </label>
                  <input
                    type="email"
                    value={supportEmail}
                    onChange={(e) => setSupportEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/25 outline-none focus:border-fuchsia-500/50"
                  />
                </div>

                {supportError ? (
                  <p className="text-sm text-red-300">{supportError}</p>
                ) : null}

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSupportModal(false);
                      setSupportError("");
                      setSupportSuccess(false);
                    }}
                    className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 hover:text-white transition"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSupportSubmit}
                    disabled={isSubmittingSupport || !supportMessage.trim()}
                    className="rounded-xl bg-fuchsia-600/80 px-4 py-2 text-sm font-medium text-white hover:bg-fuchsia-500 disabled:cursor-not-allowed disabled:opacity-50 transition"
                  >
                    {isSubmittingSupport ? "Sending..." : "Send message"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <p className="text-sm text-emerald-300">
                  Thanks — your message was sent.
                </p>
                <div className="mt-4 flex justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSupportModal(false);
                      setSupportSuccess(false);
                      setSupportError("");
                    }}
                    className="rounded-xl border border-white/10 px-4 py-2 text-sm text-white/70 hover:text-white transition"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
