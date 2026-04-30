import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  TOTAL_ROUNDS,
  PODS_LAUNCH_LABEL,
  getDebugAdjustedNow,
  getPodIdForCurrentSession,
  getPodPhaseState,
  getRoundEntryState,
  isPreLaunch,
  normalizeCity,
} from "@/lib/pods/timing";

type QueueStatus = "waiting" | "matched";

type PodQueueRow = {
  id: number;
  user_id: string;
  status: QueueStatus;
  room_id: string | null;
  round_number: number;
  pod_id: string | null;
  created_at: string;
};

type ProfileRow = {
  id: string;
  first_name: string | null;
  city: string | null;
  gender: string | null;
  interested_in: string | null;
  date_of_birth?: string | null;
  age_range?: string | null;
};

type PodRoomRow = {
  room_id: string;
  user_a_id: string;
  user_b_id: string;
  user_a_name?: string | null;
  user_b_name?: string | null;
  user_a_city?: string | null;
  user_b_city?: string | null;
  started_at?: string | null;
};

type PodMatchRow = {
  id?: number;
  user_a_id: string;
  user_b_id: string;
  room_id: string | null;
  round_number: number;
  pod_id: string | null;
};

type PodMatchParticipantRow = {
  pod_id: string;
  round_number: number;
  user_id: string;
  room_id: string | null;
};

type PodResultHistoryRow = {
  room_id: string;
  user_id: string;
  matched_user_id: string;
  outcome: string | null;
  rating: string | null;
  matched_user_rating: string | null;
  created_at: string | null;
};

type SortedUser = {
  queue: PodQueueRow;
  profile: ProfileRow;
};

type PairCandidate = {
  pairIndex: number;
  userAQueue: PodQueueRow;
  userAProfile: ProfileRow;
  userBQueue: PodQueueRow;
  userBProfile: ProfileRow;
};

const MIN_USERS_PER_ROUND = 2;
const REMATCH_COOLDOWN_DAYS = 30;

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

function normalizeGender(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (["man", "male", "m"].includes(normalized)) return "man";
  if (["woman", "female", "f"].includes(normalized)) return "woman";

  return normalized;
}

function normalizeInterestedIn(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (["men", "man", "male", "m"].includes(normalized)) return "men";
  if (["women", "woman", "female", "f"].includes(normalized)) return "women";
  if (["everyone", "both", "any", "all"].includes(normalized)) return "everyone";

  return normalized;
}

function isInterestedIn(
  targetGender: string | null | undefined,
  interestedIn: string | null | undefined
) {
  const normalizedTargetGender = normalizeGender(targetGender);
  const normalizedInterestedIn = normalizeInterestedIn(interestedIn);

  if (!normalizedTargetGender || !normalizedInterestedIn) return false;
  if (normalizedInterestedIn === "everyone") return true;
  if (normalizedInterestedIn === "men") return normalizedTargetGender === "man";
  if (normalizedInterestedIn === "women") return normalizedTargetGender === "woman";

  return false;
}

