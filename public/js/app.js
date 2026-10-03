// Vault — shell, routing, theme and backdrop.
import { icon } from './icons.js';
import { S, refreshBoot, esc, $, $$, store, debounce, thumbUrl, typeOf, getAllItems, SetupNeeded } from './util.js';
import { scanBarcode } from './scanner.js';
import { renderHome } from './views/home.js';
import { renderCollection } from './views/collection.js';
import { renderItem } from './views/item.js';
import { renderEdit } from './views/edit.js';
import { renderAdd } from './views/add.js';
import { renderSettings } from './views/settings.js';
import { renderSearch, renderLoans, renderWishlist, renderWatchlist, searchItems, renderSetup } from './views/misc.js';
import { startWatchChecks } from './watch.js';

export { scanBarcode };

// ---------------- theme ----------------
const THEMES = ['dark', 'light', 'system'];
function applyTheme(mode) {
  const sys = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = mode === 'system' ? sys : mode;
  document.documentElement.dataset.themeMode = mode;
  const btn = $('#theme-btn');
  if (btn) {
    btn.innerHTML = icon(mode === 'dark' ? 'moon' : mode === 'light' ? 'sun' : 'auto');
    btn.title = `Theme: ${mode === 'system' ? 'follow system' : mode} (click to change)`;
  }
}
export function getThemeMode() { return store('theme') || 'dark'; }
export function setThemeMode(mode) { store('theme', mode); applyTheme(mode); }
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(getThemeMode()));

// ---------------- backdrop (Kodi-style fanart) ----------------
// bd = { url, soft } — soft means "no real fanart; blur the cover heavily instead".
let bdCurrent = null;
let bdTimer = null;
export function setBackdrop(bd) {
  if (typeof bd === 'string') bd = { url: bd, soft: false };
  const key = bd && bd.url ? `${bd.url}|${bd.soft ? 1 : 0}` : null;
  clearTimeout(bdTimer);
  bdTimer = setTimeout(() => {
    if (key === bdCurrent) return;
    bdCurrent = key;
    const layers = $$('#backdrop .bd-layer');
    const showing = layers.find(l => l.classList.contains('on'));
    const next = layers.find(l => l !== showing);
    if (!key) {
      layers.forEach(l => l.classList.remove('on'));
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (bdCurrent !== key) return;
      next.style.backgroundImage = `url("${bd.url}")`;
      next.classList.toggle('soft', !!bd.soft);
      next.classList.add('on');
      if (showing) showing.classList.remove('on');
    };
    img.src = bd.url;
  }, 120);
}

// ---------------- shell ----------------
function navHtml() {
  const types = S.types.map(t => {
    const c = (S.counts[t.key] || {}).owned || 0;
    return `<a href="#/c/${t.key}" data-nav="c/${t.key}">${icon(t.icon)}<span>${esc(t.name)}</span><em>${c || ''}</em></a>`;
  }).join('');
  return `
    <a href="#/home" data-nav="home">${icon('home')}<span>Home</span></a>
    <div class="nav-sep"></div>
    ${types}
    <div class="nav-sep"></div>
    <a href="#/wishlist" data-nav="wishlist">${icon('heart')}<span>Wishlist</span></a>
    <a href="#/watchlist" data-nav="watchlist">${icon('eye')}<span>Watchlist</span></a>
    <a href="#/loans" data-nav="loans">${icon('handoff')}<span>On Loan</span></a>
    <div class="nav-grow"></div>
    <a href="#/settings" data-nav="settings">${icon('gear')}<span>Settings</span></a>`;
}

export function refreshNav() {
  $('#nav').innerHTML = navHtml();
  markNav();
}

