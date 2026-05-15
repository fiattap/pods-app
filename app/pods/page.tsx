"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/components/auth/AuthProvider";
import {
  TOTAL_ROUNDS,
  formatLaunchCountdown,
  getNextPodOpenAt,
  getNextPodOpenLabel,
  isPreLaunch,
  normalizeCity,
  PODS_LAUNCH_AT,
  PODS_LAUNCH_LABEL,
} from "@/lib/pods/timing";
import { usePodStatus } from "@/lib/pods/hooks/usePodStatus";
import { usePhaseClock } from "@/lib/pods/hooks/usePhaseClock";
import { useEnterPod } from "@/lib/pods/hooks/useEnterPod";

/**
 * Pod lobby page.
 *
 * The hard part of this screen used to be the page itself reinventing the
 * server's phase machine client-side and patching the drift with
 * sessionStorage handoff keys. That's gone. Now:
 *
 *   - useAuth()        → who's signed in, profile (first name, city)
 *   - usePodStatus()   → canonical phase/round/state from /api/pods/status
 *   - usePhaseClock()  → derived lobby moment + countdown to next round
 *   - useEnterPod()    → POST /api/pods/match for the "Enter" button
 *
 * The page's only side effects are:
 *   1. Redirect to /login when signed out
 *   2. Navigate to /pods/[roomId] when the server says we're matched
 *   3. Navigate to /pods/done when the night is over
 *   4. Track a 1Hz tick for the pre-launch countdown (until launch only)
 *
 * That's it. Everything else is rendered directly from the hook outputs.
 */
