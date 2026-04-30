import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type SupportRequestBody = {
  message?: unknown;
  email?: unknown;
  page?: unknown;
  city?: unknown;
  podId?: unknown;
  roomId?: unknown;
  roundNumber?: unknown;
  userId?: unknown;
  type?: unknown;
  reportedUserName?: unknown;
  reportedUserId?: unknown;
  debug_context?: unknown;
  isWaiting?: unknown;
  timestamp?: unknown;
};

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function asNullableString(value: unknown) {
  const trimmed = asTrimmedString(value);
  return trimmed.length > 0 ? trimmed : null;
}

function asNullableInteger(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }

  return null;
}

function asNullableUuidString(value: unknown) {
  const trimmed = asNullableString(value);
  if (!trimmed) return null;

  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidRegex.test(trimmed) ? trimmed : null;
}

function asObjectOrNull(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as SupportRequestBody | null;

    if (!body) {
      return NextResponse.json(
        { ok: false, error: "Invalid request body." },
        { status: 400 }
      );
    }

    const message = asTrimmedString(body.message);
    const email = asNullableString(body.email);
    const page = asNullableString(body.page);
    const city = asNullableString(body.city);
    const podId = asNullableString(body.podId);
    const roomId = asNullableString(body.roomId);
    const roundNumber = asNullableInteger(body.roundNumber);
    const type = asNullableString(body.type);
    const reportedUserName = asNullableString(body.reportedUserName);
    const reportedUserId = asNullableUuidString(body.reportedUserId);

    const debugContext =
      asObjectOrNull(body.debug_context) ??
      asObjectOrNull({
        isWaiting: body.isWaiting,
        timestamp: body.timestamp,
      });

    if (!message) {
      return NextResponse.json(
        { ok: false, error: "Message is required." },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const userId = user?.id ?? asNullableUuidString(body.userId);

    let reporterName: string | null = null;
    let reporterEmail: string | null = email ?? null;

    if (userId) {
      const { data: reporterProfile } = await supabase
        .from("profiles")
        .select("first_name, email")
        .eq("id", userId)
        .maybeSingle();

      if (reporterProfile) {
        reporterName =
          typeof reporterProfile.first_name === "string"
            ? reporterProfile.first_name.trim() || null
            : null;

        if (!reporterEmail && typeof reporterProfile.email === "string") {
          reporterEmail = reporterProfile.email.trim() || null;
        }
      }
    }

    const insertPayload = {
      user_id: userId,
      reporter_name: reporterName,
      reporter_email: reporterEmail,
      email: email ?? reporterEmail,
      message,
      page,
      city,
      pod_id: podId,
      room_id: roomId,
      round_number: roundNumber,
      type,
      reported_user_name: reportedUserName,
      reported_user_id: reportedUserId,
      debug_context: debugContext,
    };

    const { error } = await supabase.from("support_requests").insert(insertPayload);

    if (error) {
      console.error("SUPPORT REQUEST INSERT ERROR", {
        message: error.message,
        details: error.details,
        hint: error.hint,
        code: error.code,
        insertPayload,
      });

      return NextResponse.json(
        { ok: false, error: "Could not save support request." },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("SUPPORT REQUEST ROUTE ERROR", error);

    return NextResponse.json(
      { ok: false, error: "Unexpected server error." },
      { status: 500 }
    );
  }
}