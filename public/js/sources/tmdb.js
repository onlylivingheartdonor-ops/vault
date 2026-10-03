// TMDB (movies and TV) — requests go through Vault's server, which adds the key.
const IMG = 'https://image.tmdb.org/t/p';
const cache = new Map();

async function get(path, params = {}) {
  const qs = new URLSearchParams({ path, ...params }).toString();
  if (cache.has(qs)) return cache.get(qs);
  let res;
  try { res = await fetch(`/api/tmdb?${qs}`, { credentials: 'same-origin' }); }
  catch (e) { throw new Error('Couldn’t reach Vault. Check the internet connection.'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || `TMDB returned an error (${res.status}).`);
  cache.set(qs, data);
  return data;
}

export const img = (p, size = 'w500') => (p ? `${IMG}/${size}${p}` : null);
const yearOf = d => (d && /^\d{4}/.test(d) ? Number(d.slice(0, 4)) : null);

async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

export async function search(kind, query, page = 1) {
  const data = await get(`/search/${kind}`, { query, page: String(page), include_adult: 'false' });
  const raw = (data.results || []).slice(0, 20);
  const subs = await mapLimit(raw, 5, async r => {
    try {
      if (kind === 'movie') {
        const d = await get(`/movie/${r.id}`, { append_to_response: 'credits' });
        return ((d.credits && d.credits.crew) || []).filter(c => c.job === 'Director').map(c => c.name).join(', ').slice(0, 60);
      }
      const d = await get(`/tv/${r.id}`);
      return (d.networks && d.networks[0] && d.networks[0].name) || '';
    } catch (e) { return ''; }
  });
  const results = raw.map((r, i) => ({
    id: r.id,
    title: kind === 'movie' ? r.title : r.name,
    year: yearOf(kind === 'movie' ? r.release_date : r.first_air_date),
    subtitle: subs[i], thumb: img(r.poster_path, 'w185'), badge: null,
  }));
  return { results, has_more: page < (data.total_pages || 1), total: data.total_results || results.length };
}

function usCert(rd) {
  for (const c of (rd && rd.results) || []) {
    if (c.iso_3166_1 !== 'US') continue;
    const cert = (c.release_dates || []).map(d => d.certification).find(Boolean);
    if (cert) return cert;
  }
  return null;
}

export async function details(kind, id) {
  let data, text, title, imdbId, d;
  if (kind === 'movie') {
    d = await get(`/movie/${id}`, { append_to_response: 'credits,release_dates,external_ids' });
    const credits = d.credits || {};
    imdbId = d.imdb_id || (d.external_ids || {}).imdb_id;
    data = {
      year: yearOf(d.release_date),
      directors: (credits.crew || []).filter(c => c.job === 'Director').map(c => c.name),
      cast: (credits.cast || []).slice(0, 8).map(c => c.name),
      genres: (d.genres || []).map(g => g.name),
      runtime: d.runtime || null,
      mpaa: usCert(d.release_dates),
      studio: ((d.production_companies || [])[0] || {}).name || null,
      tmdb_score: d.vote_average ? Number(d.vote_average.toFixed(1)) : null,
      imdb: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    };
    text = d.overview ? { synopsis: d.overview } : {};
    title = d.title;
  } else {
    d = await get(`/tv/${id}`, { append_to_response: 'credits,external_ids' });
    imdbId = (d.external_ids || {}).imdb_id;
    const y1 = yearOf(d.first_air_date), y2 = yearOf(d.last_air_date);
    let years = y1 ? String(y1) : null;
    if (y1 && ['Returning Series', 'In Production'].includes(d.status)) years = `${y1}–`;
    else if (y1 && y2 && y2 !== y1) years = `${y1}–${y2}`;
    data = {
      years_aired: years,
      network: ((d.networks || [])[0] || {}).name || null,
      creators: (d.created_by || []).map(c => c.name),
      cast: ((d.credits || {}).cast || []).slice(0, 8).map(c => c.name),
      genres: (d.genres || []).map(g => g.name),
      total_seasons: d.number_of_seasons || null,
      tmdb_score: d.vote_average ? Number(d.vote_average.toFixed(1)) : null,
      imdb: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
    };
    text = d.overview ? { synopsis: d.overview } : {};
    title = d.name;
  }
  const clean = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) clean[k] = v;
  return {
    title, data: clean, text,
    ids: { tmdb_id: Number(id), imdb_id: imdbId || null },
    cover_url: img(d.poster_path, 'w780'), thumb_url: img(d.poster_path, 'w342'),
    backdrop_url: img(d.backdrop_path, 'w1280'),
  };
}

export async function test() {
  await get('/configuration');
  return 'Connected to TMDB.';
}