function markNav() {
  const h = location.hash.replace(/^#\//, '');
  $$('#nav a').forEach(a => {
    const n = a.dataset.nav;
    a.classList.toggle('active', h === n || h.startsWith(n + '/') || h.startsWith(n + '?'));
  });
}

function buildShell() {
  document.body.innerHTML = `
  <div id="backdrop"><div class="bd-layer"></div><div class="bd-layer"></div><div class="bd-shade"></div></div>
  <aside id="sidebar">
    <a class="brand" href="#/home">${icon('vault')}<span>VAULT</span></a>
    <nav id="nav"></nav>
  </aside>
  <div id="scrim"></div>
  <div id="main">
    <header id="topbar">
      <button class="icon-btn only-phone" id="menu-btn" aria-label="Menu">${icon('menu')}</button>
      <div id="page-title"></div>
      <div class="search-box">
        ${icon('search')}
        <input id="gsearch" type="search" placeholder="Search everything" autocomplete="off">
        <div id="gsearch-pop" hidden></div>
      </div>
      <button class="icon-btn" id="scan-btn" title="Scan a barcode">${icon('scan')}</button>
      <a class="btn primary add-btn" id="add-btn" href="#/add">${icon('plus')}<span>Add</span></a>
      <button class="icon-btn" id="theme-btn"></button>
      <div id="clock" class="only-wide"></div>
    </header>
    <main id="view"></main>
  </div>
  <div id="toasts"></div>`;
  refreshNav();
  applyTheme(getThemeMode());
  $('#theme-btn').onclick = () => {
    const m = getThemeMode();
    setThemeMode(THEMES[(THEMES.indexOf(m) + 1) % THEMES.length]);
  };
  $('#menu-btn').onclick = () => document.body.classList.toggle('nav-open');
  $('#scrim').onclick = () => document.body.classList.remove('nav-open');
  $('#nav').addEventListener('click', e => { if (e.target.closest('a')) document.body.classList.remove('nav-open'); });
  $('#scan-btn').onclick = () => {
    const m = location.hash.match(/^#\/(?:c|item)\/([a-z0-9_]+)/) || location.hash.match(/[?&]type=([a-z0-9_]+)/);
    const status = location.hash.startsWith('#/wishlist') ? 'wishlist' : location.hash.startsWith('#/watchlist') ? 'watchlist' : null;
    scanBarcode({ type: m && typeOf(m[1]) ? m[1] : null, status });
  };
  $('#add-btn').addEventListener('click', e => {
    // Add into the collection currently being viewed.
    const m = location.hash.match(/^#\/(?:c|item)\/([a-z0-9_]+)/);
    const cur = m && typeOf(m[1]) ? m[1] : null;
    if (cur) { e.preventDefault(); location.hash = `#/add?type=${cur}`; }
    if (location.hash.startsWith('#/wishlist')) { e.preventDefault(); location.hash = '#/add?status=wishlist'; }
    if (location.hash.startsWith('#/watchlist')) { e.preventDefault(); location.hash = '#/add?type=movie&status=watchlist'; }
  });
  setupGlobalSearch();
  const tick = () => {
    const d = new Date();
    $('#clock').textContent = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15000);
}

export function setTitle(html) { $('#page-title').innerHTML = html; }

// ---------------- global search ----------------
function setupGlobalSearch() {
  const inp = $('#gsearch');
  const pop = $('#gsearch-pop');
  const run = debounce(async () => {
    const q = inp.value.trim();
    if (q.length < 2) { pop.hidden = true; return; }
    try {
      const items = searchItems(await getAllItems(), q);
      if (inp.value.trim() !== q) return;
      if (!items.length) {
        pop.innerHTML = `<div class="gs-empty">Nothing in Vault matches \u201c${esc(q)}\u201d.</div>`;
      } else {
        const top = items.slice(0, 8);
        pop.innerHTML = top.map(it => {
          const t = typeOf(it.type);
          const th = thumbUrl(it);
          return `<a href="#/item/${it.type}/${it.id}" class="gs-row">
            <span class="gs-thumb">${th ? `<img src="${th}" alt="">` : icon(t ? t.icon : 'box')}</span>
            <span class="gs-text"><b>${esc(it.title)}</b><small>${esc(t ? t.name : it.type)}${it.status === 'wishlist' ? ' \u00b7 Wishlist' : ''}</small></span></a>`;
        }).join('') + `<a class="gs-all" href="#/search?q=${encodeURIComponent(q)}">See all ${items.length} results</a>`;
      }
      pop.hidden = false;
    } catch (e) { /* ignore while typing */ }
  }, 200);
  inp.addEventListener('input', run);
  inp.addEventListener('focus', () => { if (inp.value.trim().length >= 2) run(); });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter' && inp.value.trim()) {
      pop.hidden = true;
      location.hash = `#/search?q=${encodeURIComponent(inp.value.trim())}`;
      inp.blur();
    }
    if (e.key === 'Escape') { pop.hidden = true; inp.blur(); }
  });
  document.addEventListener('mousedown', e => { if (!e.target.closest('.search-box')) pop.hidden = true; });
  pop.addEventListener('click', e => { if (e.target.closest('a')) { pop.hidden = true; inp.value = ''; } });
}

// ---------------- router ----------------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'home';
  const [pathPart, qs] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = Object.fromEntries(new URLSearchParams(qs || ''));
  return { parts, params };
}

let routeToken = 0;
async function route() {
  const token = ++routeToken;
  const { parts, params } = parseHash();
  const view = $('#view');
  markNav();
  document.body.classList.remove('nav-open');
  window.scrollTo(0, 0);
  view.scrollTop = 0;
  const ctx = { view, params, parts, isCurrent: () => token === routeToken };
  view.className = '';
  try {
    switch (parts[0]) {
      case 'home': await renderHome(ctx); break;
      case 'c': await renderCollection(ctx, parts[1]); break;
      case 'item': await renderItem(ctx, parts[1], Number(parts[2])); break;
      case 'edit': await renderEdit(ctx, parts[1], parts[2] === 'new' ? null : Number(parts[2])); break;
      case 'add': await renderAdd(ctx); break;
      case 'settings': await renderSettings(ctx, parts[1] || 'general'); break;
      case 'search': await renderSearch(ctx); break;
      case 'loans': await renderLoans(ctx); break;
      case 'wishlist': await renderWishlist(ctx); break;
      case 'watchlist': await renderWatchlist(ctx); break;
      default: location.hash = '#/home';
    }
  } catch (e) {
    console.error(e);
    if (e instanceof SetupNeeded) { renderSetup(ctx); return; }
    if (ctx.isCurrent()) view.innerHTML = `<div class="empty"><h2>Something went wrong</h2><p>${esc(e.message)}</p></div>`;
  }
}

async function start() {
  buildShell();
  try {
    await refreshBoot();
  } catch (e) {
    if (e instanceof SetupNeeded) { renderSetup({ view: $('#view') }); return; }
    $('#view').innerHTML = `<div class="empty"><h2>Can’t reach Vault</h2><p>${esc(e.message)}</p>
      <p><button class="btn" id="retry-btn">Try again</button></p></div>`;
    $('#retry-btn').onclick = () => location.reload();
    return;
  }
  refreshNav();
  window.addEventListener('hashchange', route);
  route();
  // Quietly keep "where to watch" information up to date in the background.
  setTimeout(() => { startWatchChecks().catch(() => {}); }, 5000);
}

start();
