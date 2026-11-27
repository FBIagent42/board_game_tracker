const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL")?.replace(/\/$/, "");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const serviceKey = getServiceKey();

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

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Use POST." }, 405);
  if (!supabaseUrl || !anonKey) return jsonResponse({ error: "Server configuration is incomplete." }, 500);

  try {
    let body: { username?: unknown; password?: unknown };
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Username or password is incorrect." }, 400);
    }

    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username) || password.length < 8 || password.length > 1024) {
      return jsonResponse({ error: "Username or password is incorrect." }, 401);
    }

    const profileResponse = await fetch(`${supabaseUrl}/rest/v1/rpc/lookup_auth_email_by_username`, {
      method: "POST",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_username: username }),
    });
    if (!profileResponse.ok) {
      console.error("Username lookup failed in Supabase:", profileResponse.status);
      return jsonResponse({ error: "Sign-in is temporarily unavailable." }, 502);
    }
    const email = await profileResponse.json();
    if (typeof email !== "string" || !email) {
      return jsonResponse({ error: "Username or password is incorrect." }, 401);
    }

    const tokenResponse = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    if (!tokenResponse.ok) {
      if (tokenResponse.status === 429) {
        return jsonResponse({ error: "Too many sign-in attempts. Wait a few minutes and try again." }, 429);
      }
      return jsonResponse({ error: "Username or password is incorrect." }, 401);
    }

    const session = await tokenResponse.json();
    return jsonResponse({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });
  } catch (error) {
    console.error("Username sign-in failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Sign-in is temporarily unavailable." }, 502);
  }
});
