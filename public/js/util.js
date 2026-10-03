// Shared helpers: API calls, item normalizing, escaping, formatting, image resizing, toasts and dialogs.
import { icon } from './icons.js';

export const S = {
  types: [],
  counts: {},
  settings: {},
  boot: null,
  itemsCache: {},   // type -> normalized items array
};

export function invalidate(type) {
  if (type) delete S.itemsCache[type];
  else S.itemsCache = {};
}

export class SetupNeeded extends Error {}

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
  if (opts.raw !== undefined) {
    init.body = opts.raw;
    if (opts.contentType) init.headers['Content-Type'] = opts.contentType;
  } else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error('Vault couldn’t be reached. Check the internet connection.');
  }
  if (opts.rawResponse) return res;
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (res.status === 503 && data && data.setup) throw new SetupNeeded('setup');
  if (res.status === 401) throw new Error((data && data.error) || 'Your sign-in has expired. Reload the page to sign in again.');
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
  }
  return data;
}

export async function refreshBoot() {
  const b = await api('/api/bootstrap');
  S.boot = b;
  S.types = b.types;
  S.counts = b.counts;
  S.settings = b.settings;
  return b;
}

function parseJson(s, fallback) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(s || ''); } catch (e) { return fallback; }
}

// Turn raw database rows into the shape the views use.
export function normalizeItem(r) {
  r.tags = parseJson(r.tags, []);
  r.data = parseJson(r.data, {});
  if ('text' in r) r.text = parseJson(r.text, {});
  return r;
}

export function applySummaries(items, { loans = [], plays = [], watches = [] }) {
  const L = new Map(loans.map(l => [l.item_id, l.borrower]));
  const P = new Map(plays.map(p => [p.item_id, p]));
  const W = new Map(watches.map(w => [w.item_id, w]));
  for (const it of items) {
    it.on_loan = L.get(it.id) || null;
    const p = P.get(it.id);
    it.play_count = p ? Number(p.n) || 0 : 0;
    it.last_played = p ? p.last : null;
    const w = W.get(it.id);
    it.watched = !!w;
    it.last_watched = w ? w.last : null;
    it.seasons_watched = w && w.seasons ? [...new Set(String(w.seasons).split(',').filter(Boolean).map(Number))].sort((a, b) => a - b) : [];
  }
  return items;
}

export async function getItems(type) {
  if (!S.itemsCache[type]) {
    const r = await api(`/api/items?type=${encodeURIComponent(type)}`);
    S.itemsCache[type] = applySummaries(r.items.map(normalizeItem), r);
  }
  return S.itemsCache[type];
}

export async function getAllItems() {
  await Promise.all(S.types.map(t => getItems(t.key)));
  return S.types.flatMap(t => S.itemsCache[t.key] || []);
}

export const typeOf = key => S.types.find(t => t.key === key);

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function nowStamp() {
  return String(Date.now()).slice(-9) + Math.floor(Math.random() * 90 + 10);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return esc(s);
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const thumbUrl = it => it && it.cover ? `/media/thumbs/${encodeURIComponent(it.cover)}` : null;
export const coverUrl = it => it && it.cover ? `/media/covers/${encodeURIComponent(it.cover)}` : null;
// Games have no fanart, so their cover doubles as a heavily blurred backdrop.
export function backdropOf(it) {
  if (!it) return null;
  if (it.backdrop) return { url: `/media/backdrops/${encodeURIComponent(it.backdrop)}`, soft: false };
  if (it.cover) return { url: `/media/covers/${encodeURIComponent(it.cover)}`, soft: true };
  return null;
}

export function itemYear(it) {
  const d = it.data || {};
  return d.year || d.years_aired || '';
}

export function itemSubtitle(it) {
  const d = it.data || {};
  const bits = [];
  const y = itemYear(it);
  if (y) bits.push(y);
  if (d.edition) bits.push(d.edition);
  else if (d.format) bits.push(d.format);
  return bits.join(' · ');
}

// Values of a template field may live in data (short) or text (long text fields).
export function fieldValue(it, fd) {
  if (fd.kind === 'longtext') return (it.text && it.text[fd.key]) ?? (it.data && it.data[fd.key]);
  return it.data ? it.data[fd.key] : undefined;
}

export function fmtField(fd, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return '';
  switch (fd.kind) {
    case 'range': {
      if (typeof v !== 'object') return esc(v);
      return v.min === v.max || v.max == null ? esc(v.min) : `${esc(v.min)}–${esc(v.max)}`;
    }
    case 'bool': return v ? 'Yes' : 'No';
    case 'list': return (Array.isArray(v) ? v : [v]).map(x => `<span class="chip">${esc(x)}</span>`).join(' ');
    case 'url': return `<a href="${esc(v)}" target="_blank" rel="noopener" class="ext">${esc(String(v).replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`;
    case 'rating': return `${esc(v)} / 10`;
    case 'date': return fmtDate(v);
    case 'longtext': return `<div class="prose">${esc(v)}</div>`;
    case 'itemlink': return (Array.isArray(v) ? v : []).map(x => esc(x.name)).join(', ');
    default: return esc(v);
  }
}

export function plainField(fd, v) {
  if (v === null || v === undefined || v === '') return '';
  if (fd.kind === 'range' && typeof v === 'object') return v.min === v.max || v.max == null ? String(v.min) : `${v.min}–${v.max}`;
  if (fd.kind === 'bool') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(x => (typeof x === 'object' ? x.name : x)).join(', ');
  return String(v);
}

// ---------- images (resized in the browser before upload) ----------
export async function resizeImage(file, maxW, maxH, quality = 0.86) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) { bmp = await createImageBitmap(file); }
  const scale = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#16181f';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Couldn’t process that image.'))), 'image/jpeg', quality));
}