function getAgeFromDob(dateOfBirth: string | null | undefined) {
  if (!dateOfBirth) return null;

  const birthDate = new Date(dateOfBirth);
  if (Number.isNaN(birthDate.getTime())) return null;

  const today = getDebugAdjustedNow();

  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  const dayDiff = today.getDate() - birthDate.getDate();

  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function isAgeCompatible(currentUser: ProfileRow, candidateUser: ProfileRow) {
  const currentAge = getAgeFromDob(currentUser.date_of_birth);
  const candidateAge = getAgeFromDob(candidateUser.date_of_birth);

  if (!currentAge || !candidateAge) return false;

  const ageGap = Math.abs(currentAge - candidateAge);
  return ageGap <= 7;
}

function getAgeCompatibilityScore(currentUser: ProfileRow, candidateUser: ProfileRow) {
  const currentAge = getAgeFromDob(currentUser.date_of_birth);
  const candidateAge = getAgeFromDob(candidateUser.date_of_birth);

  if (!currentAge || !candidateAge) return 0;

  const ageGap = Math.abs(currentAge - candidateAge);

  if (ageGap <= 2) return 3;
  if (ageGap <= 5) return 2;
  if (ageGap <= 8) return 1;
  return 0;
}

function areMutuallyCompatible(currentUser: ProfileRow, candidateUser: ProfileRow) {
  return (
    normalizeCity(currentUser.city) === normalizeCity(candidateUser.city) &&
    isInterestedIn(candidateUser.gender, currentUser.interested_in) &&
    isInterestedIn(currentUser.gender, candidateUser.interested_in) &&
    isAgeCompatible(currentUser, candidateUser)
  );
}

function deterministicRoomId(podId: string, roundNumber: number, pairIndex: number) {
  return `room_${podId}_r${roundNumber}_p${pairIndex + 1}_${crypto.randomUUID()}`;
}

function sortUsersForFlexibleMatching(
  waitingRows: PodQueueRow[],
  profilesById: Map<string, ProfileRow>
): SortedUser[] {
  return waitingRows
    .map((row) => ({
      queue: row,
      profile: profilesById.get(row.user_id) ?? null,
    }))
    .filter((item): item is SortedUser => !!item.profile)
    .sort((a, b) => a.queue.user_id.localeCompare(b.queue.user_id));
}

function makePairKey(userAId: string, userBId: string) {
  return [userAId, userBId].sort().join("__");
}

function canonicalizePair(userAId: string, userBId: string) {
  return userAId.localeCompare(userBId) <= 0
    ? { userAId, userBId }
    : { userAId: userBId, userBId: userAId };
}

function isUniqueViolation(
  error: { code?: string | null; message?: string | null } | null | undefined
) {
  return error?.code === "23505";
}

function normalizeRating(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";

  if (normalized === "great") return "great";
  if (normalized === "okay") return "okay";
  if (normalized === "nope") return "nope";
  if (normalized === "no") return "nope";
  return null;
}

function hasAnyNo(
  rating: string | null | undefined,
  matchedUserRating: string | null | undefined
) {
  return (
    normalizeRating(rating) === "nope" || normalizeRating(matchedUserRating) === "nope"
  );
}

function isMutualYes(
  rating: string | null | undefined,
  matchedUserRating: string | null | undefined
) {
  return (
    normalizeRating(rating) === "great" &&
    normalizeRating(matchedUserRating) === "great"
  );
}

function isCooldownEligibleRematch(
  rating: string | null | undefined,
  matchedUserRating: string | null | undefined
) {
  const a = normalizeRating(rating);
  const b = normalizeRating(matchedUserRating);

  if (!a || !b) return false;
  if (a === "nope" || b === "nope") return false;
  if (a === "great" && b === "great") return false;

  return (
    (a === "okay" && b === "okay") ||
    (a === "okay" && b === "great") ||
    (a === "great" && b === "okay")
  );
}

function isWithinLastNDays(dateString: string | null | undefined, days: number) {
  if (!dateString) return false;

  const createdAt = new Date(dateString);
  if (Number.isNaN(createdAt.getTime())) return false;

  const now = getDebugAdjustedNow();
  const diffMs = now.getTime() - createdAt.getTime();
  const maxMs = days * 24 * 60 * 60 * 1000;

  return diffMs >= 0 && diffMs <= maxMs;
}

async function getRematchBlockDecision(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userAId: string,
  userBId: string
) {
  const { data, error } = await supabase
    .from("pod_results")
    .select(
      "room_id, user_id, matched_user_id, outcome, rating, matched_user_rating, created_at"
    )
    .or(
      `and(user_id.eq.${userAId},matched_user_id.eq.${userBId}),and(user_id.eq.${userBId},matched_user_id.eq.${userAId})`
    )
    .order("created_at", { ascending: false });

  if (error) {
    return {
      error,
      blocked: false,
      reason: null as string | null,
    };
  }

  const rows = (data ?? []) as PodResultHistoryRow[];

  if (rows.length === 0) {
    return {
      error: null,
      blocked: false,
      reason: null as string | null,
    };
  }

  const roomMap = new Map<string, PodResultHistoryRow[]>();

  for (const row of rows) {
    const existing = roomMap.get(row.room_id) ?? [];
    existing.push(row);
    roomMap.set(row.room_id, existing);
  }

  const priorEncounters = Array.from(roomMap.values())
    .map((roomRows) =>
      roomRows.sort((a, b) => {
        const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
        const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
        return bTime - aTime;
      })[0]
    )
    .sort((a, b) => {
      const aTime = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTime = b.created_at ? new Date(b.created_at).getTime() : 0;
      return bTime - aTime;
    });

  for (const row of priorEncounters) {
    if (hasAnyNo(row.rating, row.matched_user_rating)) {
      return {
        error: null,
        blocked: true,
        reason: "blocked_forever_no_rating",
      };
    }

    if (isMutualYes(row.rating, row.matched_user_rating)) {
      return {
        error: null,
        blocked: true,
        reason: "blocked_forever_mutual_yes",
      };
    }
  }

  const latestEncounter = priorEncounters[0];

  if (
    latestEncounter &&
    isCooldownEligibleRematch(
      latestEncounter.rating,
      latestEncounter.matched_user_rating
    ) &&
    isWithinLastNDays(latestEncounter.created_at, REMATCH_COOLDOWN_DAYS)
  ) {
    return {
      error: null,
      blocked: true,
      reason: "blocked_recent_positive_non_reveal_30_day_cooldown",
    };
  }

  return {
    error: null,
    blocked: false,
    reason: null as string | null,
  };
}

function buildFlexiblePairs(args: {
  users: SortedUser[];
  blockedPairKeys: Set<string>;
  blockedUserIds: Set<string>;
}) {
  const { users, blockedPairKeys, blockedUserIds } = args;

  const usedUserIds = new Set<string>();
  const pairs: PairCandidate[] = [];
  let pairIndex = 0;

  for (let i = 0; i < users.length; i += 1) {
    const userA = users[i];
    const userAId = userA.queue.user_id;

    if (usedUserIds.has(userAId)) continue;
    if (blockedUserIds.has(userAId)) continue;

    let bestCandidateIndex = -1;
    let bestCandidateScore = Number.NEGATIVE_INFINITY;

    for (let j = i + 1; j < users.length; j += 1) {
      const userB = users[j];
      const userBId = userB.queue.user_id;

      if (usedUserIds.has(userBId)) continue;
      if (blockedUserIds.has(userBId)) continue;

      if (!areMutuallyCompatible(userA.profile, userB.profile)) continue;

      const pairKey = makePairKey(userAId, userBId);
      if (blockedPairKeys.has(pairKey)) continue;

      const ageScore = getAgeCompatibilityScore(userA.profile, userB.profile);

      if (ageScore > bestCandidateScore) {
        bestCandidateScore = ageScore;
        bestCandidateIndex = j;
      }
    }

    if (bestCandidateIndex === -1) continue;

    const userB = users[bestCandidateIndex];
    const userBId = userB.queue.user_id;
    const pairKey = makePairKey(userAId, userBId);

    pairs.push({
      pairIndex,
      userAQueue: userA.queue,
      userAProfile: userA.profile,
      userBQueue: userB.queue,
      userBProfile: userB.profile,
    });

    usedUserIds.add(userAId);
    usedUserIds.add(userBId);
    blockedPairKeys.add(pairKey);
    pairIndex += 1;
  }

  return pairs;
}

async function tryAcquireRoundLock(
  supabase: Awaited<ReturnType<typeof createClient>>,
  lockKey: string
) {
  const { error } = await supabase.from("pod_round_locks").insert({
    lock_key: lockKey,
  });

  if (!error) return true;
  if (isUniqueViolation(error)) return false;

  throw error;
}

async function releaseRoundLock(
  supabase: Awaited<ReturnType<typeof createClient>>,
  lockKey: string
) {
  const { error } = await supabase
    .from("pod_round_locks")
    .delete()
    .eq("lock_key", lockKey);

  if (error) {
    console.log("[pods/match] releaseRoundLock error", {
      lockKey,
      error,
    });
  }
}

async function cleanupDuplicateQueueRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const { data, error } = await supabase
    .from("pod_queue")
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .eq("user_id", userId)
    .eq("pod_id", podId)
    .eq("round_number", roundNumber)
    .order("created_at", { ascending: false });

  if (error) {
    return { error, row: null as PodQueueRow | null };
  }

  const rows = (data ?? []) as PodQueueRow[];

  if (rows.length <= 1) {
    return { row: rows[0] ?? null, error: null };
  }

  const keepRow = rows[0];
  const deleteIds = rows.slice(1).map((row) => row.id);

  const { error: deleteError } = await supabase
    .from("pod_queue")
    .delete()
    .in("id", deleteIds);

  if (deleteError) {
    return { error: deleteError, row: null as PodQueueRow | null };
  }

  return { row: keepRow, error: null };
}

async function clearStaleQueueRoomIfNeeded(
  supabase: Awaited<ReturnType<typeof createClient>>,
  row: PodQueueRow
) {
  if (row.status !== "matched" || !row.room_id || !row.pod_id) {
    return { row, error: null as { message?: string } | null };
  }

  const { data: canonicalMatchRow, error: canonicalMatchError } = await supabase
    .from("pod_matches")
    .select("id, user_a_id, user_b_id, room_id, round_number, pod_id")
    .eq("pod_id", row.pod_id)
    .eq("round_number", row.round_number)
    .eq("room_id", row.room_id)
    .or(`user_a_id.eq.${row.user_id},user_b_id.eq.${row.user_id}`)
    .maybeSingle<PodMatchRow>();

  if (canonicalMatchError) {
    return { row: null as PodQueueRow | null, error: canonicalMatchError };
  }

  const canonicalMatch = (canonicalMatchRow as PodMatchRow | null) ?? null;

  if (canonicalMatch?.room_id) {
    return { row, error: null as { message?: string } | null };
  }

  const { data: repairedRow, error: repairError } = await supabase
    .from("pod_queue")
    .update({
      status: "waiting",
      room_id: null,
    })
    .eq("id", row.id)
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .single();

  if (repairError) {
    return { row: null as PodQueueRow | null, error: repairError };
  }

  return {
    row: (repairedRow as PodQueueRow | null) ?? null,
    error: null as { message?: string } | null,
  };
}

