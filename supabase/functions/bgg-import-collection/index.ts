const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

type XmlNode = {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  text: string;
};

type CollectionGame = {
  game_id: number;
  name: string;
  year_published: number | null;
  own: boolean;
  numplays: number;
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
const serviceKey = getServiceKey();
const bggKey = Deno.env.get("BGG_KEY");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey;

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

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

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
      if (!node || node === root || node.name !== closingName) throw new Error("BGG returned invalid XML.");
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

function parseNonnegativeInt(value: string | undefined, field: string, fallback = 0): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`BGG returned an invalid ${field}.`);
  return parsed;
}

function parseCollection(xml: string): CollectionGame[] {
  const document = parseXml(xml);
  const items = child(document, "items");
  if (!items) throw new Error("BGG returned an invalid collection response.");
  const byId = new Map<number, CollectionGame>();

  for (const item of items.children.filter((node) => node.name === "item")) {
    const gameId = parseNonnegativeInt(item.attributes.objectid ?? item.attributes.id, "game ID");
    if (!gameId) continue;
    const nameNode = child(item, "name");
    const name = (nameNode?.attributes.value || nameNode?.text || "").trim();
    if (!name) throw new Error(`BGG omitted the title for game ${gameId}.`);
    const yearNode = child(item, "yearpublished");
    const rawYear = yearNode?.attributes.value || yearNode?.text;
    const year = rawYear?.trim() ? parseNonnegativeInt(rawYear, "publication year") : null;
    const status = child(item, "status");
    const own = ["1", "true", "t", "yes"].includes((status?.attributes.own ?? "0").toLowerCase());
    const numplaysNode = child(item, "numplays");
    const numplays = parseNonnegativeInt(numplaysNode?.text, "play count");
    if (byId.has(gameId)) throw new Error(`BGG returned game ${gameId} more than once.`);
    byId.set(gameId, { game_id: gameId, name, year_published: year, own, numplays });
  }
  return [...byId.values()];
}

async function getBggCollection(username: string): Promise<CollectionGame[]> {
  const url = new URL("https://boardgamegeek.com/xmlapi2/collection");
  url.searchParams.set("username", username);
  url.searchParams.set("stats", "1");
  for (let attempt = 1; attempt <= 12; attempt++) {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bggKey}`,
        "User-Agent": "BoardGameTracker/1.0",
        Accept: "application/xml",
      },
    });
    if (response.status === 202 || [429, 500, 502, 503, 504].includes(response.status)) {
      if (attempt === 12) throw new Error(`BGG collection request remained queued (HTTP ${response.status}).`);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      continue;
    }
    if (!response.ok) throw new Error(`BGG collection request failed (HTTP ${response.status}).`);
    return parseCollection(await response.text());
  }
  throw new Error("BGG collection request failed after retries.");
}

function serviceHeaders(extra: Record<string, string> = {}) {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, ...extra };
}

async function databaseRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: serviceHeaders((init.headers as Record<string, string>) ?? {}),
  });
}

const DETAILS_FIELDS = [
  "game_id",
  "bgg_last_checked_at",
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

async function loadExistingGames(gameIds: number[]): Promise<Map<number, Record<string, unknown>>> {
  const existing = new Map<number, Record<string, unknown>>();
  for (let start = 0; start < gameIds.length; start += 300) {
    const batch = gameIds.slice(start, start + 300);
    const query = new URLSearchParams({ select: DETAILS_FIELDS.join(","), game_id: `in.(${batch.join(",")})` });
    const response = await databaseRequest(`game?${query}`);
    if (!response.ok) throw new Error(`Supabase game lookup failed (${response.status}).`);
    const rows = await response.json();
    for (const row of rows) existing.set(Number(row.game_id), row);
  }
  return existing;
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && !value.trim());
}

async function writeBatches(
  table: string,
  rows: Record<string, unknown>[],
  conflict: string,
  resolution: "merge-duplicates" | "ignore-duplicates" = "merge-duplicates",
): Promise<void> {
  for (let start = 0; start < rows.length; start += 300) {
    const batch = rows.slice(start, start + 300);
    const query = new URLSearchParams({ on_conflict: conflict });
    const response = await databaseRequest(`${table}?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: `resolution=${resolution},return=minimal`,
      },
      body: JSON.stringify(batch),
    });
    if (!response.ok) throw new Error(`Supabase ${table} write failed (${response.status}).`);
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);
  if (!supabaseUrl || !bggKey) return jsonResponse({ error: "Server configuration is incomplete." }, 500);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return jsonResponse({ error: "Sign in to import a collection." }, 401);

  try {
    const authResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, Authorization: authorization },
    });
    if (!authResponse.ok) return jsonResponse({ error: "Your session is invalid or expired. Please sign in again." }, 401);
    const authUser = await authResponse.json();

    const profileQuery = new URLSearchParams({
      select: "user_id,bgg_username",
      auth_user_id: `eq.${authUser.id}`,
      limit: "1",
    });
    const profileResponse = await databaseRequest(`user?${profileQuery}`);
    if (!profileResponse.ok) throw new Error(`Supabase profile lookup failed (${profileResponse.status}).`);
    const profiles = await profileResponse.json();
    if (!profiles.length) return jsonResponse({ error: "No application profile is linked to this account." }, 403);
    const userId = Number(profiles[0].user_id);
    const username = typeof profiles[0].bgg_username === "string" ? profiles[0].bgg_username.trim() : "";
    if (!username || username.length > 100) {
      return jsonResponse({ error: "Connect a BGG username before importing a collection." }, 400);
    }

    const collection = await getBggCollection(username);
    if (!collection.length) {
      return jsonResponse({ collection_rows: 0, new_games: 0, owned: 0, numplays_total: 0 });
    }

    const ids = collection.map((game) => game.game_id);
    const existingGames = await loadExistingGames(ids);
    const existingIds = new Set(existingGames.keys());
    const missingGames = collection
      .filter((game) => !existingIds.has(game.game_id))
      .map(({ game_id, name, year_published }) => ({ game_id, name, year_published }));
    const enrichmentIds = collection
      .filter((game) => {
        const existing = existingGames.get(game.game_id);
        return !existing || DETAILS_FIELDS.slice(2).some((field) => isMissing(existing[field]));
      })
      .map((game) => game.game_id);
    await writeBatches("game", missingGames, "game_id", "ignore-duplicates");
    await writeBatches("user_collection", collection.map((game) => ({
      user_id: userId,
      game_id: game.game_id,
      own: game.own,
      numplays: game.numplays,
    })), "user_id,game_id");

    let enrichedGames = 0;
    let enrichmentWarning: string | null = null;
    for (let start = 0; start < enrichmentIds.length; start += 80) {
      const response = await fetch(`${supabaseUrl}/functions/v1/bgg-enrich`, {
        method: "POST",
        headers: {
          apikey: anonKey,
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ game_ids: enrichmentIds.slice(start, start + 80) }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        enrichmentWarning = result.error || `BGG details could not be refreshed (${response.status}).`;
        break;
      }
      enrichedGames += Number(result.enriched || 0);
    }

    return jsonResponse({
      collection_rows: collection.length,
      new_games: missingGames.length,
      owned: collection.filter((game) => game.own).length,
      numplays_total: collection.reduce((sum, game) => sum + game.numplays, 0),
      enriched_games: enrichedGames,
      enrichment_warning: enrichmentWarning,
    });
  } catch (error) {
    console.error("BGG collection import failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Could not import the BGG collection. Check that the collection is public and try again." }, 502);
  }
});
