// Add page: search the online source by name (or arrive here from a barcode scan).
import { icon } from '../icons.js';
import { S, esc, $, $$, typeOf, toast, busy, modal } from '../util.js';
import { setTitle, setBackdrop, scanBarcode } from '../app.js';
import { setPrefill } from './edit.js';
import { SOURCE_NAMES, lookupSearch, lookupDetails, versions as bggVersions } from '../sources/index.js';

function resultCard(r) {
  return `<button class="result" data-id="${r.id}">
    <span class="r-thumb">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : icon('image')}</span>
    <span class="r-text"><b>${esc(r.title)}</b>
      <small>${[r.year, r.subtitle].filter(Boolean).map(esc).join(' · ')}</small>
      ${r.badge ? `<em class="r-badge">${esc(r.badge)}</em>` : ''}${r.language ? `<small>${esc(r.language)}</small>` : ''}</span>
  </button>`;
}

async function chooseVersion(gameId, title) {
  const done = busy('Checking editions on BoardGameGeek…');
  let versions = [];
  try { versions = await bggVersions(gameId); }
  catch (e) { toast(e.message, 'warn'); }
  finally { done(); }
  if (versions.length <= 1) return versions.length === 1 ? versions[0].id : null;
  const v = await modal({
    title: `Which edition of “${title}”?`, wide: true,
    body: `<p class="muted">BoardGameGeek lists ${versions.length} printings. Pick yours, or skip to use the standard entry.</p>
      <div class="results compact">${versions.map(v => resultCard(v)).join('')}</div>`,
    actions: [{ label: 'Skip', value: 0 }],
    onOpen: (root, close) => {
      $$('.result', root).forEach(b => b.onclick = () => close(Number(b.dataset.id)));
    },
  });
  return v === null ? undefined : (v || null);
}

export async function renderAdd(ctx) {
  const p = ctx.params;
  const typeKey = p.type && typeOf(p.type) ? p.type : (S.types[0] && S.types[0].key);
  const t = typeOf(typeKey);
  const status = p.status === 'wishlist' ? 'wishlist' : 'owned';
  const barcode = p.barcode || '';
  setTitle(`${icon('plus')} Add${status === 'wishlist' ? ' to wishlist' : ''}`);
  setBackdrop(null);
  const hasKey = t.source === 'bgg' ? S.settings.has_bgg_token : (t.source.startsWith('tmdb') ? S.settings.has_tmdb_key : true);
  const srcName = SOURCE_NAMES[t.source];
  const qs = (extra = {}) => {
    const o = { type: typeKey, ...(status === 'wishlist' ? { status } : {}), ...(barcode ? { barcode } : {}), ...extra };
    return new URLSearchParams(o).toString();
  };

  ctx.view.innerHTML = `
    <div class="add-page">
      <div class="type-tabs">${S.types.map(x => `<a href="#/add?${new URLSearchParams({ type: x.key, ...(status === 'wishlist' ? { status } : {}) })}" class="${x.key === typeKey ? 'on' : ''}">${icon(x.icon)} ${esc(x.name)}</a>`).join('')}</div>
      ${barcode ? `<div class="notice">${icon('scan')} Barcode <b>${esc(barcode)}</b> will be saved with the item you pick.</div>` : ''}
      ${srcName ? `
        ${!hasKey ? `<div class="notice warn">${icon('info')} ${srcName} isn’t connected yet. <a href="#/settings/sources">Add the key in Settings</a>, or enter this item manually.</div>` : ''}
        <form class="search-row" id="add-form">
          <div class="big-search">${icon('search')}<input id="add-q" type="search" placeholder="Search ${esc(srcName)} for a title" value="${esc(p.q || '')}" autocomplete="off"></div>
          <button class="btn primary" type="submit">Search</button>
          <button class="btn" type="button" id="add-scan">${icon('scan')} Scan</button>
        </form>
        <div id="add-results"></div>` : `
        <div class="notice">${icon('info')} ${esc(t.name)} has no online source, so items are entered by hand.</div>`}
      <div class="manual-row"><a class="btn ghost" href="#/edit/${typeKey}/new" id="add-manual">${icon('edit')} Enter manually instead</a></div>
    </div>`;

  $('#add-manual', ctx.view).onclick = () => setPrefill({ status, barcode, title: p.q || '' });
  if (!srcName) return;

  const resBox = $('#add-results', ctx.view);
  let page = 1, query = '';
  const pick = async (id, title) => {
    let version = null;
    if (t.source === 'bgg') {
      version = await chooseVersion(id, title);
      if (version === undefined) return;      // dialog closed: cancel
    }
    const done = busy('Getting details…');
    try {
      const pre = await lookupDetails(typeKey, id, version || null);
      setPrefill({ ...pre, status, barcode });
      location.hash = `#/edit/${typeKey}/new`;
    } catch (e) { toast(e.message, 'error'); }
    finally { done(); }
  };
  const run = async (more = false) => {
    if (!more) { page = 1; query = $('#add-q', ctx.view).value.trim(); }
    if (!query) return;
    if (!more) resBox.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    const btn = $('#more-btn', resBox);
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      const r = await lookupSearch(typeKey, query, page);
      if (!ctx.isCurrent()) return;
      const cards = r.results.map(resultCard).join('');
      if (!more) {
        resBox.innerHTML = r.results.length
          ? `<p class="muted">${r.total} match${r.total === 1 ? '' : 'es'} on ${srcName}. Pick the one you have.</p><div class="results">${cards}</div>`
          : `<div class="empty small"><p>No matches for “${esc(query)}”. Try fewer words, or enter it manually.</p></div>`;
      } else {
        $('.results', resBox).insertAdjacentHTML('beforeend', cards);
      }
      $('#more-btn', resBox)?.remove();
      if (r.has_more) resBox.insertAdjacentHTML('beforeend', '<div class="center"><button class="btn" id="more-btn">More results</button></div>');
      $$('.result', resBox).forEach(b => b.onclick = () => pick(b.dataset.id, b.querySelector('b').textContent));
      const mb = $('#more-btn', resBox);
      if (mb) mb.onclick = () => { page += 1; run(true); };
    } catch (e) {
      if (!more) resBox.innerHTML = `<div class="notice warn">${icon('info')} ${esc(e.message)}</div>`;
      else toast(e.message, 'error');
    }
  };
  $('#add-form', ctx.view).onsubmit = e => { e.preventDefault(); history.replaceState(null, '', `#/add?${qs({ q: $('#add-q', ctx.view).value.trim() })}`); run(); };
  $('#add-scan', ctx.view).onclick = () => scanBarcode({ type: typeKey, status: status === 'wishlist' ? 'wishlist' : null });
  if (p.q) run();
  else if (window.matchMedia('(pointer:fine)').matches) $('#add-q', ctx.view).focus();
}
