"use client";

import Link from "next/link";
import React, { useEffect, useMemo, useState } from "react";

type PrimaryCTAProps = React.ComponentProps<"a"> & {
  children: React.ReactNode;
  disabled?: boolean;
};

// Launch is anchored to 8pm Eastern (NYC cohort opens first; LA cohort still
// has its own 8pm PT pod that day, but the global "we're live" moment is when
// the first cohort goes live). Once this passes, the banner switches from
// "LAUNCHING …" to the rolling "NEXT POD — [day]" countdown.
const PODS_LAUNCH_AT = new Date("2026-05-31T20:00:00-04:00");
const PODS_LAUNCH_LABEL = "LAUNCHING MAY 31 · 8PM";
const PODS_TIME_ZONE = "America/Los_Angeles";
const EVENT_START_HOUR = 20;
const ALLOWED_POD_DAYS = ["Tuesday", "Thursday", "Sunday"] as const;

function PrimaryCTA({
  children,
  className = "",
  disabled = false,
  ...props
}: PrimaryCTAProps) {
  return (
    <a
      className={`w-full inline-flex items-center justify-center rounded-full bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold shadow-lg transition-all duration-150 px-6 py-3 text-base md:px-10 md:py-4 md:text-xl min-w-[180px] md:min-w-[260px] focus:outline-none focus:ring-2 focus:ring-fuchsia-400 focus:ring-offset-2 focus:ring-offset-black hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:pointer-events-none ${className}`}
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      {...props}
    >
      {children}
    </a>
  );
}

function getDebugAdjustedNow() {
  const debugOffsetMinutes = Number(
    process.env.NEXT_PUBLIC_PODS_DEBUG_OFFSET_MINUTES || 0
  );

  return new Date(Date.now() + debugOffsetMinutes * 60 * 1000);
}

function isPreLaunch(now: Date) {
  return now < PODS_LAUNCH_AT;
}

function getPodsTimeParts(now: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: PODS_TIME_ZONE,
    weekday: "long",
    hour12: false,
    hour: "2-digit",
  });

  const parts = formatter.formatToParts(now);

  const weekday =
    parts.find((part) => part.type === "weekday")?.value ?? "Tuesday";
  const hour = Number(
    parts.find((part) => part.type === "hour")?.value ?? "0"
  );

  return { weekday, hour };
}

function getNextPodBannerLabel(now: Date) {
  const { weekday, hour } = getPodsTimeParts(now);

  const weekdayOrder = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];

  const currentIndex = weekdayOrder.indexOf(weekday);

  for (let i = 0; i < 8; i += 1) {
    const candidateIndex = (currentIndex + i) % 7;
    const candidateWeekday = weekdayOrder[candidateIndex];

    if (
      !ALLOWED_POD_DAYS.includes(
        candidateWeekday as (typeof ALLOWED_POD_DAYS)[number]
      )
    ) {
      continue;
    }

    if (i === 0 && hour >= EVENT_START_HOUR) {
      continue;
    }

    return `NEXT POD — ${candidateWeekday.toUpperCase()} · 8PM`;
  }

  return "NEXT POD — TUESDAY · 8PM";
}

