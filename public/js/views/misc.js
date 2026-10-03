// Global search, On Loan list, the cross-collection Wishlist, and the first-run setup page.
import { icon } from '../icons.js';
import { S, api, esc, $$, typeOf, getAllItems, fmtDate, toast, invalidate } from '../util.js';
import { setTitle, setBackdrop } from '../app.js';
import { posterCard, wireHoverBackdrop, emptyState } from './components.js';

// Fields left out of search so results stay meaningful.
const SEARCH_SKIP = new Set(['game_type', 'imdb', 'expands']);
function valuesText(v) {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valuesText).join(' ');
  if (typeof v === 'object') return Object.values(v).map(valuesText).join(' ');
  return String(v);
}
export function searchItems(items, q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const it of items) {
    const title = (it.title || '').toLowerCase();
    const data = Object.entries(it.data || {}).filter(([k]) => !SEARCH_SKIP.has(k)).map(([, v]) => valuesText(v)).join(' ');
    const hay = `${title} ${it.group_name || ''} ${it.notes || ''} ${(it.tags || []).join(' ')} ${data} ${it.barcode || ''}`.toLowerCase();
    if (!hay.includes(needle)) continue;
    scored.push([title.startsWith(needle) ? 0 : title.includes(needle) ? 1 : 2, it]);
  }
  scored.sort((a, b) => (a[0] - b[0]) || (a[1].sort_title || '').localeCompare(b[1].sort_title || ''));
  return scored.map(x => x[1]);
}

export function renderSetup(ctx) {
  setBackdrop(null);
  const t = document.getElementById('page-title');
  if (t) t.innerHTML = `${icon('gear')} Finish setup`;
  ctx.view.innerHTML = `<div class="empty setup">
    <div class="empty-icon">${icon('vault')}</div>
    <h2>Almost there</h2>
    <p>Vault is running, but its sign-in protection isn\u2019t connected yet. Until it is, Vault keeps your collection locked.</p>
    <ol class="setup-steps">
      <li>In Cloudflare, open <b>Workers & Pages \u2192 vault \u2192 Settings \u2192 Domains & Routes</b> and turn on <b>Cloudflare Access</b> for the workers.dev address.</li>
      <li>Copy the <b>team domain</b> and <b>AUD tag</b> it shows into <code>wrangler.jsonc</code> on GitHub (<code>ACCESS_TEAM</code> and <code>ACCESS_AUD</code>) and commit.</li>
      <li>Wait a minute for Cloudflare to redeploy, then reload this page.</li>
    </ol>
    <p class="muted">The README in the Vault folder walks through this with screenshots-level detail.</p>
    <div class="btn-row center"><button class="btn primary" id="setup-reload">Reload</button></div>
  </div>`;
  document.getElementById('setup-reload').onclick = () => location.reload();
}

export async function renderSearch(ctx) {
  const q = (ctx.params.q || '').trim();
  setTitle(`${icon('search')} Search`);
  setBackdrop(null);
  if (!q) { ctx.view.innerHTML = emptyState('Search everything', 'Type in the search box at the top.'); return; }
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const r = { items: searchItems(await getAllItems(), q) };
  if (!ctx.isCurrent()) return;
  if (!r.items.length) {
    ctx.view.innerHTML = emptyState(`Nothing matches “${q}”`, 'Try another word, or add it to Vault.',
      `<div class="btn-row center"><a class="btn primary" href="#/add?q=${encodeURIComponent(q)}">${icon('plus')} Add “${esc(q)}”</a></div>`);
    return;
  }
  let html = `<div class="col-head"><h1>Results for “${esc(q)}”</h1><span class="count">${r.items.length} items</span></div>`;
  for (const t of S.types) {
    const items = r.items.filter(i => i.type === t.key);
    if (!items.length) continue;
    html += `<section class="result-group"><h2>${icon(t.icon)} ${esc(t.name)} <span class="count">${items.length}</span></h2>
      <div class="wall">${items.map(i => posterCard(i)).join('')}</div></section>`;
  }
  ctx.view.innerHTML = html;
  wireHoverBackdrop(ctx.view, null);
}

