export const TOTAL_ROUNDS = 3;
export const ROUND_CONVERSATION_SECONDS = 5 * 60;
export const ROUND_ENTRY_WINDOW_SECONDS = 60;
export const ROUND_RATING_SECONDS = 15;
// Spec: 15s rating + 60s lobby buffer between rounds = 75s total transition.
// Lobby buffer gives late-arriving users a window to sync up for the next round.
export const ROUND_LOBBY_BUFFER_SECONDS = 60;
export const ROUND_TRANSITION_SECONDS =
  ROUND_RATING_SECONDS + ROUND_LOBBY_BUFFER_SECONDS;
export const ROUND_TOTAL_SECONDS =
  ROUND_CONVERSATION_SECONDS + ROUND_TRANSITION_SECONDS;
export const PREOPEN_LOBBY_SECONDS = 5 * 60;
export const EVENT_START_HOUR = 20;
export const ALLOWED_POD_DAYS = ["Tuesday", "Thursday", "Sunday"] as const;
export const PODS_LAUNCH_AT = new Date("2026-05-31T20:00:00-04:00");
export const PODS_LAUNCH_LABEL = "Launch May 31 at 8PM ET";

export type PodCity = string | null | undefined;
export type AllowedPodDay = (typeof ALLOWED_POD_DAYS)[number];

export type CityTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type RoundTiming = {
  nowInSeconds: number;
  roundStartInSeconds: number;
  matchWindowEndInSeconds: number;
  roundEndInSeconds: number;
  roundStartAt: Date;
  matchWindowEndAt: Date;
  roundEndAt: Date;
  secondsUntilRoundStart: number;
  isBeforeRoundStart: boolean;
  isMatchWindowOpen: boolean;
  isAfterMatchWindow: boolean;
  isAfterRoundEnd: boolean;
};

export type RoundTimingDates = {
  now: Date;
  eventStartAt: Date;
  preopenLobbyStartAt: Date;
  roundStartAt: Date;
  matchWindowEndAt: Date;
  ratingEndsAt: Date;
  roundEndAt: Date;
};

export type PodPhase =
  | "preopen"
  | "live"
  | "rating"
  | "between_rounds"
  | "finished"
  | "closed";

export type PodPhaseState = {
  phase: PodPhase;
  currentRound: number | null;
  activeRound: number | null;
  canEnterRound: boolean;
  shouldGoToDone: boolean;
  secondsLeftInPhase: number | null;
  phaseEndsAt: Date | null;
  eventStartAt: Date | null;
  roundStartAt: Date | null;
  conversationEndsAt: Date | null;
  ratingEndsAt: Date | null;
  roundEndAt: Date | null;
  nextRoundOpensAt: Date | null;
  isOpenDay: boolean;
  isPreopen: boolean;
  isNightOver: boolean;
};

export type RoundEntryReason =
  | "not_open_day"
  | "round_not_started"
  | "entry_window_open"
  | "entry_window_closed"
  | "between_rounds"
  | "round_over"
  | "finished";

export type RoundEntryState = {
  podId: string;
  roundNumber: number;
  phase: PodPhase;
  canEnterRound: boolean;
  entryWindowOpen: boolean;
  secondsUntilRoundStart: number;
  secondsSinceRoundStart: number;
  secondsUntilRoundEnd: number;
  nextRound: number | null;
  shouldGoToDone: boolean;
  reason: RoundEntryReason;
  roundStartAt: Date;
  roundEndAt: Date;
};

export function normalizeCity(city: PodCity) {
  if (!city) return "LA";

  const normalized = city.trim().toLowerCase();

  if (
    normalized === "nyc" ||
    normalized === "new york" ||
    normalized === "new york city"
  ) {
    return "NYC";
  }

  if (normalized === "la" || normalized === "los angeles") {
    return "LA";
  }

  return "LA";
}

export function getTimeZone(city: PodCity) {
  return normalizeCity(city) === "NYC"
    ? "America/New_York"
    : "America/Los_Angeles";
}