async function ensureSelfQueueWaiting(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const dedupeResult = await cleanupDuplicateQueueRows(
    supabase,
    userId,
    podId,
    roundNumber
  );

  if (dedupeResult.error) {
    return { error: dedupeResult.error, row: null as PodQueueRow | null };
  }

  const existingRow = dedupeResult.row;

  if (!existingRow) {
    const { data, error } = await supabase
      .from("pod_queue")
      .upsert(
        {
          user_id: userId,
          status: "waiting",
          room_id: null,
          round_number: roundNumber,
          pod_id: podId,
        },
        {
          onConflict: "user_id,pod_id,round_number",
        }
      )
      .select("id, user_id, status, room_id, round_number, pod_id, created_at")
      .single();

    return {
      error,
      row: (data as PodQueueRow | null) ?? null,
    };
  }

  const cleanedExistingRowResult = await clearStaleQueueRoomIfNeeded(
    supabase,
    existingRow
  );

  if (cleanedExistingRowResult.error || !cleanedExistingRowResult.row) {
    return {
      error: cleanedExistingRowResult.error,
      row: null as PodQueueRow | null,
    };
  }

  const cleanedExistingRow = cleanedExistingRowResult.row;

  if (
    cleanedExistingRow.status === "waiting" &&
    cleanedExistingRow.room_id === null &&
    cleanedExistingRow.round_number === roundNumber &&
    cleanedExistingRow.pod_id === podId
  ) {
    return {
      error: null,
      row: cleanedExistingRow,
    };
  }

  const { data, error } = await supabase
    .from("pod_queue")
    .update({
      status: "waiting",
      room_id: null,
      round_number: roundNumber,
      pod_id: podId,
    })
    .eq("id", cleanedExistingRow.id)
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .single();

  return {
    error,
    row: (data as PodQueueRow | null) ?? null,
  };
}

async function assertUserQueuedForWaiting(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const queueResult = await ensureSelfQueueWaiting(supabase, userId, podId, roundNumber);

  if (queueResult.error || !queueResult.row) {
    return {
      error:
        queueResult.error ??
        { message: "Could not confirm queue entry for this round." },
      row: null as PodQueueRow | null,
    };
  }

  if (
    queueResult.row.user_id !== userId ||
    queueResult.row.pod_id !== podId ||
    queueResult.row.round_number !== roundNumber
  ) {
    return {
      error: { message: "Queue entry does not match the active pod session." },
      row: null as PodQueueRow | null,
    };
  }

  return {
    error: null as { message?: string } | null,
    row: queueResult.row,
  };
}

async function getExistingSelfQueueRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const dedupeResult = await cleanupDuplicateQueueRows(
    supabase,
    userId,
    podId,
    roundNumber
  );

  if (dedupeResult.error || !dedupeResult.row) {
    return {
      error: dedupeResult.error,
      row: dedupeResult.row,
    };
  }

  return clearStaleQueueRoomIfNeeded(supabase, dedupeResult.row);
}

async function backfillPodRoomMetadataIfMissing(
  supabase: Awaited<ReturnType<typeof createClient>>,
  room: PodRoomRow | null
) {
  if (!room?.room_id) return;

  const needsBackfill =
    room.user_a_name == null ||
    room.user_b_name == null ||
    room.user_a_city == null ||
    room.user_b_city == null;

  if (!needsBackfill) return;

  const userIds = [room.user_a_id, room.user_b_id].filter(Boolean);

  if (userIds.length < 2) return;

  const { data: profilesRaw, error: profilesError } = await supabase
    .from("profiles")
    .select("id, first_name, city")
    .in("id", userIds);

  if (profilesError) {
    console.log("[pods/match] backfillPodRoomMetadataIfMissing profiles error", {
      roomId: room.room_id,
      error: profilesError,
    });
    return;
  }

  const profiles = (profilesRaw ?? []) as Array<{
    id: string;
    first_name: string | null;
    city: string | null;
  }>;

  const byId = new Map(profiles.map((profile) => [profile.id, profile]));

  const userAProfile = byId.get(room.user_a_id);
  const userBProfile = byId.get(room.user_b_id);

  const payload = {
    user_a_name: room.user_a_name ?? userAProfile?.first_name ?? null,
    user_b_name: room.user_b_name ?? userBProfile?.first_name ?? null,
    user_a_city: room.user_a_city ?? userAProfile?.city ?? null,
    user_b_city: room.user_b_city ?? userBProfile?.city ?? null,
  };

  const { error: updateError } = await supabase
    .from("pod_rooms")
    .update(payload)
    .eq("room_id", room.room_id);

  if (updateError) {
    console.log("[pods/match] backfillPodRoomMetadataIfMissing update error", {
      roomId: room.room_id,
      error: updateError,
    });
    return;
  }

  room.user_a_name = payload.user_a_name;
  room.user_b_name = payload.user_b_name;
  room.user_a_city = payload.user_a_city;
  room.user_b_city = payload.user_b_city;

  console.log("[pods/match] backfilled pod_rooms metadata", {
    roomId: room.room_id,
    payload,
  });
}

async function getRoomForUserByRoomId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  roomId: string,
  userId: string
) {
  const { data: roomRow, error: roomError } = await supabase
    .from("pod_rooms")
    .select(
      "room_id, user_a_id, user_b_id, user_a_name, user_b_name, user_a_city, user_b_city, started_at"
    )
    .eq("room_id", roomId)
    .maybeSingle<PodRoomRow>();

  if (roomError) {
    return {
      error: roomError,
      room: null as PodRoomRow | null,
    };
  }

  const room = (roomRow as PodRoomRow | null) ?? null;
  const userBelongsToRoom =
    !!room && (room.user_a_id === userId || room.user_b_id === userId);

  if (!room || !userBelongsToRoom) {
    return {
      error: null,
      room: null as PodRoomRow | null,
    };
  }

  await backfillPodRoomMetadataIfMissing(supabase, room);

  return {
    error: null,
    room,
  };
}

async function getExistingMatchForUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const { data, error } = await supabase
    .from("pod_matches")
    .select("id, user_a_id, user_b_id, room_id, round_number, pod_id")
    .eq("pod_id", podId)
    .eq("round_number", roundNumber)
    .or(`user_a_id.eq.${userId},user_b_id.eq.${userId}`)
    .maybeSingle<PodMatchRow>();

  if (error) {
    return {
      error,
      match: null as PodMatchRow | null,
      room: null as PodRoomRow | null,
    };
  }

  const match = (data as PodMatchRow | null) ?? null;

  if (!match?.room_id) {
    return {
      error: null,
      match,
      room: null as PodRoomRow | null,
    };
  }

  const roomResult = await getRoomForUserByRoomId(supabase, match.room_id, userId);

  if (roomResult.error) {
    return {
      error: roomResult.error,
      match: null as PodMatchRow | null,
      room: null as PodRoomRow | null,
    };
  }

  if (!roomResult.room) {
    return {
      error: null,
      match: null as PodMatchRow | null,
      room: null as PodRoomRow | null,
    };
  }

  return {
    error: null,
    match,
    room: roomResult.room,
  };
}

