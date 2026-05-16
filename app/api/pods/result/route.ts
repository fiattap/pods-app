import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { TOTAL_ROUNDS } from "@/lib/pods/timing";
import { log } from "@/lib/log";

type Outcome = "match" | "pass";

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
  round_number: number | null;
};

type PodResultRow = {
  id: string;
  room_id: string;
  user_id: string;
  matched_user_id: string;
  round_number: number | null;
  outcome: string | null;
  shared_contact: boolean | null;
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function normalizeOutcome(value: unknown): Outcome | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "match") return "match";
  if (normalized === "pass") return "pass";
  return null;
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient();
    const body = await request.json().catch(() => null);

    log.debug("[pods/result] request body", body);

    const roomId = typeof body?.roomId === "string" ? body.roomId : null;
    const outcome = normalizeOutcome(body?.outcome);

    if (!roomId) {
      return json({ status: "error", error: "Missing or invalid roomId." }, 400);
    }

    if (!outcome) {
      return json({ status: "error", error: "Missing or invalid outcome." }, 400);
    }

    const {
      data: { user: authedUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return json(
        { status: "error", error: authError.message || "Could not verify user." },
        401
      );
    }

    if (!authedUser) {
      return json({ status: "error", error: "Not authenticated." }, 401);
    }

    const userId = authedUser.id;

    const { data: roomRaw, error: roomError } = await supabase
      .from("pod_rooms")
      .select("room_id, user_a_id, user_b_id, round_number")
      .eq("room_id", roomId)
      .maybeSingle<PodRoomRow>();

    if (roomError) {
      console.error("[pods/result] room lookup error", roomError);
      return json(
        { status: "error", error: roomError.message || "Could not load room." },
        500
      );
    }

    const room = roomRaw as PodRoomRow | null;

    if (!room) {
      return json({ status: "error", error: "Room not found." }, 404);
    }

    if (room.user_a_id !== userId && room.user_b_id !== userId) {
      return json({ status: "error", error: "You are not part of this room." }, 403);
    }

    const matchedUserId = room.user_a_id === userId ? room.user_b_id : room.user_a_id;
    const roomRoundNumber =
      typeof room.round_number === "number" ? room.round_number : null;

    const { error: upsertError } = await supabase.from("pod_results").upsert(
      {
        room_id: roomId,
        user_id: userId,
        matched_user_id: matchedUserId,
        round_number: roomRoundNumber,
        outcome,
        shared_contact: false,
      },
      {
        onConflict: "room_id,user_id",
      }
    );

    if (upsertError) {
      console.error("[pods/result] upsert error", upsertError);
      return json(
        { status: "error", error: upsertError.message || "Could not save result." },
        500
      );
    }

    const { data: resultRowsRaw, error: resultsError } = await supabase
      .from("pod_results")
      .select(
        "id, room_id, user_id, matched_user_id, round_number, outcome, shared_contact"
      )
      .eq("room_id", roomId);

    if (resultsError) {
      console.error("[pods/result] results lookup error", resultsError);
      return json(
        { status: "error", error: resultsError.message || "Could not load results." },
        500
      );
    }

    const resultRows = (resultRowsRaw ?? []) as PodResultRow[];
    const myResult = resultRows.find((row) => row.user_id === userId) ?? null;
    const otherResult = resultRows.find((row) => row.user_id === matchedUserId) ?? null;

    if (!myResult) {
      return json({ status: "error", error: "Your result was not saved." }, 500);
    }

    if (!otherResult) {
      return json({
        status: "submitted",
        message: "Your choice is saved. Waiting for the other person.",
        reveal: "waiting",
        roundNumber: roomRoundNumber,
        finalized: false,
      });
    }

    const bothMatched =
      myResult.outcome === "match" && otherResult.outcome === "match";

    if (bothMatched) {
      const { error: sharedContactUpdateError } = await supabase
        .from("pod_results")
        .update({ shared_contact: true })
        .eq("room_id", roomId);

      if (sharedContactUpdateError) {
        console.error(
          "[pods/result] shared_contact update error",
          sharedContactUpdateError
        );
        return json(
          {
            status: "error",
            error:
              sharedContactUpdateError.message ||
              "Could not finalize mutual match.",
          },
          500
        );
      }

      if (roomRoundNumber === TOTAL_ROUNDS) {
        return json({
          status: "complete",
          reveal: "mutual_match",
          sharedContact: true,
          matchedUserId,
          roundNumber: roomRoundNumber,
          finalized: true,
        });
      }

      return json({
        status: "complete",
        reveal: "waiting",
        sharedContact: true,
        matchedUserId,
        roundNumber: roomRoundNumber,
        finalized: false,
      });
    }

    if (roomRoundNumber === TOTAL_ROUNDS) {
      return json({
        status: "complete",
        reveal: "no_match",
        sharedContact: false,
        matchedUserId,
        roundNumber: roomRoundNumber,
        finalized: true,
      });
    }

    return json({
      status: "complete",
      reveal: "waiting",
      sharedContact: false,
      matchedUserId,
      roundNumber: roomRoundNumber,
      finalized: false,
    });
  } catch (error) {
    console.error("[pods/result] route error", error);

    return json(
      {
        status: "error",
        error: getErrorMessage(error, "Internal server error."),
      },
      500
    );
  }
}