export default function HomePage() {
  const currentYear = new Date().getFullYear();
  const [openFAQ, setOpenFAQ] = useState<number | null>(null);
  const [now, setNow] = useState(() => getDebugAdjustedNow());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(getDebugAdjustedNow());
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  const prelaunch = useMemo(() => isPreLaunch(now), [now]);

  const bannerText = useMemo(() => {
    if (prelaunch) {
      return PODS_LAUNCH_LABEL;
    }

    return getNextPodBannerLabel(now);
  }, [now, prelaunch]);

  const faqs = [
    {
      q: "Who is this for?",
      a: "For people who value intentional connection over endless swiping. If you’re open, curious, and willing to show up for all three nights, this is for you. Must be 23+.",
    },
    {
      q: "How do the pods work?",
      a: "Each night, you join a private audio pod. You’ll meet new people, guided by prompts. No video, just voices.",
    },
    {
      q: "What if I miss a night?",
      a: "Missing 2 nights means you forfeit eligibility for Reveal Night. Try to attend all 3!",
    },
    {
      q: "Is this LGBTQ+ friendly?",
      a: "Absolutely. All gender identities and orientations are welcome.",
    },
    {
      q: "How do matches work?",
      a: "After each night, you’ll rank your connections. On Reveal Night, mutual matches are unlocked.",
    },
  ];

  return (
    <main
      className="min-h-screen bg-black text-white flex flex-col items-center justify-start scroll-smooth"
      style={{
        background:
          "radial-gradient(circle at top, #1a1024 0%, #05030a 55%, #020106 100%)",
      }}
    >
      <div className="w-full bg-gradient-to-r from-fuchsia-700/80 via-pink-700/80 to-indigo-700/80 py-2 text-center text-xs tracking-widest uppercase font-semibold text-white shadow-md border-b border-white/10">
        {bannerText}
      </div>

      <header className="w-full max-w-5xl mx-auto flex items-center justify-between px-4 pt-4 md:px-6 md:pt-6">
        <div className="text-[10px] md:text-xs tracking-[0.35em] text-pink-400 uppercase">
          THEPODS
        </div>
        <nav className="flex items-center gap-3 md:gap-6 text-[10px] md:text-sm text-zinc-300">
          <Link href="#how" className="hover:text-pink-300 transition">
            How it works
          </Link>
          <Link href="#safety" className="hover:text-pink-300 transition">
            Safety
          </Link>
          <Link
            href="/login"
            className="text-zinc-400 hover:text-white transition font-medium"
          >
            Log in
          </Link>
        </nav>
      </header>

      <section className="w-full max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-center gap-10 md:gap-12 px-4 md:px-6 md:mt-6 min-h-[calc(100vh-96px)] md:min-h-[calc(100vh-120px)]">
        <div className="max-w-xl text-center md:text-left">
          <p className="text-[10px] md:text-xs tracking-[0.35em] text-pink-400 mb-3 md:mb-4 mt-16 md:mt-0 uppercase">
            A BLIND DATING SOCIAL EXPERIMENT
          </p>

          <h1 className="text-[24px] leading-snug md:text-5xl md:leading-tight font-semibold mb-3 md:mb-4">
            Meet someone new,
            <br />
            one pod at a time.
          </h1>

          <p className="text-[12px] md:text-base text-zinc-400 mb-6 md:mb-8">
            A 3-night, live, guided pod experience. Join blind audio pods at 8pm,
            rank your connections, and unlock mutual matches on Reveal Night.
          </p>

          <div className="flex flex-col sm:flex-row items-center md:items-center gap-3 md:gap-4">
            <Link
              href="/signup"
              className="inline-flex items-center justify-center rounded-full px-6 py-2 md:px-8 md:py-3 text-[12px] md:text-sm font-semibold bg-pink-500 hover:bg-pink-400 transition shadow-[0_0_40px_rgba(255,20,147,0.7)]"
            >
              Reserve Your Spot
            </Link>

            <div className="text-[10px] md:text-xs text-zinc-500 max-w-xs text-center md:text-left">
              <p>
                <span className="text-zinc-300">NYC & LA Cohort</span> ·{" "}
                <span className="text-zinc-300">Tue, Thu & Sun</span> ·{" "}
                <span className="text-zinc-300">8:00 PM</span>
              </p>
            </div>
          </div>
        </div>

        <div className="relative flex items-center justify-center scale-[0.9] sm:scale-95 md:scale-110 mt-4 md:mt-0">
          <div
            className="absolute rounded-full animate-ping opacity-20 [animation-duration:3.5s]"
            style={{
              width: "260px",
              height: "260px",
              border: "2px solid rgba(255,255,255,0.07)",
            }}
          />
          <div
            className="absolute rounded-full animate-ping opacity-10 [animation-duration:4.5s]"
            style={{
              width: "330px",
              height: "330px",
              border: "2px solid rgba(255,255,255,0.04)",
            }}
          />

          <div
            className="relative rounded-full flex items-center justify-center shadow-[0_0_90px_rgba(255,20,147,0.45)] md:shadow-[0_0_90px_rgba(255,20,147,0.55)]"
            style={{
              width: "215px",
              height: "215px",
              background:
                "radial-gradient(circle, rgba(255,118,255,1) 0%, rgba(125,64,255,1) 100%)",
            }}
          >
            <div className="text-center">
              <div className="text-4xl md:text-5xl mb-2">🔊</div>
              <p className="text-[10px] md:text-xs tracking-[0.25em] uppercase text-white/80">
                LIVE PODS
              </p>
              <p className="text-[9px] md:text-[10px] text-white/70 mt-1">
                Quick rounds → deeper follow-ups
              </p>
            </div>
          </div>
        </div>
      </section>

      <section id="how" className="w-full border-t border-zinc-900 bg-black/60">
        <div className="max-w-5xl mx-auto px-6 py-12">
          <h2 className="text-center text-xl md:text-2xl font-semibold tracking-[0.22em] uppercase text-zinc-200">
            How it works
          </h2>

          <div className="mt-10 grid gap-8 md:grid-cols-3 text-center">
            {[
              { step: "Sign up" },
              { step: "Join live audio pods" },
              { step: "Reveal Night" },
            ].map((item, i) => (
              <div key={item.step} className="flex flex-col items-center">
                <div className="w-14 h-14 rounded-full border-2 border-fuchsia-500/80 flex items-center justify-center text-lg font-semibold text-zinc-200">
                  {i + 1}
                </div>
                <p className="mt-4 text-base md:text-lg text-zinc-200">
                  {item.step}
                </p>
                <div className="mt-6 h-[2px] w-16 bg-fuchsia-500/80" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="w-full border-t border-zinc-900 bg-black/60">
        <div className="px-6 py-12 md:py-20 max-w-5xl mx-auto">
          <h2 className="text-xl md:text-2xl font-semibold mb-8 text-center tracking-[0.22em] uppercase text-zinc-200">
            What you’ll get
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { title: "Curated cohorts", desc: "Small groups. Intentional matching." },
              { title: "Guided conversations", desc: "Prompts keep it easy and natural." },
              { title: "Mutual matches only", desc: "You’ll only connect if it’s mutual." },
            ].map(({ title, desc }) => (
              <div
                key={title}
                className="flex flex-col items-center bg-white/5 border border-white/10 rounded-2xl p-6 shadow-lg"
              >
                <div className="text-base md:text-lg font-semibold text-zinc-100 mb-2 text-center">
                  {title}
                </div>
                <div className="text-sm md:text-base text-zinc-400 text-center">
                  {desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="w-full border-t border-zinc-900 bg-black/60">
        <div className="px-6 py-12 md:py-20 max-w-5xl mx-auto">
          <h2 className="text-xl md:text-2xl font-semibold mb-8 text-center tracking-[0.22em] uppercase text-zinc-200">
            The 3 Nights
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              { title: "Night 1", subtitle: "Chemistry" },
              { title: "Night 2", subtitle: "Values" },
              { title: "Night 3", subtitle: "Reveal" },
            ].map(({ title, subtitle }) => (
              <div
                key={title}
                className="flex flex-col items-center bg-zinc-900/70 rounded-2xl p-6 shadow-lg border border-zinc-800"
              >
                <div className="text-lg font-bold text-fuchsia-400 mb-2 tracking-wide">
                  {title}
                </div>
                <div className="text-base md:text-lg text-zinc-200 font-medium text-center">
                  {subtitle}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="w-full border-t border-zinc-900 bg-black/60">
        <div className="px-6 py-12 md:py-20 max-w-5xl mx-auto">
          <h2 className="text-xl md:text-2xl font-semibold mb-6 text-center tracking-[0.22em] uppercase text-zinc-200">
            Commitment Policy
          </h2>
          <div className="bg-zinc-900/80 rounded-xl p-6 text-zinc-300 text-center text-base md:text-lg border border-zinc-800 shadow">
            If you attend all 3 nights, you become eligible for Reveal Night. Miss
            2 nights and you forfeit eligibility.
          </div>
        </div>
      </section>

      <section className="w-full border-t border-zinc-900 bg-black/60">
        <div className="px-6 py-12 md:py-20 max-w-5xl mx-auto">
          <h2 className="text-xl md:text-2xl font-semibold mb-8 text-center tracking-[0.22em] uppercase text-zinc-200">
            FAQ
          </h2>

          <div className="max-w-2xl mx-auto space-y-4">
            {faqs.map((faq, idx) => (
              <div
                key={faq.q}
                className="border border-zinc-800 rounded-lg bg-zinc-900/70 overflow-hidden"
              >
                <button
                  className="w-full flex justify-between items-center px-5 py-4 text-left focus:outline-none focus:ring-2 focus:ring-fuchsia-400 transition-colors"
                  onClick={() => setOpenFAQ(openFAQ === idx ? null : idx)}
                >
                  <span className="font-medium text-zinc-200 text-base md:text-lg">
                    {faq.q}
                  </span>
                  <span className="text-zinc-500">{openFAQ === idx ? "–" : "+"}</span>
                </button>
                <div
                  className={`px-5 pb-4 text-zinc-400 text-sm md:text-base ${
                    openFAQ === idx ? "block" : "hidden"
                  }`}
                >
                  {faq.a}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="w-full border-t border-zinc-900 bg-black/60">
        <div className="flex flex-col items-center justify-center px-6 py-16 md:py-24 max-w-5xl mx-auto">
          <PrimaryCTA href="/signup">Reserve Your Spot</PrimaryCTA>
        </div>
      </section>

      <footer
        id="safety"
        className="w-full border-t border-zinc-900 text-[11px] text-zinc-500"
      >
        <div className="max-w-5xl mx-auto px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <p>© {currentYear} THEPODS. All rights reserved.</p>
          <p className="text-zinc-600 text-center sm:text-right">
            Be kind. Report bad behavior, and remember you can leave any pod at
            any time.
          </p>
        </div>
      </footer>
    </main>
  );
}