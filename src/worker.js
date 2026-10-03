// Vault — Cloudflare Worker.
// Serves the JSON API and media; the web pages themselves are static assets in /public.
// Design note: the free Workers plan allows ~10 ms of CPU per request, so this Worker
// stays thin — it stores data, proxies BGG/TMDB/UPC calls (adding the keys), and moves
// image bytes. Parsing and mapping of source data happens in the browser.

const VERSION = '2.1.0';
const SCHEMA_VERSION = '1';

// ---------------------------------------------------------------- defaults
const f = (key, label, kind, visible = true, source = false, options = null) => {
  const d = { key, label, kind, visible, source, builtin: true };
  if (options) d.options = options;
  return d;
};
const DISC = ['VHS', 'DVD', 'Blu-ray', '4K UHD', 'Digital'];
const REGIONS = ['A / 1', 'B / 2', 'C / 3', 'Region-free'];
const MPAA = ['G', 'PG', 'PG-13', 'R', 'NC-17', 'NR'];

const DEFAULT_TYPES = [
  { key: 'boardgame', name: 'Board Games', icon: 'dice', source: 'bgg', sort: 1, fields: [
    f('year', 'Year published', 'number', true, true),
    f('edition', 'Edition / version', 'text', true, true),
    f('publisher', 'Publisher', 'text', true, true),
    f('designers', 'Designer(s)', 'list', true, true),
    f('artists', 'Artist(s)', 'list', false, true),
    f('players', 'Players', 'range', true, true),
    f('best_players', 'Best player count', 'text', false, true),
    f('playtime', 'Play time (minutes)', 'range', true, true),
    f('min_age', 'Minimum age', 'number', true, true),
    f('weight', 'Complexity (1–5)', 'number', true, true),
    f('bgg_rating', 'BGG rating', 'number', true, true),
    f('categories', 'Categories', 'list', true, true),
    f('mechanics', 'Mechanics', 'list', false, true),
    f('game_type', 'Type', 'choice', true, true, ['Base game', 'Expansion', 'Standalone expansion']),
    f('expands', 'Expands (base game)', 'itemlink', true, true),
    f('description', 'Description', 'longtext', true, true),
    f('complete', 'Components complete', 'bool', true, false),
    f('missing', 'Missing pieces', 'text', true, false),
    f('sleeved', 'Sleeved', 'bool', false, false),
    f('language', 'Language', 'text', false, true),
  ] },
  { key: 'movie', name: 'Movies', icon: 'film', source: 'tmdb_movie', sort: 2, fields: [
    f('year', 'Year released', 'number', true, true),
    f('format', 'Format', 'choice', true, false, DISC),
    f('edition', 'Edition', 'text', true, false),
    f('box_set', 'From box set', 'text', true, false),
    f('discs', 'Number of discs', 'number', false, false),
    f('region', 'Region', 'choice', false, false, REGIONS),
    f('directors', 'Director(s)', 'list', true, true),
    f('cast', 'Cast (top billed)', 'list', true, true),
    f('genres', 'Genres', 'list', true, true),
    f('runtime', 'Runtime (minutes)', 'number', true, true),
    f('mpaa', 'Rating (MPAA)', 'choice', true, true, MPAA),
    f('studio', 'Studio', 'text', false, true),
    f('synopsis', 'Synopsis', 'longtext', true, true),
    f('tmdb_score', 'TMDB score', 'number', false, true),
    f('imdb', 'IMDb link', 'url', true, true),
    f('digital_redeemed', 'Digital code redeemed', 'bool', false, false),
  ] },
  { key: 'tv', name: 'TV Series', icon: 'tv', source: 'tmdb_tv', sort: 3, fields: [
    f('years_aired', 'Years aired', 'text', true, true),
    f('network', 'Network', 'text', true, true),
    f('creators', 'Creator(s)', 'list', true, true),
    f('cast', 'Cast (main)', 'list', true, true),
    f('genres', 'Genres', 'list', true, true),
    f('total_seasons', 'Total seasons', 'number', true, true),
    f('seasons_owned', 'Seasons owned', 'text', true, false),
    f('complete_series', 'Complete series', 'bool', true, false),
    f('format', 'Format', 'choice', true, false, DISC),
    f('edition', 'Edition', 'text', true, false),
    f('discs', 'Number of discs', 'number', false, false),
    f('region', 'Region', 'choice', false, false, REGIONS),
    f('synopsis', 'Synopsis', 'longtext', true, true),
    f('tmdb_score', 'TMDB score', 'number', false, true),
    f('imdb', 'IMDb link', 'url', true, true),
  ] },
];