export function getDebugOffsetMinutes() {
  const raw = Number(process.env.NEXT_PUBLIC_PODS_DEBUG_OFFSET_MINUTES || 0);
  return Number.isFinite(raw) ? raw : 0;
}

export function getDebugModePhaseShiftMinutes() {
  const raw = Number(
    process.env.NEXT_PUBLIC_PODS_DEBUG_PHASE_SHIFT_MINUTES || 0
  );
  return Number.isFinite(raw) ? raw : 0;
}

export function isDebugMode() {
  return getDebugOffsetMinutes() !== 0;
}

export function getDebugAdjustedNow() {
  const offset = getDebugOffsetMinutes();
  const phaseShift = offset !== 0 ? getDebugModePhaseShiftMinutes() : 0;

  return new Date(Date.now() + (offset + phaseShift) * 60 * 1000);
}

export function getCityTimeParts(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
): CityTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: getTimeZone(city),
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(at);

  const getPart = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: getPart("year"),
    month: getPart("month"),
    day: getPart("day"),
    hour: getPart("hour"),
    minute: getPart("minute"),
    second: getPart("second"),
  };
}

export function getCityWeekday(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const timeZone = getTimeZone(city);

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
  }).formatToParts(at);

  const weekday = parts.find((p) => p.type === "weekday")?.value;

  return weekday ?? "Tuesday";
}

export function isPodsOpenDay(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const weekday = getCityWeekday(city, at);
  return ALLOWED_POD_DAYS.includes(weekday as AllowedPodDay);
}

export function getNextPodOpenLabel(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const { hour } = getCityTimeParts(city, at);
  const currentWeekday = getCityWeekday(city, at);

  const weekdayOrder = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ] as const;

  const currentIndex = weekdayOrder.indexOf(
    currentWeekday as (typeof weekdayOrder)[number]
  );

  for (let i = 0; i < 8; i += 1) {
    const candidateIndex = (currentIndex + i + weekdayOrder.length) % 7;
    const candidateWeekday = weekdayOrder[candidateIndex];

    if (!ALLOWED_POD_DAYS.includes(candidateWeekday as AllowedPodDay)) {
      continue;
    }

    if (i === 0 && hour >= EVENT_START_HOUR) {
      continue;
    }

    return `${candidateWeekday} at 8:00 PM`;
  }

  return "Tuesday at 8:00 PM";
}

export function getPodIdForCurrentSession(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const normalizedCity = normalizeCity(city);
  const { year, month, day } = getCityTimeParts(normalizedCity, at);
  const formattedMonth = String(month).padStart(2, "0");
  const formattedDay = String(day).padStart(2, "0");

  return `pods_${normalizedCity.toLowerCase()}_${year}-${formattedMonth}-${formattedDay}`;
}

export function getSecondsUntilStart(city: PodCity) {
  const { hour, minute, second } = getCityTimeParts(city);
  const nowInSeconds = hour * 3600 + minute * 60 + second;
  const startInSeconds = EVENT_START_HOUR * 3600;

  return Math.max(startInSeconds - nowInSeconds, 0);
}

export function getNightEndSeconds() {
  return EVENT_START_HOUR * 3600 + TOTAL_ROUNDS * ROUND_TOTAL_SECONDS;
}

export function isPodNightOver(city: string | null) {
  const phaseState = getPodPhaseState(city);
  return phaseState.isNightOver;
}

export function formatCountdown(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function formatLaunchCountdown(targetDate: Date) {
  const diffMs = targetDate.getTime() - getDebugAdjustedNow().getTime();
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));

  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

export function getPodsSessionStorageRoundKey() {
  return `pods_latest_round:${getDebugAdjustedNow().toISOString().slice(0, 10)}`;
}

export function clampRound(round: number) {
  if (!Number.isFinite(round)) return 1;
  return Math.min(Math.max(Math.floor(round), 1), TOTAL_ROUNDS);
}

export function hasNightFinished(round: number) {
  return round > TOTAL_ROUNDS;
}

