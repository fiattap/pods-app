"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

export type AuthProfile = {
  id: string;
  first_name: string | null;
  city: string | null;
};

type AuthStatus = "loading" | "signed_in" | "signed_out";

type AuthContextValue = {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  profile: AuthProfile | null;
  /** Re-fetch the profile (e.g. after the user updates their first name or city). */
  refreshProfile: () => Promise<AuthProfile | null>;
  /** Force a fresh `supabase.auth.getUser()` round-trip. Useful after a recoverable error. */
  refreshSession: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchProfile(userId: string): Promise<AuthProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, first_name, city")
    .eq("id", userId)
    .maybeSingle<AuthProfile>();

  if (error) {
    // Surface but don't throw — the rest of the app can still run without a profile.
    console.error("[AuthProvider] failed to load profile", error);
    return null;
  }

  return data ?? null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AuthProfile | null>(null);

  // Single in-flight profile fetch guard so rapid auth events don't stampede.
  const profileLoadRef = useRef<Promise<AuthProfile | null> | null>(null);

  const loadProfile = useCallback(
    async (userId: string): Promise<AuthProfile | null> => {
      if (profileLoadRef.current) {
        return profileLoadRef.current;
      }

      const pending = fetchProfile(userId).finally(() => {
        profileLoadRef.current = null;
      });

      profileLoadRef.current = pending;
      const next = await pending;
      setProfile(next);
      return next;
    },
    []
  );

  const applySession = useCallback(
    async (nextSession: Session | null) => {
      if (!nextSession?.user) {
        setUser(null);
        setSession(null);
        setProfile(null);
        setStatus("signed_out");
        return;
      }

      setUser(nextSession.user);
      setSession(nextSession);
      setStatus("signed_in");
      await loadProfile(nextSession.user.id);
    },
    [loadProfile]
  );

  const refreshSession = useCallback(async () => {
    const {
      data: { session: fresh },
      error,
    } = await supabase.auth.getSession();

    if (error) {
      console.error("[AuthProvider] refreshSession error", error);
      await applySession(null);
      return;
    }

    await applySession(fresh ?? null);
  }, [applySession]);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return null;
    return loadProfile(user.id);
  }, [user, loadProfile]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    // onAuthStateChange will clear state, but be defensive in case the listener races.
    await applySession(null);
  }, [applySession]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const {
        data: { session: initialSession },
        error,
      } = await supabase.auth.getSession();

      if (cancelled) return;

      if (error) {
        console.error("[AuthProvider] initial getSession error", error);
        await applySession(null);
        return;
      }

      await applySession(initialSession ?? null);
    })();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (cancelled) return;
      void applySession(nextSession ?? null);
    });

    return () => {
      cancelled = true;
      subscription.unsubscribe();
    };
  }, [applySession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      session,
      profile,
      refreshProfile,
      refreshSession,
      signOut,
    }),
    [status, user, session, profile, refreshProfile, refreshSession, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Read auth/session/profile state. Must be used inside <AuthProvider />.
 *
 * Status values:
 *   - "loading": initial session fetch in flight
 *   - "signed_in": user is present (profile may still be null if the row doesn't exist yet)
 *   - "signed_out": no session
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider />.");
  }
  return ctx;
}
