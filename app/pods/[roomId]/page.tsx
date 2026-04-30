"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrackPublication,
} from "livekit-client";
import { supabase } from "@/lib/supabase/client";
import {
  ROUND_CONVERSATION_SECONDS,
  getDebugAdjustedNow,
} from "@/lib/pods/timing";

const ROOM_CONVERSATION_SECONDS = ROUND_CONVERSATION_SECONDS;
const ROOM_IDENTITY_RETRY_MS = 250;
const ROOM_IDENTITY_MAX_RETRIES = 4;
const PEER_LEFT_GRACE_MS = 2500;
const TIMER_ZERO_FORCE_AFTER_REDIRECT_MS = 2000;
const CANONICAL_END_SUPPRESS_TOLERANCE_MS = 500;

const PROMPTS = [
  "What’s something small that made your week better?",
  "What’s been on your mind lately—in a good way?",
  "What’s your go-to way to reset after a long day?",
  "What’s something you’ve been looking forward to?",
  "What’s a random thing you’ve been really into lately?",
  "What kind of energy are you bringing into this week?",
  "What’s a place you could revisit over and over again?",
  "What’s something you’ve learned about yourself recently?",
];

type MatchProfile = {
  first_name: string | null;
  city: string | null;
};

type RoomIdentityResponse = {
  ok: boolean;
  roomId?: string | null;
  otherUserId?: string | null;
  name?: string | null;
  city?: string | null;
  roundNumber?: number | null;
  roomStartedAt?: string | null;
  roundStartAt?: string | null;
  roundEndAt?: string | null;
  error?: string;
};

type PodStatusResponse = {
  ok: boolean;
  signedIn: boolean;
  currentRound: number | null;
  phase:
    | "preopen"
    | "live"
    | "rating"
    | "between_rounds"
    | "finished"
    | "closed";
  state: "none" | "waiting" | "matched" | "closedForTonight";
  roomId: string | null;
  roundNumber: number | null;
  shouldGoToDone: boolean;
};

function normalizeDisplayCity(city: string | null | undefined) {
  if (!city) return null;

  const normalized = city.trim().toLowerCase();

  if (
    normalized === "nyc" ||
    normalized === "new york" ||
    normalized === "new york city"
  ) {
    return "NYC";
  }

  if (normalized === "la" || normalized === "los angeles") {
    return "Los Angeles";
  }

  return city;
}

function getSecondsLeftFromRoomWindow(
  roomStartedAt: string | null
) {
  if (!roomStartedAt) return ROOM_CONVERSATION_SECONDS;

  const now = getDebugAdjustedNow().getTime();
  const start = new Date(roomStartedAt).getTime();
  if (!Number.isFinite(start) || start > now) {
    return ROOM_CONVERSATION_SECONDS;
  }

  const end = start + ROOM_CONVERSATION_SECONDS * 1000;

  return Math.max(
    0,
    Math.min(ROOM_CONVERSATION_SECONDS, Math.floor((end - now) / 1000))
  );
}

function getValidTimestamp(value: string | null) {
  if (!value) return null;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getCanonicalSessionEndAt(anchorAt: string | null) {
  const anchorMs = getValidTimestamp(anchorAt);
  if (anchorMs === null) return null;

  return new Date(anchorMs + ROOM_CONVERSATION_SECONDS * 1000).toISOString();
}

function shouldSuppressAfterRedirectForCanonicalEnd(
  canonicalSessionEndAt: string | null,
  now: Date = getDebugAdjustedNow()
) {
  const canonicalSessionEndAtMs = getValidTimestamp(canonicalSessionEndAt);

  if (canonicalSessionEndAtMs === null) {
    return false;
  }

  return (
    now.getTime() + CANONICAL_END_SUPPRESS_TOLERANCE_MS <
    canonicalSessionEndAtMs
  );
}

function resolveRoomTimerState(params: {
  roomStartedAt: string | null;
  roundStartAt: string | null;
  now?: Date;
}) {
  const now = params.now ?? getDebugAdjustedNow();
  const nowMs = now.getTime();
  const roomStartedAtMs = getValidTimestamp(params.roomStartedAt);
  const roundStartAtMs = getValidTimestamp(params.roundStartAt);

  if (roomStartedAtMs !== null && roomStartedAtMs <= nowMs) {
    const timerAnchorAt = new Date(roomStartedAtMs).toISOString();

    console.log("[pod-room] using roomStartedAt as timer anchor", {
      roomStartedAt: timerAnchorAt,
    });

    return {
      timerAnchorAt,
      reason: "room_started_at",
      secondsLeft: getSecondsLeftFromRoomWindow(timerAnchorAt),
      canonicalSessionEndAt: getCanonicalSessionEndAt(timerAnchorAt),
    };
  }

  if (roundStartAtMs !== null && roundStartAtMs <= nowMs) {
    const timerAnchorAt = new Date(roundStartAtMs).toISOString();

    console.log("[pod-room] falling back to roundStartAt", {
      roundStartAt: timerAnchorAt,
    });

    return {
      timerAnchorAt,
      reason: "round_start_at",
      secondsLeft: getSecondsLeftFromRoomWindow(timerAnchorAt),
      canonicalSessionEndAt: getCanonicalSessionEndAt(timerAnchorAt),
    };
  }

  const fallbackReason =
    roomStartedAtMs !== null && roomStartedAtMs > nowMs
      ? "future_room_started_at_fallback_to_now"
      : roundStartAtMs !== null
        ? "future_round_start_at_fallback_to_now"
        : "missing_timer_anchor_fallback_to_now";

  return {
    timerAnchorAt: now.toISOString(),
    reason: fallbackReason,
    secondsLeft: ROOM_CONVERSATION_SECONDS,
    canonicalSessionEndAt: null,
  };
}

function pickPrompt(seed: string) {
  let hash = 0;

  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }

  return PROMPTS[hash % PROMPTS.length];
}

function isRecoverableAuthLockMessage(message: string) {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("lock") &&
    (normalized.includes("stole it") ||
      normalized.includes("released because another request stole it") ||
      normalized.includes("was released because another request stole it"))
  );
}

function isMicrophonePermissionError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  const name = error instanceof Error ? error.name : "";

  return (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    message.includes("permission denied") ||
    message.includes("microphone permission") ||
    message.includes("could not start audio source") ||
    (message.includes("not allowed") && message.includes("microphone"))
  );
}

function getAudioConnectionErrorMessage(error: unknown, fallback: string) {
  if (isMicrophonePermissionError(error)) {
    return "Microphone permission was denied. Allow mic access and retry audio.";
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }

  return fallback;
}

