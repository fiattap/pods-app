import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getRoundTimingDates } from "@/lib/pods/timing";

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
  user_a_name: string | null;
  user_b_name: string | null;
  user_a_city: string | null;
  user_b_city: string | null;
  started_at: string | null;
};

type PodMatchRow = {
  room_id: string | null;
  round_number: number | null;
  pod_id: string | null;
};

type ProfileRow = {
  first_name: string | null;
  city: string | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const roomId = searchParams.get("roomId");

    if (!roomId) {
      return NextResponse.json(
        { ok: false, error: "Missing roomId" },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const { data: room, error: roomError } = await supabase
      .from("pod_rooms")
      .select(
        "room_id, user_a_id, user_b_id, user_a_name, user_b_name, user_a_city, user_b_city, started_at"
      )
      .eq("room_id", roomId)
      .maybeSingle<PodRoomRow>();

    if (roomError || !room) {
      return NextResponse.json(
        { ok: false, error: "Room not found" },
        { status: 404 }
      );
    }

    const isUserA = room.user_a_id === user.id;
    const isUserB = room.user_b_id === user.id;

    if (!isUserA && !isUserB) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const otherUserId = isUserA ? room.user_b_id : room.user_a_id;

    let name = isUserA ? room.user_b_name : room.user_a_name;
    let city = isUserA ? room.user_b_city : room.user_a_city;
    const currentUserCity = isUserA ? room.user_a_city : room.user_b_city;

    if ((!name || !city) && otherUserId) {
      const { data: profile } = await supabase
        .from("profiles")
        .select("first_name, city")
        .eq("id", otherUserId)
        .maybeSingle<ProfileRow>();

      if (profile) {
        name = name ?? profile.first_name;
        city = city ?? profile.city;
      }
    }

    const { data: match, error: matchError } = await supabase
      .from("pod_matches")
      .select("room_id, round_number, pod_id")
      .eq("room_id", roomId)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle<PodMatchRow>();

    if (matchError) {
      console.error("[pods/room] pod_matches error", {
        roomId,
        userId: user.id,
        error: matchError,
      });
    }

    const roundNumber = match?.round_number ?? null;
    const timingCity = currentUserCity ?? city ?? null;
    const roundTiming =
      roundNumber != null ? getRoundTimingDates(timingCity, roundNumber) : null;

    return NextResponse.json({
      ok: true,
      roomId: room.room_id,
      otherUserId,
      name: name || null,
      city: city || null,
      roundNumber,
      roomStartedAt: room.started_at ?? null,
      roundStartAt: roundTiming?.roundStartAt.toISOString() ?? null,
      roundEndAt: roundTiming?.roundEndAt.toISOString() ?? null,
    });
  } catch (err) {
    console.error("[pods/room] error", err);

    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