export function getRoundTiming(
  city: PodCity,
  roundNumber: number,
  at: Date = getDebugAdjustedNow()
): RoundTiming {
  const safeRound = clampRound(roundNumber);
  const roundTimingDates = getRoundTimingDates(city, safeRound, at);
  const { hour, minute, second } = getCityTimeParts(city, at);
  const nowInSeconds = hour * 3600 + minute * 60 + second;
  const eventStartHour = getEventStartHourForDate(city, at);
  const eventStartInSeconds = eventStartHour * 3600;
  const roundStartInSeconds =
    eventStartInSeconds + (safeRound - 1) * ROUND_TOTAL_SECONDS;
  const matchWindowEndInSeconds =
    roundStartInSeconds + ROUND_CONVERSATION_SECONDS;
  const roundEndInSeconds = roundStartInSeconds + ROUND_TOTAL_SECONDS;

  return {
    nowInSeconds,
    roundStartInSeconds,
    matchWindowEndInSeconds,
    roundEndInSeconds,
    roundStartAt: roundTimingDates.roundStartAt,
    matchWindowEndAt: roundTimingDates.matchWindowEndAt,
    roundEndAt: roundTimingDates.roundEndAt,
    secondsUntilRoundStart: Math.max(roundStartInSeconds - nowInSeconds, 0),
    isBeforeRoundStart: nowInSeconds < roundStartInSeconds,
    isMatchWindowOpen:
      nowInSeconds >= roundStartInSeconds &&
      nowInSeconds < matchWindowEndInSeconds,
    isAfterMatchWindow: nowInSeconds >= matchWindowEndInSeconds,
    isAfterRoundEnd: nowInSeconds >= roundEndInSeconds,
  };
}

export function isPreLaunch() {
  return getDebugAdjustedNow() < PODS_LAUNCH_AT;
}

export function getPreopenLobbySecondsLeft(city: PodCity) {
  const phaseState = getPodPhaseState(city);

  if (phaseState.phase === "preopen" && phaseState.secondsLeftInPhase != null) {
    return phaseState.secondsLeftInPhase;
  }

  return 0;
}

function getTimeZoneOffsetMinutes(timeZone: string, date: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });

  const zoneName =
    formatter
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")
      ?.value ?? "GMT";

  const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);

  if (!match) return 0;

  const sign = match[1] === "-" ? -1 : 1;
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3] ?? "0");

  return sign * (hours * 60 + minutes);
}

function getZonedDate(
  city: PodCity,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
) {
  const timeZone = getTimeZone(city);
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const firstOffset = getTimeZoneOffsetMinutes(timeZone, new Date(utcGuess));
  const adjustedUtc = utcGuess - firstOffset * 60 * 1000;
  const finalOffset = getTimeZoneOffsetMinutes(timeZone, new Date(adjustedUtc));

  return new Date(utcGuess - finalOffset * 60 * 1000);
}

function getWeekdayOrderIndex(weekday: string) {
  const weekdayOrder = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ] as const;

  return weekdayOrder.indexOf(weekday as (typeof weekdayOrder)[number]);
}

function getEventStartHourForWeekday(_weekday?: string) {
  void _weekday;
  return EVENT_START_HOUR;
}

function getEventStartHourForDate(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  void getCityWeekday(city, at);
  return getEventStartHourForWeekday();
}

export function getEventStartAt(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const { year, month, day } = getCityTimeParts(city, at);
  const eventStartHour = getEventStartHourForDate(city, at);

  return getZonedDate(city, year, month, day, eventStartHour, 0, 0);
}

export function getPreopenLobbyStartAt(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const eventStartAt = getEventStartAt(city, at);
  return new Date(eventStartAt.getTime() - PREOPEN_LOBBY_SECONDS * 1000);
}

