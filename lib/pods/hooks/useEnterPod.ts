"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Outcome of a single POST /api/pods/match call. The hook itself doesn't
 * navigate — it returns the result and the page wires up routing. This keeps
 * the hook framework-agnostic and testable.
 */
export type EnterPodResult =
  | { kind: "matched"; roomId: string; roundNumber: number }
  | { kind: "waiting" }
  | { kind: "no_match"; nextRound: number | null; reveal: boolean }
  | { kind: "error"; message: string };

type MatchResponseShape = {
  status?: "matched" | "waiting" | "no_match" | "error";
  roomId?: string;
  roundNumber?: number;
  nextRound?: number | null;
  reveal?: boolean;
  error?: string;
  message?: string;
  raw?: string;
};

async function parseResponse(res: Response): Promise<MatchResponseShape> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (!text) return {};

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text) as MatchResponseShape;
    } catch {
      return { raw: text, error: "Invalid JSON response from server." };
    }
  }

  try {
    return JSON.parse(text) as MatchResponseShape;
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

function getFriendlyError(body: MatchResponseShape, fallback: string) {
  if (body.error?.trim()) return body.error;
  if (body.message?.trim()) return body.message;
  if (body.raw?.trim()) {
    if (body.raw.startsWith("<!DOCTYPE") || body.raw.startsWith("<html")) {
      return "The server returned an HTML page instead of match data.";
    }
    return body.raw.length > 180 ? `${body.raw.slice(0, 180)}…` : body.raw;
  }
  return fallback;
}

export type EnterPodArgs = {
  /** The signed-in user's id, mirrored back to the server as a sanity check. */
  userId: string;
  /** Today's pod id from /api/pods/status. */
  podId: string;
  /** The round number the user is trying to enter. */
  roundNumber: number;
};

export type UseEnterPodResult = {
  /**
   * Submit the user into the queue for the current round. Returns the parsed
   * outcome. Will reject only on programmer errors — network/HTTP issues
   * resolve to { kind: "error" }.
   */
  enterPod: (args: EnterPodArgs) => Promise<EnterPodResult>;
  /** True while a POST is in flight. */
  isSubmitting: boolean;
  /** Most recent user-facing error message, or null. */
  errorMsg: string | null;
  /** Clear the current error (e.g. when the user dismisses). */
  clearError: () => void;
};

/**
 * Owns the POST /api/pods/match request lifecycle. Intentionally minimal — the
 * page polls /api/pods/status separately (via usePodStatus) and reacts to
 * `state` transitions there (waiting → matched), so this hook does NOT need
 * to do its own polling. That collapses what used to be ~600 lines of retry
 * scaffolding into a single fetch + result decoder.
 */
export function useEnterPod(): UseEnterPodResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Prevent double-submits if the button is clicked rapidly.
  const inFlightRef = useRef(false);

  const enterPod = useCallback(
    async (args: EnterPodArgs): Promise<EnterPodResult> => {
      if (inFlightRef.current) {
        return { kind: "error", message: "Already submitting." };
      }
      inFlightRef.current = true;
      setIsSubmitting(true);
      setErrorMsg(null);

      try {
        const res = await fetch("/api/pods/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: args.userId,
            podId: args.podId,
            roundNumber: args.roundNumber,
          }),
          cache: "no-store",
        });

        const body = await parseResponse(res);

        if (!res.ok) {
          const message = getFriendlyError(
            body,
            `Could not enter pod (status ${res.status}).`
          );
          setErrorMsg(message);
          return { kind: "error", message };
        }

        switch (body.status) {
          case "matched": {
            if (
              typeof body.roomId === "string" &&
              body.roomId.length > 0 &&
              typeof body.roundNumber === "number"
            ) {
              return {
                kind: "matched",
                roomId: body.roomId,
                roundNumber: body.roundNumber,
              };
            }
            const message =
              "Match response was malformed (missing room or round).";
            setErrorMsg(message);
            return { kind: "error", message };
          }
          case "waiting":
            return { kind: "waiting" };
          case "no_match":
            return {
              kind: "no_match",
              nextRound: body.nextRound ?? null,
              reveal: Boolean(body.reveal),
            };
          case "error":
          default: {
            const message = getFriendlyError(
              body,
              "Could not enter pod. Please try again."
            );
            setErrorMsg(message);
            return { kind: "error", message };
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Network error entering pod.";
        setErrorMsg(message);
        return { kind: "error", message };
      } finally {
        inFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    []
  );

  const clearError = useCallback(() => setErrorMsg(null), []);

  return { enterPod, isSubmitting, errorMsg, clearError };
}