async function getExistingParticipantLock(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const { data, error } = await supabase
    .from("pod_match_participants")
    .select("pod_id, round_number, user_id, room_id")
    .eq("pod_id", podId)
    .eq("round_number", roundNumber)
    .eq("user_id", userId)
    .maybeSingle<PodMatchParticipantRow>();

  return {
    error,
    lock: (data as PodMatchParticipantRow | null) ?? null,
  };
}

async function getLockedUserIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  podId: string,
  roundNumber: number
) {
  const { data, error } = await supabase
    .from("pod_match_participants")
    .select("user_id")
    .eq("pod_id", podId)
    .eq("round_number", roundNumber);

  if (error) {
    return { error, lockedUserIds: null as Set<string> | null };
  }

  const lockedUserIds = new Set<string>(
    (data ?? []).map((row) => String((row as { user_id: string }).user_id))
  );

  return { error: null, lockedUserIds };
}

async function getBlockedCurrentNightState(
  supabase: Awaited<ReturnType<typeof createClient>>,
  podId: string,
  roundNumber: number
) {
  const { data, error } = await supabase
    .from("pod_matches")
    .select("user_a_id, user_b_id, room_id, round_number, pod_id")
    .eq("pod_id", podId);

  if (error) {
    return {
      error,
      blockedUserIds: null as Set<string> | null,
      blockedPairKeys: null as Set<string> | null,
    };
  }

  const blockedUserIds = new Set<string>();
  const blockedPairKeys = new Set<string>();

  for (const match of (data ?? []) as PodMatchRow[]) {
    blockedPairKeys.add(makePairKey(match.user_a_id, match.user_b_id));

    if (match.round_number === roundNumber) {
      blockedUserIds.add(match.user_a_id);
      blockedUserIds.add(match.user_b_id);
    }
  }

  return {
    error: null,
    blockedUserIds,
    blockedPairKeys,
  };
}

async function cleanupFailedMatchArtifacts(
  supabase: Awaited<ReturnType<typeof createClient>>,
  podId: string,
  roundNumber: number,
  roomId: string,
  userIds: string[]
) {
  console.log("[pods/match] cleanupFailedMatchArtifacts", {
    podId,
    roundNumber,
    roomId,
    userIds,
  });

  await supabase
    .from("pod_match_participants")
    .delete()
    .eq("pod_id", podId)
    .eq("round_number", roundNumber)
    .in("user_id", userIds);

  await supabase.from("pod_matches").delete().eq("room_id", roomId);
  await supabase.from("pod_rooms").delete().eq("room_id", roomId);

  await supabase
    .from("pod_queue")
    .update({
      status: "waiting",
      room_id: null,
    })
    .in("user_id", userIds)
    .eq("pod_id", podId)
    .eq("round_number", roundNumber);
}

async function claimQueueRowAsMatched(
  supabase: Awaited<ReturnType<typeof createClient>>,
  queueId: number,
  roomId: string
) {
  const { data, error } = await supabase
    .from("pod_queue")
    .update({
      status: "matched",
      room_id: roomId,
    })
    .eq("id", queueId)
    .eq("status", "waiting")
    .is("room_id", null)
    .select("id");

  return {
    error,
    updatedCount: (data ?? []).length,
  };
}

async function getQueueRowForClaim(
  supabase: Awaited<ReturnType<typeof createClient>>,
  queueId: number
) {
  const { data, error } = await supabase
    .from("pod_queue")
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .eq("id", queueId)
    .maybeSingle<PodQueueRow>();

  return {
    error,
    row: (data as PodQueueRow | null) ?? null,
  };
}

async function getReadyMatchFromLockOrRoom(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number
) {
  const existingMatchResult = await getExistingMatchForUser(
    supabase,
    userId,
    podId,
    roundNumber
  );

  if (existingMatchResult.error) {
    return {
      error: existingMatchResult.error,
      room: null as PodRoomRow | null,
    };
  }

  if (existingMatchResult.room?.room_id) {
    return {
      error: null,
      room: existingMatchResult.room,
    };
  }

  const lockResult = await getExistingParticipantLock(
    supabase,
    userId,
    podId,
    roundNumber
  );

  if (lockResult.error) {
    return {
      error: lockResult.error,
      room: null as PodRoomRow | null,
    };
  }

  if (!lockResult.lock?.room_id) {
    return {
      error: null,
      room: null as PodRoomRow | null,
    };
  }

  const roomResult = await getRoomForUserByRoomId(
    supabase,
    lockResult.lock.room_id,
    userId
  );

  if (roomResult.error) {
    return {
      error: roomResult.error,
      room: null as PodRoomRow | null,
    };
  }

  return {
    error: null,
    room: roomResult.room,
  };
}

async function forceQueueMatchedForUser(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number,
  roomId: string
) {
  const { error } = await supabase
    .from("pod_queue")
    .update({
      status: "matched",
      room_id: roomId,
    })
    .eq("user_id", userId)
    .eq("pod_id", podId)
    .eq("round_number", roundNumber);

  if (error) {
    console.log("[pods/match] forceQueueMatchedForUser error", {
      userId,
      podId,
      roundNumber,
      roomId,
      error,
    });
  }
}

async function returnMatchedIfReady(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  podId: string,
  roundNumber: number,
  source: string
) {
  const readyResult = await getReadyMatchFromLockOrRoom(
    supabase,
    userId,
    podId,
    roundNumber
  );

  if (readyResult.error) {
    return {
      error: readyResult.error,
      response: null as ReturnType<typeof json> | null,
    };
  }

  if (!readyResult.room?.room_id) {
    return {
      error: null,
      response: null as ReturnType<typeof json> | null,
    };
  }

  await forceQueueMatchedForUser(
    supabase,
    userId,
    podId,
    roundNumber,
    readyResult.room.room_id
  );

  console.log("[pods/match] returning ready room", {
    source,
    userId,
    podId,
    roundNumber,
    roomId: readyResult.room.room_id,
  });

  return {
    error: null,
    response: json({
      status: "matched",
      roomId: readyResult.room.room_id,
      roundNumber,
    }),
  };
}

