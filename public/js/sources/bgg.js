// BoardGameGeek XML API2 — requests go through Vault's server (which adds the token);
// the XML is read here in the browser.
import { sleep } from '../util.js';

const PAGE = 20;            // /thing accepts at most 20 ids
let lastCall = 0;
const searchCache = new Map();
const thingCache = new Map();

async function pace(gap = 1200) {
  const wait = lastCall + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

// GET an XML document from BGG via the proxy. Handles "queued" (202) and "busy" (429) replies.
async function getXml(endpoint, params, { attempts = 8, gap = 1200 } = {}) {
  const qs = new URLSearchParams(params).toString();
  let delay = 2000;
  for (let i = 0; i < attempts; i++) {
    await pace(gap);
    let res;
    try { res = await fetch(`/api/bgg/${endpoint}?${qs}`, { credentials: 'same-origin' }); }
    catch (e) { throw new Error('Couldn’t reach Vault. Check the internet connection.'); }
    if (res.status === 202 || res.status === 429) {
      await sleep(delay);
      delay = Math.min(delay * 1.5, 12000);
      continue;
    }
    if (!res.ok) {
      let msg = `BoardGameGeek returned an error (${res.status}).`;
      try { msg = (await res.json()).error || msg; } catch (e) { /* not JSON */ }
      throw new Error(msg);
    }
    const text = await res.text();
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.querySelector('parsererror')) throw new Error('BoardGameGeek sent a response Vault couldn’t read. Try again.');
    const err = doc.querySelector('errors > error > message, error > message');
    if (err) throw new Error(`BoardGameGeek: ${err.textContent}`);
    return doc;
  }
  throw new Error('BoardGameGeek is busy right now. Try again in a minute.');
}

// ---- small XML helpers
const kids = (el, tag) => Array.from(el ? el.children : []).filter(c => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0] || null;
const val = (el, tag) => { const k = kid(el, tag); return k ? k.getAttribute('value') : null; };
const int = v => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const num = (v, places = 2) => { const n = parseFloat(v); return Number.isFinite(n) && n ? Number(n.toFixed(places)) : null; };
const textOf = (el, tag) => { const k = kid(el, tag); return k && k.textContent ? k.textContent.trim() : null; };

function primaryName(el) {
  const names = kids(el, 'name');
  const p = names.find(n => n.getAttribute('type') === 'primary') || names[0];
  return p ? p.getAttribute('value') : '';
}

function links(el, type, inbound = null) {
  return kids(el, 'link').filter(l => l.getAttribute('type') === type
    && (inbound === null || (l.getAttribute('inbound') === 'true') === inbound))
    .map(l => ({ id: int(l.getAttribute('id')), name: l.getAttribute('value') }));
}

const decoder = document.createElement('textarea');
function decodeEntities(s) {
  if (!s) return '';
  decoder.innerHTML = s;
  return decoder.value.replace(/\n{3,}/g, '\n\n').trim();
}

function bestPlayers(el) {
  for (const ps of kids(el, 'poll-summary')) {
    if (ps.getAttribute('name') !== 'suggested_numplayers') continue;
    for (const r of kids(ps, 'result')) {
      if (r.getAttribute('name') === 'bestwith') return (r.getAttribute('value') || '').replace('Best with ', '').trim();
    }
  }
  return null;
}

function range(lo, hi) {
  lo = int(lo); hi = int(hi);
  if (!lo && !hi) return null;
  lo = lo || hi; hi = hi || lo;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi) };
}

const rankOf = (q, name) => {
  const n = (name || '').toLowerCase().trim();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(n)) return 2;
  return 3;
};

async function candidates(query) {
  const q = query.trim().toLowerCase();
  if (searchCache.has(q)) return searchCache.get(q);
  const doc = await getXml('search', { query, type: 'boardgame,boardgameexpansion' }, { gap: 600 });
  const seen = new Map();
  for (const it of doc.querySelectorAll('items > item')) {
    const id = int(it.getAttribute('id'));
    const nameEl = kid(it, 'name');
    const name = nameEl ? nameEl.getAttribute('value') : '';
    const primary = nameEl && nameEl.getAttribute('type') === 'primary';
    const cur = seen.get(id);
    if (!cur || (primary && !cur.primary)) {
      seen.set(id, { id, name, primary, year: int(val(it, 'yearpublished')), kind: it.getAttribute('type') });
    }
  }
  const list = [...seen.values()].sort((a, b) => (rankOf(q, a.name) - rankOf(q, b.name))
    || ((a.kind === 'boardgame' ? 0 : 1) - (b.kind === 'boardgame' ? 0 : 1)) || ((b.year || 0) - (a.year || 0)));
  searchCache.set(q, list);
  return list;
}

