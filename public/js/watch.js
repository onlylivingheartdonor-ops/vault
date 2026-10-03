// "Where to watch": free streaming availability from JustWatch (via TMDB) and Watchmode,
// plus public-domain films on the Internet Archive.
import { icon } from './icons.js';
import { api, esc, today, getItems, S, fmtDate } from './util.js';

const LOGO = p => (p ? `https://image.tmdb.org/t/p/w92${p}` : null);
const RECHECK_DAYS = 30;
const ARCHIVE_MAX_YEAR = 1980;     // public-domain features are almost all older than this

export const ATTRIBUTION = `Free-streaming information from <a class="ext" href="https://www.justwatch.com" target="_blank" rel="noopener">JustWatch</a> (provided through <a class="ext" href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>) and <a class="ext" href="https://www.watchmode.com" target="_blank" rel="noopener">Watchmode</a>.`;

// ---------------------------------------------------------------- lookups
async function tmdbGet(path) {
  const res = await fetch(`/api/tmdb?${new URLSearchParams({ path })}`, { credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || (data && data.ok === false)) throw new Error((data && data.error) || `TMDB returned an error (${res.status}).`);
  return data;
}

const kindOf = type => (type === 'tv' ? 'tv' : 'movie');
const mapProviders = list => (list || []).map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path || null }))
  .filter((p, i, a) => a.findIndex(x => x.id === p.id) === i);

// Free and free-with-ads services in the US for one TMDB title.
export async function providersFor(type, tmdbId) {
  const d = await tmdbGet(`/${kindOf(type)}/${tmdbId}/watch/providers`);
  const us = (d.results || {}).US || {};
  return { link: us.link || null, free: mapProviders(us.free), ads: mapProviders(us.ads) };
}

// ---- Watchmode
async function wmGet(path) {
  const res = await fetch(`/api/watchmode?${new URLSearchParams({ path })}`, { credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok || (data && data.ok === false)) {
    const err = new Error((data && data.error) || `Watchmode returned an error (${res.status}).`);
    err.budget = !!(data && data.budget);
    throw err;
  }
  return data;
}

// Logos for Watchmode's services: fetched once a week and kept in this browser.
let wmLogoCache = null;
async function wmLogos() {
  if (wmLogoCache) return wmLogoCache;
  try {
    const saved = JSON.parse(localStorage.getItem('vault:wm-logos') || 'null');
    if (saved && Date.now() - saved.t < 7 * 86400000) { wmLogoCache = saved.map; return wmLogoCache; }
  } catch (e) { /* ignore */ }
  try {
    const list = await wmGet('/sources/');
    const map = {};
    for (const src of list || []) map[src.id] = src.logo_100px || null;
    wmLogoCache = map;
    try { localStorage.setItem('vault:wm-logos', JSON.stringify({ t: Date.now(), map })); } catch (e) { /* ignore */ }
  } catch (e) { wmLogoCache = {}; }
  return wmLogoCache;
}

export const hasWatchmode = () => !!(S.settings && S.settings.has_watchmode_key);

// Free services Watchmode lists for a TMDB title, each with a direct web link.
export async function watchmodeFor(type, tmdbId) {
  const rows = await wmGet(`/title/${kindOf(type)}-${tmdbId}/sources/`);
  const logos = await wmLogos();
  const seen = new Set();
  const list = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.type !== 'free' || (r.region && r.region !== 'US')) continue;
    if (seen.has(r.source_id)) continue;
    seen.add(r.source_id);
    list.push({ id: r.source_id, name: r.name, url: r.web_url || null, logo: logos[r.source_id] || null });
  }
  return list;
}

const norm = t => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ').trim();

// "Tubi TV" and "Tubi", "The Roku Channel" and "Roku Channel" are the same service.
const serviceKey = n => String(n || '').toLowerCase().replace(/^the\s+/, '').replace(/\b(tv|free|channel)\b/g, '')
  .replace(/[^a-z0-9]+/g, '');