const FIELD_KINDS = [
  ['text', 'Text'], ['longtext', 'Long text'], ['number', 'Number'], ['range', 'Number range (min–max)'],
  ['date', 'Date'], ['bool', 'Yes / No'], ['rating', 'Rating (1–10)'], ['choice', 'Pick-list'],
  ['list', 'Multi-value list'], ['url', 'Link'],
];
const CONDITIONS = ['New / sealed', 'Like new', 'Good', 'Fair', 'Poor'];
const ICONS = ['dice', 'film', 'tv', 'book', 'music', 'gamepad', 'coin', 'stamp', 'puzzle', 'box', 'star', 'camera'];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
  `CREATE TABLE IF NOT EXISTS types (key TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT, source TEXT DEFAULT 'none',
     builtin INTEGER DEFAULT 0, sort INTEGER DEFAULT 99, fields TEXT NOT NULL DEFAULT '[]')`,
  `CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'owned',
     title TEXT NOT NULL, sort_title TEXT, group_name TEXT, condition TEXT, location TEXT, purchase_date TEXT,
     purchase_price REAL, acquired_from TEXT, my_rating INTEGER, tags TEXT DEFAULT '[]', notes TEXT, barcode TEXT,
     date_added TEXT, updated TEXT, bgg_id INTEGER, version_id INTEGER, tmdb_id INTEGER, imdb_id TEXT,
     cover TEXT, cover_custom INTEGER DEFAULT 0, backdrop TEXT, data TEXT DEFAULT '{}', text TEXT DEFAULT '{}')`,
  `CREATE INDEX IF NOT EXISTS ix_items_type ON items(type)`,
  `CREATE INDEX IF NOT EXISTS ix_items_bgg ON items(bgg_id)`,
  `CREATE INDEX IF NOT EXISTS ix_items_barcode ON items(barcode)`,
  `CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, file TEXT NOT NULL, added TEXT)`,
  `CREATE TABLE IF NOT EXISTS loans (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, borrower TEXT NOT NULL,
     date_lent TEXT, due TEXT, returned TEXT, notes TEXT)`,
  `CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, date TEXT, players TEXT DEFAULT '[]',
     winner TEXT, notes TEXT, quantity INTEGER DEFAULT 1, bgg_play_id INTEGER UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS watches (id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL, date TEXT, season INTEGER, notes TEXT)`,
  `CREATE INDEX IF NOT EXISTS ix_photos_item ON photos(item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_loans_item ON loans(item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_plays_item ON plays(item_id)`,
  `CREATE INDEX IF NOT EXISTS ix_watches_item ON watches(item_id)`,
];

const ITEM_COLUMNS = ['type', 'status', 'title', 'group_name', 'condition', 'location', 'purchase_date', 'purchase_price',
  'acquired_from', 'my_rating', 'tags', 'notes', 'barcode', 'bgg_id', 'version_id', 'tmdb_id', 'imdb_id',
  'cover', 'cover_custom', 'backdrop', 'date_added', 'data', 'text'];
const STATUSES = ['owned', 'wishlist', 'watchlist'];
const LIST_COLUMNS = 'id,type,status,title,sort_title,group_name,condition,location,purchase_date,purchase_price,' +
  'acquired_from,my_rating,tags,notes,barcode,date_added,updated,bgg_id,version_id,tmdb_id,imdb_id,cover,cover_custom,backdrop,data';
const TABLES = ['settings', 'types', 'items', 'photos', 'loans', 'plays', 'watches'];
const IMAGE_HOSTS = [/(^|\.)geekdo-images\.com$/, /(^|\.)image\.tmdb\.org$/, /(^|\.)boardgamegeek\.com$/];

// ---------------------------------------------------------------- helpers
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});
const ok = (obj = {}) => json({ ok: true, ...obj });
const fail = (msg, status = 400, extra = {}) => json({ ok: false, error: msg, ...extra }, status);
const now = () => new Date().toISOString().slice(0, 19);
const today = () => new Date().toISOString().slice(0, 10);
const sortTitle = t => String(t || '').trim().replace(/^(the|a|an)\s+/i, '').toLowerCase();
class HttpError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

async function body(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

// ---------------------------------------------------------------- Cloudflare Access check
let certCache = { team: null, at: 0, keys: [] };

function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64urlJson = s => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

function teamUrl(env) {
  let t = String(env.ACCESS_TEAM || '').trim().replace(/\/+$/, '');
  if (!t) return '';
  if (!/^https?:\/\//.test(t)) t = t.includes('.') ? `https://${t}` : `https://${t}.cloudflareaccess.com`;
  return t;
}

async function accessKeys(team) {
  if (certCache.team === team && Date.now() - certCache.at < 3600_000 && certCache.keys.length) return certCache.keys;
  const r = await fetch(`${team}/cdn-cgi/access/certs`);
  if (!r.ok) throw new HttpError('Couldn’t load the Cloudflare Access keys. Check ACCESS_TEAM.', 500);
  const j = await r.json();
  certCache = { team, at: Date.now(), keys: j.keys || [] };
  return certCache.keys;
}

function cookieToken(request) {
  const c = request.headers.get('Cookie') || '';
  const m = c.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

async function verifyAccess(request, env) {
  if (env.DEV_NO_AUTH === '1') return { email: 'dev@localhost' };
  const team = teamUrl(env);
  const aud = String(env.ACCESS_AUD || '').trim();
  if (!team || !aud) throw new HttpError('setup', 503);
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookieToken(request);
  if (!token) throw new HttpError('Not signed in.', 401);
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError('Not signed in.', 401);
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); } catch (e) { throw new HttpError('Not signed in.', 401); }
  const keys = await accessKeys(team);
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { certCache.at = 0; throw new HttpError('Sign-in expired. Reload the page.', 401); }
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!valid || !auds.includes(aud) || (payload.exp && payload.exp * 1000 < Date.now()) || (payload.iss && payload.iss !== team)) {
    throw new HttpError('Vault couldn\u2019t confirm your sign-in. Reload the page; if this keeps happening, check ACCESS_AUD and ACCESS_TEAM in wrangler.jsonc.', 401);
  }
  return { email: payload.email || '' };
}

