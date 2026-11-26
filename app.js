const loginView = document.querySelector("#login-view");
const collectionView = document.querySelector("#collection-view");
const gameSearchView = document.querySelector("#game-search-view");
const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const collectionMessage = document.querySelector("#collection-message");
const grid = document.querySelector("#game-grid");
const searchInput = document.querySelector("#game-search");
const sortSelect = document.querySelector("#game-sort");
const catalogInput = document.querySelector("#catalog-query");
const catalogStatus = document.querySelector("#catalog-status");
const catalogResults = document.querySelector("#catalog-results");

let supabaseUrl;
let anonKey;
let currentUser;
let games = [];
let searchTimer;
let enrichmentTimer;
let activeSearch = 0;

const BGG_ENRICHMENT_DELAY_MS = 5000;
const BGG_CHECK_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;
const CORE_GAME_FIELDS = [
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

async function loadConfig() {
  const response = await fetch("./config.public.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Could not load the public Supabase settings.");
  const config = await response.json();
  supabaseUrl = config.SUPABASE_URL?.replace(/\/$/, "");
  anonKey = config.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) throw new Error("Supabase URL or anon key is missing from config.public.json.");
}

async function supabaseGet(table, params) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.message || `Database request failed (${response.status}).`);
  }
  return response.json();
}

function setLoading(loading) {
  loginButton.disabled = loading;
  loginButton.innerHTML = loading ? "Opening your shelf…" : 'View my collection <span aria-hidden="true">→</span>';
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle("error", isError);
}

async function signIn(username) {
  await loadConfig();
  const users = await supabaseGet("user", {
    select: "user_id,username",
    username: `eq.${username}`,
    limit: "1",
  });
  if (!users.length) throw new Error("We couldn't find that username. Check it and try again.");

  currentUser = users[0];
  const rows = await supabaseGet("user_collection", {
    select: "game_id,numplays,own,date_added,game:game(name,year_published,min_players,max_players,manufacturer_playtime,image_url)",
    user_id: `eq.${currentUser.user_id}`,
    own: "eq.true",
  });
  games = rows.map((row) => ({
    id: row.game_id,
    plays: Number(row.numplays || 0),
    dateAdded: row.date_added,
    ...(Array.isArray(row.game) ? row.game[0] : row.game),
  })).filter((game) => game.name);
  renderCollection();
  loginView.hidden = true;
  collectionView.hidden = false;
}

function openCatalogSearch() {
  activeSearch += 1;
  clearTimeout(enrichmentTimer);
  collectionView.hidden = true;
  gameSearchView.hidden = false;
  catalogInput.value = "";
  catalogResults.innerHTML = "";
  showMessage(catalogStatus, "Start typing to search games.");
  catalogInput.focus();
}

function normalizeTitle(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().trim();
}

function titleSimilarity(title, query) {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle === query) return 0;
  if (normalizedTitle.startsWith(query)) return 1;
  if (normalizedTitle.split(/\s+/).some((word) => word.startsWith(query))) return 2;
  if (normalizedTitle.includes(query)) return 3;
  return 4;
}

function needsBggData(game) {
  const incomplete = CORE_GAME_FIELDS.some((field) =>
    game[field] === null || game[field] === undefined
      || (typeof game[field] === "string" && game[field].trim() === "")
  );
  if (!incomplete) return false;
  if (!game.bgg_last_checked_at) return true;
  const lastChecked = Date.parse(game.bgg_last_checked_at);
  return !Number.isFinite(lastChecked) || Date.now() - lastChecked >= BGG_CHECK_COOLDOWN_MS;
}

