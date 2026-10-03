// "Where to watch": free streaming availability (TMDB / JustWatch) and public-domain films on the Internet Archive.
import { icon } from './icons.js';
import { api, esc, today, getItems, S, fmtDate } from './util.js';

const LOGO = p => (p ? `https://image.tmdb.org/t/p/w92${p}` : null);
const RECHECK_DAYS = 30;
const ARCHIVE_MAX_YEAR = 1980;     // public-domain features are almost all older than this

export const ATTRIBUTION = `Free-streaming information from <a class="ext" href="https://www.justwatch.com" target="_blank" rel="noopener">JustWatch</a>, provided through <a class="ext" href="https://www.themoviedb.org" target="_blank" rel="noopener">TMDB</a>.`;

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

const norm = t => String(t || '').toLowerCase().replace(/^(the|a|an)\s+/, '').replace(/&/g, 'and')
  .replace(/[^a-z0-9]+/g, ' ').trim();

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
export async function checkItem(item) {
  const watch = { checked: today(), link: null, free: [], ads: [], archive_candidate: null };
  if (item.tmdb_id) {
    try { Object.assign(watch, await providersFor(item.type, item.tmdb_id)); } catch (e) { watch.error = e.message; }
  }
  if (wantsArchiveCheck(item)) {
    try { watch.archive_candidate = await archiveCandidate(item); } catch (e) { /* skip */ }
  }
  delete watch.error;
  await api(`/api/items/${item.id}/data`, { method: 'PATCH', body: { watch } });
  item.data.watch = watch;
  return watch;
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
  const w = (item.data && item.data.watch) || {};
  return !!((w.free && w.free.length) || (w.ads && w.ads.length) || (item.data.archive && item.data.archive.id));
}

export function freeServiceNames(item) {
  const w = (item.data && item.data.watch) || {};
  const names = [...(w.free || []), ...(w.ads || [])].map(p => p.name);
  if (item.data.archive && item.data.archive.id) names.unshift('Internet Archive');
  return [...new Set(names)];
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

// ---------------------------------------------------------------- page section
function providerChips(list) {
  return list.map(p => `<span class="provider">${p.logo ? `<img src="${esc(LOGO(p.logo))}" alt="" loading="lazy">` : icon('play')}<span>${esc(p.name)}</span></span>`).join('');
}

export function archivePlayer(id, title) {
  return `<div class="ia-player"><iframe src="https://archive.org/embed/${encodeURIComponent(id)}" title="${esc(title || 'Internet Archive player')}"
    allow="fullscreen" allowfullscreen loading="lazy"></iframe></div>
    <div class="ia-credit">${icon('info')} <span>“${esc(title || id)}” is from the <a class="ext" href="https://archive.org/details/${encodeURIComponent(id)}" target="_blank" rel="noopener">Internet Archive</a>, where it’s offered as a public-domain film.</span></div>`;
}

export function whereToWatchHtml(item) {
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
      <div class="btn-row"><button class="btn primary" data-wtw="confirm">${icon('check')} Yes, that’s it</button>
      <button class="btn" data-wtw="decline">No</button>
      <a class="btn ghost" href="https://archive.org/details/${encodeURIComponent(c.id)}" target="_blank" rel="noopener">${icon('link')} Look at it first</a></div></div>`;
  }
  if (w && (w.free.length || w.ads.length)) {
    const go = w.link ? `href="${esc(w.link)}" target="_blank" rel="noopener"` : '';
    if (w.free.length) body += `<div class="wtw-group"><h4>Free</h4><a class="providers" ${go}>${providerChips(w.free)}</a></div>`;
    if (w.ads.length) body += `<div class="wtw-group"><h4>Free with ads</h4><a class="providers" ${go}>${providerChips(w.ads)}</a></div>`;
    if (w.link) body += `<p class="muted small">Click a service to see the links for watching it there.</p>`;
  } else if (w && !(a && a.id)) {
    body += `<p class="muted">Not free to stream anywhere right now.</p>`;
  } else if (!w) {
    body += `<p class="muted"><span class="spinner sm inline"></span> Checking…</p>`;
  }
  const ma = isMoviesAnywhere(item)
    ? `<div class="wtw-group"><h4>Your digital copy</h4><div class="btn-row"><a class="btn" href="${esc(moviesAnywhereUrl(item))}" target="_blank" rel="noopener">${icon('play')} Watch on Movies Anywhere</a>
       <button class="btn small ghost" data-wtw="ma-fix" title="Use a different Movies Anywhere address">${icon('edit')} Fix link</button></div></div>` : '';
  return `<section class="panel wtw"><div class="panel-head"><h2>Where to watch</h2>
      ${w ? `<span class="muted">Checked ${fmtDate(w.checked)}</span><button class="btn small" data-wtw="recheck">${icon('refresh')} Check again</button>` : ''}</div>
    ${ma}${body}
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