export async function things(ids, { stats = true, versions = false, gap = 600 } = {}) {
  const out = new Map();
  const need = [];
  for (const id of ids) {
    const hit = thingCache.get(`${id}:${versions}`);
    if (hit) out.set(id, hit); else need.push(id);
  }
  for (let i = 0; i < need.length; i += PAGE) {
    const chunk = need.slice(i, i + PAGE);
    const params = { id: chunk.join(',') };
    if (stats) params.stats = '1';
    if (versions) params.versions = '1';
    const doc = await getXml('thing', params, { gap });
    for (const it of doc.querySelectorAll('items > item')) {
      const id = int(it.getAttribute('id'));
      out.set(id, it);
      thingCache.set(`${id}:${versions}`, it);
    }
  }
  return out;
}

export async function search(query, page = 1) {
  const q = query.trim().toLowerCase();
  const cands = await candidates(query);
  const start = (page - 1) * PAGE;
  const chunk = cands.slice(start, start + PAGE);
  const details = chunk.length ? await things(chunk.map(c => c.id)) : new Map();
  const results = chunk.map(c => {
    const el = details.get(c.id);
    let publisher = '', thumb = null, rated = 0, isExp = c.kind === 'boardgameexpansion';
    if (el) {
      const pubs = links(el, 'boardgamepublisher');
      publisher = pubs.length ? pubs[0].name : '';
      thumb = textOf(el, 'thumbnail');
      const ratings = el.querySelector('statistics > ratings');
      rated = int(val(ratings, 'usersrated')) || 0;
      isExp = el.getAttribute('type') === 'boardgameexpansion';
    }
    return { id: c.id, title: c.name, year: c.year, subtitle: publisher, thumb, badge: isExp ? 'Expansion' : null,
      _rank: rankOf(q, c.name), _rated: rated };
  });
  results.sort((a, b) => (a._rank - b._rank) || (b._rated - a._rated));
  return { results, has_more: start + PAGE < cands.length, total: cands.length };
}

export async function versions(gameId) {
  const el = (await things([Number(gameId)], { stats: false, versions: true })).get(Number(gameId));
  if (!el) return [];
  const vs = el.querySelectorAll('versions > item');
  return Array.from(vs).map(v => ({
    id: int(v.getAttribute('id')),
    title: primaryName(v),
    year: int(val(v, 'yearpublished')) || null,
    subtitle: links(v, 'boardgamepublisher').slice(0, 2).map(x => x.name).join(', '),
    language: links(v, 'language').slice(0, 3).map(x => x.name).join(', '),
    thumb: textOf(v, 'thumbnail'),
  })).sort((a, b) => (b.year || 0) - (a.year || 0));
}

