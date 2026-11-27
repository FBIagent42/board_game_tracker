const loginView = document.querySelector("#login-view");
const collectionView = document.querySelector("#collection-view");
const gameSearchView = document.querySelector("#game-search-view");
const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const signUpEmailFields = document.querySelector("#sign-up-email-fields");
const authUsernameInput = document.querySelector("#auth-username");
const signupEmailInput = document.querySelector("#signup-email");
const passwordInput = document.querySelector("#password");
const authNote = document.querySelector("#auth-note");
const collectionMessage = document.querySelector("#collection-message");
const grid = document.querySelector("#game-grid");
const searchInput = document.querySelector("#game-search");
const sortSelect = document.querySelector("#game-sort");
const collectionExpansionFilter = document.querySelector("#collection-expansion-filter");
const catalogInput = document.querySelector("#catalog-query");
const catalogExpansionFilter = document.querySelector("#catalog-expansion-filter");
const catalogStatus = document.querySelector("#catalog-status");
const catalogResults = document.querySelector("#catalog-results");
const bggImportDialog = document.querySelector("#bgg-import-dialog");
const bggConnectionForm = document.querySelector("#bgg-connection-form");
const bggImportStatus = document.querySelector("#bgg-import-status");
const saveBggButton = document.querySelector("#save-bgg-username");
const importBggButton = document.querySelector("#import-bgg-collection");
const bggUsernameInput = document.querySelector("#bgg-username");
const bggConnectionStatus = document.querySelector("#bgg-connection-status");

let supabaseUrl;
let anonKey;
let supabaseClient;
let configPromise;
let currentSession;
let currentUser;
let games = [];
let authMode = "sign-in";
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
  if (supabaseClient) return;
  if (!configPromise) {
    configPromise = (async () => {
      const response = await fetch("./config.public.json", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the public Supabase settings.");
      const config = await response.json();
      supabaseUrl = config.SUPABASE_URL?.replace(/\/$/, "");
      anonKey = config.SUPABASE_ANON_KEY;
      if (!supabaseUrl || !anonKey) throw new Error("Supabase URL or anon key is missing from config.public.json.");
      if (!window.supabase?.createClient) throw new Error("Could not load the Supabase browser client.");
      supabaseClient = window.supabase.createClient(supabaseUrl, anonKey, {
        auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true },
      });
      supabaseClient.auth.onAuthStateChange((event, session) => {
        currentSession = session;
        if (event === "SIGNED_OUT") showLoginView();
      });
    })();
  }
  await configPromise;
}

