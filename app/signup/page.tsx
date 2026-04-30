"use client";

import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { supabase } from "@/lib/supabase/client";

type SignupProfileDraft = {
  firstName: string;
  email: string;
  gender: string;
  interestedIn: string;
  city: string;
  dobMonth: string;
  dobDay: string;
  dobYear: string;
  photoFileName: string;
};

type DraftPayload = {
  first_name: string;
  email: string;
  gender: string;
  interested_in: string;
  city: string;
  date_of_birth: string;
  age_range: string;
  photo_path: string | null;
  photo_file_name: string | null;
};

const MINIMUM_AGE = 21;
const MAXIMUM_AGE = 40;
const RESEND_COOLDOWN_SECONDS = 60;
const PHOTO_BUCKET = "profile-photos";

const MONTHS = [
  { value: "1", label: "January" },
  { value: "2", label: "February" },
  { value: "3", label: "March" },
  { value: "4", label: "April" },
  { value: "5", label: "May" },
  { value: "6", label: "June" },
  { value: "7", label: "July" },
  { value: "8", label: "August" },
  { value: "9", label: "September" },
  { value: "10", label: "October" },
  { value: "11", label: "November" },
  { value: "12", label: "December" },
];

function getAgeFromDob(dobString: string): number | null {
  const dob = new Date(dobString);
  if (Number.isNaN(dob.getTime())) return null;

  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDiff = today.getMonth() - dob.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
    age--;
  }

  return age;
}

function computeAgeRangeFromDob(dobString: string): string | null {
  const age = getAgeFromDob(dobString);
  if (age === null) return null;

  if (age < MINIMUM_AGE || age > MAXIMUM_AGE) return null;
  if (age <= 29) return "21-29";
  return "30-40";
}

function buildDobString(month: string, day: string, year: string): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function getFileExtension(fileName: string) {
  const parts = fileName.split(".");
  if (parts.length < 2) return "jpg";
  return parts.pop()?.toLowerCase() || "jpg";
}

function getFriendlyErrorMessage(error: unknown, fallback: string) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  return fallback;
}

function isOtpCooldownMessage(message: string | undefined) {
  if (!message) return false;

  const normalized = message.toLowerCase();
  return (
    normalized.includes("security purposes") ||
    normalized.includes("only request this after") ||
    normalized.includes("wait")
  );
}

