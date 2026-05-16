import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { log } from "@/lib/log";

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
};

type PodQueueRow = {
  id: number;
  user_id: string;
  status: "waiting" | "matched" | "left";
  room_id: string | null;
  round_number: number;
  pod_id: string | null;
  created_at: string;
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const body = await request.json().catch(() => null);

    const roomId = body?.roomId;
    const roundNumber = body?.roundNumber;
    const podId = body?.podId;

    if (!isNonEmptyString(roomId)) {
      return json(
        {
          ok: false,
          error: "Missing or invalid roomId.",
        },
        400
      );
    }

    if (
      typeof roundNumber !== "number" ||
      !Number.isInteger(roundNumber) ||
      roundNumber < 1
    ) {
      return json(
        {
          ok: false,
          error: "Missing or invalid roundNumber.",
        },
        400
      );
    }

    if (podId != null && !isNonEmptyString(podId)) {
      return json(
        {
          ok: false,
          error: "Invalid podId.",
        },
        400
      );
    }

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return json(
        {
          ok: false,
          error: authError.message || "Could not verify authenticated user.",
        },
        401
      );
    }

    if (!user) {
      return json(
        {
          ok: false,
          error: "Not authenticated.",
        },
        401
      );
    }

    const userId = user.id;

    const { data: roomRaw, error: roomError } = await supabase
      .from("pod_rooms")
      .select("room_id, user_a_id, user_b_id")
      .eq("room_id", roomId)
      .maybeSingle<PodRoomRow>();

    if (roomError) {
      console.error("[pods/leave] room lookup error", roomError);
      return json(
        {
          ok: false,
          error: roomError.message || "Could not verify room.",
        },
        500
      );
    }

    const room = (roomRaw as PodRoomRow | null) ?? null;

    if (!room) {
      const { error: lockError } = await deleteLeavingUserParticipantLock({
        supabase,
        userId,
        roomId,
        roundNumber,
        podId: isNonEmptyString(podId) ? podId : null,
      });

      if (lockError) {
        console.error("[pods/leave] participant lock delete error", lockError);
        return json(
          {
            ok: false,
            error: lockError.message || "Could not clear participant locks.",
          },
          500
        );
      }

      const { error: queueError } = await markLeavingUserQueueInactive({
        supabase,
        userId,
        roomId,
        roundNumber,
        podId: isNonEmptyString(podId) ? podId : null,
      });

      if (queueError) {
        console.error("[pods/leave] queue leave cleanup error", queueError);
        return json(
          {
            ok: false,
            error: queueError.message || "Could not leave pod.",
          },
          500
        );
      }

      return json({
        ok: true,
        left: true,
        roomId,
        roundNumber,
        podId: isNonEmptyString(podId) ? podId : null,
        userId,
        otherUserId: null,
      });
    }

    const isUserA = room.user_a_id === userId;
    const isUserB = room.user_b_id === userId;

    if (!isUserA && !isUserB) {
      return json(
        {
          ok: false,
          error: "You do not have access to leave this room.",
        },
        403
      );
    }

    const otherUserId = isUserA ? room.user_b_id : room.user_a_id;

    const resolvedPodId = isNonEmptyString(podId)
      ? podId
      : await getPodIdFromQueueForRoom({
          supabase,
          roomId,
          roundNumber,
        });

    // 1) Clear only the leaving user's participant lock.
    {
      const { error } = await deleteLeavingUserParticipantLock({
        supabase,
        userId,
        roomId,
        roundNumber,
        podId: resolvedPodId,
      });

      if (error) {
        console.error("[pods/leave] participant lock delete error", error);
        return json(
          {
            ok: false,
            error: error.message || "Could not clear participant locks.",
          },
          500
        );
      }
    }

    // 2) Mark only the leaving user's queue row inactive. If the schema does
    // not allow status="left", delete that row instead.
    {
      const { error } = await markLeavingUserQueueInactive({
        supabase,
        userId,
        roomId,
        roundNumber,
        podId: resolvedPodId,
      });

      if (error) {
        console.error("[pods/leave] queue leave cleanup error", error);
        return json(
          {
            ok: false,
            error: error.message || "Could not leave pod.",
          },
          500
        );
      }
    }

    // 3) IMPORTANT:
    // Do NOT delete pod_matches here.
    // pod_matches is the source of truth for preventing same-pair rematches
    // within the same pod night and for preserving match history.
    //
    // 4) IMPORTANT:
    // Do NOT delete pod_rooms here.
    // after/page.tsx and done/page.tsx still need the room row
    // to finalize results and map user_a_id/user_b_id.

    return json({
      ok: true,
      left: true,
      roomId,
      roundNumber,
      podId: resolvedPodId,
      userId,
      otherUserId,
    });
  } catch (error) {
    console.error("[pods/leave] unexpected error", error);

    return json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Internal server error.",
      },
      500
    );
  }
}

async function getPodIdFromQueueForRoom(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  roomId: string;
  roundNumber: number;
}) {
  const { supabase, roomId, roundNumber } = args;

  const { data, error } = await supabase
    .from("pod_queue")
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .eq("room_id", roomId)
    .eq("round_number", roundNumber)
    .limit(1)
    .maybeSingle<PodQueueRow>();

  if (error) {
    log.warn("[pods/leave] pod id lookup from queue failed", error);
    return null;
  }

  return (data as PodQueueRow | null)?.pod_id ?? null;
}

async function deleteLeavingUserParticipantLock(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  roomId: string;
  roundNumber: number;
  podId: string | null;
}) {
  const { supabase, userId, roomId, roundNumber, podId } = args;

  const participantDelete = supabase
    .from("pod_match_participants")
    .delete()
    .eq("user_id", userId)
    .eq("room_id", roomId)
    .eq("round_number", roundNumber);

  const participantDeleteWithPod = podId
    ? participantDelete.eq("pod_id", podId)
    : participantDelete;

  return await participantDeleteWithPod;
}

async function markLeavingUserQueueInactive(args: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  userId: string;
  roomId: string;
  roundNumber: number;
  podId: string | null;
}) {
  const { supabase, userId, roomId, roundNumber, podId } = args;

  const queueUpdate = supabase
    .from("pod_queue")
    .update({
      status: "left",
      room_id: null,
    })
    .eq("user_id", userId)
    .eq("room_id", roomId)
    .eq("round_number", roundNumber);

  const queueUpdateWithPod = podId
    ? queueUpdate.eq("pod_id", podId)
    : queueUpdate;

  const updateResult = await queueUpdateWithPod;

  if (!updateResult.error) {
    return updateResult;
  }

  log.warn(
    "[pods/leave] status left update failed, deleting leaving queue row",
    updateResult.error
  );

  const queueDelete = supabase
    .from("pod_queue")
    .delete()
    .eq("user_id", userId)
    .eq("room_id", roomId)
    .eq("round_number", roundNumber);

  const queueDeleteWithPod = podId
    ? queueDelete.eq("pod_id", podId)
    : queueDelete;

  return await queueDeleteWithPod;
}