export function getRoundTimingDates(
  city: PodCity,
  roundNumber: number,
  at: Date = getDebugAdjustedNow()
): RoundTimingDates {
  const safeRound = clampRound(roundNumber);
  const eventStartAt = getEventStartAt(city, at);
  const roundStartAt = new Date(
    eventStartAt.getTime() + (safeRound - 1) * ROUND_TOTAL_SECONDS * 1000
  );
  const matchWindowEndAt = new Date(
    roundStartAt.getTime() + ROUND_CONVERSATION_SECONDS * 1000
  );
  const ratingEndsAt = new Date(
    matchWindowEndAt.getTime() + ROUND_RATING_SECONDS * 1000
  );
  const roundEndAt = new Date(
    roundStartAt.getTime() + ROUND_TOTAL_SECONDS * 1000
  );

  return {
    now: at,
    eventStartAt,
    preopenLobbyStartAt: new Date(
      eventStartAt.getTime() - PREOPEN_LOBBY_SECONDS * 1000
    ),
    roundStartAt,
    matchWindowEndAt,
    ratingEndsAt,
    roundEndAt,
  };
}

export function getRoundEntryState(
  city: PodCity,
  roundNumber: number,
  at: Date = getDebugAdjustedNow()
): RoundEntryState {
  const safeRound = clampRound(roundNumber);
  const timing = getRoundTimingDates(city, safeRound, at);
  const podId = getPodIdForCurrentSession(city, at);
  const secondsUntilRoundStart = Math.max(
    0,
    Math.floor((timing.roundStartAt.getTime() - at.getTime()) / 1000)
  );
  const secondsSinceRoundStart = Math.max(
    0,
    Math.floor((at.getTime() - timing.roundStartAt.getTime()) / 1000)
  );
  const secondsUntilRoundEnd = Math.max(
    0,
    Math.floor((timing.roundEndAt.getTime() - at.getTime()) / 1000)
  );

  const baseState = {
    podId,
    roundNumber: safeRound,
    secondsUntilRoundStart,
    secondsSinceRoundStart,
    secondsUntilRoundEnd,
    roundStartAt: timing.roundStartAt,
    roundEndAt: timing.roundEndAt,
  };

  if (!isPodsOpenDay(city, at)) {
    return {
      ...baseState,
      phase: "closed",
      canEnterRound: false,
      entryWindowOpen: false,
      nextRound: null,
      shouldGoToDone: false,
      reason: "not_open_day",
    };
  }

  const finalRoundTiming = getRoundTimingDates(city, TOTAL_ROUNDS, at);

  if (at >= finalRoundTiming.roundEndAt) {
    return {
      ...baseState,
      phase: "finished",
      canEnterRound: false,
      entryWindowOpen: false,
      nextRound: null,
      shouldGoToDone: true,
      reason: "finished",
    };
  }

  if (at < timing.roundStartAt) {
    return {
      ...baseState,
      phase: "preopen",
      canEnterRound: false,
      entryWindowOpen: false,
      nextRound: safeRound,
      shouldGoToDone: false,
      reason: "round_not_started",
    };
  }

  if (at < timing.roundEndAt) {
    const entryWindowOpen =
      secondsSinceRoundStart <= ROUND_ENTRY_WINDOW_SECONDS;

    return {
      ...baseState,
      phase: "live",
      canEnterRound: entryWindowOpen,
      entryWindowOpen,
      nextRound: safeRound < TOTAL_ROUNDS ? safeRound + 1 : null,
      shouldGoToDone: false,
      reason: entryWindowOpen ? "entry_window_open" : "entry_window_closed",
    };
  }

  if (safeRound >= TOTAL_ROUNDS) {
    return {
      ...baseState,
      phase: "finished",
      canEnterRound: false,
      entryWindowOpen: false,
      nextRound: null,
      shouldGoToDone: true,
      reason: "finished",
    };
  }

  const nextRound = safeRound + 1;
  const nextRoundTiming = getRoundTimingDates(city, nextRound, at);

  return {
    ...baseState,
    phase: "between_rounds",
    canEnterRound: false,
    entryWindowOpen: false,
    nextRound,
    shouldGoToDone: false,
    reason: at < nextRoundTiming.roundStartAt ? "between_rounds" : "round_over",
  };
}

function getSecondsUntil(
  targetAt: Date | null,
  at: Date = getDebugAdjustedNow()
) {
  if (!targetAt) return null;

  return Math.max(0, Math.floor((targetAt.getTime() - at.getTime()) / 1000));
}