export default function SignupPage() {
  const [step, setStep] = useState(1);
  const totalSteps = 3;

  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [hasSentLink, setHasSentLink] = useState(false);
  const [resendCountdown, setResendCountdown] = useState(0);

  const [form, setForm] = useState<SignupProfileDraft>({
    firstName: "",
    email: "",
    gender: "",
    interestedIn: "",
    city: "",
    dobMonth: "",
    dobDay: "",
    dobYear: "",
    photoFileName: "",
  });

  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [selectedPhotoFile, setSelectedPhotoFile] = useState<File | null>(null);

  const today = new Date();
  const currentYear = today.getFullYear();
  const maxBirthYear = currentYear - MINIMUM_AGE;
  const minBirthYear = currentYear - MAXIMUM_AGE;

  const years = Array.from(
    { length: maxBirthYear - minBirthYear + 1 },
    (_, i) => String(maxBirthYear - i)
  );

  const days = Array.from({ length: 31 }, (_, i) => String(i + 1));

  useEffect(() => {
    return () => {
      if (photoPreviewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreviewUrl);
      }
    };
  }, [photoPreviewUrl]);

  useEffect(() => {
    if (resendCountdown <= 0) return;

    const timer = window.setInterval(() => {
      setResendCountdown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => window.clearInterval(timer);
  }, [resendCountdown]);

  function updateField<K extends keyof SignupProfileDraft>(
    key: K,
    value: SignupProfileDraft[K]
  ) {
    setErrorMsg(null);
    setSuccessMsg(null);
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function canGoNext(currentStep: number) {
    if (currentStep === 1) {
      return !!form.firstName.trim() && !!form.email.trim();
    }

    if (currentStep === 2) {
      return !!form.gender && !!form.interestedIn;
    }

    return true;
  }

  function handlePhotoChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setErrorMsg(null);
    setSuccessMsg(null);
    setSelectedPhotoFile(file);
    updateField("photoFileName", file.name);

    try {
      if (photoPreviewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(photoPreviewUrl);
      }

      const localPreview = URL.createObjectURL(file);
      setPhotoPreviewUrl(localPreview);
    } catch {
      setPhotoPreviewUrl(null);
    }
  }

  async function saveSignupDraft(email: string, data: DraftPayload) {
    const existingDraftQuery = await supabase
      .from("signup_drafts")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingDraftQuery.error) {
      throw existingDraftQuery.error;
    }

    if (existingDraftQuery.data?.id) {
      const updateResult = await supabase
        .from("signup_drafts")
        .update({
          data,
        })
        .eq("id", existingDraftQuery.data.id);

      if (updateResult.error) {
        throw updateResult.error;
      }

      return;
    }

    const insertResult = await supabase.from("signup_drafts").insert({
      email,
      data,
    });

    if (insertResult.error) {
      throw insertResult.error;
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (step < totalSteps) {
      if (!canGoNext(step)) {
        setErrorMsg("Please complete this step before continuing.");
        return;
      }

      setStep((prev) => prev + 1);
      return;
    }

    if (!form.city || !form.dobMonth || !form.dobDay || !form.dobYear) {
      setErrorMsg("Please share your city and date of birth.");
      return;
    }

    const dobString = buildDobString(form.dobMonth, form.dobDay, form.dobYear);
    const ageRange = computeAgeRangeFromDob(dobString);

    if (!ageRange) {
      setErrorMsg(
        `You must be between ${MINIMUM_AGE} and ${MAXIMUM_AGE} years old to join pods.`
      );
      return;
    }

    if (!selectedPhotoFile) {
      setErrorMsg("Please upload a profile photo before continuing.");
      return;
    }

    if (hasSentLink && resendCountdown > 0) {
      setSuccessMsg(
        `We already sent your login link. You can resend it in ${resendCountdown} seconds.`
      );
      return;
    }

    setIsSaving(true);

    let uploadedFilePath: string | null = null;

    try {
      const email = form.email.trim().toLowerCase();

      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/auth/callback?next=/pods`
          : undefined;

      const ext = getFileExtension(selectedPhotoFile.name);
      const safeEmailSlug = email.replace(/[^a-z0-9]/gi, "_").toLowerCase();
      const filePath = `temp/${safeEmailSlug}/${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.${ext}`;

      uploadedFilePath = filePath;

      const { error: uploadError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(filePath, selectedPhotoFile, {
          cacheControl: "3600",
          upsert: false,
        });

      if (uploadError) {
        console.error("PHOTO UPLOAD ERROR", uploadError);
        setErrorMsg(
          uploadError.message || "Could not upload your photo. Please try again."
        );
        return;
      }

      const draftPayload: DraftPayload = {
        first_name: form.firstName.trim(),
        email,
        gender: form.gender,
        interested_in: form.interestedIn,
        city: form.city,
        date_of_birth: dobString,
        age_range: ageRange,
        photo_path: filePath,
        photo_file_name: form.photoFileName || null,
      };

      try {
        await saveSignupDraft(email, draftPayload);
      } catch (draftError) {
        console.error("DRAFT SAVE ERROR", draftError);

        if (uploadedFilePath) {
          const { error: removeUploadError } = await supabase.storage
            .from(PHOTO_BUCKET)
            .remove([uploadedFilePath]);

          if (removeUploadError) {
            console.error("PHOTO CLEANUP ERROR", removeUploadError);
          }
        }

        setErrorMsg(
          getFriendlyErrorMessage(
            draftError,
            "Could not save your info. Please try again."
          )
        );
        return;
      }

      const { error: magicError } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: true,
        },
      });

      if (magicError) {
        console.error("MAGIC LINK ERROR", magicError);

        if (isOtpCooldownMessage(magicError.message)) {
          setHasSentLink(true);
          setResendCountdown(RESEND_COOLDOWN_SECONDS);
          setSuccessMsg(
            "We already sent your login link. Please check your email, or resend in about a minute."
          );
          return;
        }

        setErrorMsg(
          magicError.message || "Could not send your login link. Please try again."
        );
        return;
      }

      setHasSentLink(true);
      setResendCountdown(RESEND_COOLDOWN_SECONDS);
      setSuccessMsg(
        "Check your email — your login link will take you straight into the pod lobby."
      );
    } catch (error) {
      console.error("SIGNUP ERROR", error);
      setErrorMsg(
        getFriendlyErrorMessage(
          error,
          "Something went wrong. Please try again."
        )
      );
    } finally {
      setIsSaving(false);
    }
  }

  const stepLabel =
    step === 1
      ? "Before you join tonight’s pod"
      : step === 2
      ? "How should we match you?"
      : "Where are you & how old are you?";

  const submitLabel =
    step < totalSteps
      ? "Next"
      : isSaving
      ? "Sending link…"
      : hasSentLink && resendCountdown > 0
      ? `Resend in ${resendCountdown}s`
      : hasSentLink
      ? "Resend link"
      : "Finish & Continue";

  const isSubmitDisabled =
    isSaving || (step === totalSteps && hasSentLink && resendCountdown > 0);

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-black px-4 py-8 text-white md:py-12"
      style={{
        background:
          "radial-gradient(circle at top, #1a1024 0%, #05030a 55%, #020106 100%)",
      }}
    >
      <div className="w-full max-w-md md:max-w-lg">
        <div className="mb-3 text-center text-[10px] uppercase tracking-[0.35em] text-pink-400 md:mb-4 md:text-xs">
          THEPODS
        </div>

        <h1 className="mb-2 text-center text-base font-semibold sm:text-lg md:text-4xl">
          {stepLabel}
        </h1>

        <p className="mb-6 text-center text-[12px] text-zinc-400 md:mb-8 md:text-sm">
          Just a few details so we can match you better. This is only for matching
          and won&apos;t be shown in the pod.
        </p>

        <form
          onSubmit={handleSubmit}
          className="space-y-5 rounded-3xl border border-zinc-800 bg-zinc-900/90 p-5 shadow-[0_0_40px_rgba(255,20,147,0.25)] md:space-y-6 md:p-8"
        >
          <div className="mb-2 flex items-center justify-center gap-3 md:mb-4">
            {Array.from({ length: totalSteps }).map((_, i) => {
              const dotStep = i + 1;
              const isActive = dotStep === step;
              const isDone = dotStep < step;

              return (
                <span
                  key={dotStep}
                  className={`h-1.5 rounded-full transition-all ${
                    isActive
                      ? "w-8 bg-pink-400"
                      : isDone
                      ? "w-6 bg-pink-500/60"
                      : "w-4 bg-zinc-700"
                  }`}
                />
              );
            })}
          </div>

          {step === 1 && (
            <div className="space-y-4 md:space-y-5">
              <div className="space-y-1">
                <label
                  htmlFor="firstName"
                  className="text-[13px] text-zinc-300 md:text-sm"
                >
                  First name
                </label>
                <input
                  id="firstName"
                  type="text"
                  value={form.firstName}
                  onChange={(e) => updateField("firstName", e.target.value)}
                  placeholder="Alex"
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                />
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="email"
                  className="text-[13px] text-zinc-300 md:text-sm"
                >
                  Email (for account + safety only)
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  value={form.email}
                  onChange={(e) => updateField("email", e.target.value)}
                  placeholder="you@example.com"
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                />
                <p className="text-[11px] text-zinc-500">
                  We won&apos;t show this in the pod.
                </p>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4 md:space-y-5">
              <div className="space-y-1">
                <label
                  htmlFor="gender"
                  className="text-[13px] text-zinc-300 md:text-sm"
                >
                  I am a…
                </label>
                <select
                  id="gender"
                  value={form.gender}
                  onChange={(e) => updateField("gender", e.target.value)}
                  required
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                >
                  <option value="">Select one</option>
                  <option value="woman">Woman</option>
                  <option value="man">Man</option>
                  <option value="non-binary">Non-binary</option>
                  <option value="other">Prefer to self-describe / other</option>
                </select>
              </div>

              <div className="space-y-1">
                <label
                  htmlFor="interestedIn"
                  className="text-[13px] text-zinc-300 md:text-sm"
                >
                  I want to meet…
                </label>
                <select
                  id="interestedIn"
                  value={form.interestedIn}
                  onChange={(e) => updateField("interestedIn", e.target.value)}
                  required
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                >
                  <option value="">Select one</option>
                  <option value="women">Women</option>
                  <option value="men">Men</option>
                  <option value="everyone">Everyone</option>
                </select>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 md:space-y-5">
              <div className="space-y-1">
                <label
                  htmlFor="city"
                  className="text-[13px] text-zinc-300 md:text-sm"
                >
                  City
                </label>
                <select
                  id="city"
                  value={form.city}
                  onChange={(e) => updateField("city", e.target.value)}
                  required
                  className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                >
                  <option value="">Select city</option>
                  <option value="Los Angeles">Los Angeles</option>
                  <option value="New York City">New York City</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-[13px] text-zinc-300 md:text-sm">
                  Date of birth
                </label>

                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={form.dobMonth}
                    onChange={(e) => updateField("dobMonth", e.target.value)}
                    required
                    className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                  >
                    <option value="">Month</option>
                    {MONTHS.map((month) => (
                      <option key={month.value} value={month.value}>
                        {month.label}
                      </option>
                    ))}
                  </select>

                  <select
                    value={form.dobDay}
                    onChange={(e) => updateField("dobDay", e.target.value)}
                    required
                    className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                  >
                    <option value="">Day</option>
                    {days.map((day) => (
                      <option key={day} value={day}>
                        {day}
                      </option>
                    ))}
                  </select>

                  <select
                    value={form.dobYear}
                    onChange={(e) => updateField("dobYear", e.target.value)}
                    required
                    className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-[13px] outline-none focus:border-pink-500 md:text-sm"
                  >
                    <option value="">Year</option>
                    {years.map((year) => (
                      <option key={year} value={year}>
                        {year}
                      </option>
                    ))}
                  </select>
                </div>

                <p className="text-[11px] text-zinc-500">
                  You must be between {MINIMUM_AGE} and {MAXIMUM_AGE} to join pods.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-[13px] text-zinc-300 md:text-sm">
                  Add a profile photo <span className="text-pink-400">*</span>
                </label>

                <input
                  id="profilePhoto"
                  type="file"
                  accept="image/*"
                  onChange={handlePhotoChange}
                  className="sr-only"
                  required
                />

                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="profilePhoto"
                    className="inline-flex w-fit cursor-pointer items-center justify-center rounded-full bg-pink-500 px-3 py-1.5 text-[10px] font-semibold text-white shadow-[0_0_12px_rgba(255,20,147,0.35)] transition hover:bg-pink-400 md:text-xs"
                  >
                    Choose File
                  </label>

                  {form.photoFileName && (
                    <p className="break-all text-[11px] text-zinc-400">
                      {form.photoFileName}
                    </p>
                  )}
                </div>

                {!form.photoFileName && (
                  <p className="text-[11px] text-red-400">
                    A profile photo is required to join pods.
                  </p>
                )}

                <div className="mt-3 flex min-h-[50px] items-center gap-3">
                  {photoPreviewUrl ? (
                    <>
                      <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-zinc-700">
                        <img
                          src={photoPreviewUrl}
                          alt="Preview"
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <p className="text-[11px] text-zinc-400">
                        Looks great! This photo will show on your match reveal.
                      </p>
                    </>
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-700 bg-zinc-800 text-[10px] text-zinc-500">
                      No photo
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {errorMsg && (
            <p className="mt-1 text-[11px] text-red-300 md:text-xs">
              {errorMsg}
            </p>
          )}

          {successMsg && (
            <div className="rounded-2xl border border-emerald-500/30 bg-emerald-900/20 px-4 py-3">
              <p className="text-[11px] text-emerald-300 md:text-xs">
                {successMsg}
              </p>
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            {step > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setErrorMsg(null);
                  setSuccessMsg(null);
                  setStep((prev) => Math.max(1, prev - 1));
                }}
                className="text-[11px] text-zinc-400 hover:text-zinc-200 md:text-xs"
              >
                ← Back
              </button>
            ) : (
              <span />
            )}

            <button
              type="submit"
              disabled={isSubmitDisabled}
              className="rounded-full bg-pink-500 px-4 py-2 text-[11px] font-semibold leading-snug tracking-tight shadow-[0_0_18px_rgba(255,20,147,0.45)] transition hover:bg-pink-400 focus:outline-none focus:ring-2 focus:ring-pink-300/50 disabled:opacity-40 md:px-6 md:py-2.5 md:text-sm"
            >
              {submitLabel}
            </button>
          </div>
        </form>

        <p className="mt-5 text-center text-[11px] text-zinc-500 md:mt-6 md:text-xs">
          Finish your profile, then we&apos;ll send a magic link so you can jump
          right into pods.
        </p>
      </div>
    </main>
  );
}