async function enrichMissingGames(targetGames, query, requestId) {
  const ids = targetGames.filter(needsBggData).map((game) => game.game_id);
  if (!ids.length) return;

  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/bgg-enrich`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ game_ids: ids }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const retrySeconds = response.headers.get("Retry-After");
      if (requestId === activeSearch && catalogInput.value.trim() === query) {
        showMessage(
          catalogStatus,
          retrySeconds
            ? "BGG requests are busy. Missing details will be tried again on your next search."
            : (result.error || "Could not update missing BGG details right now."),
          true,
        );
      }
      return;
    }
    if (requestId !== activeSearch || catalogInput.value.trim() !== query) return;

    const updatedById = new Map((result.games || []).map((game) => [Number(game.game_id), game]));
    const updatedResults = targetGames.map((game) => ({ ...game, ...(updatedById.get(Number(game.game_id)) || {}) }));
    renderCatalogResults(updatedResults);
    if (result.enriched) {
      showMessage(catalogStatus, `Loaded BGG details for ${result.enriched} game${result.enriched === 1 ? "" : "s"}.`);
    } else {
      showMessage(catalogStatus, "Search results are up to date.");
    }
  } catch (error) {
    if (requestId !== activeSearch || catalogInput.value.trim() !== query) return;
    showMessage(catalogStatus, error.message || "Could not update missing BGG details right now.", true);
  }
}

async function searchCatalog(rawQuery) {
  clearTimeout(enrichmentTimer);
  const query = rawQuery.trim();
  const requestId = ++activeSearch;
  catalogResults.innerHTML = "";
  if (query.length < 2) {
    showMessage(catalogStatus, "Type at least two characters to search.");
    return;
  }

  showMessage(catalogStatus, "Searching the game catalog…");
  try {
    const matches = await supabaseGet("game", {
      select: "game_id,name,description,year_published,game_weight,min_players,max_players,manufacturer_playtime,community_min_playtime,community_max_playtime,manufacturer_age_rec,image_url,bgg_last_checked_at",
      name: `ilike.%${query}%`,
      order: "name.asc",
      limit: "80",
    });
    if (requestId !== activeSearch) return;

    const normalizedQuery = normalizeTitle(query);
    matches.sort((a, b) =>
      titleSimilarity(a.name, normalizedQuery) - titleSimilarity(b.name, normalizedQuery)
      || a.name.length - b.name.length
      || a.name.localeCompare(b.name)
    );
    const visibleMatches = matches.slice(0, 25);
    renderCatalogResults(visibleMatches);
    const incompleteMatches = visibleMatches.filter(needsBggData);
    if (incompleteMatches.length) {
      enrichmentTimer = setTimeout(
        () => enrichMissingGames(visibleMatches, query, requestId),
        BGG_ENRICHMENT_DELAY_MS,
      );
    }
    showMessage(catalogStatus, matches.length
      ? incompleteMatches.length
        ? `Showing the best ${Math.min(matches.length, 25)} results from up to ${matches.length} title matches. Missing BGG details load if you stay on this search for 5 seconds.`
        : `Showing the best ${Math.min(matches.length, 25)} results from up to ${matches.length} title matches. Adding games to your collection will be enabled after authentication is set up.`
      : "No matching titles found. Try another search.");
  } catch (error) {
    if (requestId !== activeSearch) return;
    showMessage(catalogStatus, error.message || "Could not search the catalog.", true);
  }
}

function renderCatalogResults(results) {
  if (!results.length) {
    catalogResults.innerHTML = "";
    return;
  }
  catalogResults.innerHTML = results.map((game) => {
    const image = game.image_url
      ? `<img src="${escapeHtml(game.image_url)}" alt="" loading="lazy" />`
      : '<span class="cover-placeholder" aria-hidden="true">🎲</span>';
    const players = game.min_players && game.max_players
      ? `${game.min_players}–${game.max_players} players`
      : "Player count not listed";
    const duration = game.manufacturer_playtime ? `${game.manufacturer_playtime} min` : "Time not listed";
    return `<article class="game-card catalog-card">
      <div class="game-cover">${image}</div>
      <div class="game-info">
        <p class="game-year">${game.year_published || "Year unknown"}</p>
        <h2>${escapeHtml(game.name)}</h2>
        <p class="game-meta">${players}<span aria-hidden="true"> · </span>${duration}</p>
      </div>
    </article>`;
  }).join("");
}

function renderCollection() {
  const search = searchInput.value.trim().toLocaleLowerCase();
  const sortBy = sortSelect.value;
  const filtered = games.filter((game) => game.name.toLocaleLowerCase().includes(search));
  filtered.sort((a, b) => {
    if (sortBy === "plays_asc") return a.plays - b.plays || a.name.localeCompare(b.name);
    if (sortBy === "plays_desc") return b.plays - a.plays || a.name.localeCompare(b.name);
    if (sortBy === "year_asc") return (a.year_published || 0) - (b.year_published || 0) || a.name.localeCompare(b.name);
    if (sortBy === "year_desc") return (b.year_published || 0) - (a.year_published || 0) || a.name.localeCompare(b.name);
    if (sortBy === "name_desc") return b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name);
  });

  document.querySelector("#welcome-user").textContent = `Signed in as ${currentUser.username}`;
  document.querySelector("#game-count").textContent = games.length;
  document.querySelector("#play-count").textContent = games.reduce((sum, game) => sum + game.plays, 0);
  document.querySelector("#showing-count").textContent = `${filtered.length} / ${games.length}`;

  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state"><span aria-hidden="true">◌</span><h2>No games found</h2><p>Try another search.</p></div>';
    return;
  }

  grid.innerHTML = filtered.map((game) => {
    const image = game.image_url
      ? `<img src="${escapeHtml(game.image_url)}" alt="" loading="lazy" />`
      : '<span class="cover-placeholder" aria-hidden="true">🎲</span>';
    const players = game.min_players && game.max_players
      ? `${game.min_players}–${game.max_players} players`
      : "Player count not listed";
    const duration = game.manufacturer_playtime ? `${game.manufacturer_playtime} min` : "Time not listed";
    const year = game.year_published || "Year unknown";
    return `<article class="game-card">
      <div class="game-cover">${image}<span class="play-badge">${game.plays} ${game.plays === 1 ? "play" : "plays"}</span></div>
      <div class="game-info">
        <p class="game-year">${year}</p>
        <h2>${escapeHtml(game.name)}</h2>
        <p class="game-meta">${players}<span aria-hidden="true"> · </span>${duration}</p>
      </div>
    </article>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(loginError, "");
  setLoading(true);
  const username = new FormData(loginForm).get("username").trim();
  try {
    await signIn(username);
  } catch (error) {
    showMessage(loginError, error.message || "Could not load your collection.", true);
  } finally {
    setLoading(false);
  }
});

document.querySelector("#sign-out").addEventListener("click", () => {
  currentUser = null;
  games = [];
  loginForm.reset();
  searchInput.value = "";
  collectionView.hidden = true;
  loginView.hidden = false;
  loginForm.querySelector("input").focus();
});

document.querySelector("#open-game-search").addEventListener("click", openCatalogSearch);
document.querySelector("#back-to-collection").addEventListener("click", () => {
  activeSearch += 1;
  clearTimeout(searchTimer);
  clearTimeout(enrichmentTimer);
  gameSearchView.hidden = true;
  collectionView.hidden = false;
});
catalogInput.addEventListener("input", () => {
  activeSearch += 1;
  clearTimeout(searchTimer);
  clearTimeout(enrichmentTimer);
  const query = catalogInput.value;
  searchTimer = setTimeout(() => searchCatalog(query), 250);
});

searchInput.addEventListener("input", renderCollection);
sortSelect.addEventListener("change", renderCollection);

