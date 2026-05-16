"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { supabase } from "@/lib/supabase/client";
import { TOTAL_ROUNDS } from "@/lib/pods/timing";
import { markRevealDismissed as setRevealDismissedFlag } from "@/lib/pods/revealDismissed";
import { usePodStatus } from "@/lib/pods/hooks/usePodStatus";
import { log } from "@/lib/log";

type MatchResult = {
  userId: string;
  name: string | null;
  city: string | null;
  contact: string | null;
  roundNumber: number | null;
  myRating: string | null;
  theirRating: string | null;
  photoUrl: string | null;
};

type PodResultRow = {
  room_id: string;
  user_id: string;
  matched_user_id: string;
  outcome: string;
  shared_contact: string | null;
  round_number?: number | null;
  rating?: string | null;
  matched_user_rating?: string | null;
};

type ProfileRow = {
  id: string;
  first_name: string | null;
  city: string | null;
  photo_path: string | null;
};

type PodFeedbackRow = {
  user_id: string;
  room_id: string;
  round_number: number;
  rating: string | null;
  contact: string | null;
};

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
};

type FinalizationSummary = {
  feedbackRows: PodFeedbackRow[];
  highestSubmittedRound: number | null;
  pendingRounds: number[];
};

type PodStatusResponse = {
  phase?: string | null;
  canEnterRound?: boolean | null;
  reason?: string | null;
};

type RevealPhase = "loading" | "sponsor" | "countdown" | "revealed";

// Inner retry: how many times we re-check pod_feedback per room/round before
// returning "waiting". Originally 8 (≈10s per round) to tolerate slow writes
// in race conditions; 3 (≈3.6s) is plenty now that match results write fast.
const RESULT_RETRY_ATTEMPTS = 3;
const RESULT_RETRY_DELAY_MS = 1200;
// Cap outer retries (each one re-runs the full per-room finalize loop) so
// the page falls through to "show what we have" if a match never submits
// feedback. Total wait ≈ MAX_OUTER_RETRIES * (per-room inner retries +
// RESULT_RETRY_DELAY_MS), bounded at roughly 10–15s before we give up.
const MAX_OUTER_RETRIES = 2;
const PHOTO_BUCKET = "profile-photos";
const SPONSOR_AUTO_CONTINUE_MS = 6500;
const SPONSOR_BY_POD_ID: Record<string, string> = {
  "pods_nyc_2026-05-14": "/sponsors/nyc/2026-05-14.png",
  "pods_la_2026-05-14": "/sponsors/la/2026-05-14.png",
};

function normalizeCity(city: string | null) {
  if (!city) return "LA";

  const normalized = city.trim().toLowerCase();

  if (
    normalized === "nyc" ||
    normalized === "new york" ||
    normalized === "new york city"
  ) {
    return "NYC";
  }

  if (normalized === "la" || normalized === "los angeles") {
    return "LA";
  }

  return "LA";
}

function getTimeZone(city: string | null) {
  return normalizeCity(city) === "NYC"
    ? "America/New_York"
    : "America/Los_Angeles";
}

function getDebugAdjustedNow() {
  const debugOffsetMinutes = Number(
    process.env.NEXT_PUBLIC_PODS_DEBUG_OFFSET_MINUTES || 0
  );

  return new Date(Date.now() + debugOffsetMinutes * 60 * 1000);
}

function getCityTimeParts(city: string | null) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: getTimeZone(city),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const now = getDebugAdjustedNow();
  const parts = formatter.formatToParts(now);

  const getPart = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
  };
}

function getPodIdForCurrentSession(city: string | null) {
  const normalizedCity = normalizeCity(city);
  const { year, month, day } = getCityTimeParts(normalizedCity);
  const formattedMonth = String(month).padStart(2, "0");
  const formattedDay = String(day).padStart(2, "0");

  return `pods_${normalizedCity.toLowerCase()}_${year}-${formattedMonth}-${formattedDay}`;
}

function getSponsorCityLabel(targetPodId: string) {
  if (targetPodId.startsWith("pods_nyc_")) return "NYC";
  if (targetPodId.startsWith("pods_la_")) return "LA";
  return "Tonight's";
}

function getSponsorImage(targetPodId: string) {
  const parts = targetPodId.split("_");

  if (parts.length !== 3) return null;

  const city = parts[1];
  const date = parts[2];

  return `/sponsors/${city}/${date}.png`;
}

function getSponsorImageCandidate(targetPodId: string) {
  return SPONSOR_BY_POD_ID[targetPodId] ?? getSponsorImage(targetPodId);
}

