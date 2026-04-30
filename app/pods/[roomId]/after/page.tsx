"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase/client";
import { TOTAL_ROUNDS, getPodsSessionStorageRoundKey } from "@/lib/pods/timing";

type Rating = "great" | "okay" | "nope" | null;

type StoredUser = {
  first_name?: string;
  email?: string;
  gender?: string;
  interested_in?: string;
  city?: string;
  date_of_birth?: string;
  age_range?: string;
  photo_path?: string | null;
  onboarding_complete?: boolean;
  contact?: string | null;
};

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
  user_a_name?: string | null;
  user_b_name?: string | null;
};

type PodRoomDetailsResponse = {
  ok: boolean;
  roomId: string;
  otherUserId: string | null;
  name: string | null;
  city: string | null;
  roundNumber: number | null;
  roomStartedAt: string | null;
  roundStartAt: string | null;
  roundEndAt: string | null;
  error?: string;
};

const PROCEED_BUFFER_SECONDS = 15;
const FEEDBACK_SAVE_RECOVERY_MS = 5000;
const FORWARD_HANDOFF_ROUND_KEY = "pods_forward_handoff_round";
const FORWARD_HANDOFF_AT_KEY = "pods_forward_handoff_at";

async function getResolvedAfterUser() {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    if (session?.user) {
      return { user: session.user, source: "session" as const };
    }
  } catch (error) {
    console.warn("[pods/after] getSession failed", error);
  }

  try {
    const result = await Promise.race([
      supabase.auth.getUser(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AFTER_GET_USER_TIMEOUT")), 2500)
      ),
    ]);

    const user = result?.data?.user ?? null;

    if (user) {
      return { user, source: "getUser" as const };
    }
  } catch (error) {
    console.warn("[pods/after] getUser fallback failed", error);
  }

  return { user: null, source: "none" as const };
}

function persistLatestRound(round: number) {
  if (typeof window === "undefined") return;

  const storageKey = getPodsSessionStorageRoundKey();
  const storedRound = Number(window.sessionStorage.getItem(storageKey) || "0");
  const safeStoredRound =
    Number.isFinite(storedRound) && storedRound > 0 ? storedRound : 0;
  const latestRound = Math.max(safeStoredRound, round);

  window.sessionStorage.setItem(storageKey, String(latestRound));
}

function persistForwardHandoffRound(round: number) {
  if (typeof window === "undefined") return;

  window.sessionStorage.setItem(FORWARD_HANDOFF_ROUND_KEY, String(round));
  window.sessionStorage.setItem(FORWARD_HANDOFF_AT_KEY, String(Date.now()));
}

