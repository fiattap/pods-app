"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase/client";

function getUserWithTimeout(timeoutMs: number) {
  return Promise.race([
    supabase.auth.getUser(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("GET_USER_TIMEOUT")), timeoutMs)
    ),
  ]);
}

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/pods";

  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkSession() {
      for (let attempt = 1; attempt <= 4; attempt++) {
        console.log("[login] auth restore attempt", { attempt });

        try {
          const {
            data: { user },
            error,
          } = await getUserWithTimeout(800);

          if (cancelled) return;

          if (user) {
            console.log("[login] session found, routing to next", {
              userId: user.id,
              next,
            });

            router.replace(next);
            return;
          }

          if (error) {
            console.warn("[login] auth restore attempt failed", {
              attempt,
              error,
            });
          }
        } catch (error) {
          if (cancelled) return;
          console.warn("[login] auth restore attempt failed", { attempt, error });
        }

        if (attempt < 4) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      console.warn("[login] no session after retries, showing login UI");

      if (!cancelled) {
        setIsLoading(false);
      }
    }

    void checkSession();

    return () => {
      cancelled = true;
    };
  }, [next, router]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) {
        console.log("[login] auth state changed, routing to next", { next });
        router.replace(next);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, [next, router]);

  useEffect(() => {
    const error = searchParams.get("error");

    if (!error) return;

    if (error === "missing_auth_code") {
      setErrorMsg("Your login link was incomplete. Please request a new one.");
      return;
    }

    if (error === "auth_callback_failed") {
      setErrorMsg("Your login link expired or failed. Please request a new one.");
      return;
    }

    if (error === "user_not_found") {
      setErrorMsg("We couldn’t find your account. Please try again.");
      return;
    }

    setErrorMsg("Could not log you in. Please try again.");
  }, [searchParams]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setMessage(null);

    try {
      const cleanEmail = email.trim().toLowerCase();

      const redirectTo =
        typeof window !== "undefined"
          ? `${window.location.origin}/auth/callback?next=${encodeURIComponent(
              next
            )}`
          : undefined;

      const { error } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          emailRedirectTo: redirectTo,
          shouldCreateUser: true,
        },
      });

      if (error) {
        console.error("LOGIN MAGIC LINK ERROR", error);
        setErrorMsg(error.message || "Could not send login link.");
        return;
      }

      setMessage("Check your email for your login link.");
    } catch (error) {
      console.error("LOGIN SUBMIT ERROR", error);
      setErrorMsg("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  if (isLoading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-black text-white">
        <p className="text-zinc-400">Loading...</p>
      </main>
    );
  }

  return (
    <main
      className="min-h-screen flex items-center justify-center bg-black px-4 py-8 text-white"
      style={{
        background:
          "radial-gradient(circle at top, #1a1024 0%, #05030a 55%, #020106 100%)",
      }}
    >
      <div className="w-full max-w-md">
        <div className="mb-4 text-center text-[10px] uppercase tracking-[0.35em] text-pink-400">
          THEPODS
        </div>

        <div className="rounded-3xl border border-zinc-800 bg-zinc-900/90 p-6 shadow-[0_0_40px_rgba(255,20,147,0.18)]">
          <h1 className="mb-2 text-center text-2xl font-semibold">Log in</h1>

          <p className="mb-6 text-center text-sm text-zinc-400">
            Enter your email and we’ll send you a magic link.
          </p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <label htmlFor="email" className="text-sm text-zinc-300">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm outline-none focus:border-pink-500"
              />
            </div>

            {errorMsg && <p className="text-sm text-red-300">{errorMsg}</p>}

            {message && <p className="text-sm text-emerald-300">{message}</p>}

            <button
              type="submit"
              disabled={loading}
              className="block w-full rounded-2xl bg-pink-500 px-4 py-3 text-sm font-semibold text-white shadow-[0_0_26px_rgba(255,20,147,0.45)] transition hover:bg-pink-400 disabled:opacity-40"
            >
              {loading ? "Sending..." : "Send Magic Link"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}

function LoginFallback() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-black text-white">
      <p className="text-zinc-400">Loading...</p>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginContent />
    </Suspense>
  );
}