async function getSponsorImageForPodId(targetPodId: string) {
  const sponsorImageSrc = getSponsorImageCandidate(targetPodId);

  if (!sponsorImageSrc) return null;

  try {
    const response = await fetch(sponsorImageSrc, {
      method: "HEAD",
      cache: "no-store",
    });

    return response.ok ? sponsorImageSrc : null;
  } catch (error) {
    console.error("[DONE RESULT DEBUG] sponsor image check failed", {
      podId: targetPodId,
      sponsorImageSrc,
      error,
    });
    return null;
  }
}

function isFinishedPodStatus(data: PodStatusResponse | null) {
  if (!data) return false;

  return (
    data.phase === "finished" ||
    (data.canEnterRound === false && data.reason === "finished")
  );
}

async function isPodNightFinishedForDonePage() {
  try {
    const response = await fetch("/api/pods/status", {
      method: "GET",
      cache: "no-store",
    });

    if (!response.ok) {
      log.warn("[DONE RESULT DEBUG] pod status check failed", {
        status: response.status,
        statusText: response.statusText,
      });
      return false;
    }

    const data = (await response.json().catch(() => null)) as
      | PodStatusResponse
      | null;

    return isFinishedPodStatus(data);
  } catch (error) {
    console.error("[DONE RESULT DEBUG] pod status check error", error);
    return false;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRating(
  value: string | null | undefined
): "great" | "okay" | "nope" | null {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (normalized === "great") return "great";
  if (normalized === "okay") return "okay";
  if (normalized === "nope") return "nope";

  return null;
}

function isPositiveRating(value: string | null | undefined) {
  const normalized = normalizeRating(value);
  return normalized === "great";
}

function getOutcomeFromRatings(
  ratingA: string | null | undefined,
  ratingB: string | null | undefined
) {
  const normalizedA = normalizeRating(ratingA);
  const normalizedB = normalizeRating(ratingB);

  if (!normalizedA || !normalizedB) return "pending";

  if (isPositiveRating(normalizedA) && isPositiveRating(normalizedB)) {
    return "match";
  }

  return "no_match";
}

function getInitials(name: string | null) {
  if (!name) return "♡";

  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "♡";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();

  return `${parts[0][0] ?? ""}${parts[1][0] ?? ""}`.toUpperCase();
}

async function getSignedPhotoUrl(photoPath: string | null) {
  if (!photoPath) return null;

  const { data, error } = await supabase.storage
    .from(PHOTO_BUCKET)
    .createSignedUrl(photoPath, 60 * 60);

  if (error) {
    console.error("SIGNED PHOTO URL ERROR", {
      photoPath,
      message: error.message,
    });
    return null;
  }

  return data?.signedUrl ?? null;
}

export default function PodsDonePage() {
  const router = useRouter();
  // Pulled exclusively for `pod.podId` so the dismissed-reveal flag can be
  // keyed to this exact pod night. Without this, a click handler firing
  // before the page has resolved its own city/podId would write a flag the
  // lobby couldn't match. Polling at the default cadence is fine — the
  // value we care about (podId) doesn't change during a pod night.
  const { status: pod } = usePodStatus();
  function markRevealDismissed() {
    setRevealDismissedFlag(pod?.podId);
  }

  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState<MatchResult[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [phase, setPhase] = useState<RevealPhase>("loading");
  const [countdown, setCountdown] = useState(3);
  const [city, setCity] = useState<string | null>(null);
  const [showContinue, setShowContinue] = useState(false);
  const [fromSponsor, setFromSponsor] = useState(false);
  const [resolvedSponsorImageSrc, setResolvedSponsorImageSrc] = useState<
    string | null
  >(null);
  const [failedSponsorImageSrc, setFailedSponsorImageSrc] = useState<
    string | null
  >(null);
  const resultRetryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Bounded outer-retry counter: caps how many times we re-poll for the
  // OTHER user's feedback before giving up and showing whatever results
  // are already finalized. Without this cap the page polls forever when
  // a match left without rating, which is what produced the "Finalizing
  // your results" infinite spinner. Resets on every fresh loadResults
  // entry that doesn't immediately re-schedule a retry.
  const outerRetryCountRef = useRef(0);

  const podId = useMemo(() => getPodIdForCurrentSession(city), [city]);

  useEffect(() => {
    let cancelled = false;
    let isLoadingResults = false;

    const clearResultRetryTimeout = () => {
      if (resultRetryTimeoutRef.current) {
        clearTimeout(resultRetryTimeoutRef.current);
        resultRetryTimeoutRef.current = null;
      }
    };

    async function getRoomForResults(targetRoomId: string) {
      const { data: roomRowRaw, error: roomLookupError } = await supabase
        .from("pod_rooms")
        .select("room_id, user_a_id, user_b_id")
        .eq("room_id", targetRoomId)
        .maybeSingle<PodRoomRow>();

      if (roomLookupError) {
        console.error("DONE ROOM LOOKUP ERROR", roomLookupError);
        return {
          error: roomLookupError,
          room: null as PodRoomRow | null,
        };
      }

      const room = roomRowRaw as PodRoomRow | null;

      if (!room) {
        const notFoundError = new Error("Room not found");
        console.error("DONE ROOM LOOKUP ERROR", {
          message: "Room not found",
          targetRoomId,
        });

        return {
          error: notFoundError,
          room: null as PodRoomRow | null,
        };
      }

      return {
        error: null,
        room,
      };
    }

    async function upsertPodResultsForRoomRound(
      targetRoomId: string,
      targetRound: number
    ): Promise<"created" | "waiting" | "error"> {
      const roomResult = await getRoomForResults(targetRoomId);

      if (roomResult.error || !roomResult.room) {
        return "error";
      }

      const roomRow = roomResult.room;

      const { data: roomFeedbackRowsRaw, error: roomFeedbackError } = await supabase
        .from("pod_feedback")
        .select("user_id, room_id, round_number, rating, contact")
        .eq("room_id", targetRoomId)
        .eq("round_number", targetRound);

      if (roomFeedbackError) {
        console.error("DONE ROOM FEEDBACK LOAD ERROR", roomFeedbackError);
        return "error";
      }

      const roomFeedbackRows = (roomFeedbackRowsRaw ?? []) as PodFeedbackRow[];

      log.debug("[DONE RESULT DEBUG] feedback rows", {
        roomId: targetRoomId,
        round: targetRound,
        count: roomFeedbackRows.length,
        rows: roomFeedbackRows,
      });

      const feedbackA = roomFeedbackRows.find(
        (row) => row.user_id === roomRow.user_a_id
      );
      const feedbackB = roomFeedbackRows.find(
        (row) => row.user_id === roomRow.user_b_id
      );

      if (!feedbackA || !feedbackB) {
        log.debug("[DONE RESULT DEBUG] waiting for both users", {
          roomId: targetRoomId,
          round: targetRound,
          hasA: !!feedbackA,
          hasB: !!feedbackB,
        });
        return "waiting";
      }

      const outcome = getOutcomeFromRatings(feedbackA.rating, feedbackB.rating);
      const isMatch = outcome === "match";

      const sharedContactForA = isMatch ? feedbackB.contact ?? null : null;
      const sharedContactForB = isMatch ? feedbackA.contact ?? null : null;

      const rowsToWrite = [
        {
          room_id: targetRoomId,
          user_id: roomRow.user_a_id,
          matched_user_id: roomRow.user_b_id,
          round_number: targetRound,
          rating: normalizeRating(feedbackA.rating),
          matched_user_rating: normalizeRating(feedbackB.rating),
          outcome,
          shared_contact: sharedContactForA,
        },
        {
          room_id: targetRoomId,
          user_id: roomRow.user_b_id,
          matched_user_id: roomRow.user_a_id,
          round_number: targetRound,
          rating: normalizeRating(feedbackB.rating),
          matched_user_rating: normalizeRating(feedbackA.rating),
          outcome,
          shared_contact: sharedContactForB,
        },
      ];

      const { error: podResultsError } = await supabase
        .from("pod_results")
        .upsert(rowsToWrite, {
          onConflict: "room_id,user_id",
        });

      if (podResultsError) {
        console.error("DONE POD RESULTS UPSERT ERROR", podResultsError);
        return "error";
      }

      log.debug("[DONE RESULT DEBUG] pod_results written", {
        roomId: targetRoomId,
        round: targetRound,
        outcome,
      });

      return "created";
    }

    async function waitForAndFinalizeResults(
      targetRoomId: string,
      targetRound: number
    ): Promise<boolean> {
      for (let attempt = 1; attempt <= RESULT_RETRY_ATTEMPTS; attempt += 1) {
        if (cancelled) {
          return false;
        }

        const result = await upsertPodResultsForRoomRound(
          targetRoomId,
          targetRound
        );

        if (result === "created") {
          return true;
        }

        if (result === "error") {
          return false;
        }

        if (attempt < RESULT_RETRY_ATTEMPTS) {
          await sleep(RESULT_RETRY_DELAY_MS);
        }
      }

      return false;
    }

    async function finalizeUserResultsForPod(
      userId: string
    ): Promise<FinalizationSummary> {
      const { data: feedbackRowsRaw, error: feedbackError } = await supabase
        .from("pod_feedback")
        .select("user_id, room_id, round_number, rating, contact")
        .eq("user_id", userId);

      if (feedbackError) {
        console.error("DONE USER FEEDBACK LOAD ERROR", feedbackError);
        throw new Error("Could not load your submitted ratings.");
      }

      const feedbackRows = (feedbackRowsRaw ?? []) as PodFeedbackRow[];

      if (feedbackRows.length === 0) {
        return {
          feedbackRows: [],
          highestSubmittedRound: null,
          pendingRounds: [],
        };
      }

      const uniqueRoomRounds = Array.from(
        new Map(
          feedbackRows.map((row) => [
            `${row.room_id}::${row.round_number}`,
            { roomId: row.room_id, roundNumber: row.round_number },
          ])
        ).values()
      );
      const highestSubmittedRound = feedbackRows.reduce<number>(
        (maxRound, row) => Math.max(maxRound, row.round_number),
        0
      );
      const pendingRounds = new Set<number>();

      log.debug("[DONE RESULT DEBUG] finalizing room rounds", uniqueRoomRounds);

      for (const item of uniqueRoomRounds) {
        const finalized = await waitForAndFinalizeResults(
          item.roomId,
          item.roundNumber
        );

        if (!finalized) {
          log.debug("[DONE RESULT DEBUG] room round not finalized yet", item);
          pendingRounds.add(item.roundNumber);
        }
      }

      return {
        feedbackRows,
        highestSubmittedRound,
        pendingRounds: Array.from(pendingRounds).sort((a, b) => a - b),
      };
    }

    async function loadResults() {
      if (isLoadingResults) return;

      isLoadingResults = true;
      clearResultRetryTimeout();

      try {
        setLoading(true);
        setErrorMsg(null);
        setPhase("loading");
        setCountdown(3);
        setResolvedSponsorImageSrc(null);

        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
          if (!cancelled) {
            setErrorMsg("Please log in again.");
            setLoading(false);
          }
          return;
        }

        const { data: profileRaw, error: profileError } = await supabase
          .from("profiles")
          .select("id, first_name, city, photo_path")
          .eq("id", user.id)
          .maybeSingle<ProfileRow>();

        if (profileError) {
          console.error("DONE PROFILE LOAD ERROR", profileError);
        }

        const sessionCity = profileRaw?.city ?? null;

        if (!cancelled) {
          setCity(sessionCity);
        }

        const userId = user.id;
        const currentPodId = getPodIdForCurrentSession(sessionCity);
        const resolveRevealEntry = async () => {
          const nextSponsorImage = await getSponsorImageForPodId(currentPodId);

          return {
            nextSponsorImage,
            nextPhase: nextSponsorImage ? "sponsor" : "countdown",
          } satisfies {
            nextSponsorImage: string | null;
            nextPhase: RevealPhase;
          };
        };

        const finalizationSummary = await finalizeUserResultsForPod(userId);

        if (cancelled) return;

        const feedbackRows = finalizationSummary.feedbackRows;
        const highestSubmittedRound = finalizationSummary.highestSubmittedRound;

        if (
          highestSubmittedRound !== null &&
          highestSubmittedRound < TOTAL_ROUNDS
        ) {
          const nextRound = Math.min(highestSubmittedRound + 1, TOTAL_ROUNDS);
          const podNightFinished = await isPodNightFinishedForDonePage();

          if (cancelled) return;

          if (podNightFinished) {
            log.debug(
              "[DONE RESULT DEBUG] staying on done page because pod night is finished",
              {
                highestSubmittedRound,
                nextRound,
                pendingRounds: finalizationSummary.pendingRounds,
              }
            );
          } else {
            log.debug("[DONE RESULT DEBUG] returning user to next round lobby", {
              highestSubmittedRound,
              nextRound,
              pendingRounds: finalizationSummary.pendingRounds,
            });

            // The new lobby is driven by /api/pods/status, not by the older
            // FORWARD_HANDOFF sessionStorage signaling. Just route to /pods —
            // it'll self-sync to the correct round on its next status poll.
            router.replace(`/pods?round=${nextRound}`);
            return;
          }
        }

        if (
          highestSubmittedRound === TOTAL_ROUNDS &&
          finalizationSummary.pendingRounds.length > 0
        ) {
          // Bounded retry: don't poll forever waiting for a match who left
          // without rating. After MAX_OUTER_RETRIES we fall through and
          // render whatever's already in pod_results — rounds with no
          // counter-rating just won't appear in the user's reveal list,
          // which is the right outcome (a no_match-by-omission).
          if (outerRetryCountRef.current >= MAX_OUTER_RETRIES) {
            log.debug(
              "[DONE RESULT DEBUG] outer retry budget exhausted; proceeding with partial results",
              {
                attempts: outerRetryCountRef.current,
                pendingRounds: finalizationSummary.pendingRounds,
              }
            );
            outerRetryCountRef.current = 0;
            // Fall through to the pod_results query below.
          } else {
            outerRetryCountRef.current += 1;
            log.debug(
              "[DONE RESULT DEBUG] final round not fully finalized yet, retrying",
              {
                attempt: outerRetryCountRef.current,
                maxAttempts: MAX_OUTER_RETRIES,
                pendingRounds: finalizationSummary.pendingRounds,
              }
            );

            resultRetryTimeoutRef.current = setTimeout(() => {
              if (!cancelled) {
                void loadResults();
              }
            }, RESULT_RETRY_DELAY_MS);
            return;
          }
        } else {
          // Successful pass-through (no pending rounds): reset the counter so
          // a future re-entry into the retry branch starts fresh.
          outerRetryCountRef.current = 0;
        }

        const roomIdsFromThisUser = Array.from(
          new Set(feedbackRows.map((row) => row.room_id).filter(Boolean))
        );

        if (roomIdsFromThisUser.length === 0) {
          const { nextSponsorImage, nextPhase } = await resolveRevealEntry();

          if (cancelled) return;

          if (!cancelled) {
            setResolvedSponsorImageSrc(nextSponsorImage);
            setMatches([]);
            setLoading(false);
            setPhase(nextPhase);
          }
          return;
        }

        const { data: resultRowsRaw, error: resultsError } = await supabase
          .from("pod_results")
          .select(
            "room_id, user_id, matched_user_id, outcome, shared_contact, round_number, rating, matched_user_rating"
          )
          .eq("user_id", userId)
          .in("room_id", roomIdsFromThisUser);

        if (resultsError) {
          console.error("DONE RESULTS LOAD ERROR", resultsError);
          if (!cancelled) {
            setErrorMsg("Could not load your results.");
            setLoading(false);
          }
          return;
        }

        let results = (resultRowsRaw ?? []) as PodResultRow[];

        if (results.length > 0) {
          const { data: roomRowsRaw, error: roomRowsError } = await supabase
            .from("pod_rooms")
            .select("room_id, user_a_id, user_b_id")
            .in(
              "room_id",
              Array.from(new Set(results.map((row) => row.room_id)))
            );

          if (roomRowsError) {
            console.error("DONE ROOM SCOPE LOAD ERROR", roomRowsError);
          } else {
            const roomRows = (roomRowsRaw ?? []) as PodRoomRow[];
            const roomIdsForCurrentPod = new Set<string>();

            for (const room of roomRows) {
              if (room.room_id.includes(currentPodId)) {
                roomIdsForCurrentPod.add(room.room_id);
              }
            }

            if (roomIdsForCurrentPod.size > 0) {
              results = results.filter((row) =>
                roomIdsForCurrentPod.has(row.room_id)
              );
            }
          }
        }

        const mutualMatches = results.filter((row) => row.outcome === "match");

        if (mutualMatches.length === 0) {
          const { nextSponsorImage, nextPhase } = await resolveRevealEntry();

          if (cancelled) return;

          if (!cancelled) {
            setResolvedSponsorImageSrc(nextSponsorImage);
            setMatches([]);
            setLoading(false);
            setPhase(nextPhase);
          }
          return;
        }

        const uniqueMatches = Array.from(
          new Map(
            mutualMatches.map((row) => [
              `${row.matched_user_id}::${row.room_id}`,
              row,
            ])
          ).values()
        );

        const matchedUserIds = Array.from(
          new Set(uniqueMatches.map((row) => row.matched_user_id))
        );

        const { data: profilesRaw, error: profilesError } = await supabase
          .from("profiles")
          .select("id, first_name, city, photo_path")
          .in("id", matchedUserIds);

        if (profilesError) {
          console.error("DONE PROFILE LOAD ERROR", profilesError);
          if (!cancelled) {
            setErrorMsg("Could not load match profiles.");
            setLoading(false);
          }
          return;
        }

        const profiles = (profilesRaw ?? []) as ProfileRow[];

        const profileMap = new Map(
          profiles.map((profile) => [profile.id, profile])
        );

        const photoUrlEntries = await Promise.all(
          profiles.map(async (profile) => {
            const signedUrl = await getSignedPhotoUrl(profile.photo_path);
            return [profile.id, signedUrl] as const;
          })
        );

        const photoUrlMap = new Map(photoUrlEntries);

        const finalMatches: MatchResult[] = uniqueMatches
          .map((row) => {
            const profile = profileMap.get(row.matched_user_id);

            return {
              userId: row.matched_user_id,
              name: profile?.first_name ?? null,
              city: profile?.city ?? null,
              contact: row.shared_contact ?? null,
              roundNumber:
                typeof row.round_number === "number" ? row.round_number : null,
              myRating: row.rating ?? null,
              theirRating: row.matched_user_rating ?? null,
              photoUrl: photoUrlMap.get(row.matched_user_id) ?? null,
            };
          })
          .sort((a, b) => {
            const aRound = a.roundNumber ?? 999;
            const bRound = b.roundNumber ?? 999;
            return aRound - bRound;
          });

        if (!cancelled) {
          const { nextSponsorImage, nextPhase } = await resolveRevealEntry();

          if (cancelled) return;

          setResolvedSponsorImageSrc(nextSponsorImage);
          setMatches(finalMatches);
          setLoading(false);
          setPhase(nextPhase);
        }
      } catch (error) {
        console.error("DONE RESULT LOAD ERROR", error);
        if (!cancelled) {
          setErrorMsg(
            error instanceof Error ? error.message : "Something went wrong."
          );
          setLoading(false);
        }
      } finally {
        isLoadingResults = false;
      }
    }

    void loadResults();

    return () => {
      cancelled = true;
      clearResultRetryTimeout();
    };
  }, [podId, router]);

  const sponsorImageSrc =
    resolvedSponsorImageSrc !== failedSponsorImageSrc
      ? resolvedSponsorImageSrc
      : null;
  const sponsorCityLabel = getSponsorCityLabel(podId);

  const continueFromSponsor = useCallback(() => {
    setFromSponsor(true);
    setCountdown(2);
    setPhase("countdown");
  }, []);

  useEffect(() => {
    setFailedSponsorImageSrc(null);
  }, [resolvedSponsorImageSrc]);

  useEffect(() => {
    if (phase === "sponsor") {
      setShowContinue(false);
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "sponsor") return;

    setFromSponsor(false);
  }, [phase]);

  useEffect(() => {
    if (loading || errorMsg || phase !== "sponsor") return;

    if (!sponsorImageSrc) {
      setFromSponsor(false);
      setCountdown(3);
      setPhase("countdown");
      return;
    }

    const buttonDelay = setTimeout(() => {
      setShowContinue(true);
    }, 4000);

    const autoContinue = setTimeout(() => {
      setFromSponsor(true);
      setCountdown(2);
      setPhase("countdown");
    }, SPONSOR_AUTO_CONTINUE_MS);

    return () => {
      clearTimeout(buttonDelay);
      clearTimeout(autoContinue);
    };
  }, [
    continueFromSponsor,
    errorMsg,
    loading,
    phase,
    sponsorImageSrc,
  ]);

  useEffect(() => {
    if (loading || errorMsg || phase !== "countdown") return;

    if (countdown <= 1) {
      const timeout = setTimeout(() => {
        setPhase("revealed");
      }, 850);

      return () => clearTimeout(timeout);
    }

    const interval = setInterval(() => {
      setCountdown((prev) => prev - 1);
    }, 850);

    return () => clearInterval(interval);
  }, [phase, countdown, loading, errorMsg]);

  const hasMatches = matches.length > 0;

  return (
    <main
      className="min-h-screen bg-black text-white flex items-center justify-center px-3 py-4 md:px-4 md:py-8 overflow-hidden"
      style={{
        background:
          "radial-gradient(circle at top, #2a0f36 0%, #120617 35%, #05030a 70%, #020106 100%)",
      }}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <motion.div
          className="absolute left-1/2 top-[12%] h-56 w-56 -translate-x-1/2 rounded-full bg-pink-500/10 blur-3xl md:h-72 md:w-72"
          animate={{ scale: [1, 1.2, 1], opacity: [0.35, 0.6, 0.35] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute bottom-[8%] left-[15%] h-40 w-40 rounded-full bg-fuchsia-500/10 blur-3xl md:h-56 md:w-56"
          animate={{ scale: [1.1, 0.95, 1.1], opacity: [0.25, 0.45, 0.25] }}
          transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute right-[10%] top-[25%] h-36 w-36 rounded-full bg-rose-400/10 blur-3xl md:h-52 md:w-52"
          animate={{ scale: [0.95, 1.15, 0.95], opacity: [0.2, 0.4, 0.2] }}
          transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>

      <div className="relative z-10 w-full max-w-md md:max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-3 text-center text-[10px] uppercase tracking-[0.35em] text-pink-400 md:mb-4 md:text-xs"
        >
          THEPODS
        </motion.div>

        <div className="rounded-[1.75rem] border border-white/10 bg-zinc-900/70 backdrop-blur-xl px-4 py-5 md:rounded-[2rem] md:p-10 text-center shadow-[0_0_60px_rgba(255,20,147,0.18)]">
          <AnimatePresence mode="wait">
            {loading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 1.02 }}
                transition={{ duration: 0.35 }}
              >
                <div className="mb-5 flex justify-center">
                  <motion.div
                    className="h-14 w-14 rounded-full border-2 border-pink-400/30 border-t-pink-400 md:h-16 md:w-16"
                    animate={{ rotate: 360 }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  />
                </div>
                <h1 className="mb-3 text-2xl font-semibold md:text-4xl">
                  Finalizing your results
                </h1>
                <p className="text-sm text-zinc-400 md:text-base">
                  Checking for mutual matches...
                </p>
              </motion.div>
            ) : errorMsg ? (
              <motion.div
                key="error"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
              >
                <h1 className="mb-3 text-2xl font-semibold md:text-4xl">
                  We hit a snag
                </h1>
                <p className="text-sm text-red-300">{errorMsg}</p>
                <button
                  onClick={() => {
                    markRevealDismissed();
                    router.push("/pods");
                  }}
                  className="mt-6 w-full rounded-full bg-pink-500 px-6 py-3 text-sm font-semibold shadow-[0_0_25px_rgba(255,20,147,0.5)] transition hover:bg-pink-400"
                >
                  Back to Lobby
                </button>
              </motion.div>
            ) : phase === "sponsor" && sponsorImageSrc ? (
              <motion.div
                key="sponsor"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.4 }}
                className="py-3 md:py-6"
              >
                <p className="mb-4 text-[11px] uppercase tracking-[0.32em] text-zinc-500">
                  Tonight&rsquo;s {sponsorCityLabel} pod is sponsored by
                </p>

                <div className="mx-auto overflow-hidden rounded-2xl border border-white/10 bg-black/20 md:rounded-3xl">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={sponsorImageSrc}
                    alt={`Tonight's ${sponsorCityLabel} pod sponsor`}
                    onError={() => {
                      setFailedSponsorImageSrc(sponsorImageSrc);
                      setFromSponsor(false);
                      setCountdown(3);
                      setPhase("countdown");
                    }}
                    className="h-auto w-full object-cover"
                  />
                </div>

                <AnimatePresence>
                  {showContinue && (
                    <motion.button
                      type="button"
                      onClick={continueFromSponsor}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 8 }}
                      transition={{ duration: 0.3 }}
                      className="mt-6 w-full rounded-full bg-pink-500 px-6 py-3 text-sm font-semibold shadow-[0_0_25px_rgba(255,20,147,0.5)] hover:bg-pink-400"
                    >
                      Continue
                    </motion.button>
                  )}
                </AnimatePresence>
              </motion.div>
            ) : phase === "countdown" ? (
              <motion.div
                key={fromSponsor ? "sponsor-countdown" : "countdown"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="py-4 md:py-8"
              >
                <p className="mb-4 text-[11px] uppercase tracking-[0.35em] text-zinc-500">
                  Ready?
                </p>
                <motion.div
                  key={countdown}
                  initial={{ scale: 0.7, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 1.15, opacity: 0 }}
                  transition={{ duration: 0.45 }}
                  className="text-6xl font-semibold text-white md:text-9xl"
                >
                  {countdown}
                </motion.div>
                <p className="mt-5 text-sm text-zinc-400">
                  Opening your reveal...
                </p>
              </motion.div>
            ) : hasMatches ? (
              <motion.div
                key="match"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.55 }}
              >
                <motion.div
                  initial={{ scale: 0.96, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ duration: 0.5 }}
                  className="mb-6 md:mb-8"
                >
                  <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-pink-500/20 ring-1 ring-pink-400/30 md:h-20 md:w-20">
                    <motion.span
                      className="text-3xl md:text-4xl"
                      animate={{ scale: [1, 1.12, 1] }}
                      transition={{ duration: 1.5, repeat: Infinity }}
                    >
                      💖
                    </motion.span>
                  </div>

                  <h1 className="mb-3 text-3xl font-semibold md:text-5xl">
                    It&apos;s a Match
                  </h1>

                  <p className="mx-auto max-w-lg text-sm text-zinc-300 md:text-base">
                    You both wanted to talk again.
                  </p>
                </motion.div>

                <div className="mt-5 space-y-4 md:space-y-5">
                  {matches.map((match, index) => (
                    <motion.div
                      key={`${match.userId}-${match.roundNumber ?? index}`}
                      initial={{ opacity: 0, y: 16 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.18 + index * 0.1 }}
                      className="rounded-[1.5rem] border border-pink-500/20 bg-gradient-to-br from-pink-900/18 to-fuchsia-900/8 p-3.5 text-left shadow-[0_0_20px_rgba(255,20,147,0.08)] md:rounded-[1.75rem] md:p-5"
                    >
                      <div className="flex items-start gap-3 md:gap-4">
                        <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5 md:h-20 md:w-20 md:rounded-2xl">
                          {match.photoUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={match.photoUrl}
                              alt={match.name ? `${match.name}'s photo` : "Match photo"}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center bg-white/[0.03] text-base font-semibold text-pink-200 md:text-xl">
                              {getInitials(match.name)}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="truncate text-lg font-semibold leading-tight md:text-2xl">
                                {match.name || "Someone"}
                              </p>

                              <div className="mt-1 flex flex-col gap-0.5 text-xs text-zinc-400 md:flex-row md:flex-wrap md:items-center md:gap-x-3 md:gap-y-1 md:text-sm">
                                {match.city ? <span>{match.city}</span> : null}
                                {match.roundNumber ? (
                                  <span className="text-zinc-500">
                                    Round {match.roundNumber}
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            <div className="inline-flex w-fit shrink-0 rounded-full border border-pink-400/25 bg-pink-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.22em] text-pink-300">
                              Mutual
                            </div>
                          </div>

                          <div className="mt-3 space-y-2.5 md:mt-4 md:space-y-3">
                            {(match.myRating || match.theirRating) && (
                              <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-3 md:px-4">
                                <p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                                  Feedback
                                </p>
                                <p className="mt-1.5 text-sm leading-relaxed text-white md:text-base">
                                  ✨ You both said yes
                                </p>
                              </div>
                            )}

                            <div className="rounded-2xl border border-white/8 bg-black/18 px-3 py-3 md:px-4">
                              <p className="text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                                Shared Contact
                              </p>

                              {match.contact ? (
                                <p className="mt-1.5 break-all text-sm leading-relaxed text-white md:text-base">
                                  {match.contact}
                                </p>
                              ) : (
                                <p className="mt-1.5 text-sm text-zinc-400">
                                  No contact shared
                                </p>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>

                <div className="mt-7 flex flex-col gap-3 md:mt-8">
                  <button
                    onClick={() => {
                    markRevealDismissed();
                    router.push("/pods");
                  }}
                    className="w-full rounded-full bg-pink-500 px-6 py-3 text-sm font-semibold shadow-[0_0_25px_rgba(255,20,147,0.5)] transition hover:bg-pink-400"
                  >
                    Back to Lobby
                  </button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="no-match"
                initial={{ opacity: 0, y: 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.55 }}
              >
                <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-white/5 ring-1 ring-white/10 md:h-20 md:w-20">
                  <span className="text-3xl md:text-4xl">🌙</span>
                </div>

                <h1 className="mb-3 text-3xl font-semibold md:text-5xl">
                  No Match This Time
                </h1>

                <p className="mx-auto max-w-lg text-sm text-zinc-400 md:text-base">
                  No mutual matches tonight, but that&apos;s part of the experiment.
                  Come back for the next pod 💫
                </p>

                <div className="mt-7 rounded-3xl border border-white/8 bg-black/20 p-4 text-left md:mt-8 md:p-6">
                  <p className="text-[11px] uppercase tracking-[0.25em] text-zinc-500">
                    Keep going
                  </p>
                  <p className="mt-2 text-sm text-zinc-300">
                    The best conversations don&apos;t always happen on the first try.
                  </p>
                </div>

                <div className="mt-7 flex flex-col gap-3 md:mt-8">
                  <button
                    onClick={() => {
                    markRevealDismissed();
                    router.push("/pods");
                  }}
                    className="w-full rounded-full bg-pink-500 px-6 py-3 text-sm font-semibold shadow-[0_0_25px_rgba(255,20,147,0.5)] transition hover:bg-pink-400"
                  >
                    Back to Lobby
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </main>
  );
}
