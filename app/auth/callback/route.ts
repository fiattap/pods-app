import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

type SignupDraftData = {
  first_name?: string;
  email?: string;
  gender?: string;
  interested_in?: string;
  city?: string;
  date_of_birth?: string;
  age_range?: string;
  photo_path?: string | null;
  photo_file_name?: string | null;
};

function getSafeNextPath(nextParam: string | null) {
  if (!nextParam) return "/pods";
  if (!nextParam.startsWith("/")) return "/pods";
  if (nextParam.startsWith("//")) return "/pods";
  return nextParam;
}

function redirectWithNoStore(path: string, origin: string) {
  const response = NextResponse.redirect(new URL(path, origin));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code");
    const next = getSafeNextPath(requestUrl.searchParams.get("next"));

    if (!code) {
      return redirectWithNoStore(
        "/login?error=missing_auth_code",
        requestUrl.origin
      );
    }

    const supabase = await createClient();

    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(
      code
    );

    if (exchangeError) {
      console.error("[auth/callback] exchange error", exchangeError);
      return redirectWithNoStore(
        "/login?error=auth_callback_failed",
        requestUrl.origin
      );
    }

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user || !user.email) {
      console.error("[auth/callback] user error", { userError, user });
      return redirectWithNoStore(
        "/login?error=user_not_found",
        requestUrl.origin
      );
    }

    const email = user.email.toLowerCase().trim();

    const { data: existingProfile, error: existingProfileError } = await supabase
      .from("profiles")
      .select("id, onboarding_complete")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfileError) {
      console.error("[auth/callback] existing profile check error", existingProfileError);
      return redirectWithNoStore(
        "/signup?error=profile_lookup_failed",
        requestUrl.origin
      );
    }

    if (existingProfile?.onboarding_complete) {
      return redirectWithNoStore(next, requestUrl.origin);
    }

    const { data: draftRow, error: draftError } = await supabase
      .from("signup_drafts")
      .select("id, data")
      .eq("email", email)
      .maybeSingle();

    if (draftError) {
      console.error("[auth/callback] draft load error", draftError);
      return redirectWithNoStore(
        "/signup?error=draft_load_failed",
        requestUrl.origin
      );
    }

    if (!draftRow?.data) {
      return redirectWithNoStore(
        "/signup?error=missing_signup_draft",
        requestUrl.origin
      );
    }

    const draft = draftRow.data as SignupDraftData;

    const profilePayload = {
      id: user.id,
      first_name: draft.first_name?.trim() || "",
      email,
      gender: draft.gender || "",
      interested_in: draft.interested_in || "",
      city: draft.city || "",
      date_of_birth: draft.date_of_birth || null,
      age_range: draft.age_range || null,
      photo_path: draft.photo_path ?? null,
      onboarding_complete: true,
    };

    const { error: upsertError } = await supabase
      .from("profiles")
      .upsert(profilePayload, { onConflict: "id" });

    if (upsertError) {
      console.error("[auth/callback] profile upsert error", upsertError);
      return redirectWithNoStore(
        "/signup?error=profile_upsert_failed",
        requestUrl.origin
      );
    }

    const { error: deleteDraftError } = await supabase
      .from("signup_drafts")
      .delete()
      .eq("email", email);

    if (deleteDraftError) {
      console.error("[auth/callback] signup draft delete error", deleteDraftError);
    }

    return redirectWithNoStore(next, requestUrl.origin);
  } catch (error) {
    console.error("[auth/callback] unexpected route error", error);
    const requestUrl = new URL(request.url);
    return redirectWithNoStore(
      "/login?error=unexpected_auth_callback_error",
      requestUrl.origin
    );
  }
}