// Convert a /thing element into Vault's prefill shape.
export function mapThing(el, versionId = null) {
  const id = int(el.getAttribute('id'));
  const isExp = el.getAttribute('type') === 'boardgameexpansion';
  const ratings = el.querySelector('statistics > ratings');
  const pubs = links(el, 'boardgamepublisher');
  const data = {
    year: int(val(el, 'yearpublished')) || null,
    publisher: pubs.length ? pubs[0].name : '',
    designers: links(el, 'boardgamedesigner').map(x => x.name).filter(n => n !== '(Uncredited)'),
    artists: links(el, 'boardgameartist').map(x => x.name).filter(n => n !== '(Uncredited)'),
    players: range(val(el, 'minplayers'), val(el, 'maxplayers')),
    best_players: bestPlayers(el),
    playtime: range(val(el, 'minplaytime') || val(el, 'playingtime'), val(el, 'maxplaytime') || val(el, 'playingtime')),
    min_age: int(val(el, 'minage')) || null,
    weight: num(val(ratings, 'averageweight')),
    bgg_rating: num(val(ratings, 'average'), 1),
    categories: links(el, 'boardgamecategory').map(x => x.name),
    mechanics: links(el, 'boardgamemechanic').map(x => x.name),
    game_type: isExp ? 'Expansion' : 'Base game',
    expands: isExp ? links(el, 'boardgameexpansion', true).map(x => ({ bgg_id: x.id, name: x.name })) : [],
  };
  let cover = textOf(el, 'image');
  let thumb = textOf(el, 'thumbnail');
  if (versionId) {
    for (const v of el.querySelectorAll('versions > item')) {
      if (int(v.getAttribute('id')) !== Number(versionId)) continue;
      data.edition = primaryName(v);
      const vy = int(val(v, 'yearpublished'));
      if (vy) data.year = vy;
      const vp = links(v, 'boardgamepublisher');
      if (vp.length) data.publisher = vp[0].name;
      const langs = links(v, 'language');
      if (langs.length) data.language = langs.map(x => x.name).join(', ');
      const vi = textOf(v, 'image');
      const vt = textOf(v, 'thumbnail');
      if (vi) { cover = vi; thumb = vt || vi; }
      break;
    }
  }
  const clean = {};
  for (const [k, v] of Object.entries(data)) if (v !== null && v !== '' && !(Array.isArray(v) && !v.length)) clean[k] = v;
  const description = decodeEntities(textOf(el, 'description'));
  return {
    title: primaryName(el),
    data: clean,
    text: description ? { description } : {},
    ids: { bgg_id: id, version_id: versionId ? Number(versionId) : null },
    cover_url: cover || thumb, thumb_url: thumb || cover, backdrop_url: null,
  };
}

export async function details(gameId, versionId = null) {
  const id = Number(gameId);
  const el = (await things([id], { stats: true, versions: !!versionId })).get(id);
  if (!el) throw new Error('BoardGameGeek didn’t return that game.');
  return mapThing(el, versionId);
}

// ---- the user's own collection and plays
export async function collection(username) {
  const out = [];
  for (const params of [
    { username, subtype: 'boardgame', excludesubtype: 'boardgameexpansion', version: '1' },
    { username, subtype: 'boardgameexpansion', version: '1' },
  ]) {
    const doc = await getXml('collection', params, { attempts: 20, gap: 2000 });
    for (const it of doc.querySelectorAll('items > item')) {
      const st = kid(it, 'status');
      if (!st) continue;
      let status = null;
      if (st.getAttribute('own') === '1') status = 'owned';
      else if (st.getAttribute('wishlist') === '1' || st.getAttribute('wanttobuy') === '1' || st.getAttribute('preordered') === '1') status = 'wishlist';
      if (!status) continue;
      const ver = it.querySelector('version > item');
      out.push({
        bgg_id: int(it.getAttribute('objectid')),
        name: textOf(it, 'name') || '',
        status,
        version_id: ver && ver.getAttribute('id') ? int(ver.getAttribute('id')) : null,
        comment: (textOf(it, 'comment') || '').trim(),
      });
    }
  }
  return out;
}

export async function* plays(username, maxPages = 60) {
  for (let page = 1; page <= maxPages; page++) {
    const doc = await getXml('plays', { username, page: String(page) }, { gap: 2000 });
    const root = doc.documentElement;
    const found = kids(root, 'play');
    if (!found.length) return;
    for (const p of found) {
      const item = kid(p, 'item');
      if (!item) continue;
      const players = [], winners = [];
      for (const pl of p.querySelectorAll('players > player')) {
        const name = (pl.getAttribute('name') || pl.getAttribute('username') || '').trim();
        if (name) { players.push(name); if (pl.getAttribute('win') === '1') winners.push(name); }
      }
      yield {
        bgg_play_id: int(p.getAttribute('id')), date: p.getAttribute('date'), quantity: int(p.getAttribute('quantity')) || 1,
        bgg_id: int(item.getAttribute('objectid')), players, winner: winners.join(', '), notes: (textOf(p, 'comments') || '').trim(),
      };
    }
    const total = int(root.getAttribute('total')) || 0;
    if (page * 100 >= total) return;
  }
}

export async function test() {
  await getXml('thing', { id: '13' }, { attempts: 3, gap: 0 });
  return 'Connected to BoardGameGeek.';
}