export function getPodPhaseState(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
): PodPhaseState {
  const isOpenDay = isPodsOpenDay(city, at);

  if (!isOpenDay) {
    return {
      phase: "closed",
      currentRound: null,
      activeRound: null,
      canEnterRound: false,
      shouldGoToDone: false,
      secondsLeftInPhase: null,
      phaseEndsAt: null,
      eventStartAt: null,
      roundStartAt: null,
      conversationEndsAt: null,
      ratingEndsAt: null,
      roundEndAt: null,
      nextRoundOpensAt: null,
      isOpenDay: false,
      isPreopen: false,
      isNightOver: false,
    };
  }

  const eventStartAt = getEventStartAt(city, at);
  const preopenLobbyStartAt = getPreopenLobbyStartAt(city, at);

  if (at < preopenLobbyStartAt) {
    return {
      phase: "closed",
      currentRound: null,
      activeRound: null,
      canEnterRound: false,
      shouldGoToDone: false,
      secondsLeftInPhase: getSecondsUntil(preopenLobbyStartAt, at),
      phaseEndsAt: preopenLobbyStartAt,
      eventStartAt,
      roundStartAt: null,
      conversationEndsAt: null,
      ratingEndsAt: null,
      roundEndAt: null,
      nextRoundOpensAt: eventStartAt,
      isOpenDay: true,
      isPreopen: false,
      isNightOver: false,
    };
  }

  const firstRound = getRoundTimingDates(city, 1, at);

  if (at < firstRound.roundStartAt) {
    return {
      phase: "preopen",
      currentRound: 1,
      activeRound: 1,
      canEnterRound: false,
      shouldGoToDone: false,
      secondsLeftInPhase: getSecondsUntil(firstRound.roundStartAt, at),
      phaseEndsAt: firstRound.roundStartAt,
      eventStartAt,
      roundStartAt: firstRound.roundStartAt,
      conversationEndsAt: firstRound.matchWindowEndAt,
      ratingEndsAt: firstRound.ratingEndsAt,
      roundEndAt: firstRound.roundEndAt,
      nextRoundOpensAt: firstRound.roundStartAt,
      isOpenDay: true,
      isPreopen: true,
      isNightOver: false,
    };
  }

  for (let round = 1; round <= TOTAL_ROUNDS; round += 1) {
    const timing = getRoundTimingDates(city, round, at);

    if (at < timing.matchWindowEndAt) {
      return {
        phase: "live",
        currentRound: round,
        activeRound: round,
        canEnterRound: true,
        shouldGoToDone: false,
        secondsLeftInPhase: getSecondsUntil(timing.matchWindowEndAt, at),
        phaseEndsAt: timing.matchWindowEndAt,
        eventStartAt,
        roundStartAt: timing.roundStartAt,
        conversationEndsAt: timing.matchWindowEndAt,
        ratingEndsAt: timing.ratingEndsAt,
        roundEndAt: timing.roundEndAt,
        nextRoundOpensAt:
          round < TOTAL_ROUNDS
            ? getRoundTimingDates(city, round + 1, at).roundStartAt
            : null,
        isOpenDay: true,
        isPreopen: false,
        isNightOver: false,
      };
    }

    if (at < timing.ratingEndsAt) {
      return {
        phase: "rating",
        currentRound: round,
        activeRound: round,
        canEnterRound: false,
        shouldGoToDone: false,
        secondsLeftInPhase: getSecondsUntil(timing.ratingEndsAt, at),
        phaseEndsAt: timing.ratingEndsAt,
        eventStartAt,
        roundStartAt: timing.roundStartAt,
        conversationEndsAt: timing.matchWindowEndAt,
        ratingEndsAt: timing.ratingEndsAt,
        roundEndAt: timing.roundEndAt,
        nextRoundOpensAt:
          round < TOTAL_ROUNDS
            ? getRoundTimingDates(city, round + 1, at).roundStartAt
            : null,
        isOpenDay: true,
        isPreopen: false,
        isNightOver: false,
      };
    }

    if (round < TOTAL_ROUNDS) {
      const nextRoundTiming = getRoundTimingDates(city, round + 1, at);

      if (at < nextRoundTiming.roundStartAt) {
        return {
          phase: "between_rounds",
          currentRound: round + 1,
          activeRound: round,
          canEnterRound: false,
          shouldGoToDone: false,
          secondsLeftInPhase: getSecondsUntil(nextRoundTiming.roundStartAt, at),
          phaseEndsAt: nextRoundTiming.roundStartAt,
          eventStartAt,
          roundStartAt: nextRoundTiming.roundStartAt,
          conversationEndsAt: nextRoundTiming.matchWindowEndAt,
          ratingEndsAt: nextRoundTiming.ratingEndsAt,
          roundEndAt: nextRoundTiming.roundEndAt,
          nextRoundOpensAt: nextRoundTiming.roundStartAt,
          isOpenDay: true,
          isPreopen: false,
          isNightOver: false,
        };
      }

      continue;
    }

    if (at < timing.roundEndAt) {
      return {
        phase: "finished",
        currentRound: round,
        activeRound: round,
        canEnterRound: false,
        shouldGoToDone: at >= timing.roundEndAt,
        secondsLeftInPhase: getSecondsUntil(timing.roundEndAt, at),
        phaseEndsAt: timing.roundEndAt,
        eventStartAt,
        roundStartAt: timing.roundStartAt,
        conversationEndsAt: timing.matchWindowEndAt,
        ratingEndsAt: timing.ratingEndsAt,
        roundEndAt: timing.roundEndAt,
        nextRoundOpensAt: null,
        isOpenDay: true,
        isPreopen: false,
        isNightOver: false,
      };
    }
  }

  const finalRound = getRoundTimingDates(city, TOTAL_ROUNDS, at);

  return {
    phase: "finished",
    currentRound: TOTAL_ROUNDS,
    activeRound: TOTAL_ROUNDS,
    canEnterRound: false,
    shouldGoToDone: true,
    secondsLeftInPhase: 0,
    phaseEndsAt: null,
    eventStartAt,
    roundStartAt: finalRound.roundStartAt,
    conversationEndsAt: finalRound.matchWindowEndAt,
    ratingEndsAt: finalRound.ratingEndsAt,
    roundEndAt: finalRound.roundEndAt,
    nextRoundOpensAt: null,
    isOpenDay: true,
    isPreopen: false,
    isNightOver: true,
  };
}

