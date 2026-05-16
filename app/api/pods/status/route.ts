import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  PODS_LAUNCH_LABEL,
  getDebugAdjustedNow,
  getPodIdForCurrentSession,
  getPodPhaseState,
  getRoundEntryState,
  isPreLaunch,
  type PodPhase,
  type RoundEntryReason,
} from "@/lib/pods/timing";
import { log } from "@/lib/log";

type QueueStatus = "waiting" | "matched" | "left";
type PodStatusState = "none" | "waiting" | "matched" | "closedForTonight";

type ProfileRow = {
  first_name: string | null;
  city: string | null;
};

type PodQueueRow = {
  id: number;
  user_id: string;
  status: QueueStatus;
  room_id: string | null;
  round_number: number | null;
  pod_id: string | null;
  created_at: string;
};

type PodMatchRow = {
  id: number;
  room_id: string | null;
  round_number: number | null;
  pod_id: string | null;
  user_a_id: string;
  user_b_id: string;
};

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function toIsoString(value: Date | null) {
  return value ? value.toISOString() : null;
}

function buildStatus(params: {
  signedIn: boolean;
  userId?: string | null;
  firstName?: string | null;
  city?: string | null;
  podId?: string | null;
  currentRound?: number | null;
  phase: PodPhase;
  state: PodStatusState;
  hasActiveSession?: boolean;
  roomId?: string | null;
  roundNumber?: number | null;
  canEnterRound: boolean;
  shouldGoToDone: boolean;
  entryWindowOpen?: boolean;
  secondsSinceRoundStart?: number | null;
  secondsUntilRoundStart?: number | null;
  secondsUntilRoundEnd?: number | null;
  nextRound?: number | null;
  reason?: RoundEntryReason | null;
  secondsLeftInPhase?: number | null;
  roundStartAt?: Date | null;
  conversationEndsAt?: Date | null;
  roundEndAt?: Date | null;
  ratingEndsAt?: Date | null;
  nextRoundOpensAt?: Date | null;
  isOpenDay?: boolean;
  isPreopen?: boolean;
  prelaunch?: boolean;
  launchLabel?: string | null;
  recoverableError?: string;
}) {
  const closedForTonight =
    params.phase === "finished" && params.shouldGoToDone === true;
  const hasActiveSession =
    params.hasActiveSession ??
    (params.state === "matched" || params.state === "waiting");
  const serverNow = getDebugAdjustedNow();
  const roundNumber = params.roundNumber ?? params.currentRound ?? null;

  log.debug("[pods/status] canonical phase resolved", {
    podId: params.podId ?? null,
    roundNumber,
    canonicalPhase: params.phase,
    canEnterRound: params.canEnterRound,
    serverNow: serverNow.toISOString(),
  });

  return {
    ok: true,
    signedIn: params.signedIn,
    userId: params.userId ?? null,
    firstName: params.firstName ?? null,
    city: params.city ?? null,
    podId: params.podId ?? null,
    currentRound: params.currentRound ?? null,
    canonicalPhase: params.phase,
    phase: params.phase,
    state: params.state,
    hasActiveSession,
    roomId: params.roomId ?? null,
    roundNumber: params.roundNumber ?? null,
    canEnterRound: params.canEnterRound,
    shouldGoToDone: params.shouldGoToDone,
    entryWindowOpen: params.entryWindowOpen ?? false,
    secondsSinceRoundStart: params.secondsSinceRoundStart ?? null,
    secondsUntilRoundStart: params.secondsUntilRoundStart ?? null,
    secondsUntilRoundEnd: params.secondsUntilRoundEnd ?? null,
    nextRound: params.nextRound ?? null,
    reason: params.reason ?? null,
    secondsLeftInPhase: params.secondsLeftInPhase ?? null,
    roundStartAt: toIsoString(params.roundStartAt ?? null),
    conversationEndsAt: toIsoString(params.conversationEndsAt ?? null),
    roundEndAt: toIsoString(params.roundEndAt ?? null),
    ratingEndsAt: toIsoString(params.ratingEndsAt ?? null),
    nextRoundOpensAt: toIsoString(params.nextRoundOpensAt ?? null),
    prelaunch: params.prelaunch ?? false,
    launchLabel: params.launchLabel ?? null,
    closedForTonight,
    isOpenDay: params.isOpenDay ?? false,
    isPreopen: params.isPreopen ?? false,
    serverNow: serverNow.toISOString(),
    ...(params.recoverableError
      ? { recoverableError: params.recoverableError }
      : {}),
  };
}

