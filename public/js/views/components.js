// Reusable pieces: poster cards, rows, hover-to-backdrop.
import { icon } from '../icons.js';
import { esc, thumbUrl, backdropOf, itemSubtitle, typeOf, $$ } from '../util.js';
import { setBackdrop } from '../app.js';
import { isFreeToWatch } from '../watch.js';

export function posterCard(it, { showType = false, stackCount = 0, href = null } = {}) {
  const t = typeOf(it.type);
  const th = thumbUrl(it);
  const badges = [];
  if (it.on_loan) badges.push(`<span class="badge loan" title="On loan to ${esc(it.on_loan)}">${icon('handoff')}</span>`);
  if (it.status === 'wishlist') badges.push(`<span class="badge wish" title="Wishlist">${icon('heart')}</span>`);
  if (it.status === 'watchlist') badges.push(`<span class="badge watch" title="Watchlist (free online)">${icon('eye')}</span>`);
  if ((it.type === 'movie' || it.type === 'tv') && isFreeToWatch(it)) badges.push('<span class="badge free" title="Free to watch">FREE</span>');
  if ((it.type === 'movie' || it.type === 'tv') && it.status !== 'wishlist' && !it.watched) badges.push('<span class="badge dot" title="Unwatched"></span>');
  const plays = it.play_count ? `<span class="badge plays" title="${it.play_count} plays">${it.play_count}×</span>` : '';
  const sub = showType && t ? t.name : itemSubtitle(it);
  const link = href || `#/item/${it.type}/${it.id}`;
  const bd = backdropOf(it);
  return `<a class="poster-card${stackCount ? ' stack' : ''}" href="${link}" data-bd="${esc(bd ? bd.url : '')}" data-soft="${bd && bd.soft ? 1 : 0}">
    <div class="poster">
      ${th ? `<img src="${th}" alt="" loading="lazy">` : `<div class="noimg">${icon(t ? t.icon : 'box')}<span>${esc(it.title)}</span></div>`}
      <div class="badges">${badges.join('')}</div>${plays}
      ${stackCount ? `<span class="stack-count">${stackCount}</span>` : ''}
    </div>
    <div class="pc-title">${esc(stackCount ? it.group_name : it.title)}</div>
    <div class="pc-sub">${esc(stackCount ? `${stackCount} items` : sub)}</div>
  </a>`;
}

export function row(title, items, opts = {}) {
  if (!items.length) return '';
  return `<section class="shelf">
    <div class="shelf-head"><h2>${esc(title)}</h2>${opts.more ? `<a href="${opts.more}" class="more">See all</a>` : ''}
      <div class="shelf-nav"><button class="icon-btn" data-dir="-1" aria-label="Scroll left">${icon('chevL')}</button><button class="icon-btn" data-dir="1" aria-label="Scroll right">${icon('chevR')}</button></div></div>
    <div class="shelf-track">${items.map(it => posterCard(it, opts)).join('')}</div>
  </section>`;
}

export function wireShelves(root) {
  $$('.shelf', root).forEach(s => {
    const track = s.querySelector('.shelf-track');
    s.querySelectorAll('.shelf-nav button').forEach(b => {
      b.onclick = () => track.scrollBy({ left: Number(b.dataset.dir) * track.clientWidth * 0.85, behavior: 'smooth' });
    });
  });
}

// Hovering or focusing a poster swaps the page backdrop to that item's fanart.
export function wireHoverBackdrop(root, fallback = null) {
  const handler = e => {
    const card = e.target.closest('[data-bd]');
    if (card && card.dataset.bd) setBackdrop({ url: card.dataset.bd, soft: card.dataset.soft === '1' });
  };
  root.addEventListener('mouseover', handler);
  root.addEventListener('focusin', handler);
  if (fallback !== null) root.addEventListener('mouseleave', () => setBackdrop(fallback));
}

export function emptyState(title, text, actions = '') {
  return `<div class="empty"><div class="empty-icon">${icon('vault')}</div><h2>${esc(title)}</h2><p>${text}</p>${actions}</div>`;
}
