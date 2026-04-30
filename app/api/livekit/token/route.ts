import { NextResponse } from "next/server";
import { AccessToken } from "livekit-server-sdk";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const roomName = body?.roomName;

    if (!roomName || typeof roomName !== "string") {
      return NextResponse.json({ error: "Missing roomName" }, { status: 400 });
    }

    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const serverUrl = process.env.LIVEKIT_URL;

    if (!apiKey || !apiSecret || !serverUrl) {
      return NextResponse.json(
        { error: "Missing LiveKit env vars" },
        { status: 500 }
      );
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity: user.id,
      name: user.email ?? user.id,
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return NextResponse.json({
      serverUrl,
      token,
    });
  } catch (error) {
    console.error("LIVEKIT TOKEN ROUTE ERROR", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}