export async function renderLoans(ctx) {
  setTitle(`${icon('handoff')} On Loan`);
  setBackdrop(null);
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const [active, all] = await Promise.all([api('/api/loans?active=1'), api('/api/loans')]);
  if (!ctx.isCurrent()) return;
  const past = all.loans.filter(l => l.returned).slice(0, 30);
  const now = new Date().toISOString().slice(0, 10);
  const rowHtml = (l, isActive) => {
    const t = typeOf(l.type);
    const th = l.cover ? `/media/thumbs/${encodeURIComponent(l.cover)}` : null;
    const overdue = isActive && l.due && l.due < now;
    return `<li class="loan-row">
      <a class="lr-thumb" href="#/item/${l.type}/${l.item_id}">${th ? `<img src="${th}" alt="">` : icon(t ? t.icon : 'box')}</a>
      <div class="lr-text"><a href="#/item/${l.type}/${l.item_id}"><b>${esc(l.title)}</b></a>
        <span>${esc(l.borrower)} · lent ${fmtDate(l.date_lent)}${l.due ? ` · <span class="${overdue ? 'warn' : ''}">due ${fmtDate(l.due)}${overdue ? ' (overdue)' : ''}</span>` : ''}${l.returned ? ` · returned ${fmtDate(l.returned)}` : ''}</span></div>
      ${isActive ? `<button class="btn small" data-return="${l.id}" data-type="${l.type}">${icon('check')} Returned</button>` : ''}
    </li>`;
  };
  ctx.view.innerHTML = `
    <div class="col-head"><h1>On Loan</h1><span class="count">${active.loans.length} out</span></div>
    ${active.loans.length ? `<ul class="loan-list">${active.loans.map(l => rowHtml(l, true)).join('')}</ul>`
      : emptyState('Nothing is out on loan', 'Use “Lend” on any item to keep track of who has it.')}
    ${past.length ? `<h2 class="sub-head">Recently returned</h2><ul class="loan-list past">${past.map(l => rowHtml(l, false)).join('')}</ul>` : ''}`;
  $$('[data-return]', ctx.view).forEach(b => b.onclick = async () => {
    try {
      await api(`/api/loans/${b.dataset.return}`, { method: 'PUT', body: { return: true } });
      invalidate(b.dataset.type);
      toast('Marked returned.', 'ok');
      renderLoans(ctx);
    } catch (e) { toast(e.message, 'error'); }
  });
}

export async function renderWishlist(ctx) {
  setTitle(`${icon('heart')} Wishlist`);
  setBackdrop(null);
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const all = await getAllItems();
  if (!ctx.isCurrent()) return;
  const wish = all.filter(i => i.status === 'wishlist');
  if (!wish.length) {
    ctx.view.innerHTML = emptyState('Your wishlist is empty', 'Add things you’re hoping to find. “Got it” moves them into your collection.',
      `<div class="btn-row center"><a class="btn primary" href="#/add?status=wishlist">${icon('plus')} Add to wishlist</a></div>`);
    return;
  }
  let html = `<div class="col-head"><h1>Wishlist</h1><span class="count">${wish.length} items</span>
    <a class="btn small" href="#/add?status=wishlist">${icon('plus')} Add to wishlist</a></div>`;
  for (const t of S.types) {
    const items = wish.filter(i => i.type === t.key).sort((a, b) => (a.sort_title || '').localeCompare(b.sort_title || ''));
    if (!items.length) continue;
    html += `<section class="result-group"><h2>${icon(t.icon)} ${esc(t.name)} <span class="count">${items.length}</span></h2>
      <div class="wall">${items.map(i => posterCard(i)).join('')}</div></section>`;
  }
  ctx.view.innerHTML = html;
  wireHoverBackdrop(ctx.view, null);
}