async function fetchCanonicalPodStatus() {
  const res = await fetch("/api/pods/status", {
    method: "GET",
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const data = (await res.json().catch(() => null)) as PodStatusResponse | null;
  return data?.ok ? data : null;
}

export default function PodRoomPage() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();

  const roomIdParam = params?.roomId;
  const roomId =
    typeof roomIdParam === "string"
      ? roomIdParam
      : Array.isArray(roomIdParam)
        ? roomIdParam[0]
        : "";

  const roundFromUrlRaw = searchParams.get("round");
  const parsedRound = Number(roundFromUrlRaw);
  const lockedRound =
    Number.isFinite(parsedRound) && parsedRound > 0 ? parsedRound : 1;

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [authResolved, setAuthResolved] = useState(false);

  const [secondsLeft, setSecondsLeft] = useState(ROOM_CONVERSATION_SECONDS);
  const [roundNumber, setRoundNumber] = useState(lockedRound);
  const [roomStartedAt, setRoomStartedAt] = useState<string | null>(null);
  const [matchProfile, setMatchProfile] = useState<MatchProfile | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [showRestoreSession, setShowRestoreSession] = useState(false);

  const [hasStartedSession, setHasStartedSession] = useState(false);
  const [isConnectingAudio, setIsConnectingAudio] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [peerLeftEarly, setPeerLeftEarly] = useState(false);
  const [peerFailedAudio, setPeerFailedAudio] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isLeaving, setIsLeaving] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const audioElsRef = useRef<HTMLMediaElement[]>([]);
  const connectingRef = useRef(false);
  const connectedRef = useRef(false);
  const cleanedUpRef = useRef(false);
  const hasRedirectedRef = useRef(false);
  const hasStartedSessionRef = useRef(false);
  const secondsLeftRef = useRef(ROOM_CONVERSATION_SECONDS);
  const hasAttemptedConnectRef = useRef(false);
  const hadRemoteParticipantRef = useRef(false);
  const remoteParticipantIdsRef = useRef<Set<string>>(new Set());
  const peerLeftTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReconnectingRef = useRef(false);
  const staleRoomStatusCountRef = useRef(0);
  const canonicalSessionEndAtRef = useRef<string | null>(null);
  const hasResolvedRoomTimingRef = useRef(false);
  const afterRedirectSuppressedRef = useRef(false);
  const timerZeroAtRef = useRef<number | null>(null);

  useEffect(() => {
    hasStartedSessionRef.current = hasStartedSession;
  }, [hasStartedSession]);

  useEffect(() => {
    secondsLeftRef.current = secondsLeft;

    if (secondsLeft > 0) {
      timerZeroAtRef.current = null;
    }
  }, [secondsLeft]);

  useEffect(() => {
    isReconnectingRef.current = isReconnecting;
  }, [isReconnecting]);

  const clearPeerLeftTimeout = useCallback(() => {
    if (peerLeftTimeoutRef.current) {
      clearTimeout(peerLeftTimeoutRef.current);
      peerLeftTimeoutRef.current = null;
    }
  }, []);

  const getTrackedRemoteCount = useCallback(() => {
    return remoteParticipantIdsRef.current.size;
  }, []);

  const markRemotePresent = useCallback(
    (participantSid?: string | null) => {
      clearPeerLeftTimeout();

      if (participantSid) {
        remoteParticipantIdsRef.current.add(participantSid);
      }

      hadRemoteParticipantRef.current = true;
      setRemoteConnected(true);
      setPeerLeftEarly(false);

      console.log("[pod-room] markRemotePresent", {
        participantSid,
        trackedRemoteCount: remoteParticipantIdsRef.current.size,
      });
    },
    [clearPeerLeftTimeout]
  );

  const schedulePeerLeftCheck = useCallback(
    (reason: string) => {
      clearPeerLeftTimeout();

      peerLeftTimeoutRef.current = setTimeout(() => {
        const room = roomRef.current;
        const trackedRemoteCount = remoteParticipantIdsRef.current.size;
        const livekitRemoteCount = room?.remoteParticipants.size ?? 0;
        const hasRemote = trackedRemoteCount > 0 || livekitRemoteCount > 0;

        console.log("[pod-room] peer-left grace check", {
          reason,
          trackedRemoteCount,
          livekitRemoteCount,
          hasStartedSession: hasStartedSessionRef.current,
          secondsLeft: secondsLeftRef.current,
          hadRemoteParticipant: hadRemoteParticipantRef.current,
          isReconnecting: isReconnectingRef.current,
        });

        if (hasRemote) {
          setRemoteConnected(true);
          setPeerLeftEarly(false);
          return;
        }

        setRemoteConnected(false);
        setPeerFailedAudio(false);

        if (
          hasStartedSessionRef.current &&
          secondsLeftRef.current > 0 &&
          hadRemoteParticipantRef.current &&
          !isReconnectingRef.current
        ) {
          console.warn("[pod-room] confirmed peer left early", {
            reason,
            secondsLeft: secondsLeftRef.current,
          });
          setPeerLeftEarly(true);
          return;
        }

        setPeerLeftEarly(false);
      }, PEER_LEFT_GRACE_MS);
    },
    [clearPeerLeftTimeout]
  );

  const removeRemoteParticipant = useCallback(
    (participantSid?: string | null, reason?: string) => {
      if (participantSid) {
        remoteParticipantIdsRef.current.delete(participantSid);
      }

      const stillHasTrackedRemote = remoteParticipantIdsRef.current.size > 0;
      setRemoteConnected(stillHasTrackedRemote);
      setPeerFailedAudio(false);

      console.log("[pod-room] removeRemoteParticipant", {
        participantSid,
        reason,
        trackedRemoteCount: remoteParticipantIdsRef.current.size,
      });

      if (!stillHasTrackedRemote) {
        if (
          reason === "participant_disconnected" &&
          hasStartedSessionRef.current &&
          secondsLeftRef.current > 0 &&
          hadRemoteParticipantRef.current &&
          !isReconnectingRef.current
        ) {
          clearPeerLeftTimeout();
          setPeerLeftEarly(true);
          return;
        }

        schedulePeerLeftCheck(reason || "remote_removed");
      } else {
        setPeerLeftEarly(false);
      }
    },
    [clearPeerLeftTimeout, schedulePeerLeftCheck]
  );

  useEffect(() => {
    setMatchProfile(null);
    setMatchError(null);
    setHasStartedSession(false);
    setAudioReady(false);
    setRemoteConnected(false);
    setPeerLeftEarly(false);
    setPeerFailedAudio(false);
    setPlaybackBlocked(false);
    setAudioError(null);
    setIsConnectingAudio(false);
    setIsReconnecting(false);
    setIsMuted(false);
    setIsLeaving(false);
    setRoundNumber(lockedRound);
    setRoomStartedAt(null);
    setSecondsLeft(ROOM_CONVERSATION_SECONDS);
    setShowRestoreSession(false);

    connectingRef.current = false;
    connectedRef.current = false;
    cleanedUpRef.current = false;
    hasAttemptedConnectRef.current = false;
    hadRemoteParticipantRef.current = false;
    remoteParticipantIdsRef.current = new Set();
    isReconnectingRef.current = false;
    staleRoomStatusCountRef.current = 0;
    canonicalSessionEndAtRef.current = null;
    hasResolvedRoomTimingRef.current = false;
    afterRedirectSuppressedRef.current = false;
    clearPeerLeftTimeout();

    console.log("[pod-room] roomId changed → reset state", { roomId });
  }, [roomId, lockedRound, clearPeerLeftTimeout]);

  const safeDisconnect = useCallback(async () => {
    cleanedUpRef.current = true;
    connectingRef.current = false;
    connectedRef.current = false;
    remoteParticipantIdsRef.current = new Set();
    clearPeerLeftTimeout();

    setAudioReady(false);
    setRemoteConnected(false);
    setPeerLeftEarly(false);
    setPeerFailedAudio(false);
    setIsConnectingAudio(false);
    setIsReconnecting(false);

    const activeRoom = roomRef.current;
    roomRef.current = null;

    try {
      if (activeRoom) {
        activeRoom.removeAllListeners();
        await activeRoom.disconnect();
      }
    } catch (error) {
      console.error("[pod-room] safe disconnect error", error);
    }

    audioElsRef.current.forEach((el) => {
      try {
        el.pause();
        el.srcObject = null;
        el.remove();
      } catch {}
    });
    audioElsRef.current = [];
  }, [clearPeerLeftTimeout]);

  const ensurePlayback = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;

    try {
      await room.startAudio();

      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch (micError) {
        console.error("[pod-room] mic enable after playback error", micError);
      }

      setPlaybackBlocked(false);
      setAudioReady(true);
      setAudioError(null);

      console.log("[pod-room] playback manually enabled");
    } catch (error) {
      console.error("[pod-room] ensurePlayback error", error);
      setPlaybackBlocked(true);
      setAudioError("Audio is still blocked. Tap again to enable sound.");
    }
  }, []);

  const leaveCurrentPod = useCallback(async (targetRoundNumber = roundNumber) => {
    if (!roomId) return;

    const response = await fetch("/api/pods/leave", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        roomId,
        roundNumber: targetRoundNumber,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || "Could not leave pod.");
    }
  }, [roomId, roundNumber]);

  const routeToAfter = useCallback(
    async (targetRoundNumber = roundNumber, source = "session_end") => {
      if (!roomId || hasRedirectedRef.current) return;

      hasRedirectedRef.current = true;
      hasAttemptedConnectRef.current = true;

      try {
        await leaveCurrentPod(targetRoundNumber);
      } catch (error) {
        console.error("[pod-room] leave before after redirect error", {
          source,
          roomId,
          roundNumber: targetRoundNumber,
          error,
        });
      }

      console.log("[pod-room] routing to after because session has ended", {
        source,
        roomId,
        roundNumber: targetRoundNumber,
        canonicalSessionEndAt: canonicalSessionEndAtRef.current,
      });

      await safeDisconnect();
      router.replace(`/pods/${roomId}/after?round=${targetRoundNumber}`);
    },
    [leaveCurrentPod, roomId, roundNumber, router, safeDisconnect]
  );

  useEffect(() => {
    if (!roomId) {
      router.replace("/pods");
      return;
    }

    setPrompt(pickPrompt(`${roomId}-${roundNumber}`));
  }, [roomId, roundNumber, router]);

  useEffect(() => {
    let cancelled = false;

    async function loadCurrentUser() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();

        if (cancelled) return;

        if (session?.user) {
          console.log("[pod-room] session restore success", {
            roomId,
            userId: session.user.id,
            source: "getSession",
          });

          setCurrentUserId(session.user.id);
          setAuthResolved(true);
          return;
        }
      } catch (error) {
        console.warn("[pod-room] getSession failed during room load", {
          roomId,
          error,
        });
      }

      for (let attempt = 1; attempt <= 6; attempt += 1) {
        try {
          console.log("[pod-room] auth restore attempt", {
            attempt,
            roomId,
          });

          const {
            data: { user },
            error,
          } = await supabase.auth.getUser();

          if (cancelled) return;

          if (error) {
            const message = error.message || "";

            if (isRecoverableAuthLockMessage(message)) {
              console.warn("[pod-room] recoverable auth lock during room load", {
                attempt,
                roomId,
                message,
              });
            } else {
              console.error("[pod-room] auth getUser error", {
                attempt,
                roomId,
                error,
              });
            }
          }

          if (user) {
            console.log("[pod-room] auth restore success", {
              roomId,
              userId: user.id,
              attempt,
              source: "getUser",
            });

            setCurrentUserId(user.id);
            setAuthResolved(true);
            return;
          }

          if (attempt < 6) {
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        } catch (error) {
          console.error("[pod-room] loadCurrentUser error", {
            attempt,
            roomId,
            error,
          });

          if (cancelled) return;

          if (attempt < 6) {
            await new Promise((resolve) => setTimeout(resolve, 350));
          }
        }
      }

      if (cancelled) return;

      console.warn(
        "[pod-room] auth unresolved after retries; marking auth resolved without user",
        {
          roomId,
        }
      );

      setCurrentUserId(null);
      setAuthResolved(true);
    }

    void loadCurrentUser();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    if (
      audioReady ||
      isConnectingAudio ||
      isReconnecting ||
      playbackBlocked ||
      !!audioError ||
      secondsLeftRef.current === 0
    ) {
      setShowRestoreSession(false);
      return;
    }

    const timeout = setTimeout(() => {
      if (
        !audioReady &&
        !isConnectingAudio &&
        !isReconnecting &&
        !playbackBlocked &&
        !audioError &&
        secondsLeftRef.current > 0
      ) {
        console.warn("[pod-room] stale room recovery UI visible", {
          roomId,
          authResolved,
          currentUserId,
          audioReady,
          isConnectingAudio,
          isReconnecting,
        });
        setShowRestoreSession(true);
      }
    }, 5000);

    return () => clearTimeout(timeout);
  }, [
    audioReady,
    isConnectingAudio,
    isReconnecting,
    playbackBlocked,
    audioError,
    roomId,
    authResolved,
    currentUserId,
  ]);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    let retryId: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    async function fetchRoomIdentity() {
      if (attempts >= ROOM_IDENTITY_MAX_RETRIES) return;
      attempts += 1;

      try {
        const res = await fetch(
          `/api/pods/room?roomId=${encodeURIComponent(roomId)}`,
          {
            method: "GET",
            cache: "no-store",
          }
        );

        const data =
          (await res.json().catch(() => null)) as RoomIdentityResponse | null;

        if (cancelled) return;

        if (!res.ok || !data?.ok) {
          if (attempts < ROOM_IDENTITY_MAX_RETRIES) {
            retryId = setTimeout(() => {
              if (!cancelled) {
                void fetchRoomIdentity();
              }
            }, ROOM_IDENTITY_RETRY_MS);
          } else {
            hasResolvedRoomTimingRef.current = true;
          }
          return;
        }

        const resolvedName = data.name?.trim() || null;
        const resolvedCity = normalizeDisplayCity(data.city);
        const resolvedRoundNumber =
          typeof data.roundNumber === "number" && data.roundNumber > 0
            ? data.roundNumber
            : lockedRound;
        const now = getDebugAdjustedNow();
        const resolvedRoundStartAt = data.roundStartAt ?? null;
        const resolvedTimerState = resolveRoomTimerState({
          roomStartedAt: data.roomStartedAt ?? null,
          roundStartAt: resolvedRoundStartAt,
          now,
        });
        hasResolvedRoomTimingRef.current = true;
        canonicalSessionEndAtRef.current =
          resolvedTimerState.canonicalSessionEndAt;

        setMatchProfile((prev) => ({
          first_name: resolvedName ?? prev?.first_name ?? null,
          city: resolvedCity ?? prev?.city ?? null,
        }));
        setRoundNumber(resolvedRoundNumber);
        setRoomStartedAt(resolvedTimerState.timerAnchorAt);

        console.log("[pod-room] timer anchor resolved", {
          roomId,
          roundNumber: resolvedRoundNumber,
          roomStartedAt: data.roomStartedAt ?? null,
          roundStartAt: resolvedRoundStartAt,
          chosenTimerAnchor: resolvedTimerState.timerAnchorAt,
          timerAnchorReason: resolvedTimerState.reason,
          computedSecondsLeft: resolvedTimerState.secondsLeft,
        });

        const nextSecondsLeft = resolvedTimerState.secondsLeft;

        setSecondsLeft(nextSecondsLeft);
        setMatchError(null);

        if (nextSecondsLeft === 0) {
          const timerZeroAt = timerZeroAtRef.current ?? Date.now();
          const forceAfterGrace =
            Date.now() - timerZeroAt >= TIMER_ZERO_FORCE_AFTER_REDIRECT_MS;

          timerZeroAtRef.current = timerZeroAt;

          if (
            shouldSuppressAfterRedirectForCanonicalEnd(
              resolvedTimerState.canonicalSessionEndAt,
              now
            ) &&
            !forceAfterGrace
          ) {
            console.log(
              "[pod-room] suppressing immediate after redirect because session is still active",
              {
                roomId,
                roundNumber: resolvedRoundNumber,
                canonicalSessionEndAt: resolvedTimerState.canonicalSessionEndAt,
              }
            );
            return;
          }

          await routeToAfter(resolvedRoundNumber, "room_identity_timer_zero");
        }
      } catch (error) {
        console.error("[pod-room] fetchRoomIdentity error", error);

        if (attempts < ROOM_IDENTITY_MAX_RETRIES) {
          retryId = setTimeout(() => {
            if (!cancelled) {
              void fetchRoomIdentity();
            }
          }, ROOM_IDENTITY_RETRY_MS);
        } else {
          hasResolvedRoomTimingRef.current = true;
        }
      }
    }

    void fetchRoomIdentity();

    return () => {
      cancelled = true;
      if (retryId) clearTimeout(retryId);
    };
  }, [roomId, authResolved, lockedRound, routeToAfter]);

  const redirectToCanonicalDestination = useCallback(
    async (status: PodStatusResponse | null) => {
      if (hasRedirectedRef.current) return;

      hasRedirectedRef.current = true;
      hasAttemptedConnectRef.current = true;
      await safeDisconnect();

      if (!status?.signedIn) {
        router.replace("/pods");
        return;
      }

      if (status.shouldGoToDone) {
        router.replace("/pods/done");
        return;
      }

      if (
        status.state === "matched" &&
        status.roomId &&
        status.roomId !== roomId
      ) {
        router.replace(
          `/pods/${status.roomId}?round=${status.roundNumber ?? status.currentRound ?? 1}`
        );
        return;
      }

      if (status.phase === "rating" && status.currentRound === roundNumber) {
        try {
          await leaveCurrentPod(roundNumber);
        } catch (error) {
          console.error("[pod-room] leave before rating redirect error", {
            roomId,
            roundNumber,
            error,
          });
        }

        console.log(
          "[pod-room] routing to after because session has actually ended",
          {
            roomId,
            roundNumber,
            canonicalSessionEndAt: canonicalSessionEndAtRef.current,
          }
        );
        router.replace(`/pods/${roomId}/after?round=${roundNumber}`);
        return;
      }

      router.replace("/pods");
    },
    [leaveCurrentPod, roomId, roundNumber, router, safeDisconnect]
  );

  useEffect(() => {
    if (!roomId) return;
    if (!authResolved) return;

    let cancelled = false;

    const validateCanonicalRoom = async () => {
      try {
        const canonicalStatus = await fetchCanonicalPodStatus();

        if (cancelled || !canonicalStatus) return;

        const roomStillCanonical =
          canonicalStatus.state === "matched" &&
          canonicalStatus.roomId === roomId;

        if (roomStillCanonical) {
          afterRedirectSuppressedRef.current = false;
          staleRoomStatusCountRef.current = 0;
          return;
        }

        const isCurrentRoundRatingPhase =
          canonicalStatus.phase === "rating" &&
          canonicalStatus.currentRound === roundNumber;

        if (isCurrentRoundRatingPhase && !hasResolvedRoomTimingRef.current) {
          return;
        }

        const timerEnded = secondsLeftRef.current === 0;
        const timerZeroAt =
          timerEnded ? timerZeroAtRef.current ?? Date.now() : null;
        const forceAfterGrace =
          timerEnded &&
          timerZeroAt !== null &&
          Date.now() - timerZeroAt >= TIMER_ZERO_FORCE_AFTER_REDIRECT_MS;

        if (timerEnded && timerZeroAtRef.current === null) {
          timerZeroAtRef.current = timerZeroAt;
        }

        if (
          isCurrentRoundRatingPhase &&
          shouldSuppressAfterRedirectForCanonicalEnd(
            canonicalSessionEndAtRef.current
          ) &&
          !forceAfterGrace
        ) {
          staleRoomStatusCountRef.current = 0;

          if (!afterRedirectSuppressedRef.current) {
            afterRedirectSuppressedRef.current = true;
            console.log(
              "[pod-room] suppressing immediate after redirect because session is still active",
              {
                roomId,
                roundNumber,
                canonicalSessionEndAt: canonicalSessionEndAtRef.current,
              }
            );
          }

          return;
        }

        afterRedirectSuppressedRef.current = false;

        const shouldRedirectImmediately =
          !canonicalStatus.signedIn ||
          canonicalStatus.shouldGoToDone ||
          (canonicalStatus.state === "matched" &&
            !!canonicalStatus.roomId &&
            canonicalStatus.roomId !== roomId) ||
          isCurrentRoundRatingPhase;

        if (shouldRedirectImmediately) {
          await redirectToCanonicalDestination(canonicalStatus);
          return;
        }

        staleRoomStatusCountRef.current += 1;

        if (staleRoomStatusCountRef.current < 2) {
          console.warn("[pod-room] awaiting second canonical stale-room confirmation", {
            roomId,
            roundNumber,
            canonicalStatus,
          });
          return;
        }

        await redirectToCanonicalDestination(canonicalStatus);
      } catch (error) {
        if (!cancelled) {
          console.error("[pod-room] canonical room validation failed", error);
        }
      }
    };

    void validateCanonicalRoom();

    const interval = setInterval(() => {
      void validateCanonicalRoom();
    }, 4000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [authResolved, redirectToCanonicalDestination, roomId, roundNumber]);

  useEffect(() => {
    if (!roomStartedAt) return;

    setSecondsLeft(getSecondsLeftFromRoomWindow(roomStartedAt));

    const interval = setInterval(() => {
      setSecondsLeft(getSecondsLeftFromRoomWindow(roomStartedAt));
    }, 1000);

    return () => clearInterval(interval);
  }, [roomId, roomStartedAt]);

  useEffect(() => {
    if (roomId && !hasStartedSession) {
      console.log("[pod-room] auto-starting session", {
        roomId,
        currentUserId,
      });

      setHasStartedSession(true);
    }
  }, [hasStartedSession, roomId, currentUserId]);

  const connectAudio = useCallback(
    async (forceRetry = false) => {
      console.log("[pod-room] connectAudio start", {
        roomId,
        currentUserId,
        authResolved,
        forceRetry,
      });

      if (!roomId) return;
      if (hasRedirectedRef.current) return;

      if (!authResolved) {
        console.log("[pod-room] connectAudio blocked: auth not resolved yet", {
          roomId,
        });
        return;
      }

      if (!currentUserId) {
        console.warn("[pod-room] connectAudio blocked: no current user", {
          roomId,
        });
        setAudioError("Could not restore your session.");
        return;
      }

      if (forceRetry) {
        hasAttemptedConnectRef.current = false;
        await safeDisconnect();
      }

      if (connectingRef.current || connectedRef.current || roomRef.current) {
        console.log("[pod-room] skipping duplicate connect", {
          connecting: connectingRef.current,
          connected: connectedRef.current,
          hasRoom: !!roomRef.current,
          lockedRound,
        });
        return;
      }

      connectingRef.current = true;
      cleanedUpRef.current = false;
      setAudioError(null);
      setPlaybackBlocked(false);
      setIsConnectingAudio(true);
      setIsReconnecting(false);

      const maxAttempts = forceRetry ? 1 : 2;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const tokenRes = await fetch("/api/livekit/token", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ roomName: roomId }),
            cache: "no-store",
          });

          const tokenPayload = await tokenRes.json().catch(() => null);

          console.log("[pod-room] token response", {
            status: tokenRes.status,
            payload: tokenPayload,
            attempt,
          });

          if (!tokenRes.ok || !tokenPayload?.token || !tokenPayload?.serverUrl) {
            console.error("[pod-room] token fetch failed", tokenPayload);
            console.error("LIVEKIT TOKEN FETCH ERROR", {
              status: tokenRes.status,
              tokenPayload,
              lockedRound,
              attempt,
            });

            if (tokenRes.status === 401 || tokenRes.status === 403) {
              setAudioError("Could not restore your session.");
              return;
            }

            throw new Error(tokenPayload?.error || "Could not connect audio.");
          }

          const room = new Room();
          roomRef.current = room;

          console.log("[pod-room] connecting to LiveKit", {
            serverUrl: tokenPayload.serverUrl,
            roomId,
            attempt,
          });

          console.log("[pod-room] connecting to room", {
            roomId,
            userId: currentUserId,
            lockedRound,
            attempt,
          });

          room.on(RoomEvent.Reconnecting, () => {
            console.log("[pod-room] reconnecting", { lockedRound });
            clearPeerLeftTimeout();
            setPeerLeftEarly(false);
            setIsReconnecting(true);
            setIsConnectingAudio(false);
          });

          room.on(RoomEvent.Reconnected, () => {
            console.log("[pod-room] reconnected", { lockedRound });

            const livekitParticipantIds = new Set<string>();
            room.remoteParticipants.forEach((participant) => {
              livekitParticipantIds.add(participant.sid);
            });
            remoteParticipantIdsRef.current = livekitParticipantIds;

            const hasRemote = livekitParticipantIds.size > 0;

            clearPeerLeftTimeout();
            setIsReconnecting(false);
            setAudioReady(true);
            setIsConnectingAudio(false);
            setRemoteConnected(hasRemote);
            setPeerLeftEarly(false);

            if (hasRemote) {
              hadRemoteParticipantRef.current = true;
            }
          });

          room.on(RoomEvent.ParticipantConnected, (participant) => {
            if (cleanedUpRef.current || roomRef.current !== room) {
              console.log("[pod-room] ignoring stale ParticipantConnected", {
                participantSid: participant.sid,
                lockedRound,
              });
              return;
            }

            console.log("[pod-room] participant connected", {
              identity: participant.identity,
              sid: participant.sid,
              lockedRound,
            });

            setPeerFailedAudio(false);
            markRemotePresent(participant.sid);
          });

          room.on(RoomEvent.ParticipantDisconnected, (participant) => {
            if (cleanedUpRef.current || roomRef.current !== room) {
              console.log("[pod-room] ignoring stale ParticipantDisconnected", {
                participantSid: participant.sid,
                lockedRound,
              });
              return;
            }

            console.log("[pod-room] participant disconnected", {
              identity: participant.identity,
              sid: participant.sid,
              lockedRound,
            });

            removeRemoteParticipant(participant.sid, "participant_disconnected");
          });

          room.on(
            RoomEvent.TrackSubscribed,
            (
              track: RemoteTrack,
              publication: RemoteTrackPublication,
              participant: RemoteParticipant
            ) => {
              if (cleanedUpRef.current || roomRef.current !== room) {
                console.log("[pod-room] ignoring stale TrackSubscribed event", {
                  participantSid: participant.sid,
                  trackSid: publication.trackSid,
                  lockedRound,
                });
                return;
              }

              console.log("[pod-room] track subscribed", {
                participantIdentity: participant.identity,
                participantSid: participant.sid,
                trackSid: publication.trackSid,
                kind: track.kind,
                lockedRound,
              });

              if (track.kind === Track.Kind.Audio) {
                setPeerFailedAudio(false);
                markRemotePresent(participant.sid);

                try {
                  const element = track.attach();
                  element.autoplay = true;
                  audioElsRef.current.push(element);
                  document.body.appendChild(element);
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);

                  if (
                    message.includes(
                      "Tried to add a track for a participant, that's not present"
                    )
                  ) {
                    console.warn("[pod-room] ignored stale track attach event", {
                      participantIdentity: participant.identity,
                      participantSid: participant.sid,
                      trackSid: publication.trackSid,
                      lockedRound,
                      message,
                    });
                    return;
                  }

                  console.error("[pod-room] audio attach error", error);
                }
              }
            }
          );

          room.on(
            RoomEvent.TrackUnsubscribed,
            (
              track: RemoteTrack,
              publication: RemoteTrackPublication,
              participant: RemoteParticipant
            ) => {
              if (cleanedUpRef.current || roomRef.current !== room) {
                console.log("[pod-room] ignoring stale TrackUnsubscribed event", {
                  participantSid: participant.sid,
                  trackSid: publication.trackSid,
                  lockedRound,
                });
                return;
              }

              console.log("[pod-room] track unsubscribed", {
                participantIdentity: participant.identity,
                participantSid: participant.sid,
                trackSid: publication.trackSid,
                kind: track.kind,
                lockedRound,
              });

              try {
                const detachedEls = track.detach();
                detachedEls.forEach((el) => {
                  try {
                    el.pause();
                    el.srcObject = null;
                    el.remove();
                  } catch {}
                });

                audioElsRef.current = audioElsRef.current.filter(
                  (existingEl) => !detachedEls.includes(existingEl)
                );
              } catch {}

              const participantStillExists = remoteParticipantIdsRef.current.has(
                participant.sid
              );

              if (participantStillExists) {
                if (track.kind === Track.Kind.Audio) {
                  setPeerFailedAudio(true);
                }

                markRemotePresent(participant.sid);
              } else {
                removeRemoteParticipant(participant.sid, "track_unsubscribed");
              }
            }
          );

          room.on(
            RoomEvent.LocalTrackPublished,
            (publication: LocalTrackPublication) => {
              if (cleanedUpRef.current || roomRef.current !== room) {
                console.log("[pod-room] ignoring stale LocalTrackPublished", {
                  trackSid: publication.trackSid,
                  lockedRound,
                });
                return;
              }

              console.log("[pod-room] local track published", {
                trackSid: publication.trackSid,
                kind: publication.kind,
                lockedRound,
              });
            }
          );

          room.on(RoomEvent.MediaDevicesError, (error) => {
            if (cleanedUpRef.current || roomRef.current !== room) return;

            console.error("[pod-room] media devices error", error);
            setAudioError(
              getAudioConnectionErrorMessage(
                error,
                "Microphone access failed."
              )
            );
          });

          room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
            if (cleanedUpRef.current || roomRef.current !== room) return;

            console.log("[pod-room] audio playback status changed", {
              canPlaybackAudio: room.canPlaybackAudio,
              lockedRound,
            });
            setPlaybackBlocked(!room.canPlaybackAudio);
          });

          room.on(RoomEvent.Disconnected, (reason) => {
            if (cleanedUpRef.current || roomRef.current !== room) {
              console.log("[pod-room] ignoring stale Disconnected event", {
                lockedRound,
              });
              return;
            }

            console.log("[pod-room] room disconnected", reason, { lockedRound });

            remoteParticipantIdsRef.current = new Set();
            clearPeerLeftTimeout();
            setIsReconnecting(false);
            setAudioReady(false);
            setRemoteConnected(false);
          });

          await room.connect(tokenPayload.serverUrl, tokenPayload.token);

          console.log("[pod-room] LiveKit connected", {
            roomName: room.name,
            attempt,
          });

          if (cleanedUpRef.current) {
            await safeDisconnect();
            return;
          }

          const initialRemoteIds = new Set<string>();
          room.remoteParticipants.forEach((participant) => {
            initialRemoteIds.add(participant.sid);
          });
          remoteParticipantIdsRef.current = initialRemoteIds;

          if (initialRemoteIds.size > 0) {
            hadRemoteParticipantRef.current = true;
            setRemoteConnected(true);
            setPeerLeftEarly(false);
          } else {
            setRemoteConnected(false);
          }

          try {
            await room.startAudio();
            console.log("[pod-room] startAudio success", { attempt });
            setPlaybackBlocked(false);
          } catch (error) {
            console.warn("[pod-room] initial room.startAudio blocked", error);
            setPlaybackBlocked(true);
            setAudioError("Your browser is blocking audio. Tap to enable sound.");
          }

          try {
            await room.localParticipant.setMicrophoneEnabled(true);
            console.log("[pod-room] mic enabled", { attempt });
          } catch (error) {
            const micErrorMessage = getAudioConnectionErrorMessage(
              error,
              "Could not enable your microphone."
            );

            console.error("[pod-room] mic enable failed", {
              attempt,
              roomId,
              error,
              micErrorMessage,
            });

            throw new Error(micErrorMessage);
          }

          if (cleanedUpRef.current) {
            await safeDisconnect();
            return;
          }

          connectedRef.current = true;
          connectingRef.current = false;
          hasAttemptedConnectRef.current = true;

          setIsMuted(false);
          setAudioReady(true);
          setIsConnectingAudio(false);
          setIsReconnecting(false);
          setPlaybackBlocked(!room.canPlaybackAudio);

          console.log("[pod-room] connected successfully", {
            roomName: room.name,
            localParticipantSid: room.localParticipant.sid,
            roundNumber,
            trackedRemoteCount: getTrackedRemoteCount(),
            attempt,
          });

          return;
        } catch (error) {
          console.error("[pod-room] connectAudio FAILED", error);
          console.error("LIVEKIT CONNECT ERROR", error);

          await safeDisconnect();

          if (attempt === maxAttempts) {
            setAudioError(
              getAudioConnectionErrorMessage(
                error,
                "Could not connect audio."
              )
            );
            setIsConnectingAudio(false);
            setIsReconnecting(false);
            return;
          }

          console.warn("[pod-room] retrying connectAudio once", {
            roomId,
            attempt,
          });
        }
      }
    },
    [
      roomId,
      currentUserId,
      authResolved,
      safeDisconnect,
      roundNumber,
      lockedRound,
      clearPeerLeftTimeout,
      markRemotePresent,
      removeRemoteParticipant,
      getTrackedRemoteCount,
    ]
  );

  useEffect(() => {
    if (!roomId) return;
    if (!authResolved) return;
    if (!currentUserId) return;
    if (hasAttemptedConnectRef.current) return;
    if (connectingRef.current || connectedRef.current || roomRef.current) return;

    console.log("[pod-room] attempting connectAudio after auth ready", {
      roomId,
      authResolved,
      currentUserId,
    });

    void connectAudio();
  }, [roomId, authResolved, currentUserId, connectAudio]);

  useEffect(() => {
    return () => {
      cleanedUpRef.current = true;
      void safeDisconnect();
    };
  }, [roomId, safeDisconnect]);

  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;

    if (remoteConnected) {
      hadRemoteParticipantRef.current = true;
      setPeerLeftEarly(false);
    }
  }, [remoteConnected]);

  useEffect(() => {
    if (secondsLeft !== 0 || hasRedirectedRef.current) return;

    const timerZeroAt = timerZeroAtRef.current ?? Date.now();
    const elapsedSinceZeroMs = Date.now() - timerZeroAt;
    const shouldSuppressForCanonicalEnd =
      shouldSuppressAfterRedirectForCanonicalEnd(canonicalSessionEndAtRef.current);

    timerZeroAtRef.current = timerZeroAt;

    if (
      shouldSuppressForCanonicalEnd &&
      elapsedSinceZeroMs < TIMER_ZERO_FORCE_AFTER_REDIRECT_MS
    ) {
      console.log(
        "[pod-room] suppressing immediate after redirect because session is still active",
        {
          roomId,
          roundNumber,
          canonicalSessionEndAt: canonicalSessionEndAtRef.current,
        }
      );

      const remainingGraceMs =
        TIMER_ZERO_FORCE_AFTER_REDIRECT_MS - elapsedSinceZeroMs;
      const timeout = setTimeout(() => {
        void routeToAfter(roundNumber, "seconds_left_zero_grace_elapsed");
      }, remainingGraceMs);

      return () => clearTimeout(timeout);
    }

    void routeToAfter(roundNumber, "seconds_left_zero");
  }, [secondsLeft, roomId, roundNumber, routeToAfter]);

  async function handleToggleMute() {
    const room = roomRef.current;
    if (!room) return;

    try {
      const nextMuted = !isMuted;
      await room.localParticipant.setMicrophoneEnabled(!nextMuted);
      setIsMuted(nextMuted);
    } catch (error) {
      console.error("TOGGLE MUTE ERROR", error);
      setAudioError("Could not update microphone state.");
    }
  }

  async function handleRetryAudio() {
    setAudioError(null);
    setPlaybackBlocked(false);
    setShowRestoreSession(false);
    setPeerLeftEarly(false);
    setRemoteConnected(false);
    setAudioReady(false);
    setIsConnectingAudio(false);
    setIsReconnecting(false);
    await connectAudio(true);
  }

  async function handleLeavePod() {
    if (isLeaving) return;
    setIsLeaving(true);

    try {
      await leaveCurrentPod();
      await safeDisconnect();
      router.push(`/pods/${roomId}/after?round=${roundNumber}`);
    } catch (error) {
      console.error("LEAVE POD ERROR", error);
      setIsLeaving(false);
    }
  }

  const minutesStr = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const secondsStr = String(secondsLeft % 60).padStart(2, "0");
  const timer = `${minutesStr}:${secondsStr}`;

  const shouldShowRoomRefresh =
    showRestoreSession &&
    !audioReady &&
    !isConnectingAudio &&
    !isReconnecting &&
    !playbackBlocked &&
    !audioError &&
    secondsLeft > 0;

  const hadRemoteParticipant = hadRemoteParticipantRef.current;

  const statusLabel =
    isLeaving
      ? "Leaving your pod..."
      : secondsLeft === 0
        ? "Session ended"
        : playbackBlocked
          ? "Tap to enable audio"
          : isReconnecting
            ? "Reconnecting..."
            : isConnectingAudio
              ? "Connecting audio..."
              : shouldShowRoomRefresh
                ? "Connection stalled."
                : !authResolved
                  ? "Restoring your session..."
                  : !currentUserId
                    ? "Restoring your session..."
                    : peerLeftEarly
                      ? "Your match has left the pod."
                      : peerFailedAudio && remoteConnected
                        ? "Your match is having audio issues."
                        : audioReady && remoteConnected
                          ? "You’re live — say hi 👋"
                          : audioReady
                            ? "Waiting for your match to join..."
                            : audioError
                              ? audioError
                              : "Connecting audio...";

  console.log("[pod-room] status snapshot", {
    authResolved,
    currentUserId,
    audioReady,
    isConnectingAudio,
    remoteConnected,
    peerLeftEarly,
    hadRemoteParticipant,
    trackedRemoteCount: remoteParticipantIdsRef.current.size,
  });

  const displayName = matchProfile?.first_name?.trim() || "Your pod";
  const displayCity = matchProfile?.city?.trim() || null;
  const hasLoadedIdentity = !!matchProfile?.first_name;

  return (
    <main
      onClick={playbackBlocked ? () => void ensurePlayback() : undefined}
      className="relative flex min-h-screen w-full items-center justify-center overflow-x-hidden bg-black px-4 py-6 text-white md:py-10"
      style={{
        background:
          "radial-gradient(circle at top, #1a1024 0%, #05030a 60%, #020106 100%)",
      }}
    >
      <div className="mt-8 flex w-full max-w-sm flex-col items-center md:mt-10 md:max-w-3xl">
        <div className="mb-2 text-[9px] uppercase tracking-[0.35em] text-pink-400 md:mb-3 md:text-xs">
          THEPODS
        </div>

        <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-zinc-500 md:text-xs">
          Round {roundNumber}
        </div>

        <div className="mb-4 text-[10px] text-zinc-400 md:mb-5 md:text-xs">
          Time left in pod:{" "}
          <span className="font-mono tabular-nums text-zinc-200">{timer}</span>
        </div>

        <div className="mb-3 mt-4 max-w-md text-center md:mb-5 md:mt-6">
          <p className="mb-1 text-[12px] leading-snug text-zinc-400 md:mb-2 md:text-lg">
            No video, just conversation. You&apos;re in a 1:1 voice pod.
          </p>
          <p className="text-[12px] leading-snug text-zinc-300 md:text-base md:leading-normal">
            Say hi, see if there&apos;s a vibe, and swap info if it clicks.
          </p>
        </div>

        {prompt && (
          <div className="mt-3 w-full max-w-md rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-center shadow-[0_0_20px_rgba(255,20,147,0.12)]">
            <p className="mb-1 text-[10px] uppercase tracking-[0.25em] text-zinc-500 md:text-xs">
              To get things started
            </p>
            <p className="text-[13px] leading-relaxed text-zinc-200 md:text-base">
              {prompt}
            </p>
          </div>
        )}

        <div className="relative mt-8 flex w-full max-w-xs items-center justify-center overflow-hidden md:mt-9 md:max-w-md">
          <div
            className="rounded-full"
            style={{
              width: "320px",
              height: "320px",
              border: "2px solid rgba(255,255,255,0.05)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <div
              className="animate-pulse flex h-[190px] w-[190px] items-center justify-center rounded-full shadow-[0_0_60px_rgba(255,20,147,0.3)]"
              style={{
                background:
                  "radial-gradient(circle, rgba(255,118,255,1) 0%, rgba(125,64,255,1) 100%)",
              }}
            >
              <span className="text-5xl md:text-7xl">🔊</span>
            </div>
          </div>
        </div>

        <p
          className={`mt-4 text-[14px] font-medium md:mt-6 md:text-lg ${
            secondsLeft === 0 ? "text-red-300" : "text-green-300"
          }`}
        >
          {statusLabel}
        </p>

        {peerFailedAudio && (
          <p className="mt-2 text-xs text-zinc-400">
            They may need to allow microphone access and retry.
          </p>
        )}

        {!peerLeftEarly &&
          !peerFailedAudio &&
          !hadRemoteParticipant &&
          !remoteConnected &&
          audioReady &&
          !isReconnecting && (
            <p className="mt-2 text-[11px] text-zinc-400">
              Waiting for the other person...
            </p>
          )}

        {playbackBlocked && (
          <div className="mt-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-4 text-center">
            <p className="mb-2 text-sm text-zinc-200">
              Tap anywhere to enable audio 🔊
            </p>
            <p className="text-xs text-zinc-400">
              Your browser needs one tap before you can hear your pod.
            </p>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void ensurePlayback();
              }}
              className="mt-4 rounded-full bg-zinc-800 px-5 py-2 text-[12px] transition hover:bg-zinc-700 md:text-sm"
            >
              Enable audio
            </button>
          </div>
        )}

        {audioError && !playbackBlocked && (
          <div className="mt-3 flex flex-col items-center gap-3">
            <p className="text-[11px] text-red-300 md:text-sm">{audioError}</p>
            <button
              type="button"
              onClick={handleRetryAudio}
              disabled={isConnectingAudio || isLeaving}
              className="rounded-full bg-zinc-800 px-5 py-2 text-[12px] transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 md:text-sm"
            >
              {isConnectingAudio ? "Retrying..." : "Retry audio"}
            </button>
          </div>
        )}

        {shouldShowRoomRefresh && (
          <div className="mt-3 flex flex-col items-center gap-3">
            <p className="text-[11px] text-zinc-400 md:text-sm">
              Having trouble connecting?
            </p>
            <button
              type="button"
              onClick={() => {
                if (typeof window !== "undefined") {
                  window.location.reload();
                }
              }}
              className="rounded-full bg-zinc-800 px-5 py-2 text-[12px] transition hover:bg-zinc-700 md:text-sm"
            >
              Refresh
            </button>
          </div>
        )}

        <div className="mt-7 mb-10 flex w-full flex-col items-center gap-4 md:mt-9 md:mb-14 md:gap-6">
          <div className="flex flex-col items-center justify-center gap-3 sm:flex-row md:gap-6">
            <button
              type="button"
              onClick={handleToggleMute}
              disabled={secondsLeft === 0 || !audioReady || isReconnecting}
              className="flex items-center gap-2 rounded-full bg-zinc-800 px-5 py-2.5 text-[12px] transition hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-40 md:px-6 md:py-3 md:text-sm"
            >
              🎤 {isMuted ? "Unmute mic" : "Mute mic"}
            </button>

            <button
              type="button"
              onClick={handleLeavePod}
              disabled={isLeaving}
              className="rounded-full bg-pink-500 px-7 py-2.5 text-[12px] font-semibold shadow-[0_0_20px_rgba(255,20,147,0.6)] transition hover:bg-pink-400 disabled:opacity-50 md:px-8 md:py-3 md:text-sm"
            >
              {isLeaving ? "Leaving..." : "Leave Pod"}
            </button>
          </div>

          <div className="mt-4 w-full max-w-xs md:max-w-md">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/80 px-4 py-3 text-center">
              <p className="mb-1 text-[11px] text-zinc-500">
                You&apos;re talking to
              </p>
              <p className="font-semibold">{displayName}</p>
              <p className="text-[11px] text-zinc-300">
                {displayCity
                  ? displayCity
                  : hasLoadedIdentity
                    ? "Connected to your pod"
                    : "Getting their details..."}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">
                {matchError
                  ? matchError
                  : hasLoadedIdentity
                    ? "Get to know each other and see if there’s a vibe."
                    : "We found your pod. Loading their details in the background."}
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