export async function GET(request: Request) {
  try {
    const supabase = await createClient();
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get("roomId");

    if (!roomId) {
      return json({ status: "error", error: "Missing roomId." }, 400);
    }

    const {
      data: { user: authedUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return json(
        { status: "error", error: authError.message || "Could not verify user." },
        401
      );
    }

    if (!authedUser) {
      return json({ status: "error", error: "Not authenticated." }, 401);
    }

    const userId = authedUser.id;

    const { data: roomRaw, error: roomError } = await supabase
      .from("pod_rooms")
      .select("room_id, user_a_id, user_b_id, round_number")
      .eq("room_id", roomId)
      .maybeSingle<PodRoomRow>();

    if (roomError) {
      console.error("[pods/result] GET room lookup error", roomError);
      return json(
        { status: "error", error: roomError.message || "Could not load room." },
        500
      );
    }

    const room = roomRaw as PodRoomRow | null;

    if (!room) {
      return json({ status: "error", error: "Room not found." }, 404);
    }

    if (room.user_a_id !== userId && room.user_b_id !== userId) {
      return json({ status: "error", error: "You are not part of this room." }, 403);
    }

    const matchedUserId = room.user_a_id === userId ? room.user_b_id : room.user_a_id;
    const roomRoundNumber =
      typeof room.round_number === "number" ? room.round_number : null;

    const { data: resultRowsRaw, error: resultsError } = await supabase
      .from("pod_results")
      .select(
        "id, room_id, user_id, matched_user_id, round_number, outcome, shared_contact"
      )
      .eq("room_id", roomId);

    if (resultsError) {
      console.error("[pods/result] GET results lookup error", resultsError);
      return json(
        { status: "error", error: resultsError.message || "Could not load results." },
        500
      );
    }

    const resultRows = (resultRowsRaw ?? []) as PodResultRow[];
    const myResult = resultRows.find((row) => row.user_id === userId) ?? null;
    const otherResult = resultRows.find((row) => row.user_id === matchedUserId) ?? null;

    if (!myResult) {
      return json({
        status: "idle",
        reveal: "not_submitted",
        roundNumber: roomRoundNumber,
        finalized: false,
      });
    }

    if (!otherResult) {
      return json({
        status: "submitted",
        reveal: "waiting",
        roundNumber: roomRoundNumber,
        finalized: false,
      });
    }

    const bothMatched =
      myResult.outcome === "match" && otherResult.outcome === "match";

    if (roomRoundNumber === TOTAL_ROUNDS) {
      return json({
        status: "complete",
        reveal: bothMatched ? "mutual_match" : "no_match",
        sharedContact: bothMatched,
        matchedUserId,
        roundNumber: roomRoundNumber,
        finalized: true,
      });
    }

    return json({
      status: "complete",
      reveal: "waiting",
      sharedContact: bothMatched,
      matchedUserId,
      roundNumber: roomRoundNumber,
      finalized: false,
    });
  } catch (error) {
    console.error("[pods/result] GET route error", error);

    return json(
      {
        status: "error",
        error: getErrorMessage(error, "Internal server error."),
      },
      500
    );
  }
}