async function supabaseGet(table, params) {
  const url = new URL(`${supabaseUrl}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    headers: { apikey: anonKey, Authorization: `Bearer ${currentSession?.access_token || anonKey}` },
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.message || `Database request failed (${response.status}).`);
  }
  return response.json();
}

function setLoading(loading) {
  loginButton.disabled = loading;
  loginButton.innerHTML = loading
    ? (authMode === "sign-up" ? "Creating account…" : "Signing in…")
    : `${authMode === "sign-up" ? "Create account" : "Sign in"} <span aria-hidden="true">→</span>`;
}

function showMessage(element, text, isError = false) {
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle("error", isError);
}

async function loadCollection() {
  const rows = await supabaseGet("user_collection", {
    select: "game_id,numplays,own,date_added,game:game(name,year_published,min_players,max_players,manufacturer_playtime,image_url,is_expansion)",
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
}

async function openUserSession(session) {
  currentSession = session;
  const users = await supabaseGet("user", {
    select: "user_id,username,bgg_username",
    auth_user_id: `eq.${session.user.id}`,
    limit: "1",
  });
  if (!users.length) throw new Error("Your account profile is still being created. Please sign out and try again shortly.");

  currentUser = users[0];
  await loadCollection();
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

function filterGamesByExpansion(gameList, filter) {
  if (filter === "expansions") return gameList.filter((game) => game.is_expansion === true);
  if (filter === "base") return gameList.filter((game) => game.is_expansion === false);
  return gameList;
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
        Authorization: `Bearer ${currentSession?.access_token || anonKey}`,
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
    const searchParams = {
      select: "game_id,name,is_expansion,description,year_published,game_weight,min_players,max_players,manufacturer_playtime,community_min_playtime,community_max_playtime,manufacturer_age_rec,image_url,bgg_last_checked_at",
      name: `ilike.%${query}%`,
      order: "name.asc",
      limit: "80",
    };
    if (catalogExpansionFilter.value === "expansions") searchParams.is_expansion = "eq.true";
    if (catalogExpansionFilter.value === "base") searchParams.is_expansion = "eq.false";
    const matches = await supabaseGet("game", searchParams);
    if (requestId !== activeSearch) return;

    const normalizedQuery = normalizeTitle(query);
    matches.sort((a, b) =>
      titleSimilarity(a.name, normalizedQuery) - titleSimilarity(b.name, normalizedQuery)
      || a.name.length - b.name.length
      || a.name.localeCompare(b.name)
    );
    const expansionMatches = matches;
    const visibleMatches = expansionMatches.slice(0, 25);
    renderCatalogResults(visibleMatches);
    const incompleteMatches = visibleMatches.filter(needsBggData);
    if (incompleteMatches.length) {
      enrichmentTimer = setTimeout(
        () => enrichMissingGames(visibleMatches, query, requestId),
        BGG_ENRICHMENT_DELAY_MS,
      );
    }
    showMessage(catalogStatus, expansionMatches.length
      ? incompleteMatches.length
        ? `Showing ${Math.min(expansionMatches.length, 25)} of ${expansionMatches.length} title matches. Missing BGG details load if you stay on this search for 5 seconds.`
        : `Showing ${Math.min(expansionMatches.length, 25)} of ${expansionMatches.length} title matches.`
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
    const alreadyOwned = games.some((ownedGame) => Number(ownedGame.id) === Number(game.game_id));
    return `<article class="game-card catalog-card">
      <div class="game-cover">${image}</div>
      <div class="game-info">
        <p class="game-year">${game.year_published || "Year unknown"}</p>
        <h2>${escapeHtml(game.name)}</h2>
        <p class="game-meta">${players}<span aria-hidden="true"> · </span>${duration}</p>
        <button class="add-game-button" type="button" data-add-game="${Number(game.game_id)}" ${alreadyOwned ? "disabled" : ""}>
          ${alreadyOwned ? "In your collection" : "Add to collection"}
        </button>
      </div>
    </article>`;
  }).join("");
}

async function addGameToCollection(gameId, button) {
  if (!currentSession || !currentUser) {
    showMessage(catalogStatus, "Sign in to add games to your collection.", true);
    return;
  }
  button.disabled = true;
  button.textContent = "Adding…";
  try {
    const { error } = await supabaseClient.rpc("add_game_to_my_collection", {
      p_game_id: Number(gameId),
    });
    if (error) throw error;
    await loadCollection();
    button.textContent = "In your collection";
    showMessage(catalogStatus, "Game added to your collection.");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Add to collection";
    showMessage(catalogStatus, error.message || "Could not add this game.", true);
  }
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === "sign-up";
  signUpEmailFields.hidden = !isSignUp;
  signupEmailInput.required = isSignUp;
  authUsernameInput.placeholder = isSignUp ? "Choose a username" : "Your username";
  passwordInput.autocomplete = isSignUp ? "new-password" : "current-password";
  document.querySelector("#auth-sign-in-mode").classList.toggle("active", !isSignUp);
  document.querySelector("#auth-sign-up-mode").classList.toggle("active", isSignUp);
  document.querySelector("#auth-sign-in-mode").setAttribute("aria-pressed", String(!isSignUp));
  document.querySelector("#auth-sign-up-mode").setAttribute("aria-pressed", String(isSignUp));
  loginButton.innerHTML = `${isSignUp ? "Create account" : "Sign in"} <span aria-hidden="true">→</span>`;
  authNote.textContent = isSignUp
    ? "Email is required by Supabase. Email confirmation is disabled; sign in with your username and password."
    : "Sign in with your Game Shelf username and password.";
  showMessage(loginError, "");
}

async function submitAuthForm() {
  await loadConfig();
  const username = authUsernameInput.value.trim();
  const password = passwordInput.value;
  if (authMode === "sign-up") {
    const email = signupEmailInput.value.trim();
    const { data, error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: { username },
      },
    });
    if (error) throw error;
    if (data.session) {
      await openUserSession(data.session);
      return;
    }
    throw new Error("Supabase did not start a session. Check that email confirmation is disabled in Supabase Auth.");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/username-sign-in`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Username or password is incorrect.");
  const { data, error } = await supabaseClient.auth.setSession({
    access_token: result.access_token,
    refresh_token: result.refresh_token,
  });
  if (error) throw error;
  await openUserSession(data.session);
}

async function saveBggUsername(event) {
  event.preventDefault();
  saveBggButton.disabled = true;
  saveBggButton.textContent = "Saving…";
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/user?user_id=eq.${currentUser.user_id}`, {
      method: "PATCH",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${currentSession.access_token}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ bgg_username: bggUsernameInput.value.trim() }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.message || `Could not save the BGG username (${response.status}).`);
    }
    currentUser.bgg_username = bggUsernameInput.value.trim();
    renderCollection();
    bggImportDialog.close();
    showMessage(collectionMessage, `Connected BGG username ${currentUser.bgg_username}.`);
  } catch (error) {
    showMessage(bggImportStatus, error.message || "Could not save the BGG username.", true);
  } finally {
    saveBggButton.disabled = false;
    saveBggButton.textContent = "Save BGG username";
  }
}

async function importBggCollection() {
  if (!currentSession || !currentUser?.bgg_username) return;
  importBggButton.disabled = true;
  importBggButton.textContent = "Importing…";
  showMessage(collectionMessage, "Fetching your BGG collection. This can take a little while.");
  try {
    const response = await fetch(`${supabaseUrl}/functions/v1/bgg-import-collection`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${currentSession.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Collection import failed (${response.status}).`);
    await loadCollection();
    showMessage(
      collectionMessage,
      `Imported ${result.collection_rows} BGG items; added ${result.new_games} missing catalog games and refreshed details for ${result.enriched_games || 0}.${result.enrichment_warning ? ` BGG detail refresh: ${result.enrichment_warning}` : ""}`,
    );
  } catch (error) {
    showMessage(collectionMessage, error.message || "Could not import the BGG collection.", true);
  } finally {
    importBggButton.disabled = !currentUser?.bgg_username;
    importBggButton.textContent = "Import BGG collection";
  }
}