export default function PodsPage() {
  const router = useRouter();
  const { status: authStatus, profile, user } = useAuth();
  const { status: pod, error: podStatusError } = usePodStatus({
    enabled: authStatus !== "loading",
  });
  const clock = usePhaseClock(pod);
  const { enterPod, isSubmitting, errorMsg, clearError } = useEnterPod();

  const firstName = profile?.first_name ?? null;
  const city = profile?.city ?? null;
  const currentRound = pod?.currentRound ?? 1;
  const safeCurrentRound = Math.min(Math.max(currentRound, 1), TOTAL_ROUNDS);

  // --- Side effect 1: redirect to /login when signed out -------------------
  const [hasRedirectedToLogin, setHasRedirectedToLogin] = useState(false);
  useEffect(() => {
    if (authStatus === "signed_out" && !hasRedirectedToLogin) {
      setHasRedirectedToLogin(true);
      router.replace("/login");
    }
  }, [authStatus, hasRedirectedToLogin, router]);

  // --- Side effect 2: navigate to /pods/[roomId] when matched --------------
  const [hasNavigatedToRoom, setHasNavigatedToRoom] = useState<string | null>(
    null
  );
  useEffect(() => {
    if (!pod) return;
    if (pod.state !== "matched") return;
    if (!pod.roomId) return;
    if (hasNavigatedToRoom === pod.roomId) return;

    setHasNavigatedToRoom(pod.roomId);
    const target = pod.roundNumber
      ? `/pods/${pod.roomId}?round=${pod.roundNumber}`
      : `/pods/${pod.roomId}`;
    router.push(target);
  }, [pod, hasNavigatedToRoom, router]);

  // --- Side effect 3: navigate to /pods/done when night is over ------------
  // shouldGoToDone is the server's canonical signal that the user is finished
  // for the night (either round 3 ended, or round 3 had no match → reveal).
  const [hasNavigatedToDone, setHasNavigatedToDone] = useState(false);
  useEffect(() => {
    if (!pod) return;
    if (!pod.shouldGoToDone) return;
    if (hasNavigatedToDone) return;
    setHasNavigatedToDone(true);
    router.push("/pods/done");
  }, [pod, hasNavigatedToDone, router]);

  // --- Side effect 4: 1Hz tick for "long" countdowns -----------------------
  // Drives two displays:
  //   - The pre-launch countdown ("Launch May 12 at 8PM. Starting in 3d 4h…")
  //   - The "next pod night opens in X" countdown shown on non-pod days /
  //     after a pod night finishes.
  // Both want a second-by-second refresh but are otherwise idle, so one tick
  // is enough.
  const [, setSlowTick] = useState(0);
  const showLaunchBanner = isPreLaunch();
  const showNextPodNightCountdown =
    !showLaunchBanner &&
    (clock.moment === "closed" || clock.moment === "finished");
  useEffect(() => {
    if (!showLaunchBanner && !showNextPodNightCountdown) return;
    const id = setInterval(() => setSlowTick((t) => (t + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
  }, [showLaunchBanner, showNextPodNightCountdown]);

  // Formatted "Sunday at 8:00 PM (in 2d 4h 23m)" string. Only meaningful when
  // showNextPodNightCountdown is true.
  const nextPodNightCountdownLabel = showNextPodNightCountdown
    ? formatLaunchCountdown(getNextPodOpenAt(city))
    : null;

  // --- Action: "Enter the Pod" button ---------------------------------------
  const handleEnterPod = useCallback(async () => {
    if (!pod) return;
    if (!pod.canEnterRound || !pod.entryWindowOpen) return;
    if (!pod.podId) return;
    if (!user?.id) return;
    if (pod.roundNumber == null && pod.currentRound == null) return;

    const round = pod.roundNumber ?? pod.currentRound ?? safeCurrentRound;
    const result = await enterPod({
      userId: user.id,
      podId: pod.podId,
      roundNumber: round,
    });

    if (result.kind === "matched") {
      // The status poll will catch this within 2.5s, but jump immediately
      // so the user feels the response. The matched-status effect above
      // is idempotent.
      const target = `/pods/${result.roomId}?round=${result.roundNumber}`;
      setHasNavigatedToRoom(result.roomId);
      router.push(target);
    }
    // For "waiting" or "no_match" the page just re-renders off the next
    // status poll. No special handling needed.
  }, [pod, enterPod, router, safeCurrentRound, user?.id]);

  // --- Support modal state (isolated; doesn't touch pod logic) -------------
  const [showSupportModal, setShowSupportModal] = useState(false);
  const [supportMessage, setSupportMessage] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [isSubmittingSupport, setIsSubmittingSupport] = useState(false);
  const [supportSuccess, setSupportSuccess] = useState(false);
  const [supportError, setSupportError] = useState("");

  const handleSupportSubmit = useCallback(async () => {
    if (!supportMessage.trim()) return;
    setIsSubmittingSupport(true);
    setSupportError("");
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: supportMessage,
          email: supportEmail || user?.email || null,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        setSupportError(body || `Could not send (status ${res.status}).`);
        return;
      }
      setSupportSuccess(true);
      setSupportMessage("");
      setSupportEmail("");
    } catch (err) {
      setSupportError(
        err instanceof Error ? err.message : "Could not send support message."
      );
    } finally {
      setIsSubmittingSupport(false);
    }
  }, [supportMessage, supportEmail, user?.email]);

  // --- Derived display flags ------------------------------------------------
  // "Waiting" means the user's queue row is open AND the entry window is still
  // active. Once the window closes without a match, we drop the waiting UI and
  // let the missed_round moment + countdown take over (see usePhaseClock).
  const isWaiting =
    pod?.state === "waiting" && pod?.entryWindowOpen === true;
  const isFinished = pod?.phase === "finished" || pod?.closedForTonight;
  const nextPodOpenLabel = getNextPodOpenLabel(city);
  const buttonEnabled =
    !!pod &&
    pod.canEnterRound &&
    pod.entryWindowOpen &&
    !isSubmitting &&
    !isWaiting &&
    !isFinished &&
    !showLaunchBanner;

  // Button visibility rule: only show when the user has a real action or is
  // mid-match. In all the "waiting at lobby with a countdown" states, the
  // button would be a disabled label duplicating info already on screen — so
  // we hide it entirely. The countdown card carries the visual weight.
  const showButton =
    isSubmitting ||                       // mid-POST: "Entering…"
    isWaiting ||                          // matched and waiting: "Looking for a match…"
    (pod?.canEnterRound === true && pod?.entryWindowOpen === true) || // ready to act
    showLaunchBanner ||                   // pre-launch: "Opens at launch"
    isFinished;                           // finished: "Closed for tonight"

  // Status line copy. Always reflects something useful; never blank. When the
  // countdown card is on screen, this line gives complementary info (what
  // *just* happened or what's coming), not a duplicate of the timer.
  const liveStatusText = (() => {
    if (showLaunchBanner) {
      return `${PODS_LAUNCH_LABEL}. Starting in ${formatLaunchCountdown(
        PODS_LAUNCH_AT
      )}`;
    }
    if (authStatus === "loading") return "Loading…";
    if (!pod) return "Loading lobby…";
    if (podStatusError) return podStatusError;
    if (isFinished) {
      return `Next pod opens ${nextPodOpenLabel}.`;
    }
    if (isWaiting) return "Looking for a match…";
    // The card already shows the timer; give the status line a different role.
    if (clock.moment === "missed_round") {
      return `Missed round ${safeCurrentRound}. You'll be back in the lobby for the next one.`;
    }
    if (clock.moment === "between_rounds") {
      return `Round ${safeCurrentRound > 1 ? safeCurrentRound - 1 : safeCurrentRound} just ended. Quick break, then we go again.`;
    }
    if (clock.moment === "preopen") {
      return "Doors open in a few minutes. Hold tight.";
    }
    if (clock.moment === "live" && pod.canEnterRound) {
      return `Round ${safeCurrentRound} is live. Entry window is open.`;
    }
    if (clock.moment === "live" && !pod.canEnterRound) {
      return `Round ${safeCurrentRound} is in progress.`;
    }
    return "Pods open Tuesday, Thursday, and Sunday at 8:00 PM.";
  })();

  const buttonLabel = (() => {
    if (isSubmitting) return "Entering the Pod…";
    if (isWaiting) return "Looking for a match…";
    if (showLaunchBanner) return "Opens at launch";
    if (isFinished) return "Closed for tonight";
    if (clock.moment === "preopen") return "Opens when countdown ends";
    if (clock.moment === "between_rounds") return "Opens when countdown ends";
    if (clock.moment === "missed_round") return "Catch the next round";
    if (clock.moment === "closed") return "Pods are closed today";
    if (pod?.canEnterRound) return "Enter the Pod";
    return "Enter the Pod";
  })();

  // A "lobby moment" copy block — short helper text shown in the three
  // "waiting at lobby" cases. Keeps things expectations-clear: each round
  // requires its own click (no auto-enter), so the helper tells users that.
  const lobbyMomentCopy = (() => {
    if (clock.moment === "preopen") {
      return "Pods are about to open. When the countdown ends, you'll be able to enter.";
    }
    if (clock.moment === "between_rounds") {
      return "Quick reset. When the next pod opens, you'll be able to enter.";
    }
    if (clock.moment === "missed_round") {
      return "When the next pod opens, you'll be able to enter.";
    }
    return null;
  })();

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
                Tonight&apos;s session
              </p>

              <h2 className="text-base md:text-xl font-semibold mb-2">
                Blind Voice Pods
              </h2>

              <p className="text-[11px] md:text-sm text-zinc-400 mb-4 md:mb-6">
                Short voice dates. Real conversations. See if there&apos;s a vibe.
              </p>

              {/*
                Unified countdown card. Renders in any "user is waiting at the
                lobby" state. Three flavors, picked in priority order:
                  1. In-night: countdown to the next round (preopen, between
                     rounds, or after missing/leaving a round)
                  2. Off-night: countdown to the next pod night (Tue/Thu/Sun
                     at 8 PM) — shown when pods are closed today or done.
              */}
              {clock.showNextRoundCountdown ? (
                <div className="mb-4 rounded-2xl border border-pink-500/20 bg-pink-500/5 px-4 py-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.25em] text-pink-300/80">
                    {clock.moment === "preopen"
                      ? "Pods open in"
                      : "Next pod opens in"}
                  </p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums text-white">
                    {clock.nextRoundCountdownLabel}
                  </p>
                </div>
              ) : nextPodNightCountdownLabel ? (
                <div className="mb-4 rounded-2xl border border-pink-500/20 bg-pink-500/5 px-4 py-3 text-center">
                  <p className="text-[10px] uppercase tracking-[0.25em] text-pink-300/80">
                    Next pod night
                  </p>
                  <p className="mt-1 text-base font-semibold text-white">
                    {nextPodOpenLabel}
                  </p>
                  <p className="mt-0.5 text-sm tabular-nums text-zinc-400">
                    in {nextPodNightCountdownLabel}
                  </p>
                </div>
              ) : null}

              <p className="text-[11px] md:text-sm mb-4">
                <span className="text-zinc-400">Status: </span>
                <span className="text-emerald-400 font-medium">
                  {liveStatusText}
                </span>
              </p>

              {lobbyMomentCopy && (
                <p className="mb-4 text-[11px] md:text-sm text-zinc-400">
                  {lobbyMomentCopy}
                </p>
              )}

              {errorMsg && (
                <div className="mb-4 flex items-start justify-between gap-3 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2">
                  <p className="text-[11px] md:text-sm text-red-300">
                    {errorMsg}
                  </p>
                  <button
                    type="button"
                    onClick={clearError}
                    className="text-[11px] text-red-300/70 hover:text-red-200"
                    aria-label="Dismiss error"
                  >
                    ✕
                  </button>
                </div>
              )}

              {showButton && (
                <button
                  type="button"
                  onClick={() => {
                    void handleEnterPod();
                  }}
                  disabled={!buttonEnabled}
                  className={`block w-full rounded-2xl px-4 py-2.5 md:py-3 text-[12px] md:text-sm font-semibold text-center transition ${
                    buttonEnabled
                      ? "bg-pink-500 hover:bg-pink-400 text-white shadow-[0_0_26px_rgba(255,20,147,0.45)]"
                      : "bg-pink-500/25 text-pink-200/50 shadow-none cursor-not-allowed"
                  }`}
                >
                  {buttonLabel}
                </button>
              )}

              {/*
                pod.recoverableError carries server-internal codes like
                PODS_STATUS_MISSING_CURRENT_ROUND. We intentionally don't
                surface those to users — they're noise. They remain readable
                in the network response via DevTools if needed for debugging.
              */}
            </div>
          </div>

          <p className="text-center text-zinc-500 text-[10px] md:text-xs max-w-md">
            {isFinished
              ? `Next pod opens ${nextPodOpenLabel}.`
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
                  and we&apos;ll look into it.
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
