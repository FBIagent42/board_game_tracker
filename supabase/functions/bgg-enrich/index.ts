const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

const BGG_THING_URL = "https://boardgamegeek.com/xmlapi2/thing";
const MAX_IDS_PER_REQUEST = 20;
const MAX_IDS_PER_FUNCTION_CALL = 80;
const CHECK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EDGE_WAIT_MS = 120_000;
const FIELDS = [
  "game_id",
  "is_expansion",
  "bgg_last_checked_at",
  "name",
  "description",
  "year_published",
  "game_weight",
  "avg_rating",
  "bayes_avg_rating",
  "min_players",
  "max_players",
  "manufacturer_playtime",
  "community_min_playtime",
  "community_max_playtime",
  "manufacturer_age_rec",
  "image_url",
  "community_age_rec",
  "best_players",
];

const COMPLETENESS_FIELDS = [
  "image_url",
  "description",
  "year_published",
  "game_weight",
  "min_players",
  "max_players",
  "manufacturer_playtime",
  "community_min_playtime",
  "community_max_playtime",
  "manufacturer_age_rec",
];

type GameRow = Record<string, string | number | boolean | null> & {
  game_id: number;
  bgg_last_checked_at: string | null;
};

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, ...extraHeaders, "Content-Type": "application/json" },
  });
}

function missing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

function isComplete(game: GameRow): boolean {
  return COMPLETENESS_FIELDS.every((field) => !missing(game[field]));
}

function needsBggCheck(game: GameRow, now = Date.now()): boolean {
  if (isComplete(game)) return false;
  if (!game.bgg_last_checked_at) return true;
  const lastChecked = Date.parse(game.bgg_last_checked_at);
  return !Number.isFinite(lastChecked) || now - lastChecked >= CHECK_COOLDOWN_MS;
}

function numericValue(value: string | null | undefined, integer = false): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return integer ? Math.trunc(parsed) : parsed;
}

function readValue(item: Element, selector: string): string | null {
  return item.querySelector(selector)?.getAttribute("value") ?? null;
}

function parseBggItems(xmlText: string): Map<number, Record<string, unknown>> {
  const document = new DOMParser().parseFromString(xmlText, "application/xml");
  if (document.querySelector("parsererror")) throw new Error("BGG returned invalid XML.");

  const result = new Map<number, Record<string, unknown>>();
  for (const item of Array.from(document.querySelectorAll("items > item"))) {
    const gameId = numericValue(item.getAttribute("id"), true);
    if (!gameId) continue;

    const names = Array.from(item.querySelectorAll(":scope > name"));
    const primaryName = names.find((name) => name.getAttribute("type") === "primary")
      ?.getAttribute("value") ?? names[0]?.getAttribute("value") ?? null;
    const ratings = item.querySelector("statistics > ratings");
    const image = item.querySelector(":scope > image")?.textContent?.trim() || null;
    const thumbnail = item.querySelector(":scope > thumbnail")?.textContent?.trim() || null;
    const description = item.querySelector(":scope > description")?.textContent?.trim() || null;

    result.set(gameId, {
      game_id: gameId,
      is_expansion: item.getAttribute("type") === "boardgameexpansion",
      name: primaryName,
      description,
      year_published: numericValue(readValue(item, ":scope > yearpublished"), true),
      game_weight: numericValue(ratings?.querySelector(":scope > averageweight")?.getAttribute("value")),
      avg_rating: numericValue(ratings?.querySelector(":scope > average")?.getAttribute("value")),
      bayes_avg_rating: numericValue(ratings?.querySelector(":scope > bayesaverage")?.getAttribute("value")),
      min_players: numericValue(readValue(item, ":scope > minplayers"), true),
      max_players: numericValue(readValue(item, ":scope > maxplayers"), true),
      manufacturer_playtime: numericValue(readValue(item, ":scope > playingtime"), true),
      community_min_playtime: numericValue(readValue(item, ":scope > minplaytime"), true),
      community_max_playtime: numericValue(readValue(item, ":scope > maxplaytime"), true),
      manufacturer_age_rec: numericValue(readValue(item, ":scope > minage"), true),
      image_url: image || thumbnail,
    });
  }
  return result;
}

function getServiceKey(): string {
  const secretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeysRaw) {
    try {
      const secretKeys = JSON.parse(secretKeysRaw);
      if (secretKeys.default) return secretKeys.default;
    } catch {
      // Fall through to the legacy environment variable.
    }
  }
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacy) throw new Error("Supabase service secret is unavailable.");
  return legacy;
}

const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
const serviceKey = getServiceKey();
const bggKey = Deno.env.get("BGG_KEY");

if (!supabaseUrl || !bggKey) throw new Error("Supabase URL or BGG_KEY is missing from function secrets.");

function serviceHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    ...extra,
  };
}