async function materializeFlexibleRound(
  supabase: Awaited<ReturnType<typeof createClient>>,
  podId: string,
  roundNumber: number
) {
  console.log("[pods/match] materializeFlexibleRound:start", {
    podId,
    roundNumber,
  });

  const lockedUsersResult = await getLockedUserIds(supabase, podId, roundNumber);

  if (lockedUsersResult.error || !lockedUsersResult.lockedUserIds) {
    console.log("[pods/match] materializeFlexibleRound:lockedUsersError", {
      podId,
      roundNumber,
      error: lockedUsersResult.error,
    });

    return {
      error: lockedUsersResult.error,
      ready: false,
      count: 0,
      matchedCount: 0,
      reason: null as string | null,
      raceDetected: false,
    };
  }

  const blockedCurrentNightResult = await getBlockedCurrentNightState(
    supabase,
    podId,
    roundNumber
  );

  if (
    blockedCurrentNightResult.error ||
    !blockedCurrentNightResult.blockedUserIds ||
    !blockedCurrentNightResult.blockedPairKeys
  ) {
    console.log("[pods/match] materializeFlexibleRound:blockedNightStateError", {
      podId,
      roundNumber,
      error: blockedCurrentNightResult.error,
    });

    return {
      error: blockedCurrentNightResult.error,
      ready: false,
      count: 0,
      matchedCount: 0,
      reason: null as string | null,
      raceDetected: false,
    };
  }

  const lockedUserIds = lockedUsersResult.lockedUserIds;
  const blockedUserIds = blockedCurrentNightResult.blockedUserIds;
  const blockedPairKeys = blockedCurrentNightResult.blockedPairKeys;

  const { data: waitingRowsRaw, error: waitingError } = await supabase
    .from("pod_queue")
    .select("id, user_id, status, room_id, round_number, pod_id, created_at")
    .eq("status", "waiting")
    .eq("pod_id", podId)
    .eq("round_number", roundNumber)
    .is("room_id", null)
    .order("created_at", { ascending: true });

  if (waitingError) {
    console.log("[pods/match] materializeFlexibleRound:waitingRowsError", {
      podId,
      roundNumber,
      error: waitingError,
    });

    return {
      error: waitingError,
      ready: false,
      count: 0,
      matchedCount: 0,
      reason: null as string | null,
      raceDetected: false,
    };
  }

  const waitingRows = (waitingRowsRaw ?? []) as PodQueueRow[];

  const dedupedWaitingRows = Array.from(
    new Map(waitingRows.map((row) => [row.user_id, row])).values()
  ).filter(
    (row) => !lockedUserIds.has(row.user_id) && !blockedUserIds.has(row.user_id)
  );

  console.log("[pods/match] materializeFlexibleRound:waitingPool", {
    podId,
    roundNumber,
    rawWaitingCount: waitingRows.length,
    dedupedWaitingCount: dedupedWaitingRows.length,
    lockedUserIds: Array.from(lockedUserIds),
    blockedUserIds: Array.from(blockedUserIds),
    blockedPairCount: blockedPairKeys.size,
  });

  if (dedupedWaitingRows.length < MIN_USERS_PER_ROUND) {
    return {
      error: null,
      ready: false,
      count: dedupedWaitingRows.length,
      matchedCount: 0,
      reason: `Waiting for more people to join round ${roundNumber} (${dedupedWaitingRows.length}/${MIN_USERS_PER_ROUND}).`,
      raceDetected: false,
    };
  }

  const waitingUserIds = dedupedWaitingRows.map((row) => row.user_id);

  const { data: waitingProfilesRaw, error: waitingProfilesError } = await supabase
    .from("profiles")
    .select("id, first_name, city, gender, interested_in, date_of_birth, age_range")
    .in("id", waitingUserIds);

  if (waitingProfilesError) {
    console.log("[pods/match] materializeFlexibleRound:waitingProfilesError", {
      podId,
      roundNumber,
      error: waitingProfilesError,
    });

    return {
      error: waitingProfilesError,
      ready: false,
      count: dedupedWaitingRows.length,
      matchedCount: 0,
      reason: null as string | null,
      raceDetected: false,
    };
  }

  const waitingProfiles = (waitingProfilesRaw ?? []) as ProfileRow[];
  const waitingProfilesById = new Map(
    waitingProfiles.map((profile) => [profile.id, profile])
  );

  const sortedUsers = sortUsersForFlexibleMatching(
    dedupedWaitingRows,
    waitingProfilesById
  );

  const pairs = buildFlexiblePairs({
    users: sortedUsers,
    blockedUserIds,
    blockedPairKeys: new Set([...blockedPairKeys]),
  });

  console.log("[pods/match] materializeFlexibleRound:pairsBuilt", {
    podId,
    roundNumber,
    pairCount: pairs.length,
    pairs: pairs.map((pair) => ({
      pairIndex: pair.pairIndex,
      userAId: pair.userAQueue.user_id,
      userBId: pair.userBQueue.user_id,
    })),
  });

  if (pairs.length === 0) {
    return {
      error: null,
      ready: false,
      count: dedupedWaitingRows.length,
      matchedCount: 0,
      reason: `No new compatible match is available for round ${roundNumber}.`,
      raceDetected: false,
    };
  }

  let successfulMatches = 0;

  for (const pair of pairs) {
    const roomId = deterministicRoomId(podId, roundNumber, pair.pairIndex);

    const canonicalPair = canonicalizePair(
      pair.userAQueue.user_id,
      pair.userBQueue.user_id
    );

    const userAId = canonicalPair.userAId;
    const userBId = canonicalPair.userBId;
    const pairKey = makePairKey(userAId, userBId);

    const canonicalUserAQueue =
      pair.userAQueue.user_id === userAId ? pair.userAQueue : pair.userBQueue;
    const canonicalUserBQueue =
      pair.userAQueue.user_id === userAId ? pair.userBQueue : pair.userAQueue;
    const canonicalUserAProfile =
      pair.userAQueue.user_id === userAId ? pair.userAProfile : pair.userBProfile;
    const canonicalUserBProfile =
      pair.userAQueue.user_id === userAId ? pair.userBProfile : pair.userAProfile;
    const roomStartedAt = getDebugAdjustedNow().toISOString();

    console.log("[pods/match] pairCandidate:start", {
      podId,
      roundNumber,
      roomId,
      roomStartedAt,
      pairIndex: pair.pairIndex,
      userAId,
      userBId,
      pairKey,
    });

    if (blockedPairKeys.has(pairKey)) {
      console.log("[pods/match] pairCandidate:skippedAlreadyBlocked", {
        podId,
        roundNumber,
        userAId,
        userBId,
        pairKey,
      });
      continue;
    }

    const rematchDecision = await getRematchBlockDecision(
      supabase,
      userAId,
      userBId
    );

    if (rematchDecision.error) {
      console.log("[pods/match] pairCandidate:rematchDecisionError", {
        podId,
        roundNumber,
        userAId,
        userBId,
        error: rematchDecision.error,
      });

      return {
        error: rematchDecision.error,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    if (rematchDecision.blocked) {
      console.log("[pods/match] rematch blocked", {
        podId,
        roundNumber,
        userAId,
        userBId,
        reason: rematchDecision.reason,
      });
      blockedPairKeys.add(pairKey);
      continue;
    }

    const existingCurrentNightMatchResult = await supabase
      .from("pod_matches")
      .select("id")
      .eq("pod_id", podId)
      .or(
        `and(user_a_id.eq.${userAId},user_b_id.eq.${userBId}),and(user_a_id.eq.${userBId},user_b_id.eq.${userAId})`
      )
      .maybeSingle();

    if (existingCurrentNightMatchResult.error) {
      console.log("[pods/match] pairCandidate:existingNightMatchError", {
        podId,
        roundNumber,
        userAId,
        userBId,
        error: existingCurrentNightMatchResult.error,
      });

      return {
        error: existingCurrentNightMatchResult.error,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    if (existingCurrentNightMatchResult.data) {
      console.log("[pods/match] pairCandidate:duplicateNightMatchBeforeLock", {
        podId,
        roundNumber,
        userAId,
        userBId,
        existing: existingCurrentNightMatchResult.data,
      });
      blockedPairKeys.add(pairKey);
      continue;
    }

    const queueAState = await getQueueRowForClaim(
      supabase,
      canonicalUserAQueue.id
    );
    const queueBState = await getQueueRowForClaim(
      supabase,
      canonicalUserBQueue.id
    );

    if (queueAState.error || queueBState.error) {
      console.log("[pods/match] pairCandidate:queueStateReadError", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        queueAState,
        queueBState,
      });

      return {
        error: queueAState.error || queueBState.error,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    const queueARow = queueAState.row;
    const queueBRow = queueBState.row;

    const queueAReady =
      !!queueARow &&
      queueARow.user_id === userAId &&
      queueARow.pod_id === podId &&
      queueARow.round_number === roundNumber &&
      queueARow.status === "waiting" &&
      queueARow.room_id == null;

    const queueBReady =
      !!queueBRow &&
      queueBRow.user_id === userBId &&
      queueBRow.pod_id === podId &&
      queueBRow.round_number === roundNumber &&
      queueBRow.status === "waiting" &&
      queueBRow.room_id == null;

    if (!queueAReady || !queueBReady) {
      console.log("[pods/match] pairCandidate:queueNotClaimableBeforeLock", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        queueARow,
        queueBRow,
      });
      continue;
    }

    console.log("[pods/match] INSERT pod_match_participants", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
    });

    const { error: participantInsertError } = await supabase
      .from("pod_match_participants")
      .insert([
        {
          pod_id: podId,
          round_number: roundNumber,
          user_id: userAId,
          room_id: roomId,
        },
        {
          pod_id: podId,
          round_number: roundNumber,
          user_id: userBId,
          room_id: roomId,
        },
      ]);

    if (participantInsertError) {
      console.log("[pods/match] INSERT pod_match_participants ERROR", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        error: participantInsertError,
      });

      if (isUniqueViolation(participantInsertError)) {
        return {
          error: null,
          ready: false,
          count: dedupedWaitingRows.length,
          matchedCount: successfulMatches,
          reason: "Matching is being finalized. Please retry.",
          raceDetected: true,
        };
      }

      return {
        error: participantInsertError,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    console.log("[pods/match] INSERT pod_match_participants SUCCESS", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
    });

    const rematchDecisionAfterLock = await getRematchBlockDecision(
      supabase,
      userAId,
      userBId
    );

    if (rematchDecisionAfterLock.error) {
      console.log("[pods/match] pairCandidate:rematchDecisionAfterLockError", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        error: rematchDecisionAfterLock.error,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      return {
        error: rematchDecisionAfterLock.error,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    if (rematchDecisionAfterLock.blocked) {
      console.log("[pods/match] pairCandidate:blockedAfterLock", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        reason: rematchDecisionAfterLock.reason,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);
      blockedPairKeys.add(pairKey);
      continue;
    }

    const {
      data: duplicateNightMatchAfterLock,
      error: duplicateNightMatchAfterLockError,
    } = await supabase
      .from("pod_matches")
      .select("id")
      .eq("pod_id", podId)
      .or(
        `and(user_a_id.eq.${userAId},user_b_id.eq.${userBId}),and(user_a_id.eq.${userBId},user_b_id.eq.${userAId})`
      )
      .maybeSingle();

    if (duplicateNightMatchAfterLockError) {
      console.log("[pods/match] pairCandidate:duplicateNightMatchAfterLockError", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        error: duplicateNightMatchAfterLockError,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      return {
        error: duplicateNightMatchAfterLockError,
        ready: false,
        count: dedupedWaitingRows.length,
        matchedCount: successfulMatches,
        reason: null as string | null,
        raceDetected: false,
      };
    }

    if (duplicateNightMatchAfterLock) {
      console.log("[pods/match] pairCandidate:duplicateNightMatchAfterLockFound", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        existing: duplicateNightMatchAfterLock,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);
      blockedPairKeys.add(pairKey);
      continue;
    }

    const queueAClaimResult = await claimQueueRowAsMatched(
      supabase,
      canonicalUserAQueue.id,
      roomId
    );

    if (queueAClaimResult.error || queueAClaimResult.updatedCount !== 1) {
      console.log("[pods/match] queueA claim failed", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        queueId: canonicalUserAQueue.id,
        queueAClaimResult,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      continue;
    }

    console.log("[pods/match] queueA claim success", {
      podId,
      roundNumber,
      userAId,
      roomId,
      queueId: canonicalUserAQueue.id,
    });

    const queueBClaimResult = await claimQueueRowAsMatched(
      supabase,
      canonicalUserBQueue.id,
      roomId
    );

    if (queueBClaimResult.error || queueBClaimResult.updatedCount !== 1) {
      const queueBStateAfterFailure = await getQueueRowForClaim(
        supabase,
        canonicalUserBQueue.id
      );

      console.log("[pods/match] queueB claim failed", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        queueId: canonicalUserBQueue.id,
        queueBClaimResult,
        queueBStateAfterFailure,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      continue;
    }

    console.log("[pods/match] queueB claim success", {
      podId,
      roundNumber,
      userBId,
      roomId,
      queueId: canonicalUserBQueue.id,
    });

    console.log("[pods/match] queue claims success", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
    });

    console.log("[pods/match] UPSERT pod_rooms", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
      roomStartedAt,
      user_a_name: canonicalUserAProfile.first_name ?? null,
      user_b_name: canonicalUserBProfile.first_name ?? null,
      user_a_city: canonicalUserAProfile.city ?? null,
      user_b_city: canonicalUserBProfile.city ?? null,
    });

    const { error: roomError } = await supabase.from("pod_rooms").upsert(
      {
        room_id: roomId,
        user_a_id: userAId,
        user_b_id: userBId,
        user_a_name: canonicalUserAProfile.first_name ?? null,
        user_a_city: canonicalUserAProfile.city ?? null,
        user_b_name: canonicalUserBProfile.first_name ?? null,
        user_b_city: canonicalUserBProfile.city ?? null,
        started_at: roomStartedAt,
      },
      {
        onConflict: "room_id",
      }
    );

    if (roomError) {
      console.log("[pods/match] UPSERT pod_rooms ERROR", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        error: roomError,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      continue;
    }

    console.log("[pods/match] UPSERT pod_rooms SUCCESS", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
      roomStartedAt,
    });

    console.log("[pods/match] INSERT pod_matches", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
    });

    const { error: matchError } = await supabase.from("pod_matches").insert({
      user_a_id: userAId,
      user_b_id: userBId,
      room_id: roomId,
      round_number: roundNumber,
      pod_id: podId,
    });

    if (matchError) {
      console.log("[pods/match] INSERT pod_matches ERROR", {
        podId,
        roundNumber,
        userAId,
        userBId,
        roomId,
        error: matchError,
      });

      await cleanupFailedMatchArtifacts(supabase, podId, roundNumber, roomId, [
        userAId,
        userBId,
      ]);

      if (isUniqueViolation(matchError)) {
        blockedPairKeys.add(pairKey);
      }

      continue;
    }

    console.log("[pods/match] INSERT pod_matches SUCCESS", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
    });

    await supabase
      .from("pod_queue")
      .update({
        status: "matched",
        room_id: roomId,
      })
      .in("user_id", [userAId, userBId])
      .eq("pod_id", podId)
      .eq("round_number", roundNumber);

    blockedPairKeys.add(pairKey);
    blockedUserIds.add(userAId);
    blockedUserIds.add(userBId);
    successfulMatches += 2;

    console.log("[pods/match] pairCandidate:completed", {
      podId,
      roundNumber,
      userAId,
      userBId,
      roomId,
      roomStartedAt,
      successfulMatches,
    });
  }

  if (successfulMatches === 0) {
    console.log("[pods/match] materializeFlexibleRound:noSuccessfulMatches", {
      podId,
      roundNumber,
    });

    return {
      error: null,
      ready: false,
      count: dedupedWaitingRows.length,
      matchedCount: 0,
      reason: `No new compatible match is available for round ${roundNumber}.`,
      raceDetected: false,
    };
  }

  console.log("[pods/match] materializeFlexibleRound:success", {
    podId,
    roundNumber,
    successfulMatches,
  });

  return {
    error: null,
    ready: true,
    count: dedupedWaitingRows.length,
    matchedCount: successfulMatches,
    reason: null as string | null,
    raceDetected: false,
  };
}

export async function POST(request: Request) {
  try {
    console.log("MATCH ROUTE VERSION 2026-04-15-SINGLE-READY-PATH");

    if (isPreLaunch()) {
      return json(
        {
          ok: false,
          status: "prelaunch",
          error: "PODS_NOT_LIVE_YET",
          message: PODS_LAUNCH_LABEL,
        },
        200
      );
    }

    const supabase = await createClient();

    const body = await request.json().catch(() => null);
    console.log("[pods/match] request body", body);

    const requestedUserId = body?.userId;
    const requestedRoundNumber = body?.roundNumber;
    const requestedPodId = body?.podId;

    if (!requestedUserId || typeof requestedUserId !== "string") {
      return json({ status: "error", error: "Missing or invalid userId." }, 400);
    }

    if (
      requestedRoundNumber != null &&
      (typeof requestedRoundNumber !== "number" ||
        !Number.isInteger(requestedRoundNumber) ||
        requestedRoundNumber < 1 ||
        requestedRoundNumber > TOTAL_ROUNDS)
    ) {
      return json({ status: "error", error: "Missing or invalid roundNumber." }, 400);
    }

    if (
      requestedPodId != null &&
      (typeof requestedPodId !== "string" || !requestedPodId.trim())
    ) {
      return json({ status: "error", error: "Missing or invalid podId." }, 400);
    }

    const {
      data: { user: authedUser },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      console.log("[pods/match] auth getUser error", authError);

      return json(
        {
          status: "error",
          error: authError.message || "Could not verify authenticated user.",
        },
        401
      );
    }

    if (!authedUser) {
      console.log("[pods/match] auth missing user");
      return json({ status: "error", error: "Not authenticated." }, 401);
    }

    if (authedUser.id !== requestedUserId) {
      console.log("[pods/match] auth user mismatch", {
        authedUserId: authedUser.id,
        requestedUserId,
      });

      return json({ status: "error", error: "User mismatch." }, 403);
    }

    const userId = authedUser.id;

    const {
      data: currentUserProfileRaw,
      error: currentUserProfileError,
    } = await supabase
      .from("profiles")
      .select("id, first_name, city, gender, interested_in, date_of_birth, age_range")
      .eq("id", userId)
      .maybeSingle<ProfileRow>();

    if (currentUserProfileError) {
      console.log("[pods/match] currentUserProfileError", {
        userId,
        error: currentUserProfileError,
      });

      return json(
        {
          status: "error",
          error: currentUserProfileError.message || "Could not load your profile.",
        },
        500
      );
    }

    const currentUserProfile = currentUserProfileRaw as ProfileRow | null;

    if (!currentUserProfile) {
      console.log("[pods/match] current user profile missing", { userId });
      return json({ status: "error", error: "Your profile was not found." }, 404);
    }

    if (
      !normalizeGender(currentUserProfile.gender) ||
      !normalizeInterestedIn(currentUserProfile.interested_in)
    ) {
      console.log("[pods/match] profile missing gender/interested_in", {
        userId,
        gender: currentUserProfile.gender,
        interested_in: currentUserProfile.interested_in,
      });

      return json(
        {
          status: "error",
          error: "Your profile is missing gender or interested_in.",
        },
        400
      );
    }

    const debugAdjustedNow = getDebugAdjustedNow();
    const podId = getPodIdForCurrentSession(
      currentUserProfile.city,
      debugAdjustedNow
    );
    const phaseState = getPodPhaseState(
      currentUserProfile.city,
      debugAdjustedNow
    );
    const roundNumber = phaseState.currentRound ?? 1;
    const entryState = getRoundEntryState(
      currentUserProfile.city,
      roundNumber,
      debugAdjustedNow
    );

    console.log("[pods/match] session resolved", {
      userId,
      requestedPodId,
      requestedRoundNumber,
      derivedPodId: podId,
      roundNumber,
      canonicalPhase: phaseState.phase,
      city: currentUserProfile.city,
      secondsLeftInPhase: phaseState.secondsLeftInPhase,
      serverNow: debugAdjustedNow.toISOString(),
    });

    console.log("[pods/match] entry state resolved", {
      userId,
      podId,
      roundNumber,
      phase: entryState.phase,
      canEnterRound: entryState.canEnterRound,
      entryWindowOpen: entryState.entryWindowOpen,
      reason: entryState.reason,
      serverNow: debugAdjustedNow.toISOString(),
    });

    if (requestedPodId && requestedPodId !== podId) {
      console.log("[pods/match] pod session mismatch", {
        requestedPodId,
        derivedPodId: podId,
        userId,
        roundNumber,
      });

      return json(
        {
          status: "error",
          error: "Pod session mismatch. Please refresh and try again.",
        },
        409
      );
    }

    if (
      requestedRoundNumber &&
      requestedRoundNumber !== roundNumber
    ) {
      console.log("[pods/match] ignoring stale client round hint", {
        userId,
        requestedRoundNumber,
        canonicalRoundNumber: roundNumber,
        phase: phaseState.phase,
      });
    }

    {
      const readyResult = await returnMatchedIfReady(
        supabase,
        userId,
        podId,
        roundNumber,
        "before_anything_else"
      );

      if (readyResult.error) {
        console.log("[pods/match] readyBeforeAnythingElse error", {
          userId,
          podId,
          roundNumber,
          error: readyResult.error,
        });

        return json(
          {
            status: "error",
            error:
              readyResult.error.message ||
              "Could not verify ready room.",
          },
          500
        );
      }

      if (readyResult.response) return readyResult.response;
    }

    const existingSelfQueueResult = await getExistingSelfQueueRow(
      supabase,
      userId,
      podId,
      roundNumber
    );

    if (existingSelfQueueResult.error) {
      console.log("[pods/match] existing self queue read error", {
        userId,
        podId,
        roundNumber,
        error: existingSelfQueueResult.error,
      });

      return json(
        {
          status: "error",
          error:
            existingSelfQueueResult.error.message ||
            "Could not verify your queue state.",
        },
        500
      );
    }

    const existingSelfQueueRow = existingSelfQueueResult.row;
    const hasExistingRoundQueue =
      existingSelfQueueRow?.status === "waiting" ||
      existingSelfQueueRow?.status === "matched";

    if (entryState.shouldGoToDone) {
      return json({
        status: "no_match",
        message: "Final round entry has closed. You can reveal your matches now.",
        roundNumber,
        nextRound: null,
        reveal: true,
        reason: entryState.reason,
      });
    }

    if (!hasExistingRoundQueue && !entryState.canEnterRound) {
      console.log("[pods/match] new entry blocked by entry state", {
        userId,
        podId,
        roundNumber,
        phase: entryState.phase,
        canEnterRound: entryState.canEnterRound,
        entryWindowOpen: entryState.entryWindowOpen,
        reason: entryState.reason,
        serverNow: debugAdjustedNow.toISOString(),
      });

      return json({
        status: "no_match",
        message:
          roundNumber < TOTAL_ROUNDS
            ? `Round ${roundNumber} entry has closed. Moving you to round ${
                roundNumber + 1
              }.`
            : "Final round entry has closed. You can reveal your matches now.",
        roundNumber,
        nextRound: roundNumber < TOTAL_ROUNDS ? roundNumber + 1 : null,
        reveal: roundNumber >= TOTAL_ROUNDS,
        reason: entryState.reason,
      });
    }

    const selfQueueResult = await ensureSelfQueueWaiting(
      supabase,
      userId,
      podId,
      roundNumber
    );

    if (selfQueueResult.error || !selfQueueResult.row) {
      console.log("[pods/match] ensureSelfQueueWaiting error", {
        userId,
        podId,
        roundNumber,
        error: selfQueueResult.error,
        row: selfQueueResult.row,
      });

      return json(
        {
          status: "error",
          error: selfQueueResult.error?.message || "Could not join waiting queue.",
        },
        500
      );
    }

    console.log("[pods/match] self queued/waiting", {
      userId,
      podId,
      roundNumber,
      queueRow: selfQueueResult.row,
    });

    {
      const readyResult = await returnMatchedIfReady(
        supabase,
        userId,
        podId,
        roundNumber,
        "after_queue"
      );

      if (readyResult.error) {
        console.log("[pods/match] readyAfterQueue error", {
          userId,
          podId,
          roundNumber,
          error: readyResult.error,
        });

        return json(
          {
            status: "error",
            error:
              readyResult.error.message ||
              "Could not verify room after queueing.",
          },
          500
        );
      }

      if (readyResult.response) return readyResult.response;
    }

    const roundLockKey = `${podId}__r${roundNumber}`;
    const lockAcquired = await tryAcquireRoundLock(supabase, roundLockKey);

    if (!lockAcquired) {
      const readyResult = await returnMatchedIfReady(
        supabase,
        userId,
        podId,
        roundNumber,
        "lock_busy"
      );

      if (readyResult.error) {
        console.log("[pods/match] readyWhileLockBusy error", {
          userId,
          podId,
          roundNumber,
          error: readyResult.error,
        });

        return json(
          {
            status: "error",
            error:
              readyResult.error.message ||
              "Could not verify existing match while matching was in progress.",
          },
          500
        );
      }

      if (readyResult.response) return readyResult.response;

      const verifiedQueueResult = await assertUserQueuedForWaiting(
        supabase,
        userId,
        podId,
        roundNumber
      );

      if (verifiedQueueResult.error) {
        console.log("[pods/match] lock busy and queue verification failed", {
          userId,
          podId,
          roundNumber,
          error: verifiedQueueResult.error,
        });

        return json(
          {
            status: "error",
            error:
              verifiedQueueResult.error.message ||
              "Could not confirm you were added to the queue.",
          },
          500
        );
      }

      return json({
        status: "waiting",
        message: "Finalizing your match...",
        waitingCount: 0,
        requiredCount: MIN_USERS_PER_ROUND,
      });
    }

    let materializeResult;

    try {
      materializeResult = await materializeFlexibleRound(
        supabase,
        podId,
        roundNumber
      );
    } finally {
      await releaseRoundLock(supabase, roundLockKey);
    }

    if (materializeResult.error) {
      console.log("[pods/match] materializeFlexibleRound error", {
        userId,
        podId,
        roundNumber,
        error: materializeResult.error,
      });

      return json(
        {
          status: "error",
          error:
            materializeResult.error.message || "Could not build flexible round.",
        },
        500
      );
    }

    console.log("[pods/match] materializeFlexibleRound result", {
      userId,
      podId,
      roundNumber,
      materializeResult,
    });

    {
      const readyResult = await returnMatchedIfReady(
        supabase,
        userId,
        podId,
        roundNumber,
        "after_materialize"
      );

      if (readyResult.error) {
        console.log("[pods/match] readyAfterMaterialize error", {
          userId,
          podId,
          roundNumber,
          error: readyResult.error,
        });

        return json(
          {
            status: "error",
            error:
              readyResult.error.message ||
              "Could not verify match result.",
          },
          500
        );
      }

      if (readyResult.response) return readyResult.response;
    }

    if (materializeResult.ready || materializeResult.raceDetected) {
      const verifiedQueueResult = await assertUserQueuedForWaiting(
        supabase,
        userId,
        podId,
        roundNumber
      );

      if (verifiedQueueResult.error) {
        console.log("[pods/match] finalizing waiting response blocked by queue verification", {
          userId,
          podId,
          roundNumber,
          error: verifiedQueueResult.error,
        });

        return json(
          {
            status: "error",
            error:
              verifiedQueueResult.error.message ||
              "Could not confirm you were added to the queue.",
          },
          500
        );
      }

      return json({
        status: "waiting",
        message: "Finalizing your match...",
        waitingCount: materializeResult.count,
        requiredCount: MIN_USERS_PER_ROUND,
      });
    }

    const verifiedQueueResult = await assertUserQueuedForWaiting(
      supabase,
      userId,
      podId,
      roundNumber
    );

    if (verifiedQueueResult.error) {
      console.log("[pods/match] final waiting response blocked by queue verification", {
        userId,
        podId,
        roundNumber,
        error: verifiedQueueResult.error,
      });

      return json(
        {
          status: "error",
          error:
            verifiedQueueResult.error.message ||
            "Could not confirm you were added to the queue.",
        },
        500
      );
    }

    console.log("[pods/match] returning waiting response", {
      userId,
      podId,
      roundNumber,
      verifiedQueueRow: verifiedQueueResult.row,
      reason:
        materializeResult.reason ||
        `Waiting for more people to join round ${roundNumber} (${materializeResult.count}/${MIN_USERS_PER_ROUND}).`,
    });

    return json({
      status: "waiting",
      message:
        materializeResult.reason ||
        `Waiting for more people to join round ${roundNumber} (${materializeResult.count}/${MIN_USERS_PER_ROUND}).`,
      waitingCount: materializeResult.count,
      requiredCount: MIN_USERS_PER_ROUND,
    });
  } catch (error) {
    console.log("[pods/match] POST catch error", error);

    return json(
      {
        status: "error",
        error: getErrorMessage(error, "Internal server error."),
      },
      500
    );
  }
}