function renderCollection() {
  const search = searchInput.value.trim().toLocaleLowerCase();
  const sortBy = sortSelect.value;
  const searched = games.filter((game) => game.name.toLocaleLowerCase().includes(search));
  const filtered = filterGamesByExpansion(searched, collectionExpansionFilter.value);
  filtered.sort((a, b) => {
    if (sortBy === "plays_asc") return a.plays - b.plays || a.name.localeCompare(b.name);
    if (sortBy === "plays_desc") return b.plays - a.plays || a.name.localeCompare(b.name);
    if (sortBy === "year_asc") return (a.year_published || 0) - (b.year_published || 0) || a.name.localeCompare(b.name);
    if (sortBy === "year_desc") return (b.year_published || 0) - (a.year_published || 0) || a.name.localeCompare(b.name);
    if (sortBy === "name_desc") return b.name.localeCompare(a.name);
    return a.name.localeCompare(b.name);
  });

  document.querySelector("#welcome-user").textContent = `Signed in as ${currentUser.username}`;
  const bggConnected = Boolean(currentUser.bgg_username);
  bggConnectionStatus.textContent = bggConnected ? `BGG: ${currentUser.bgg_username}` : "BGG not connected";
  importBggButton.disabled = !bggConnected;
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

function showLoginView() {
  currentSession = null;
  currentUser = null;
  games = [];
  loginForm.reset();
  searchInput.value = "";
  collectionView.hidden = true;
  gameSearchView.hidden = true;
  loginView.hidden = false;
  setAuthMode("sign-in");
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage(loginError, "");
  setLoading(true);
  try {
    await submitAuthForm();
  } catch (error) {
    showMessage(loginError, error.message || "Could not sign in.", true);
  } finally {
    setLoading(false);
  }
});

document.querySelector("#auth-sign-in-mode").addEventListener("click", () => setAuthMode("sign-in"));
document.querySelector("#auth-sign-up-mode").addEventListener("click", () => setAuthMode("sign-up"));
document.querySelector("#sign-out").addEventListener("click", async () => {
  if (supabaseClient) await supabaseClient.auth.signOut();
  showLoginView();
});

document.querySelector("#open-game-search").addEventListener("click", openCatalogSearch);
catalogResults.addEventListener("click", (event) => {
  const button = event.target.closest("[data-add-game]");
  if (button) void addGameToCollection(button.dataset.addGame, button);
});
document.querySelector("#connect-bgg").addEventListener("click", () => {
  showMessage(bggImportStatus, "");
  bggUsernameInput.value = currentUser?.bgg_username || "";
  bggImportDialog.showModal();
});
importBggButton.addEventListener("click", () => void importBggCollection());
document.querySelector("#cancel-bgg-import").addEventListener("click", () => bggImportDialog.close());
bggConnectionForm.addEventListener("submit", (event) => void saveBggUsername(event));
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
collectionExpansionFilter.addEventListener("change", renderCollection);
catalogExpansionFilter.addEventListener("change", () => {
  clearTimeout(searchTimer);
  searchCatalog(catalogInput.value);
});

(async function initializeApp() {
  try {
    await loadConfig();
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    if (data.session) await openUserSession(data.session);
  } catch (error) {
    showMessage(loginError, error.message || "Could not connect to Supabase.", true);
  }
})();