async function loadGames(ids: number[]): Promise<GameRow[]> {
  if (!ids.length) return [];
  const query = new URLSearchParams({
    select: FIELDS.join(","),
    game_id: `in.(${ids.join(",")})`,
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/game?${query}`, {
    headers: serviceHeaders(),
  });
  if (!response.ok) throw new Error(`Supabase game lookup failed (${response.status}).`);
  return await response.json();
}

async function claimRequestSlot(): Promise<number> {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/claim_bgg_request_slot`, {
    method: "POST",
    headers: serviceHeaders({ "Content-Type": "application/json" }),
    body: "{}",
  });
  if (!response.ok) throw new Error(`Could not reserve a BGG request slot (${response.status}).`);
  const value = await response.json();
  const date = Array.isArray(value) ? value[0] : value;
  const slotAt = Date.parse(String(date));
  if (!Number.isFinite(slotAt)) throw new Error("The BGG request gate returned an invalid time.");
  return slotAt;
}

async function waitForRequestSlot(): Promise<void> {
  const slotAt = await claimRequestSlot();
  const delay = Math.max(0, slotAt - Date.now());
  if (delay > MAX_EDGE_WAIT_MS) {
    throw new Response(JSON.stringify({ error: "BGG request queue is busy. Please retry shortly." }), {
      status: 429,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": String(Math.ceil(delay / 1000)) },
    });
  }
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
}

async function writeBggResults(
  candidates: GameRow[],
  bggItems: Map<number, Record<string, unknown>>,
  checkedAt: string,
): Promise<void> {
  const existingById = new Map(candidates.map((game) => [game.game_id, game]));
  const upserts: Record<string, unknown>[] = [];
  for (const [gameId, bgg] of bggItems) {
    const existing = existingById.get(gameId);
    if (!existing) continue;
    const merged: Record<string, unknown> = { ...existing, bgg_last_checked_at: checkedAt };
    for (const [field, value] of Object.entries(bgg)) {
      if (field === "game_id") continue;
      if (!missing(value)) merged[field] = value;
    }
    upserts.push(merged);
  }

  if (upserts.length) {
    const response = await fetch(`${supabaseUrl}/rest/v1/game?on_conflict=game_id`, {
      method: "POST",
      headers: serviceHeaders({
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(upserts),
    });
    if (!response.ok) throw new Error(`Supabase game update failed (${response.status}).`);
  }

  const checkedIds = candidates.map((game) => game.game_id);
  const query = new URLSearchParams({ game_id: `in.(${checkedIds.join(",")})` });
  const response = await fetch(`${supabaseUrl}/rest/v1/game?${query}`, {
    method: "PATCH",
    headers: serviceHeaders({
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    }),
    body: JSON.stringify({ bgg_last_checked_at: checkedAt }),
  });
  if (!response.ok) throw new Error(`Could not record BGG check time (${response.status}).`);
}

async function enrichBatch(ids: number[]): Promise<number[]> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let candidates = (await loadGames(ids)).filter((game) => needsBggCheck(game));
    if (!candidates.length) return [];

    await waitForRequestSlot();

    // Another invocation may have filled these rows while this request waited.
    candidates = (await loadGames(candidates.map((game) => game.game_id)))
      .filter((game) => needsBggCheck(game));
    if (!candidates.length) return [];

    const requestedIds = candidates.map((game) => game.game_id);
    const query = new URLSearchParams({ id: requestedIds.join(","), stats: "1" });
    const response = await fetch(`${BGG_THING_URL}?${query}`, {
      headers: {
        Authorization: `Bearer ${bggKey}`,
        "User-Agent": "BoardGameTracker/1.0",
      },
    });
    if (response.status === 202 || [429, 500, 502, 503, 504].includes(response.status)) {
      if (attempt === 5) throw new Error(`BGG remained unavailable after ${attempt} attempts.`);
      continue;
    }
    if (!response.ok) throw new Error(`BGG returned HTTP ${response.status}.`);

    const bggItems = parseBggItems(await response.text());
    const checkedAt = new Date().toISOString();
    await writeBggResults(candidates, bggItems, checkedAt);
    return [...bggItems.keys()];
  }
  return [];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);

  let payload: { game_ids?: unknown };
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be JSON." }, 400);
  }
  if (!Array.isArray(payload.game_ids) || payload.game_ids.length > MAX_IDS_PER_FUNCTION_CALL) {
    return jsonResponse({ error: `Provide up to ${MAX_IDS_PER_FUNCTION_CALL} game_ids.` }, 400);
  }
  const ids = [...new Set(payload.game_ids.map((value) => Number(value)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return jsonResponse({ error: "Every game_id must be a positive integer." }, 400);
  }
  if (!ids.length) return jsonResponse({ enriched: 0, games: [] });

  try {
    const enrichedIds: number[] = [];
    for (let index = 0; index < ids.length; index += MAX_IDS_PER_REQUEST) {
      enrichedIds.push(...await enrichBatch(ids.slice(index, index + MAX_IDS_PER_REQUEST)));
    }
    const games = await loadGames(ids);
    return jsonResponse({ enriched: enrichedIds.length, games });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("BGG enrichment failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Could not update missing BoardGameGeek data right now." }, 502);
  }
});