// One combined list of free services from both sources. JustWatch says whether ads are shown;
// Watchmode supplies the direct links.
export function mergedServices(w) {
  if (!w) return [];
  const out = new Map();
  const add = (p, extra) => {
    const k = serviceKey(p.name);
    const cur = out.get(k) || { name: p.name, logo: null, url: null, ads: false };
    cur.logo = cur.logo || (p.logo ? (String(p.logo).startsWith('http') ? p.logo : LOGO(p.logo)) : null);
    cur.url = cur.url || p.url || null;
    Object.assign(cur, extra);
    out.set(k, cur);
  };
  (w.free || []).forEach(p => add(p, {}));
  (w.ads || []).forEach(p => add(p, { ads: true }));
  ((w.wm && w.wm.list) || []).forEach(p => add(p, {}));
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function yearOfDoc(d) {
  const y = Array.isArray(d.year) ? d.year[0] : d.year;
  if (y && /^\d{4}/.test(String(y))) return Number(String(y).slice(0, 4));
  const dt = Array.isArray(d.date) ? d.date[0] : d.date;
  return dt && /^\d{4}/.test(String(dt)) ? Number(String(dt).slice(0, 4)) : null;
}

// Best public-domain match on the Internet Archive, or null. Matches title closely and year within one.
export async function archiveCandidate(item) {
  const title = item.title;
  const year = Number(item.data.year || String(item.data.years_aired || '').slice(0, 4)) || null;
  const r = await fetch(`/api/archive?${new URLSearchParams({ title, kind: kindOf(item.type) })}`, { credentials: 'same-origin' });
  if (!r.ok) return null;
  let j;
  try { j = await r.json(); } catch (e) { return null; }
  const docs = (j.response && j.response.docs) || [];
  const want = norm(title);
  const scored = [];
  for (const d of docs) {
    const t = Array.isArray(d.title) ? d.title[0] : d.title;
    const n = norm(t);
    const dy = yearOfDoc(d);
    let score = 0;
    if (n === want) score += 3;
    else if (n.startsWith(want) || want.startsWith(n)) score += 2;
    else continue;
    if (year && dy) {
      if (Math.abs(dy - year) <= 1) score += 2;
      else continue;   // wrong film with the same name
    }
    scored.push({ score, id: d.identifier, title: t, year: dy, downloads: Number(d.downloads) || 0 });
  }
  scored.sort((a, b) => (b.score - a.score) || (b.downloads - a.downloads));
  return scored.length ? { id: scored[0].id, title: scored[0].title, year: scored[0].year } : null;
}

function wantsArchiveCheck(item) {
  if (item.data.archive !== undefined) return false;   // already confirmed or declined
  const y = Number(item.data.year || String(item.data.years_aired || '').slice(0, 4)) || null;
  return !y || y <= ARCHIVE_MAX_YEAR;
}

// Check one item, save the result into its data.watch, and return it.
// JustWatch is checked every time; Watchmode only when asked (its free plan is limited), otherwise
// the previous Watchmode result is kept.
export async function checkItem(item, { watchmode = false } = {}) {
  const prev = item.data.watch || {};
  const watch = { checked: today(), link: null, free: [], ads: [], archive_candidate: null, wm: prev.wm || null };
  if (item.tmdb_id) {
    try { Object.assign(watch, await providersFor(item.type, item.tmdb_id)); } catch (e) { /* keep empty */ }
    if (watchmode && hasWatchmode()) {
      try { watch.wm = { checked: today(), list: await watchmodeFor(item.type, item.tmdb_id) }; }
      catch (e) { if (e.budget) watch.wm = prev.wm || null; }
    }
  }
  if (wantsArchiveCheck(item)) {
    try { watch.archive_candidate = await archiveCandidate(item); } catch (e) { /* skip */ }
  }
  await api(`/api/items/${item.id}/data`, { method: 'PATCH', body: { watch } });
  item.data.watch = watch;
  return watch;
}

// Free service names for a title that isn't in Vault yet (used on the Add pages).
export async function freeNamesFor(type, tmdbId, { watchmode = false } = {}) {
  const w = await providersFor(type, tmdbId);
  if (watchmode && hasWatchmode()) {
    try { w.wm = { list: await watchmodeFor(type, tmdbId) }; } catch (e) { /* skip */ }
  }
  return mergedServices(w).map(x => x.name);
}

export async function setArchive(item, value) {
  await api(`/api/items/${item.id}/data`, { method: 'PATCH', body: { archive: value } });
  item.data.archive = value;
}

export async function setMoviesAnywhereUrl(item, url) {
  await api(`/api/items/${item.id}/data`, { method: 'PATCH', body: { ma_url: url || null } });
  item.data.ma_url = url || null;
}

export function isFreeToWatch(item) {
  const w = item.data && item.data.watch;
  return !!(mergedServices(w).length || (item.data.archive && item.data.archive.id));
}

export function freeServiceNames(item) {
  const names = mergedServices(item.data && item.data.watch).map(p => p.name);
  if (item.data.archive && item.data.archive.id) names.unshift('Internet Archive');
  return names;
}

export const isMoviesAnywhere = item => /movies\s*anywhere/i.test(item.location || '');

export function moviesAnywhereUrl(item) {
  if (item.data.ma_url) return item.data.ma_url;
  const slug = String(item.title || '').toLowerCase().replace(/&/g, 'and').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `https://moviesanywhere.com/movie/${slug}`;
}

const stale = w => !w || !w.checked || (Date.now() - Date.parse(w.checked)) / 86400000 > RECHECK_DAYS;
export const needsCheck = item => (item.type === 'movie' || item.type === 'tv') && stale(item.data.watch);
// Watchmode is asked when a title's page is opened, at most once a month per title.
export const needsWatchmode = item => hasWatchmode() && !!item.tmdb_id && (item.type === 'movie' || item.type === 'tv')
  && stale(item.data.watch && item.data.watch.wm);

// ---------------------------------------------------------------- page section
// A chip goes to the title itself when Watchmode gave a direct link; otherwise to that service's own
// search for the title; only for services Vault has no search address for does it fall back to the
// JustWatch listing on TMDB.
function serviceChips(list, title, fallbackLink) {
  return list.map(p => {
    const search = siteSearchUrl(p.name, title);
    const href = p.url || search || fallbackLink;
    const tip = p.url ? `Open on ${p.name}` : search ? `Find it on ${p.name}` : 'See where to watch';
    const inner = `${p.logo ? `<img src="${esc(p.logo)}" alt="" loading="lazy">` : icon('play')}<span>${esc(p.name)}${p.ads ? '<small>with ads</small>' : ''}</span>`;
    return href ? `<a class="provider" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(tip)}">${inner}</a>`
      : `<span class="provider">${inner}</span>`;
  }).join('');
}

// Each button opens that service's own search page for this title (US addresses, checked by hand).
const SEARCH_SITES = [
  ['Pluto TV', q => `https://pluto.tv/us/search/?term=${encodeURIComponent(q)}`],
  ['Tubi', q => `https://tubitv.com/search/${encodeURIComponent(q)}`],
  ['The Roku Channel', q => `https://therokuchannel.roku.com/search/${encodeURIComponent(q)}`],
  ['Plex', q => `https://watch.plex.tv/search?query=${encodeURIComponent(q)}`],
  // Kanopy can't take a search from the address, so it isn't in the row; its chip opens Kanopy's search page.
  ['Kanopy', () => 'https://www.kanopy.com/en/search', { row: false }],
  ['Hoopla', q => `https://www.hoopladigital.com/search?q=${encodeURIComponent(q)}&scope=everything&type=direct`],
  ['YouTube', q => `https://www.youtube.com/results?search_query=${encodeURIComponent(`${q} full movie`)}`],
];
function siteSearchUrl(serviceName, title) {
  const k = serviceKey(serviceName);
  const hit = SEARCH_SITES.find(([name]) => serviceKey(name) === k);
  return hit ? hit[1](title) : null;
}
function searchRowHtml(item) {
  const links = SEARCH_SITES.filter(([, , opt]) => !opt || opt.row !== false).map(([name, url]) =>
    `<a class="btn small ghost" target="_blank" rel="noopener" href="${esc(url(item.title))}">${icon('search')} ${esc(name)}</a>`).join('');
  return `<div class="wtw-group wtw-search"><h4>Search for it on</h4><div class="btn-row">${links}</div></div>`;
}

export function archivePlayer(id, title) {
  return `<div class="ia-player"><iframe src="https://archive.org/embed/${encodeURIComponent(id)}" title="${esc(title || 'Internet Archive player')}"
    allow="fullscreen" allowfullscreen loading="lazy"></iframe></div>
    <div class="ia-credit">${icon('info')} <span>\u201c${esc(title || id)}\u201d is from the <a class="ext" href="https://archive.org/details/${encodeURIComponent(id)}" target="_blank" rel="noopener">Internet Archive</a>, where it\u2019s offered as a public-domain film.</span></div>`;
}

export function whereToWatchHtml(item, { busy = false } = {}) {
  const w = item.data.watch;
  const a = item.data.archive;
  let body = '';
  if (a && a.id) {
    body += `<div class="wtw-group"><h4>Free on the Internet Archive</h4>${archivePlayer(a.id, a.title)}
      <button class="btn small ghost" data-wtw="unlink">Not this film</button></div>`;
  } else if (w && w.archive_candidate && a === undefined) {
    const c = w.archive_candidate;
    body += `<div class="wtw-group ia-confirm"><h4>Possibly free on the Internet Archive</h4>
      <p>The Archive has a public-domain film called <b>${esc(c.title)}</b>${c.year ? ` (${c.year})` : ''}. Is it this one?</p>
      <div class="btn-row"><button class="btn primary" data-wtw="confirm">${icon('check')} Yes, that\u2019s it</button>
      <button class="btn" data-wtw="decline">No</button>
      <a class="btn ghost" href="https://archive.org/details/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">${icon('link')} Look at it first</a></div></div>`;
  }
  const services = mergedServices(w);
  if (services.length) {
    body += `<div class="wtw-group"><h4>Free to stream</h4><div class="providers">${serviceChips(services, item.title, w.link)}</div></div>`;
  } else if (w && !(a && a.id)) {
    body += `<p class="muted">Not listed as free anywhere right now.</p>`;
  }
  if (!w || busy) body += `<p class="muted"><span class="spinner sm inline"></span> Checking\u2026</p>`;
  const ma = isMoviesAnywhere(item)
    ? `<div class="wtw-group"><h4>Your digital copy</h4><div class="btn-row"><a class="btn" href="${esc(moviesAnywhereUrl(item))}" target="_blank" rel="noopener">${icon('play')} Watch on Movies Anywhere</a>
       <button class="btn small ghost" data-wtw="ma-fix" title="Use a different Movies Anywhere address">${icon('edit')} Fix link</button></div></div>` : '';
  const sources = hasWatchmode() ? 'JustWatch and Watchmode' : 'JustWatch';
  return `<section class="panel wtw"><div class="panel-head"><h2>Where to watch</h2>
      ${w ? `<span class="muted" title="Checked with ${sources}">Checked ${fmtDate(w.checked)}</span><button class="btn small" data-wtw="recheck">${icon('refresh')} Check again</button>` : ''}</div>
    ${ma}${body}${searchRowHtml(item)}
    <p class="attrib">${ATTRIBUTION}</p></section>`;
}

// ---------------------------------------------------------------- background checks
export const watchStatus = { running: false, total: 0, done: 0 };
const LOCK = 'vault:watchlock';
const tabId = Math.random().toString(36).slice(2);

function takeLock() {
  try {
    const cur = JSON.parse(localStorage.getItem(LOCK) || 'null');
    if (cur && cur.id !== tabId && Date.now() - cur.t < 30000) return false;   // another tab is checking
    localStorage.setItem(LOCK, JSON.stringify({ id: tabId, t: Date.now() }));
    return true;
  } catch (e) { return true; }
}

// Quietly works through movies and TV that haven't been checked in a month. One item at a time, gently paced.
export async function startWatchChecks() {
  if (watchStatus.running) return;
  if (!S.types.some(t => t.key === 'movie' || t.key === 'tv')) return;
  watchStatus.running = true;
  try {
    const items = [];
    for (const t of ['movie', 'tv']) if (S.types.some(x => x.key === t)) items.push(...await getItems(t));
    const todo = items.filter(needsCheck);
    watchStatus.total = todo.length;
    watchStatus.done = 0;
    for (const it of todo) {
      if (!takeLock()) break;
      if (!needsCheck(it)) { watchStatus.done += 1; continue; }
      try { await checkItem(it); } catch (e) {
        if (/sign-in|signed in|reach Vault/i.test(e.message)) break;
      }
      watchStatus.done += 1;
      document.dispatchEvent(new CustomEvent('vault-watch-progress'));
      await new Promise(r => setTimeout(r, 800));
    }
  } finally {
    watchStatus.running = false;
    document.dispatchEvent(new CustomEvent('vault-watch-progress'));
  }
}
