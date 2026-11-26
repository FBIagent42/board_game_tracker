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

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

function decodeXml(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    try {
      return String.fromCodePoint(codePoint);
    } catch {
      return entity;
    }
  });
}

function parseXml(xmlText: string): XmlNode {
  const root: XmlNode = { name: "#document", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tokens = xmlText.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]+>|[^<]+/g) ?? [];

  for (const token of tokens) {
    if (token.startsWith("<!--") || token.startsWith("<?") || /^<!DOCTYPE\b/i.test(token)) continue;
    if (token.startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith("</")) {
      const closingName = token.slice(2, -1).trim();
      const node = stack.pop();
      if (!node || node === root || node.name !== closingName) {
        throw new Error("BGG returned invalid XML.");
      }
      stack[stack.length - 1].text += node.text;
      continue;
    }
    if (token.startsWith("<")) {
      const match = token.match(/^<([\w:.-]+)([\s\S]*?)\/?>(?:\s*)$/);
      if (!match) throw new Error("BGG returned invalid XML.");
      const [, name, rawAttributes] = match;
      const attributes: Record<string, string> = {};
      const attributePattern = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
      for (const attribute of rawAttributes.matchAll(attributePattern)) {
        attributes[attribute[1]] = decodeXml(attribute[2].slice(1, -1));
      }
      const node: XmlNode = { name, attributes, children: [], text: "" };
      stack[stack.length - 1].children.push(node);
      if (!/\/>$/.test(token)) stack.push(node);
      continue;
    }
    stack[stack.length - 1].text += decodeXml(token);
  }

  if (stack.length !== 1) throw new Error("BGG returned invalid XML.");
  return root;
}

function child(node: XmlNode, name: string): XmlNode | undefined {
  return node.children.find((candidate) => candidate.name === name);
}

function value(node: XmlNode | undefined): string | null {
  return node?.attributes.value ?? null;
}

function parseBggItems(xmlText: string): Map<number, Record<string, unknown>> {
  const document = parseXml(xmlText);
  const items = child(document, "items");
  if (!items) throw new Error("BGG returned invalid XML.");
  const result = new Map<number, Record<string, unknown>>();
  for (const item of items.children.filter((candidate) => candidate.name === "item")) {
    const gameId = numericValue(item.attributes.id, true);
    if (!gameId) continue;

    const names = item.children.filter((candidate) => candidate.name === "name");
    const primaryName = names.find((name) => name.attributes.type === "primary")
      ?.attributes.value ?? names[0]?.attributes.value ?? null;
    const statistics = child(item, "statistics");
    const ratings = statistics ? child(statistics, "ratings") : undefined;
    const averageWeight = ratings ? child(ratings, "averageweight") : undefined;
    const average = ratings ? child(ratings, "average") : undefined;
    const bayesAverage = ratings ? child(ratings, "bayesaverage") : undefined;
    const image = child(item, "image")?.text.trim() || null;
    const thumbnail = child(item, "thumbnail")?.text.trim() || null;
    const description = child(item, "description")?.text.trim() || null;
    const itemValue = (name: string) => value(child(item, name));

    result.set(gameId, {
      game_id: gameId,
      is_expansion: item.attributes.type === "boardgameexpansion",
      name: primaryName,
      description,
      year_published: numericValue(itemValue("yearpublished"), true),
      game_weight: numericValue(value(averageWeight)),
      avg_rating: numericValue(value(average)),
      bayes_avg_rating: numericValue(value(bayesAverage)),
      min_players: numericValue(itemValue("minplayers"), true),
      max_players: numericValue(itemValue("maxplayers"), true),
      manufacturer_playtime: numericValue(itemValue("playingtime"), true),
      community_min_playtime: numericValue(itemValue("minplaytime"), true),
      community_max_playtime: numericValue(itemValue("maxplaytime"), true),
      manufacturer_age_rec: numericValue(itemValue("minage"), true),
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
