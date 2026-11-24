const loginView = document.querySelector("#login-view");
const collectionView = document.querySelector("#collection-view");
const loginForm = document.querySelector("#login-form");
const loginButton = document.querySelector("#login-button");
const loginError = document.querySelector("#login-error");
const collectionMessage = document.querySelector("#collection-message");
const grid = document.querySelector("#game-grid");
const searchInput = document.querySelector("#game-search");
const sortSelect = document.querySelector("#game-sort");

let supabaseUrl;
let anonKey;
let currentUser;
let games = [];

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

function renderCollection() {
  const search = searchInput.value.trim().toLocaleLowerCase();
  const sortBy = sortSelect.value;
  const filtered = games.filter((game) => game.name.toLocaleLowerCase().includes(search));
  filtered.sort((a, b) => {
    if (sortBy === "plays") return b.plays - a.plays || a.name.localeCompare(b.name);
    if (sortBy === "year") return (b.year_published || 0) - (a.year_published || 0) || a.name.localeCompare(b.name);
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

searchInput.addEventListener("input", renderCollection);
sortSelect.addEventListener("change", renderCollection);

