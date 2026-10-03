// Home: featured item plus Kodi-style shelves.
import { icon } from '../icons.js';
import { S, api, esc, getAllItems, backdropOf, coverUrl, itemSubtitle, typeOf } from '../util.js';
import { setTitle, setBackdrop } from '../app.js';
import { row, wireShelves, wireHoverBackdrop, emptyState } from './components.js';

export async function renderHome(ctx) {
  setTitle('Home');
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const all = await getAllItems();
  if (!ctx.isCurrent()) return;
  if (!all.length) {
    setBackdrop(null);
    const tips = [];
    if (!S.settings.has_bgg_token || !S.settings.has_tmdb_key) tips.push('<a class="btn" href="#/settings/sources">Add API keys</a>');
    tips.push('<a class="btn" href="#/settings/import">Import from BoardGameGeek</a>');
    tips.push('<a class="btn primary" href="#/add">Add your first item</a>');
    ctx.view.innerHTML = emptyState('Welcome to Vault',
      'Your collection is empty. Connect your data sources, bring in your BoardGameGeek collection, or add something by name or barcode.',
      `<div class="btn-row center">${tips.join('')}</div>`);
    return;
  }
  const owned = all.filter(i => i.status === 'owned');
  const byAdded = (a, b) => (b.date_added || '').localeCompare(a.date_added || '');
  const withBd = owned.filter(i => i.backdrop).sort(byAdded);
  const featured = withBd[0] || owned.slice().sort(byAdded)[0] || all[0];
  const fBd = backdropOf(featured);
  setBackdrop(fBd);
  const ft = typeOf(featured.type);
  const cover = coverUrl(featured);

  let shelves = '';
  for (const t of S.types) {
    const items = owned.filter(i => i.type === t.key).sort(byAdded).slice(0, 24);
    shelves += row(`Recently added · ${t.name}`, items, { more: `#/c/${t.key}` });
  }
  const unwatched = owned.filter(i => i.type === 'movie' && !i.watched).sort(byAdded).slice(0, 24);
  shelves += row('Unwatched movies', unwatched, { more: '#/c/movie?f=unwatched' });
  const tvOpen = owned.filter(i => i.type === 'tv' && !i.watched).sort(byAdded).slice(0, 24);
  shelves += row('TV series to start', tvOpen, { more: '#/c/tv?f=unwatched' });
  const played = owned.filter(i => i.play_count > 0).sort((a, b) => (b.last_played || '').localeCompare(a.last_played || '')).slice(0, 24);
  shelves += row('Recently played', played, { more: '#/c/boardgame?sort=last_played' });
  const loaned = all.filter(i => i.on_loan);
  shelves += row('On loan', loaned, { more: '#/loans', showType: true });
  const wish = all.filter(i => i.status === 'wishlist').sort(byAdded).slice(0, 24);
  shelves += row('Wishlist', wish, { more: '#/wishlist', showType: true });

  const totals = S.types.map(t => {
    const c = (S.counts[t.key] || {}).owned || 0;
    return c ? `<a href="#/c/${t.key}" class="stat">${icon(t.icon)}<b>${c}</b><span>${esc(t.name)}</span></a>` : '';
  }).join('');

  ctx.view.innerHTML = `
    <section class="hero">
      ${cover ? `<a class="hero-cover" href="#/item/${featured.type}/${featured.id}"><img src="${cover}" alt=""></a>` : ''}
      <div class="hero-text">
        <div class="eyebrow">${icon(ft ? ft.icon : 'box')} Latest in ${esc(ft ? ft.name : '')}</div>
        <h1>${esc(featured.title)}</h1>
        <div class="hero-sub">${esc(itemSubtitle(featured))}</div>
        <p class="hero-blurb" id="hero-blurb"></p>
        <div class="btn-row"><a class="btn primary" href="#/item/${featured.type}/${featured.id}">Open</a>
        <a class="btn" href="#/c/${featured.type}">Browse ${esc(ft ? ft.name : '')}</a></div>
      </div>
    </section>
    <div class="stats">${totals}</div>
    ${shelves}`;
  wireShelves(ctx.view);
  wireHoverBackdrop(ctx.view, fBd);
  // The list view leaves out long text, so fetch the featured item's description separately.
  api(`/api/items/${featured.id}`).then(r => {
    const t = JSON.parse(r.item.text || '{}');
    const blurb = t.synopsis || t.description || '';
    const el = document.getElementById('hero-blurb');
    if (el && ctx.isCurrent()) el.textContent = blurb.length > 360 ? `${blurb.slice(0, 360)}\u2026` : blurb;
  }).catch(() => {});
}