// ---------------------------------------------------------------- database
let schemaReady = false;

async function ensureSchema(env) {
  if (schemaReady) return;
  try {
    const r = await env.DB.prepare(`SELECT value FROM settings WHERE key='schema_version'`).first();
    if (r && r.value === SCHEMA_VERSION) { schemaReady = true; return; }
  } catch (e) { /* tables don't exist yet */ }
  await env.DB.batch(SCHEMA.map(s => env.DB.prepare(s)));
  const existing = await env.DB.prepare('SELECT key FROM types').all();
  const have = new Set(existing.results.map(r => r.key));
  const stmts = DEFAULT_TYPES.filter(t => !have.has(t.key)).map(t => env.DB.prepare(
    'INSERT INTO types(key,name,icon,source,builtin,sort,fields) VALUES(?,?,?,?,1,?,?)')
    .bind(t.key, t.name, t.icon, t.source, t.sort, JSON.stringify(t.fields)));
  stmts.push(env.DB.prepare(`INSERT INTO settings(key,value) VALUES('schema_version',?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(SCHEMA_VERSION));
  await env.DB.batch(stmts);
  schemaReady = true;
}

async function getSetting(env, key) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return r ? r.value : null;
}

function typeRow(r) {
  return { key: r.key, name: r.name, icon: r.icon, source: r.source, builtin: !!r.builtin, sort: r.sort,
    fields: JSON.parse(r.fields || '[]') };
}

async function getType(env, key) {
  const r = await env.DB.prepare('SELECT * FROM types WHERE key=?').bind(key).first();
  return r ? typeRow(r) : null;
}

function cleanItemValues(b) {
  const v = {};
  for (const k of ITEM_COLUMNS) if (k in b) v[k] = b[k];
  if ('tags' in v) v.tags = JSON.stringify(Array.isArray(v.tags) ? v.tags : []);
  if ('data' in v) v.data = JSON.stringify(v.data || {});
  if ('text' in v) v.text = JSON.stringify(v.text || {});
  if ('purchase_price' in v) {
    const p = String(v.purchase_price ?? '').replace(/[$,]/g, '').trim();
    v.purchase_price = p === '' ? null : Number(p);
    if (Number.isNaN(v.purchase_price)) v.purchase_price = null;
  }
  if ('my_rating' in v) v.my_rating = v.my_rating === '' || v.my_rating == null ? null : Number(v.my_rating);
  for (const k of ['bgg_id', 'version_id', 'tmdb_id']) if (k in v && (v[k] === '' || v[k] == null)) v[k] = null;
  if ('cover_custom' in v) v.cover_custom = v.cover_custom ? 1 : 0;
  if ('status' in v && !STATUSES.includes(v.status)) v.status = 'owned';
  if ('title' in v) { v.title = String(v.title || 'Untitled').trim() || 'Untitled'; v.sort_title = sortTitle(v.title); }
  return v;
}

// ---------------------------------------------------------------- media (R2)
const MEDIA_KINDS = ['covers', 'thumbs', 'backdrops', 'photos'];
const validMediaKey = k => /^(covers|thumbs|backdrops|photos)\/[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)$/.test(k);
const stamp = () => String(Date.now()).slice(-9) + Math.floor(Math.random() * 90 + 10);

async function storeRemoteImage(env, url, key) {
  let host;
  try { host = new URL(url).hostname; } catch (e) { throw new HttpError('Bad image address.'); }
  if (!IMAGE_HOSTS.some(rx => rx.test(host))) throw new HttpError('Images can only be fetched from BGG or TMDB.');
  const r = await fetch(url, { headers: { 'User-Agent': 'Vault/2.0 (personal collection catalog)' } });
  if (!r.ok) throw new HttpError(`Couldn’t download the image (${r.status}).`, 502);
  const buf = await r.arrayBuffer();
  await env.MEDIA.put(key, buf, { httpMetadata: { contentType: r.headers.get('Content-Type') || 'image/jpeg' } });
}

async function deleteMedia(env, keys) {
  const list = keys.filter(Boolean);
  if (list.length) await env.MEDIA.delete(list);
}

async function applyMedia(env, item, { cover_url, thumb_url, backdrop_url }) {
  const warnings = [];
  const upd = {};
  const old = [];
  if (cover_url) {
    const name = `${item.id}_${stamp()}.jpg`;
    try {
      await storeRemoteImage(env, cover_url, `covers/${name}`);
      try { await storeRemoteImage(env, thumb_url || cover_url, `thumbs/${name}`); }
      catch (e) { await storeRemoteImage(env, cover_url, `thumbs/${name}`); }
      upd.cover = name; upd.cover_custom = 0;
      if (item.cover) old.push(`covers/${item.cover}`, `thumbs/${item.cover}`);
    } catch (e) { warnings.push(e.message); }
  }
  if (backdrop_url) {
    const name = `${item.id}_${stamp()}.jpg`;
    try {
      await storeRemoteImage(env, backdrop_url, `backdrops/${name}`);
      upd.backdrop = name;
      if (item.backdrop) old.push(`backdrops/${item.backdrop}`);
    } catch (e) { warnings.push(e.message); }
  }
  if (Object.keys(upd).length) {
    const keys = Object.keys(upd);
    await env.DB.prepare(`UPDATE items SET ${keys.map(k => `${k}=?`).join(',')}, updated=? WHERE id=?`)
      .bind(...keys.map(k => upd[k]), now(), item.id).run();
    await deleteMedia(env, old);
  }
  return warnings;
}

// ---------------------------------------------------------------- source proxies
const BGG_ENDPOINTS = ['search', 'thing', 'collection', 'plays'];

async function proxyBgg(env, endpoint, url) {
  if (!BGG_ENDPOINTS.includes(endpoint)) throw new HttpError('Unknown BGG request.');
  const token = (await getSetting(env, 'bgg_token')) || '';
  const target = new URL(`https://boardgamegeek.com/xmlapi2/${endpoint}`);
  url.searchParams.forEach((v, k) => target.searchParams.set(k, v));
  const headers = { 'User-Agent': 'Vault/2.0 (personal collection catalog)' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(target.toString(), { headers });
  if (r.status === 401 || r.status === 403) {
    return fail(token ? 'BoardGameGeek rejected the API token. Check it in Settings → Sources.'
      : 'BoardGameGeek needs an API token. Add it in Settings → Sources.', 502, { source: 'bgg' });
  }
  if (r.status === 202) return new Response('', { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (r.status === 429) return fail('BoardGameGeek is busy. Wait a moment and try again.', 429);
  if (!r.ok) return fail(`BoardGameGeek returned an error (${r.status}).`, 502);
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function proxyTmdb(env, url) {
  const key = ((await getSetting(env, 'tmdb_key')) || '').trim();
  if (!key) return fail('TMDB needs an API key. Add it in Settings → Sources.', 502, { source: 'tmdb' });
  const path = url.searchParams.get('path') || '';
  if (!/^\/(search\/(movie|tv)|movie\/\d+|tv\/\d+|movie\/\d+\/watch\/providers|tv\/\d+\/watch\/providers|configuration)$/.test(path)) {
    throw new HttpError('Unknown TMDB request.');
  }
  const target = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.forEach((v, k) => { if (k !== 'path') target.searchParams.set(k, v); });
  const headers = { Accept: 'application/json' };
  if (key.startsWith('eyJ') || key.length > 60) headers.Authorization = `Bearer ${key}`;
  else target.searchParams.set('api_key', key);
  const r = await fetch(target.toString(), { headers });
  if (r.status === 401) return fail('TMDB rejected the API key. Check it in Settings → Sources.', 502);
  if (r.status === 404) return fail('TMDB doesn’t have that title.', 404);
  if (r.status === 429) return fail('TMDB is busy. Wait a moment and try again.', 429);
  if (!r.ok) return fail(`TMDB returned an error (${r.status}).`, 502);
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// Internet Archive search, limited to its curated public-domain film and TV collections.
const ARCHIVE_COLLECTIONS = { movie: ['feature_films', 'film_noir', 'SciFi_Horror', 'silent_films'], tv: ['classic_tv'] };

async function proxyArchive(url) {
  const title = String(url.searchParams.get('title') || '').replace(/["\\()\[\]{}:^~*?!+\-&|\/]/g, ' ').replace(/\b(AND|OR|NOT)\b/g, ' ').trim().slice(0, 120);
  const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
  if (!title) throw new HttpError('No title.');
  const cols = ARCHIVE_COLLECTIONS[kind].map(c => `collection:${c}`).join(' OR ');
  const q = `title:(${title}) AND mediatype:movies AND (${cols})`;
  const target = new URL('https://archive.org/advancedsearch.php');
  target.searchParams.set('q', q);
  for (const fl of ['identifier', 'title', 'year', 'date', 'downloads']) target.searchParams.append('fl[]', fl);
  target.searchParams.set('rows', '12');
  target.searchParams.set('sort[]', 'downloads desc');
  target.searchParams.set('output', 'json');
  const r = await fetch(target.toString(), { headers: { 'User-Agent': 'Vault/2.1 (personal collection catalog)', Accept: 'application/json' } });
  if (!r.ok) return fail(`The Internet Archive returned an error (${r.status}).`, 502);
  return new Response(r.body, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function proxyUpc(code) {
  code = String(code || '').replace(/\D/g, '');
  if (!code) throw new HttpError('No barcode.');
  const r = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`,
    { headers: { 'User-Agent': 'Vault/2.0 (personal collection catalog)', Accept: 'application/json' } });
  if (r.status === 429) return fail('The free barcode lookup limit for today has been reached. Use name search instead.', 429);
  if (r.status === 400 || r.status === 404) return ok({ product: null });
  if (!r.ok) return fail(`The barcode lookup service returned an error (${r.status}).`, 502);
  const j = await r.json();
  const it = (j.items || [])[0];
  return ok({ product: it ? { title: it.title || '', brand: it.brand || '', category: it.category || '' } : null });
}

// ---------------------------------------------------------------- API routes
async function api(request, env, url, user) {
  const p = url.pathname.replace(/^\/api/, '');
  const m = request.method;
  const DB = env.DB;
  let mm;

  if (p === '/bootstrap' && m === 'GET') {
    const [types, counts, settings] = await DB.batch([
      DB.prepare('SELECT * FROM types ORDER BY sort, name'),
      DB.prepare('SELECT type, status, COUNT(*) n FROM items GROUP BY type, status'),
      DB.prepare(`SELECT key, value FROM settings WHERE key IN ('bgg_token','tmdb_key','bgg_username')`),
    ]);
    const c = {};
    for (const r of counts.results) (c[r.type] = c[r.type] || { owned: 0, wishlist: 0 })[r.status] = r.n;
    const s = Object.fromEntries(settings.results.map(r => [r.key, r.value]));
    return ok({
      version: VERSION, user: user.email, types: types.results.map(typeRow), counts: c,
      settings: { has_bgg_token: !!s.bgg_token, has_tmdb_key: !!s.tmdb_key, bgg_username: s.bgg_username || '' },
      field_kinds: FIELD_KINDS, conditions: CONDITIONS, icons: ICONS,
    });
  }

  if (p === '/settings' && m === 'PUT') {
    const b = await body(request);
    const stmts = [];
    for (const k of ['bgg_token', 'tmdb_key', 'bgg_username']) {
      if (k in b) stmts.push(DB.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
        .bind(k, String(b[k] || '').trim()));
    }
    if (stmts.length) await DB.batch(stmts);
    return ok();
  }

  // ---- source proxies
  if ((mm = p.match(/^\/bgg\/([a-z]+)$/)) && m === 'GET') return proxyBgg(env, mm[1], url);
  if (p === '/tmdb' && m === 'GET') return proxyTmdb(env, url);
  if (p === '/archive' && m === 'GET') return proxyArchive(url);
  if ((mm = p.match(/^\/upc\/(\d{6,14})$/)) && m === 'GET') return proxyUpc(mm[1]);

  // ---- collection types
  if (p === '/types' && m === 'POST') {
    const b = await body(request);
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError('Give the collection a name.');
    let key = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'collection';
    const base = key;
    for (let n = 2; await getType(env, key); n++) key = `${base}_${n}`;
    let fields = [];
    if (b.copy_from) {
      const src = await getType(env, b.copy_from);
      if (src) fields = src.fields.filter(fd => fd.kind !== 'itemlink').map(fd => ({ ...fd, source: false }));
    }
    await DB.prepare('INSERT INTO types(key,name,icon,source,builtin,sort,fields) VALUES(?,?,?,?,0,50,?)')
      .bind(key, name, b.icon || 'box', 'none', JSON.stringify(fields)).run();
    return ok({ type: await getType(env, key) });
  }
  if ((mm = p.match(/^\/types\/([a-z0-9_]+)$/))) {
    const t = await getType(env, mm[1]);
    if (!t) throw new HttpError('Not found.', 404);
    if (m === 'PUT') {
      const b = await body(request);
      const old = Object.fromEntries(t.fields.map(fd => [fd.key, fd]));
      const kinds = new Set([...FIELD_KINDS.map(k => k[0]), 'itemlink']);
      const seen = new Set();
      const clean = [];
      for (const fd of (b.fields || t.fields)) {
        const label = String(fd.label || '').trim();
        if (!label) continue;
        let k = fd.key || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'field';
        if (ITEM_COLUMNS.includes(k) || ['id', 'sort_title', 'updated'].includes(k)) k = `custom_${k}`;
        while (seen.has(k)) k += '_x';
        seen.add(k);
        const prev = old[k] || {};
        const kind = prev.builtin ? prev.kind : (kinds.has(fd.kind) ? fd.kind : 'text');
        const e = { key: k, label, kind, visible: fd.visible !== false, source: !!prev.source, builtin: !!prev.builtin };
        if (Array.isArray(fd.options)) e.options = fd.options.map(o => String(o).trim()).filter(Boolean);
        else if (prev.options) e.options = prev.options;
        clean.push(e);
      }
      for (const [k, fd] of Object.entries(old)) if (fd.builtin && !seen.has(k)) clean.push({ ...fd, visible: false });
      await DB.prepare('UPDATE types SET name=?, icon=?, fields=? WHERE key=?')
        .bind(String(b.name || t.name).trim() || t.name, b.icon || t.icon, JSON.stringify(clean), t.key).run();
      return ok({ type: await getType(env, t.key) });
    }
    if (m === 'DELETE') {
      if (t.builtin) throw new HttpError('Built-in collections can’t be deleted.');
      const n = (await DB.prepare('SELECT COUNT(*) n FROM items WHERE type=?').bind(t.key).first()).n;
      if (n) throw new HttpError(`This collection still has ${n} items. Delete or move them first.`);
      await DB.prepare('DELETE FROM types WHERE key=?').bind(t.key).run();
      return ok();
    }
  }

  // ---- items
  if (p === '/items' && m === 'GET') {
    const type = url.searchParams.get('type');
    const where = type ? 'WHERE type=?' : '';
    const sub = type ? 'WHERE item_id IN (SELECT id FROM items WHERE type=?)' : '';
    const bind = s => (type ? s.bind(type) : s);
    const [items, loans, plays, watches] = await DB.batch([
      bind(DB.prepare(`SELECT ${LIST_COLUMNS} FROM items ${where} ORDER BY sort_title`)),
      bind(DB.prepare(`SELECT item_id, borrower FROM loans ${sub ? sub + ' AND' : 'WHERE'} returned IS NULL`)),
      bind(DB.prepare(`SELECT item_id, SUM(COALESCE(quantity,1)) n, MAX(date) last FROM plays ${sub} GROUP BY item_id`)),
      bind(DB.prepare(`SELECT item_id, COUNT(*) n, MAX(date) last, GROUP_CONCAT(season) seasons FROM watches ${sub} GROUP BY item_id`)),
    ]);
    return ok({ items: items.results, loans: loans.results, plays: plays.results, watches: watches.results });
  }

  if (p === '/items' && m === 'POST') {
    const b = await body(request);
    if (!(await getType(env, b.type))) throw new HttpError('Unknown collection type.');
    const v = cleanItemValues(b);
    v.date_added = v.date_added || now();
    v.updated = now();
    v.status = STATUSES.includes(v.status) ? v.status : 'owned';
    if (!v.title) { v.title = 'Untitled'; v.sort_title = 'untitled'; }
    const keys = Object.keys(v);
    const r = await DB.prepare(`INSERT INTO items(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')}) RETURNING id`)
      .bind(...keys.map(k => v[k] ?? null)).first();
    const warnings = await applyMedia(env, { id: r.id }, b);
    return ok({ id: r.id, warnings });
  }

  if (p === '/items/full' && m === 'GET') {
    const type = url.searchParams.get('type');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = Math.min(Number(url.searchParams.get('limit') || 100), 200);
    const s = type ? DB.prepare('SELECT * FROM items WHERE type=? ORDER BY id LIMIT ? OFFSET ?').bind(type, limit, offset)
      : DB.prepare('SELECT * FROM items ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset);
    const r = await s.all();
    return ok({ items: r.results, more: r.results.length === limit });
  }

  if ((mm = p.match(/^\/items\/(\d+)$/))) {
    const id = Number(mm[1]);
    const item = await DB.prepare('SELECT * FROM items WHERE id=?').bind(id).first();
    if (!item) throw new HttpError('That item no longer exists.', 404);
    if (m === 'GET') {
      const [photos, loans, plays, watches] = await DB.batch([
        DB.prepare('SELECT id, file, added FROM photos WHERE item_id=? ORDER BY id').bind(id),
        DB.prepare('SELECT * FROM loans WHERE item_id=? ORDER BY date_lent DESC, id DESC').bind(id),
        DB.prepare('SELECT * FROM plays WHERE item_id=? ORDER BY date DESC, id DESC').bind(id),
        DB.prepare('SELECT * FROM watches WHERE item_id=? ORDER BY date DESC, id DESC').bind(id),
      ]);
      return ok({ item, photos: photos.results, loans: loans.results, plays: plays.results, watches: watches.results });
    }
    if (m === 'PUT') {
      const b = await body(request);
      const v = cleanItemValues(b);
      if (b.acquired_now) v.date_added = now();
      const old = [];
      if ('cover' in v && v.cover !== item.cover && item.cover) old.push(`covers/${item.cover}`, `thumbs/${item.cover}`);
      if ('backdrop' in v && v.backdrop !== item.backdrop && item.backdrop) old.push(`backdrops/${item.backdrop}`);
      v.updated = now();
      const keys = Object.keys(v);
      await DB.prepare(`UPDATE items SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).bind(...keys.map(k => v[k] ?? null), id).run();
      await deleteMedia(env, old);
      return ok();
    }
    if (m === 'DELETE') {
      const photos = await DB.prepare('SELECT file FROM photos WHERE item_id=?').bind(id).all();
      await DB.batch([
        DB.prepare('DELETE FROM photos WHERE item_id=?').bind(id),
        DB.prepare('DELETE FROM loans WHERE item_id=?').bind(id),
        DB.prepare('DELETE FROM plays WHERE item_id=?').bind(id),
        DB.prepare('DELETE FROM watches WHERE item_id=?').bind(id),
        DB.prepare('DELETE FROM items WHERE id=?').bind(id),
      ]);
      await deleteMedia(env, [
        item.cover && `covers/${item.cover}`, item.cover && `thumbs/${item.cover}`, item.backdrop && `backdrops/${item.backdrop}`,
        ...photos.results.flatMap(ph => [`photos/${ph.file}`, `thumbs/p_${ph.file}`]),
      ]);
      return ok();
    }
  }

  // Merge a few machine-maintained keys into items.data server-side, so background checks
  // never overwrite edits made elsewhere at the same time.
  if ((mm = p.match(/^\/items\/(\d+)\/data$/)) && m === 'PATCH') {
    const b = await body(request);
    const allowed = ['watch', 'archive', 'ma_url'];
    const stmts = [];
    for (const k of allowed) {
      if (!(k in b)) continue;
      stmts.push(DB.prepare(`UPDATE items SET data = json_set(COALESCE(data,'{}'), '$.${k}', json(?)) WHERE id=?`)
        .bind(JSON.stringify(b[k] ?? null), Number(mm[1])));
    }
    if (stmts.length) await DB.batch(stmts);
    return ok();
  }

  if ((mm = p.match(/^\/items\/(\d+)\/media$/)) && m === 'POST') {
    const item = await DB.prepare('SELECT id, cover, backdrop FROM items WHERE id=?').bind(Number(mm[1])).first();
    if (!item) throw new HttpError('Not found.', 404);
    return ok({ warnings: await applyMedia(env, item, await body(request)) });
  }

  if ((mm = p.match(/^\/items\/(\d+)\/photos$/)) && m === 'POST') {
    const b = await body(request);
    if (!b.file || !/^[A-Za-z0-9_.-]+\.jpg$/.test(b.file)) throw new HttpError('Bad photo name.');
    await DB.prepare('INSERT INTO photos(item_id,file,added) VALUES(?,?,?)').bind(Number(mm[1]), b.file, now()).run();
    return ok();
  }
  if ((mm = p.match(/^\/photos\/(\d+)$/)) && m === 'DELETE') {
    const r = await DB.prepare('SELECT file FROM photos WHERE id=?').bind(Number(mm[1])).first();
    if (r) {
      await DB.prepare('DELETE FROM photos WHERE id=?').bind(Number(mm[1])).run();
      await deleteMedia(env, [`photos/${r.file}`, `thumbs/p_${r.file}`]);
    }
    return ok();
  }

  // Raw image upload (already resized in the browser)
  if ((mm = p.match(/^\/upload\/(.+)$/)) && m === 'PUT') {
    const key = decodeURIComponent(mm[1]);
    if (!validMediaKey(key)) throw new HttpError('Bad file name.');
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > 25 * 1024 * 1024) throw new HttpError('That image is too large.');
    await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('Content-Type') || 'image/jpeg' } });
    return ok({ key });
  }

  // ---- loans
  if (p === '/loans' && m === 'GET') {
    const active = url.searchParams.get('active');
    const r = await DB.prepare(`SELECT l.*, i.title, i.type, i.cover FROM loans l JOIN items i ON i.id=l.item_id
      ${active ? 'WHERE l.returned IS NULL' : ''} ORDER BY l.date_lent DESC, l.id DESC LIMIT 300`).all();
    return ok({ loans: r.results });
  }
  if ((mm = p.match(/^\/items\/(\d+)\/loans$/)) && m === 'POST') {
    const b = await body(request);
    const borrower = String(b.borrower || '').trim();
    if (!borrower) throw new HttpError('Who borrowed it?');
    await DB.prepare('INSERT INTO loans(item_id,borrower,date_lent,due,notes) VALUES(?,?,?,?,?)')
      .bind(Number(mm[1]), borrower, b.date_lent || today(), b.due || null, b.notes || null).run();
    return ok();
  }
  if ((mm = p.match(/^\/loans\/(\d+)$/))) {
    if (m === 'PUT') {
      const b = await body(request);
      if (b.return) await DB.prepare('UPDATE loans SET returned=? WHERE id=?').bind(b.returned || today(), Number(mm[1])).run();
      return ok();
    }
    if (m === 'DELETE') { await DB.prepare('DELETE FROM loans WHERE id=?').bind(Number(mm[1])).run(); return ok(); }
  }

  // ---- plays
  const players = v => (Array.isArray(v) ? v : String(v || '').split(',')).map(x => String(x).trim()).filter(Boolean);
  if ((mm = p.match(/^\/items\/(\d+)\/plays$/)) && m === 'POST') {
    const b = await body(request);
    await DB.prepare('INSERT INTO plays(item_id,date,players,winner,notes,quantity) VALUES(?,?,?,?,?,1)')
      .bind(Number(mm[1]), b.date || today(), JSON.stringify(players(b.players)), String(b.winner || '').trim() || null, b.notes || null).run();
    return ok();
  }
  if (p === '/plays/bulk' && m === 'POST') {
    const b = await body(request);
    const rows = (b.plays || []).slice(0, 80);
    if (rows.length) {
      await DB.batch(rows.map(r => DB.prepare(`INSERT OR IGNORE INTO plays(item_id,date,players,winner,notes,quantity,bgg_play_id)
        VALUES(?,?,?,?,?,?,?)`).bind(Number(r.item_id), r.date || null, JSON.stringify(players(r.players)),
        r.winner || null, r.notes || null, Number(r.quantity) || 1, r.bgg_play_id ?? null)));
    }
    return ok({ count: rows.length });
  }
  if (p === '/plays/bgg-ids' && m === 'GET') {
    const r = await DB.prepare('SELECT bgg_play_id FROM plays WHERE bgg_play_id IS NOT NULL').all();
    return ok({ ids: r.results.map(x => x.bgg_play_id) });
  }
  if ((mm = p.match(/^\/plays\/(\d+)$/))) {
    if (m === 'PUT') {
      const b = await body(request);
      await DB.prepare('UPDATE plays SET date=?, players=?, winner=?, notes=? WHERE id=?')
        .bind(b.date || today(), JSON.stringify(players(b.players)), String(b.winner || '').trim() || null, b.notes || null, Number(mm[1])).run();
      return ok();
    }
    if (m === 'DELETE') { await DB.prepare('DELETE FROM plays WHERE id=?').bind(Number(mm[1])).run(); return ok(); }
  }

  // ---- watches
  if ((mm = p.match(/^\/items\/(\d+)\/watches$/)) && m === 'POST') {
    const b = await body(request);
    const season = b.season === '' || b.season == null ? null : Number(b.season);
    await DB.prepare('INSERT INTO watches(item_id,date,season,notes) VALUES(?,?,?,?)')
      .bind(Number(mm[1]), b.date || today(), season, b.notes || null).run();
    return ok();
  }
  if ((mm = p.match(/^\/watches\/(\d+)$/)) && m === 'DELETE') {
    await DB.prepare('DELETE FROM watches WHERE id=?').bind(Number(mm[1])).run();
    return ok();
  }

  if (p === '/people' && m === 'GET') {
    const [a, b] = await DB.batch([
      DB.prepare('SELECT DISTINCT borrower AS n FROM loans'),
      DB.prepare('SELECT players, winner FROM plays ORDER BY id DESC LIMIT 500'),
    ]);
    const names = new Set(a.results.map(r => r.n).filter(Boolean));
    for (const r of b.results) { try { JSON.parse(r.players || '[]').forEach(x => names.add(x)); } catch (e) { /* skip */ } }
    return ok({ names: [...names].filter(Boolean).sort((x, y) => x.localeCompare(y)) });
  }

  // ---- backup & restore
  if ((mm = p.match(/^\/backup\/([a-z]+)$/)) && m === 'GET') {
    const table = mm[1];
    if (!TABLES.includes(table)) throw new HttpError('Unknown table.');
    const offset = Number(url.searchParams.get('offset') || 0);
    const limit = 200;
    const order = table === 'settings' || table === 'types' ? 'key' : 'id';
    const r = await DB.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(limit, offset).all();
    return ok({ rows: r.results, more: r.results.length === limit });
  }
  if (p === '/media-list' && m === 'GET') {
    const r = await env.MEDIA.list({ cursor: url.searchParams.get('cursor') || undefined, limit: 500 });
    return ok({ keys: r.objects.map(o => o.key), cursor: r.truncated ? r.cursor : null });
  }
  if (p === '/restore/begin' && m === 'POST') {
    const b = await body(request);
    if (b.confirm !== 'REPLACE') throw new HttpError('Restore needs confirmation.');
    await DB.batch(['photos', 'loans', 'plays', 'watches', 'items', 'types'].map(t => DB.prepare(`DELETE FROM ${t}`))
      .concat([DB.prepare(`DELETE FROM settings WHERE key <> 'schema_version'`)]));
    return ok();
  }
  if (p === '/restore/rows' && m === 'POST') {
    const b = await body(request);
    const table = b.table;
    if (!TABLES.includes(table)) throw new HttpError('Unknown table.');
    const rows = (b.rows || []).slice(0, 50);
    const stmts = [];
    for (const row of rows) {
      if (table === 'settings' && row.key === 'schema_version') continue;
      const keys = Object.keys(row).filter(k => /^[a-z_]+$/.test(k));
      stmts.push(DB.prepare(`INSERT OR REPLACE INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`)
        .bind(...keys.map(k => row[k] ?? null)));
    }
    if (stmts.length) await DB.batch(stmts);
    return ok({ count: stmts.length });
  }

  throw new HttpError('Not found.', 404);
}

// ---------------------------------------------------------------- entry
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isApi = url.pathname.startsWith('/api/');
    const isMedia = url.pathname.startsWith('/media/');
    if (!isApi && !isMedia) return env.ASSETS.fetch(request);
    try {
      const user = await verifyAccess(request, env);
      await ensureSchema(env);
      if (isMedia) {
        const key = decodeURIComponent(url.pathname.slice('/media/'.length));
        if (!validMediaKey(key)) return new Response('Not found', { status: 404 });
        const obj = await env.MEDIA.get(key);
        if (!obj) return new Response('Not found', { status: 404 });
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'private, max-age=31536000, immutable');
        headers.set('ETag', obj.httpEtag);
        return new Response(obj.body, { headers });
      }
      return await api(request, env, url, user);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.message === 'setup') return fail('Vault isn’t finished setting up.', 503, { setup: true });
        return fail(e.message, e.status);
      }
      console.error(e);
      return fail(`Something went wrong on the server: ${e.message}`, 500);
    }
  },
};