function entryStatusFields(entryState: ReturnType<typeof getRoundEntryState>) {
  return {
    phase: entryState.phase,
    shouldGoToDone: entryState.shouldGoToDone,
    entryWindowOpen: entryState.entryWindowOpen,
    secondsSinceRoundStart: entryState.secondsSinceRoundStart,
    secondsUntilRoundStart: entryState.secondsUntilRoundStart,
    secondsUntilRoundEnd: entryState.secondsUntilRoundEnd,
    nextRound: entryState.nextRound,
    reason: entryState.reason,
    roundStartAt: entryState.roundStartAt,
    roundEndAt: entryState.roundEndAt,
  };
}

async function getValidatedRoom(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
  userId: string
) {
  const { data, error } = await supabase
    .from("pod_rooms")
    .select("room_id, user_a_id, user_b_id")
    .eq("room_id", roomId)
    .maybeSingle<PodRoomRow>();

  if (error) {
    console.error("[pods/status] pod_rooms error", {
      roomId,
      userId,
      error,
    });
    return null;
  }

  if (!data) return null;

  if (data.user_a_id !== userId && data.user_b_id !== userId) {
    return null;
  }

  return data;
}

async function resolveActiveMatchedRoomId(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  queueRows: PodQueueRow[];
  podId: string;
  currentRound: number;
}) {
  for (const row of args.queueRows) {
    if (
      row.status !== "matched" ||
      !row.room_id ||
      row.pod_id !== args.podId ||
      row.round_number !== args.currentRound
    ) {
      continue;
    }

    const room = await getValidatedRoom(
      args.supabase,
      row.room_id,
      args.userId
    );

    if (room) {
      return room.room_id;
    }
  }

  return null;
}