export async function uploadBlob(key, blob) {
  return api(`/api/upload/${encodeURIComponent(key)}`, { method: 'PUT', raw: blob, contentType: 'image/jpeg' });
}

// Replace an item's cover with an image file chosen by the user.
export async function setCustomCover(itemId, file) {
  const name = `${itemId}_${nowStamp()}.jpg`;
  const [cover, thumb] = await Promise.all([resizeImage(file, 1200, 1800), resizeImage(file, 360, 1080, 0.82)]);
  await uploadBlob(`covers/${name}`, cover);
  await uploadBlob(`thumbs/${name}`, thumb);
  await api(`/api/items/${itemId}`, { method: 'PUT', body: { cover: name, cover_custom: 1 } });
}

export async function addPhotos(itemId, files) {
  for (const file of files) {
    const name = `${itemId}_${nowStamp()}.jpg`;
    const [photo, thumb] = await Promise.all([resizeImage(file, 2000, 2000), resizeImage(file, 640, 640, 0.8)]);
    await uploadBlob(`photos/${name}`, photo);
    await uploadBlob(`thumbs/p_${name}`, thumb);
    await api(`/api/items/${itemId}/photos`, { method: 'POST', body: { file: name } });
  }
}

// ---------- toasts ----------
export function toast(msg, kind = 'info', ms = 3800) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = esc(msg);
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, ms);
  return el;
}

export function busy(msg) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.innerHTML = `<div class="spinner"></div><div class="busy-msg">${esc(msg)}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const done = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 200); };
  done.update = m => { el.querySelector('.busy-msg').textContent = m; };
  return done;
}

// ---------- modal dialogs ----------
export function modal({ title, body, actions = [], wide = false, onOpen, cls = '' }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${cls}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-x aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body">${body}</div>
      ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.kind || ''}" data-a="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('in'));
    let closed = false;
    const close = val => {
      if (closed) return;
      closed = true;
      wrap.classList.remove('in');
      document.removeEventListener('keydown', onKey);
      wrap.dispatchEvent(new Event('modal-close'));
      setTimeout(() => wrap.remove(), 180);
      resolve(val);
    };
    const onKey = e => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(null); });
    wrap.querySelector('[data-x]').onclick = () => close(null);
    wrap.querySelectorAll('[data-a]').forEach(b => {
      b.onclick = async () => {
        const a = actions[Number(b.dataset.a)];
        if (a.handler) {
          const root = wrap.querySelector('.modal-body');
          b.disabled = true;
          try {
            const v = await a.handler(root);
            if (v === false) { b.disabled = false; return; }
            close(v === undefined ? a.value ?? true : v);
          } catch (err) { toast(err.message, 'error'); b.disabled = false; }
        } else close(a.value ?? null);
      };
    });
    if (onOpen) onOpen(wrap.querySelector('.modal-body'), close, wrap);
    const first = wrap.querySelector('.modal-body input:not([type=hidden]):not([type=checkbox]),.modal-body select,.modal-body textarea');
    if (first && window.matchMedia('(pointer:fine)').matches) setTimeout(() => first.focus(), 60);
  });
}

export function confirmBox(title, message, okLabel = 'Delete', kind = 'danger') {
  return modal({
    title, body: `<p>${esc(message)}</p>`,
    actions: [{ label: 'Cancel', value: false }, { label: okLabel, kind, value: true }],
  });
}

// Chip-style input for names (players, tags, list fields).
export function namesInput(initial = [], suggestions = [], placeholder = 'Add a name and press Enter') {
  const wrap = document.createElement('div');
  wrap.className = 'names-input';
  const listId = 'dl' + Math.random().toString(36).slice(2);
  const names = [...initial];
  const render = () => {
    wrap.innerHTML = names.map((n, i) => `<span class="chip removable">${esc(n)}<button type="button" data-i="${i}" aria-label="Remove">×</button></span>`).join('')
      + `<input list="${listId}" placeholder="${esc(placeholder)}" enterkeyhint="done"><datalist id="${listId}">${suggestions.map(s => `<option value="${esc(s)}">`).join('')}</datalist>`;
    const inp = wrap.querySelector('input');
    inp.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ',') && inp.value.trim()) {
        e.preventDefault(); add(inp.value);
      } else if (e.key === 'Backspace' && !inp.value && names.length) {
        names.pop(); render(); wrap.querySelector('input').focus();
      }
    });
    inp.addEventListener('change', () => { if (inp.value.trim() && suggestions.includes(inp.value.trim())) add(inp.value); });
    wrap.querySelectorAll('button[data-i]').forEach(b => b.onclick = () => { names.splice(Number(b.dataset.i), 1); render(); });
    wrap.dispatchEvent(new Event('names-changed'));
  };
  const add = v => {
    v.split(',').map(s => s.trim()).filter(Boolean).forEach(s => { if (!names.includes(s)) names.push(s); });
    render(); wrap.querySelector('input').focus();
  };
  render();
  return {
    el: wrap,
    get: () => {
      const pending = wrap.querySelector('input').value.trim();
      if (pending) pending.split(',').map(s => s.trim()).filter(Boolean).forEach(s => { if (!names.includes(s)) names.push(s); });
      return [...names];
    },
  };
}

export function pickFile({ accept = 'image/*', capture = null, multiple = false } = {}) {
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    if (capture) inp.setAttribute('capture', capture);
    if (multiple) inp.multiple = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = () => { resolve(Array.from(inp.files || [])); inp.remove(); };
    inp.click();
  });
}

export function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem('vault:' + key) || 'null');
    localStorage.setItem('vault:' + key, JSON.stringify(val));
  } catch (e) { return null; }
  return val;
}

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.dataset.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Couldn’t load ${src}`));
    document.head.appendChild(s);
  });
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