export function getCurrentRoundForNow(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const phaseState = getPodPhaseState(city, at);

  if (phaseState.currentRound != null) {
    return phaseState.currentRound;
  }

  return 1;
}

export function getCurrentLobbyRoundForNow(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const phaseState = getPodPhaseState(city, at);

  if (phaseState.phase === "between_rounds" && phaseState.currentRound != null) {
    return phaseState.currentRound;
  }

  if (phaseState.currentRound != null) {
    return phaseState.currentRound;
  }

  return 1;
}

export function getNextPodOpenAt(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const now = at;
  const currentWeekday = getCityWeekday(city, now);
  const currentIndex = getWeekdayOrderIndex(currentWeekday);

  const weekdayOrder = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ] as const;

  for (let i = 0; i < 8; i += 1) {
    const candidateDate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const candidateWeekday = weekdayOrder[(currentIndex + i) % 7];

    if (!ALLOWED_POD_DAYS.includes(candidateWeekday as AllowedPodDay)) {
      continue;
    }

    const { year, month, day } = getCityTimeParts(city, candidateDate);
    const candidateHour = getEventStartHourForWeekday(candidateWeekday);

    const candidateOpenAt = getZonedDate(
      city,
      year,
      month,
      day,
      candidateHour,
      0,
      0
    );

    if (candidateOpenAt.getTime() > now.getTime()) {
      return candidateOpenAt;
    }
  }

  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

export function getSecondsUntilNextPodOpen(
  city: PodCity,
  at: Date = getDebugAdjustedNow()
) {
  const nextOpenAt = getNextPodOpenAt(city, at);

  return Math.max(
    0,
    Math.floor((nextOpenAt.getTime() - at.getTime()) / 1000)
  );
}