export async function GET() {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      console.error("[pods/status] auth.getUser error", authError);
    }

    if (authError || !user) {
      return json(
        buildStatus({
          signedIn: false,
          phase: "closed",
          state: "none",
          canEnterRound: false,
          shouldGoToDone: false,
        })
      );
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("first_name, city")
      .eq("id", user.id)
      .maybeSingle<ProfileRow>();

    if (profileError) {
      console.error("[pods/status] profiles error", {
        userId: user.id,
        error: profileError,
      });
    }

    const firstName = profile?.first_name ?? null;
    const city = profile?.city ?? null;
    const debugAdjustedNow = getDebugAdjustedNow();
    const podId = getPodIdForCurrentSession(city, debugAdjustedNow);

    if (isPreLaunch()) {
      const phaseState = getPodPhaseState(city, debugAdjustedNow);

      return json(
        buildStatus({
          signedIn: true,
          userId: user.id,
          firstName,
          city,
          podId,
          currentRound: phaseState.currentRound,
          phase: "closed",
          state: "none",
          canEnterRound: false,
          shouldGoToDone: false,
          secondsLeftInPhase: phaseState.secondsLeftInPhase,
          roundStartAt: phaseState.roundStartAt,
          conversationEndsAt: phaseState.conversationEndsAt,
          roundEndAt: phaseState.roundEndAt,
          ratingEndsAt: phaseState.ratingEndsAt,
          nextRoundOpensAt: phaseState.nextRoundOpensAt,
          isOpenDay: phaseState.isOpenDay,
          isPreopen: false,
          prelaunch: true,
          launchLabel: PODS_LAUNCH_LABEL,
        })
      );
    }

    const phaseState = getPodPhaseState(city, debugAdjustedNow);
    const currentRound = phaseState.currentRound;

    if (currentRound == null) {
      return json(
        buildStatus({
          signedIn: true,
          userId: user.id,
          firstName,
          city,
          podId,
          currentRound: null,
          phase: "closed",
          state: "none",
          canEnterRound: false,
          shouldGoToDone: false,
          isOpenDay: phaseState.isOpenDay,
          isPreopen: false,
          recoverableError: "PODS_STATUS_MISSING_CURRENT_ROUND",
        })
      );
    }

    const entryState = getRoundEntryState(city, currentRound, debugAdjustedNow);
    const entryFields = entryStatusFields(entryState);

    log.debug("[pods/status] entry state resolved", {
      podId,
      currentRound,
      phase: entryState.phase,
      canEnterRound: entryState.canEnterRound,
      entryWindowOpen: entryState.entryWindowOpen,
      reason: entryState.reason,
      serverNow: debugAdjustedNow.toISOString(),
    });

    const [
      { data: queueData, error: queueError },
      { data: matchData, error: matchError },
    ] = await Promise.all([
      supabase
        .from("pod_queue")
        .select("id, user_id, status, room_id, round_number, pod_id, created_at")
        .eq("user_id", user.id)
        .eq("pod_id", podId)
        .eq("round_number", currentRound)
        .in("status", ["waiting", "matched"])
        .order("created_at", { ascending: false }),
      supabase
        .from("pod_matches")
        .select("id, room_id, round_number, pod_id, user_a_id, user_b_id")
        .or(`user_a_id.eq.${user.id},user_b_id.eq.${user.id}`)
        .eq("pod_id", podId)
        .eq("round_number", currentRound)
        .order("id", { ascending: false }),
    ]);

    if (queueError) {
      console.error("[pods/status] pod_queue error", {
        userId: user.id,
        podId,
        currentRound,
        error: queueError,
      });
    }

    if (matchError) {
      console.error("[pods/status] pod_matches error", {
        userId: user.id,
        podId,
        currentRound,
        error: matchError,
      });
    }

    const queueRows = (queueData ?? []) as PodQueueRow[];
    const matchRows = ((matchData ?? []) as PodMatchRow[]).filter(
      (row) =>
        row.room_id &&
        row.round_number === currentRound &&
        row.pod_id === podId
    );
    const activeWaitingRows = queueRows.filter(
      (row) =>
        row.status === "waiting" &&
        row.pod_id === podId &&
        row.round_number === currentRound
    );

    const matchedRoomId = await resolveActiveMatchedRoomId({
      supabase,
      userId: user.id,
      queueRows,
      podId,
      currentRound,
    });

    if (matchRows.length > 0 && !matchedRoomId) {
      log.debug("[pods/status] historical matches ignored for restore", {
        userId: user.id,
        podId,
        currentRound,
        historicalMatchCount: matchRows.length,
      });
    }

    if (matchedRoomId) {
      return json(
        buildStatus({
          signedIn: true,
          userId: user.id,
          firstName,
          city,
          podId,
          currentRound,
          ...entryFields,
          state: "matched",
          roomId: matchedRoomId,
          roundNumber: currentRound,
          canEnterRound: false,
          secondsLeftInPhase: phaseState.secondsLeftInPhase,
          conversationEndsAt: phaseState.conversationEndsAt,
          ratingEndsAt: phaseState.ratingEndsAt,
          nextRoundOpensAt: phaseState.nextRoundOpensAt,
          isOpenDay: phaseState.isOpenDay,
          isPreopen: false,
          recoverableError:
            queueError || matchError || profileError
              ? "PODS_STATUS_PARTIAL_DATA"
              : undefined,
        })
      );
    }

    if (activeWaitingRows.length > 0) {
      return json(
        buildStatus({
          signedIn: true,
          userId: user.id,
          firstName,
          city,
          podId,
          currentRound,
          ...entryFields,
          state: "waiting",
          roundNumber: currentRound,
          canEnterRound: false,
          secondsLeftInPhase: phaseState.secondsLeftInPhase,
          conversationEndsAt: phaseState.conversationEndsAt,
          ratingEndsAt: phaseState.ratingEndsAt,
          nextRoundOpensAt: phaseState.nextRoundOpensAt,
          isOpenDay: phaseState.isOpenDay,
          isPreopen: false,
          recoverableError:
            queueError || matchError || profileError
              ? "PODS_STATUS_PARTIAL_DATA"
              : undefined,
        })
      );
    }

    return json(
      buildStatus({
        signedIn: true,
        userId: user.id,
        firstName,
        city,
        podId,
        currentRound,
        ...entryFields,
        state: entryState.shouldGoToDone ? "closedForTonight" : "none",
        canEnterRound: entryState.canEnterRound,
        secondsLeftInPhase: phaseState.secondsLeftInPhase,
        conversationEndsAt: phaseState.conversationEndsAt,
        ratingEndsAt: phaseState.ratingEndsAt,
        nextRoundOpensAt: phaseState.nextRoundOpensAt,
        isOpenDay: phaseState.isOpenDay,
        isPreopen: false,
        recoverableError:
          queueError || matchError || profileError
            ? "PODS_STATUS_PARTIAL_DATA"
            : undefined,
      })
    );
  } catch (error) {
    console.error("[pods/status] unexpected error", error);

    return json(
      buildStatus({
        signedIn: true,
        phase: "closed",
        state: "none",
        canEnterRound: false,
        shouldGoToDone: false,
        recoverableError: "UNEXPECTED_STATUS_ROUTE_ERROR",
      })
    );
  }
}
