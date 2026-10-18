// RAWG video game database (https://rawg.io/apidocs): ratings, images and
// details for saved games. Needs the RAWG_API_KEY secret; without it every
// lookup returns null and Botdog carries on without game details.
//
// RAWG's free plan asks for a link back to RAWG wherever its data is shown,
// so every embed links to the game's RAWG page and says "Data from RAWG".

const API = "https://api.rawg.io/api";
export const RAWG_SITE = "https://rawg.io";
const USER_AGENT = "Botdog (https://github.com/AdrianClarkeQA/Hotdog-Bot)";

// A lookup that takes longer than this is abandoned, so a slow RAWG never
// holds up a Discord reply for long.
const TIMEOUT_MS = 5000;

// An exact-name match needs at least this many RAWG users to win outright.
// Stops "Halo" matching a tiny itch.io game called "Halo" over the real series.
const MIN_POPULAR = 100;

export const hasRawg = (env) => Boolean(env.RAWG_API_KEY);

async function get(env, path, params = {}) {
  if (!hasRawg(env)) return null;
  const url = new URL(`${API}${path}`);
  url.searchParams.set("key", env.RAWG_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    // The key is in the URL, so log the path only.
    console.error(`RAWG ${path} failed:`, err.message);
    return null;
  }
}

// Lowercase letters and digits only, so "HELLDIVERS 2" matches "Helldivers 2"
// and "Halo: Reach" matches "halo reach".
export function normaliseName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Picks the search result that's most likely the game meant, or null.
//  1. An exact name match that's reasonably popular (the most popular one).
//  2. Otherwise the most popular result whose name starts with the search
//     ("Halo" -> Halo Infinite rather than an obscure exact match).
//  3. Otherwise an exact match of any popularity.
// Anything else (names that only share a word or two) counts as not found.
export function pickResult(query, results) {
  const q = normaliseName(query);
  if (!q || !Array.isArray(results)) return null;
  const byPopularity = (a, b) => (b.added ?? 0) - (a.added ?? 0);
  const exact = results.filter((r) => normaliseName(r.name) === q).sort(byPopularity);
  if (exact[0] && (exact[0].added ?? 0) >= MIN_POPULAR) return exact[0];
  const prefix = results
    .filter((r) => normaliseName(r.name).startsWith(`${q} `))
    .sort(byPopularity);
  return prefix[0] ?? exact[0] ?? null;
}

// Co-op labels from RAWG's community tags, most specific first.
const COOP_TAGS = [
  ["online-co-op", "Online co-op"],
  ["local-co-op", "Local co-op"],
  ["split-screen", "Split-screen"],
];

export function coopModes(tags) {
  const slugs = new Set((tags ?? []).map((t) => t.slug));
  const modes = COOP_TAGS.filter(([slug]) => slugs.has(slug)).map(([, label]) => label);
  if (!modes.length && (slugs.has("co-op") || slugs.has("cooperative"))) modes.push("Co-op");
  return modes;
}

const names = (list, key) => (list ?? []).map((x) => x?.[key]?.name ?? x?.name).filter(Boolean);

// The fields Botdog saves for a game, from either a search result or the
// full game record (both have the same shape for these).
export function summarise(game) {
  if (!game?.id) return null;
  const platforms = game.parent_platforms?.length
    ? names(game.parent_platforms, "platform")
    : names(game.platforms, "platform");
  return {
    rawg_id: game.id,
    rawg_slug: game.slug ?? null,
    rawg_name: game.name ?? null,
    image_url: game.background_image ?? null,
    metacritic: Number.isFinite(game.metacritic) ? game.metacritic : null,
    rawg_rating: game.ratings_count > 0 && game.rating > 0 ? game.rating : null,
    rawg_ratings_count: game.ratings_count ?? null,
    released: game.tba ? "TBA" : game.released ?? null,
    playtime: game.playtime > 0 ? game.playtime : null,
    genres: names(game.genres).join(", ") || null,
    platforms: platforms.join(", ") || null,
    coop_modes: coopModes(game.tags).join(", ") || null,
  };
}

// Searches RAWG for a game by name. Returns its summary, or null if there's
// no convincing match (or RAWG couldn't be reached).
export async function findOnRawg(env, name) {
  const data = await get(env, "/games", { search: name, search_precise: "true", page_size: "10" });
  return summarise(pickResult(name, data?.results));
}

// The full record for one game, by RAWG id or slug: everything in the
// summary plus the description, stores and age rating. Null if not found.
export async function rawgDetails(env, idOrSlug) {
  const game = await get(env, `/games/${encodeURIComponent(idOrSlug)}`);
  if (!game?.id) return null;
  return {
    ...summarise(game),
    description: game.description_raw ?? null,
    stores: names(game.stores, "store").join(", ") || null,
    age_rating: game.esrb_rating?.name ?? null,
    extra_image: game.background_image_additional ?? null,
  };
}

// Reads a RAWG game page link (or a bare slug) and returns the slug, or null.
//   https://rawg.io/games/deep-rock-galactic  ->  deep-rock-galactic
export function slugFromLink(text) {
  const raw = String(text ?? "").trim();
  const m = /rawg\.io\/games\/([a-z0-9-]+)/i.exec(raw);
  if (m) return m[1].toLowerCase();
  return /^[a-z0-9-]+$/i.test(raw) ? raw.toLowerCase() : null;
}

export const rawgPage = (slug) => (slug ? `${RAWG_SITE}/games/${slug}` : RAWG_SITE);