export default function FeedbackPage() {
  const router = useRouter();
  const params = useParams();
  const roomId = params?.roomId as string;

  const [rating, setRating] = useState<Rating>(null);
  const [contact, setContact] = useState("");
  const [shareSavedContact, setShareSavedContact] = useState(true);
  const [isEditingContact, setIsEditingContact] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [saveRecoveryMsg, setSaveRecoveryMsg] = useState<string | null>(null);
  const [feedbackSaved, setFeedbackSaved] = useState(false);
  const [proceedSecondsLeft, setProceedSecondsLeft] = useState(
    PROCEED_BUFFER_SECONDS
  );

  const [user, setUser] = useState<StoredUser | null>(null);
  const [currentRound, setCurrentRoundState] = useState(1);
  const [completedRound, setCompletedRound] = useState(1);
  const [isReady, setIsReady] = useState(false);
  const [authLoadFailed, setAuthLoadFailed] = useState(false);

  const [showReportMenu, setShowReportMenu] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportType, setReportType] = useState<"technical" | "user" | null>(
    null
  );
  const [reportMessage, setReportMessage] = useState("");
  const [isSubmittingReport, setIsSubmittingReport] = useState(false);
  const [reportSuccess, setReportSuccess] = useState(false);
  const [reportError, setReportError] = useState("");
  const [reportTargetName, setReportTargetName] = useState<string | null>(null);
  const [reportTargetUserId, setReportTargetUserId] = useState<string | null>(
    null
  );

  const lockedRoundRef = useRef(1);
  const submitAttemptRef = useRef(0);
  const submitRecoveryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const roundNumber = currentRound;

  function clearSubmitRecoveryTimeout() {
    if (submitRecoveryTimeoutRef.current) {
      clearTimeout(submitRecoveryTimeoutRef.current);
      submitRecoveryTimeoutRef.current = null;
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadRoomRound() {
      if (!roomId) {
        setIsReady(true);
        return;
      }

      try {
        const res = await fetch(
          `/api/pods/room?roomId=${encodeURIComponent(roomId)}`,
          {
            method: "GET",
            cache: "no-store",
          }
        );

        const data = (await res.json()) as PodRoomDetailsResponse;

        if (cancelled) return;

        if (res.ok && data?.ok && data.roundNumber) {
          const resolvedRound = Math.min(
            Math.max(data.roundNumber, 1),
            TOTAL_ROUNDS
          );

          setCurrentRoundState(resolvedRound);
          setCompletedRound(resolvedRound);
          lockedRoundRef.current = resolvedRound;
        } else {
          console.warn("[pods/after] room round lookup fallback", {
            roomId,
            status: res.status,
            data,
          });

          setCurrentRoundState(1);
          setCompletedRound(1);
          lockedRoundRef.current = 1;
        }
      } catch (error) {
        if (cancelled) return;

        console.error("[pods/after] room round fetch error", error);
        setCurrentRoundState(1);
        setCompletedRound(1);
        lockedRoundRef.current = 1;
      }
    }

    void loadRoomRound();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  useEffect(() => {
    setProceedSecondsLeft(PROCEED_BUFFER_SECONDS);
  }, [currentRound]);

  useEffect(() => {
    return () => {
      clearSubmitRecoveryTimeout();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadUserProfile() {
      const { user: authUser, source } = await getResolvedAfterUser();

      if (cancelled) return;

      if (!authUser) {
        console.warn("AFTER PAGE PROFILE AUTH UNRESOLVED", { source });
        setAuthLoadFailed(true);
        setIsReady(true);
        return;
      }

      setAuthLoadFailed(false);

      const { data: profile, error } = await supabase
        .from("profiles")
        .select(
          "first_name, email, gender, interested_in, city, date_of_birth, age_range, photo_path, onboarding_complete, contact"
        )
        .eq("id", authUser.id)
        .maybeSingle();

      if (cancelled) return;

      if (error) {
        console.error("AFTER PAGE PROFILE LOAD ERROR", error);
        setIsReady(true);
        return;
      }

      if (profile) {
        const typedProfile = profile as StoredUser;
        setUser(typedProfile);
        setContact(typedProfile.contact ?? "");
      }

      setIsReady(true);
    }

    void loadUserProfile();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadReportTarget() {
      if (!roomId) return;

      const { user: authUser } = await getResolvedAfterUser();

      if (cancelled || !authUser) return;

      const { data: room, error } = await supabase
        .from("pod_rooms")
        .select("room_id, user_a_id, user_b_id, user_a_name, user_b_name")
        .eq("room_id", roomId)
        .maybeSingle<PodRoomRow>();

      if (cancelled) return;

      if (error) {
        console.error("AFTER PAGE REPORT TARGET LOAD ERROR", error);
        return;
      }

      if (!room) return;

      const isUserA = room.user_a_id === authUser.id;
      const isUserB = room.user_b_id === authUser.id;

      if (!isUserA && !isUserB) return;

      if (isUserA) {
        setReportTargetName(room.user_b_name?.trim() || "your match");
        setReportTargetUserId(room.user_b_id);
      } else {
        setReportTargetName(room.user_a_name?.trim() || "your match");
        setReportTargetUserId(room.user_a_id);
      }
    }

    void loadReportTarget();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  async function resetQueueForCurrentUser(targetRound: number) {
    console.log("[pods/after] skipping client queue reset", {
      targetRound,
    });
  }

  const hasSavedContact = !!user?.contact?.trim();
  const isFinalRound = completedRound >= TOTAL_ROUNDS;

  const subtitle = isFinalRound
    ? "Final check-in. Let us know how it went."
    : "Quick check-in before your next round.";

  const lockedRound = lockedRoundRef.current;

  const nextActionLabel = !feedbackSaved
    ? ""
    : lockedRound >= TOTAL_ROUNDS
      ? "Reveal Your Matches ✨"
      : `Continue to Round ${lockedRound + 1} (${proceedSecondsLeft}s)`;

  function ratingButtonClasses(value: Rating) {
    const isActive = rating === value;

    return [
      "flex cursor-pointer flex-col items-center justify-center rounded-2xl border px-5 py-3 transition",
      isActive
        ? "border-pink-500 bg-pink-500/20 shadow-[0_0_20px_rgba(255,20,147,0.5)]"
        : "border-zinc-700 bg-zinc-900 hover:border-pink-400",
      "text-[12px] md:text-sm",
    ].join(" ");
  }

  async function persistProfileContact(
    userId: string,
    nextContact: string | null
  ) {
    const { error } = await supabase
      .from("profiles")
      .update({ contact: nextContact })
      .eq("id", userId);

    if (error) {
      console.error("PROFILE CONTACT SAVE ERROR", error);
      throw new Error(error.message || "Could not save your contact.");
    }

    setUser((prev) => ({
      ...(prev ?? {}),
      contact: nextContact,
    }));
  }

  function handleStartEditingContact() {
    setContact(user?.contact ?? "");
    setIsEditingContact(true);
    setErrorMsg(null);
  }

  function handleCancelEditingContact() {
    setContact(user?.contact ?? "");
    setIsEditingContact(false);
    setErrorMsg(null);
  }

  async function handleSaveEditedContact() {
    setErrorMsg(null);

    const trimmedContact = contact.trim();

    if (!trimmedContact) {
      setErrorMsg("Enter a contact method first.");
      return;
    }

    try {
      const { user: authUser } = await getResolvedAfterUser();

      if (!authUser) {
        setErrorMsg("Please log in again.");
        router.push("/login");
        return;
      }

      await persistProfileContact(authUser.id, trimmedContact);
      setContact(trimmedContact);
      setIsEditingContact(false);
    } catch (err) {
      console.error("EDIT CONTACT SAVE ERROR", err);
      setErrorMsg(
        err instanceof Error
          ? err.message
          : "Could not save your contact. Please try again."
      );
    }
  }

  async function checkForRecoveredFeedback(args: {
    attemptId: number;
    userId: string;
    targetRoomId: string;
    targetRound: number;
  }) {
    try {
      const { data: existingFeedback, error: existingFeedbackError } =
        await supabase
          .from("pod_feedback")
          .select("user_id")
          .eq("user_id", args.userId)
          .eq("room_id", args.targetRoomId)
          .eq("round_number", args.targetRound)
          .maybeSingle();

      if (submitAttemptRef.current !== args.attemptId) return;

      if (existingFeedbackError) {
        console.error(
          "[pods/after] feedback recovery lookup error",
          existingFeedbackError
        );
      }

      if (existingFeedback) {
        setErrorMsg(null);
        setSaveRecoveryMsg(null);
        setIsEditingContact(false);
        setFeedbackSaved(true);
        setSubmitting(false);
        void resetQueueForCurrentUser(args.targetRound);
        return;
      }
    } catch (error) {
      if (submitAttemptRef.current !== args.attemptId) return;

      console.error("[pods/after] feedback recovery check failed", error);
    }

    if (submitAttemptRef.current !== args.attemptId) return;

    setSubmitting(false);
    setSaveRecoveryMsg("Saving is taking longer than expected.");
  }

  async function submitFeedback() {
    setErrorMsg(null);
    setSaveRecoveryMsg(null);

    if (!roomId) {
      setErrorMsg("Missing room info. Please go back and try again.");
      return;
    }

    if (!rating) {
      setErrorMsg("Tell us how it went first.");
      return;
    }

    const attemptId = submitAttemptRef.current + 1;
    submitAttemptRef.current = attemptId;
    const targetRoomId = roomId;
    const targetRound = currentRound;

    try {
      setSubmitting(true);
      setFeedbackSaved(false);

      const { user: authUser } = await getResolvedAfterUser();

      if (!authUser) {
        if (submitAttemptRef.current !== attemptId) return;

        setErrorMsg("Please log in again.");
        router.push("/login");
        return;
      }

      const normalizedContact = contact.trim() || null;
      const existingSavedContact = user?.contact?.trim() || null;

      if (!hasSavedContact && !normalizedContact) {
        if (submitAttemptRef.current !== attemptId) return;

        setErrorMsg("Add a contact method first, or type one now.");
        return;
      }

      clearSubmitRecoveryTimeout();
      submitRecoveryTimeoutRef.current = setTimeout(() => {
        void checkForRecoveredFeedback({
          attemptId,
          userId: authUser.id,
          targetRoomId,
          targetRound,
        });
      }, FEEDBACK_SAVE_RECOVERY_MS);

      if (normalizedContact && normalizedContact !== existingSavedContact) {
        await persistProfileContact(authUser.id, normalizedContact);
      }

      const latestSavedContact =
        normalizedContact || existingSavedContact || null;

      const contactValue = shareSavedContact ? latestSavedContact : null;

      console.log("[CONTACT DEBUG]", {
        roomId,
        round: currentRound,
        rawInput: contact,
        hasSavedContact,
        shareSavedContact,
        latestSavedContact,
        savedContactToFeedback: contactValue,
      });

      const { error: feedbackError } = await supabase
        .from("pod_feedback")
        .upsert(
          {
            user_id: authUser.id,
            room_id: targetRoomId,
            round_number: targetRound,
            rating,
            contact: contactValue,
          },
          {
            onConflict: "user_id,room_id,round_number",
          }
        );

      if (feedbackError) {
        if (submitAttemptRef.current !== attemptId) {
          return;
        }

        console.error("FEEDBACK SAVE ERROR", feedbackError);
        setErrorMsg(
          feedbackError.message || "Could not save feedback. Please try again."
        );
        return;
      }

      if (submitAttemptRef.current !== attemptId) {
        return;
      }

      setIsEditingContact(false);
      await resetQueueForCurrentUser(targetRound);

      if (submitAttemptRef.current !== attemptId) {
        return;
      }

      setFeedbackSaved(true);
      setSaveRecoveryMsg(null);
    } catch (err) {
      if (submitAttemptRef.current !== attemptId) {
        return;
      }

      console.error("FEEDBACK SAVE ERROR", err);
      setErrorMsg(
        err instanceof Error && err.message.endsWith("_TIMEOUT")
          ? "Saving took too long. Please try again."
          : err instanceof Error
            ? err.message
            : "Could not save feedback. Please try again."
      );
    } finally {
      if (submitAttemptRef.current === attemptId) {
        clearSubmitRecoveryTimeout();
        setSubmitting(false);
      }
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await submitFeedback();
  }

  const handleContinue = useCallback(async () => {
    if (!feedbackSaved) return;

    if (completedRound >= TOTAL_ROUNDS) {
      router.push("/pods/done");
      return;
    }

    try {
      const nextRound = Math.min(completedRound + 1, TOTAL_ROUNDS);
      persistLatestRound(nextRound);
      persistForwardHandoffRound(nextRound);
      setCurrentRoundState(nextRound);
      router.replace(`/pods?round=${nextRound}`);
    } catch (err) {
      console.error("CONTINUE QUEUE ERROR", err);
      const nextRound = Math.min(completedRound + 1, TOTAL_ROUNDS);
      persistLatestRound(nextRound);
      persistForwardHandoffRound(nextRound);
      setCurrentRoundState(nextRound);
      router.replace(`/pods?round=${nextRound}`);
    }
  }, [completedRound, feedbackSaved, router]);

  useEffect(() => {
    if (!feedbackSaved) return;
    if (completedRound >= TOTAL_ROUNDS) return;

    if (proceedSecondsLeft <= 0) {
      void handleContinue();
      return;
    }

    const interval = setInterval(() => {
      setProceedSecondsLeft((prev) => prev - 1);
    }, 1000);

    return () => clearInterval(interval);
  }, [feedbackSaved, completedRound, proceedSecondsLeft, handleContinue]);

  async function handleBackToLobby() {
    router.replace("/pods");
  }

  async function handleSubmitReport() {
    if (!reportMessage.trim()) {
      setReportError("Please enter a message.");
      return;
    }

    setReportError("");
    setIsSubmittingReport(true);

    try {
      const { user: authUser } = await getResolvedAfterUser();

      const res = await fetch("/api/support", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: reportMessage.trim(),
          type: reportType,
          page: `/pods/${roomId}/after`,
          roomId,
          roundNumber: currentRound,
          userId: authUser?.id ?? null,
          reportedUserName: reportType === "user" ? reportTargetName : null,
          reportedUserId: reportType === "user" ? reportTargetUserId : null,
          debug_context: {
            timestamp: new Date().toISOString(),
          },
        }),
      });

      const data = await res.json();

      if (data.ok) {
        setReportSuccess(true);
        setReportMessage("");
      } else {
        setReportError(data.error || "Something went wrong.");
      }
    } catch (error) {
      console.error("REPORT SUBMIT ERROR", error);
      setReportError("Something went wrong.");
    } finally {
      setIsSubmittingReport(false);
    }
  }

  const roundLabel = `Round ${currentRound} of ${TOTAL_ROUNDS}`;

  useEffect(() => {
    if (isReady) return;

    const timeout = setTimeout(() => {
      console.warn("[pods/after] safe ready fallback", {
        roomId,
        roundNumber,
      });

      setIsReady(true);
    }, 3000);

    return () => clearTimeout(timeout);
  }, [roomId, roundNumber, isReady]);

  if (!isReady) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-black text-white">
        <p className="text-zinc-400">Wrapping up your pod...</p>
      </main>
    );
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-black px-4 py-8 text-white md:py-12"
      style={{
        background:
          "radial-gradient(circle at top, #1a1024 0%, #05030a 55%, #020106 100%)",
      }}
    >
      <div className="w-full max-w-md md:max-w-xl">
        <div className="mb-3 text-center text-[10px] uppercase tracking-[0.35em] text-pink-400 md:mb-4 md:text-xs">
          THEPODS
        </div>

        <div className="mb-2 text-center text-[11px] uppercase tracking-[0.25em] text-zinc-500 md:text-xs">
          {roundLabel}
        </div>

        <h1 className="mb-2 text-center text-2xl font-semibold md:text-4xl">
          How did it go?
        </h1>

        <p className="mx-auto mb-6 max-w-lg text-center text-[12px] text-zinc-400 md:mb-8 md:text-sm">
          {subtitle}
        </p>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-3xl border border-zinc-800 bg-zinc-900 p-5 shadow-[0_0_40px_rgba(255,20,147,0.25)] md:space-y-6 md:p-8"
        >
          {authLoadFailed && (
            <p className="text-xs text-zinc-400">
              We couldn&apos;t fully restore your session. Refresh if saving doesn&apos;t
              work.
            </p>
          )}

          {user?.first_name ? (
            <div className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center text-[12px] text-zinc-300 md:text-sm">
              Nice work,{" "}
              <span className="font-semibold text-white">{user.first_name}</span>
              . Let&apos;s log this round.
            </div>
          ) : null}

          <div>
            <p className="mb-3 text-center text-[13px] text-zinc-300 md:text-sm">
              Do you want to talk again?
            </p>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <button
                type="button"
                className={ratingButtonClasses("great")}
                onClick={() => setRating("great")}
              >
                <span className="mb-1 text-xl md:text-2xl">😍</span>
                <span className="font-medium">Yes</span>
              </button>

              <button
                type="button"
                className={ratingButtonClasses("okay")}
                onClick={() => setRating("okay")}
              >
                <span className="mb-1 text-xl md:text-2xl">🤔</span>
                <span className="font-medium">Maybe</span>
              </button>

              <button
                type="button"
                className={ratingButtonClasses("nope")}
                onClick={() => setRating("nope")}
              >
                <span className="mb-1 text-xl md:text-2xl">👎</span>
                <span className="font-medium">No</span>
              </button>
            </div>
          </div>

          {!hasSavedContact ? (
            <div className="space-y-2">
              <label
                className="text-[13px] text-zinc-300 md:text-sm"
                htmlFor="contact"
              >
                Save your contact for future matches
              </label>

              <input
                id="contact"
                type="text"
                className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                placeholder="IG handle, email, or phone"
                value={contact}
                onChange={(e) => setContact(e.target.value)}
              />

              <p className="text-[11px] text-zinc-500">
                You only need to save this once.
              </p>
            </div>
          ) : (
            <div className="space-y-3 rounded-2xl border border-white/10 bg-black/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-zinc-300 md:text-sm">
                    Saved contact
                  </p>

                  {!isEditingContact ? (
                    <p className="mt-1 break-words text-[12px] text-white md:text-sm">
                      {user?.contact}
                    </p>
                  ) : (
                    <div className="mt-2 space-y-2">
                      <input
                        id="contact"
                        type="text"
                        className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                        placeholder="IG handle, email, or phone"
                        value={contact}
                        onChange={(e) => setContact(e.target.value)}
                      />

                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={handleSaveEditedContact}
                          className="rounded-full bg-pink-500 px-4 py-2 text-[12px] font-semibold text-white transition hover:bg-pink-400"
                        >
                          Save
                        </button>

                        <button
                          type="button"
                          onClick={handleCancelEditingContact}
                          className="rounded-full border border-zinc-700 px-4 py-2 text-[12px] font-semibold text-zinc-300 transition hover:border-pink-400 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {!isEditingContact ? (
                  <button
                    type="button"
                    onClick={handleStartEditingContact}
                    className="shrink-0 rounded-full border border-zinc-700 px-3 py-1.5 text-[11px] font-semibold text-zinc-300 transition hover:border-pink-400 hover:text-white"
                  >
                    Edit
                  </button>
                ) : null}
              </div>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  checked={shareSavedContact}
                  onChange={(e) => setShareSavedContact(e.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-zinc-600 bg-black"
                />
                <div>
                  <p className="text-[13px] text-zinc-300 md:text-sm">
                    Share my saved contact if it’s a match
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    We’ll only share it if the match is mutual.
                  </p>
                </div>
              </label>
            </div>
          )}

          {errorMsg && (
            <p className="mt-1 text-[11px] text-red-300">{errorMsg}</p>
          )}

          {saveRecoveryMsg && !feedbackSaved && (
            <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
              <p className="text-[11px] text-amber-100 md:text-sm">
                {saveRecoveryMsg}
              </p>

              <button
                type="button"
                onClick={() => {
                  void submitFeedback();
                }}
                className="mt-3 w-full rounded-full border border-amber-300/40 px-6 py-2.5 text-[13px] font-semibold text-amber-50 transition hover:border-amber-200 hover:bg-amber-100/10 md:py-3 md:text-sm"
              >
                Try saving again
              </button>
            </div>
          )}

          {feedbackSaved && (
            <div className="mt-3 rounded-2xl border border-emerald-500/40 bg-emerald-900/20 p-4">
              <p className="text-[11px] text-emerald-300 md:text-xs">
                Feedback saved for {roundLabel.toLowerCase()}.
              </p>

              <p className="mt-2 text-[12px] text-zinc-200 md:text-sm">
                {completedRound >= TOTAL_ROUNDS
                  ? "You’ve finished all 3 rounds for tonight."
                  : `You’re ready to head back for round ${completedRound + 1}.`}
              </p>

              <p className="mt-2 text-[12px] text-zinc-300 md:text-sm">
                {shareSavedContact
                  ? `Contact available to share: ${
                      contact.trim() || user?.contact || "None"
                    }`
                  : "Contact sharing is off for this match"}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-3 pt-2">
            {!feedbackSaved ? (
              <button
                type="submit"
                disabled={submitting || !roomId}
                className="w-full rounded-full bg-pink-500 px-6 py-2.5 text-[13px] font-semibold shadow-[0_0_25px_rgba(255,20,147,0.5)] transition hover:bg-pink-400 disabled:opacity-40 md:py-3 md:text-sm"
              >
                {submitting
                  ? "Saving…"
                  : !roomId
                    ? "Missing room info…"
                    : "Save Feedback"}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleContinue}
                  className="w-full rounded-full bg-fuchsia-600 px-6 py-2.5 text-[13px] font-semibold shadow-[0_0_25px_rgba(192,38,211,0.4)] transition hover:bg-fuchsia-500 md:py-3 md:text-sm"
                >
                  {nextActionLabel}
                </button>

                {feedbackSaved && completedRound < TOTAL_ROUNDS && (
                  <p className="text-center text-[11px] text-zinc-400 md:text-xs">
                    Proceeding automatically in {proceedSecondsLeft}s
                  </p>
                )}
              </>
            )}

            <button
              type="button"
              onClick={handleBackToLobby}
              className="w-full rounded-full border border-zinc-700 bg-transparent px-6 py-2.5 text-center text-[13px] font-semibold transition hover:border-pink-400 md:py-3 md:text-sm"
            >
              Back to Lobby
            </button>
          </div>
        </form>

        <p className="mx-auto mt-5 max-w-md text-center text-[11px] text-zinc-500 md:mt-6 md:text-xs">
          This saves feedback instantly for this round. Final match results are
          computed on the done page.
        </p>

        <div className="mt-6 flex justify-center">
          <button
            type="button"
            onClick={() => setShowReportMenu((prev) => !prev)}
            className="text-[11px] tracking-wide text-white/30 transition hover:text-white/60"
          >
            Need help?
          </button>
        </div>

        {showReportMenu && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setReportType("technical");
                setShowReportMenu(false);
                setShowReportModal(true);
                setReportError("");
                setReportSuccess(false);
                setReportMessage("");
              }}
              className="text-sm text-white/65 transition hover:text-white"
            >
              Report an issue
            </button>

            <button
              type="button"
              onClick={() => {
                setReportType("user");
                setShowReportMenu(false);
                setShowReportModal(true);
                setReportError("");
                setReportSuccess(false);
                setReportMessage("");
              }}
              className="text-sm text-white/65 transition hover:text-white"
            >
              Report a user
            </button>
          </div>
        )}

        {showReportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
            <div className="relative w-full max-w-sm rounded-2xl border border-pink-500/30 bg-zinc-950 p-7 shadow-2xl">
              <button
                type="button"
                className="absolute right-3 top-3 text-lg text-zinc-500 hover:text-pink-400"
                onClick={() => {
                  setShowReportModal(false);
                  setReportMessage("");
                  setReportSuccess(false);
                  setReportError("");
                }}
                aria-label="Close"
              >
                ×
              </button>

              <div className="mb-2 text-center text-lg font-semibold text-pink-400">
                {reportType === "user" ? "Report User" : "Report an Issue"}
              </div>

              <div className="mb-4 text-center text-xs text-zinc-400">
                {reportType === "user"
                  ? "Let us know if someone made you uncomfortable or broke the rules."
                  : "Describe any technical or app issues you experienced."}
              </div>

              {reportType === "user" && (
                <div className="mb-4 rounded-xl border border-white/10 bg-black/30 px-4 py-3 text-center">
                  <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    Reporting
                  </p>
                  <p className="mt-1 text-sm font-medium text-white">
                    {reportTargetName || "Your match"}
                  </p>
                </div>
              )}

              {reportSuccess ? (
                <div className="mb-2 text-center text-sm text-emerald-400">
                  Thank you for your report. We&apos;ll review it promptly.
                </div>
              ) : (
                <>
                  <textarea
                    className="mb-3 w-full resize-none rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] text-zinc-200 outline-none focus:border-pink-500"
                    rows={4}
                    placeholder={
                      reportType === "user"
                        ? "Describe what happened..."
                        : "Describe the issue..."
                    }
                    value={reportMessage}
                    onChange={(e) => setReportMessage(e.target.value)}
                    disabled={isSubmittingReport}
                  />

                  {reportError && (
                    <div className="mb-2 text-center text-xs text-red-400">
                      {reportError}
                    </div>
                  )}

                  <button
                    type="button"
                    className="w-full rounded-full bg-pink-500 px-5 py-2 text-sm font-semibold shadow-[0_0_15px_rgba(255,20,147,0.4)] transition hover:bg-pink-400 disabled:opacity-40"
                    onClick={handleSubmitReport}
                    disabled={isSubmittingReport || !reportMessage.trim()}
                  >
                    {isSubmittingReport ? "Sending…" : "Send Report"}
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
