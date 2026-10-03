// Item page: big cover, details, personal copy info, photos and the extras.
import { icon } from '../icons.js';
import { api, esc, $$, typeOf, coverUrl, backdropOf, fmtField, fieldValue, fmtDate, toast, busy, modal,
  confirmBox, namesInput, pickFile, today, invalidate, refreshBoot, itemSubtitle, normalizeItem, getAllItems,
  setCustomCover, addPhotos } from '../util.js';
import { setTitle, setBackdrop, refreshNav } from '../app.js';
import { refreshItem } from '../sources/index.js';
import { whereToWatchHtml, needsCheck, checkItem, setArchive, setMoviesAnywhereUrl, archivePlayer } from '../watch.js';

const STATUS_LABEL = { owned: 'Owned', wishlist: 'Wishlist', watchlist: 'Watchlist (free online)' };

// Assemble the full item from the API reply, plus links and expansion info from the cached lists.
async function loadItem(id) {
  const r = await api(`/api/items/${id}`);
  const it = normalizeItem(r.item);
  it.photos = r.photos;
  it.loans = r.loans;
  it.plays = r.plays.map(p => ({ ...p, players: (() => { try { return JSON.parse(p.players || '[]'); } catch (e) { return []; } })() }));
  it.watches = r.watches;
  it.on_loan = (it.loans.find(l => !l.returned) || {}).borrower || null;
  it.play_count = it.plays.reduce((n, p) => n + (Number(p.quantity) || 1), 0);
  it.last_played = it.plays.length ? it.plays[0].date : null;
  it.watched = it.watches.length > 0;
  it.seasons_watched = [...new Set(it.watches.filter(w => w.season != null).map(w => Number(w.season)))].sort((a, b) => a - b);
  const all = await getAllItems();
  const sameType = all.filter(x => x.type === it.type && x.id !== it.id);
  it.expands_resolved = (it.data.expands || []).map(e => {
    const hit = sameType.filter(x => x.bgg_id === e.bgg_id).sort((a, b) => (a.status === 'owned' ? -1 : 1) - (b.status === 'owned' ? -1 : 1))[0];
    return { ...e, item_id: hit ? hit.id : null };
  });
  it.expansions_owned = it.bgg_id ? sameType.filter(x => (x.data.expands || []).some(e => e.bgg_id === it.bgg_id))
    .map(x => ({ id: x.id, title: x.title, status: x.status })) : [];
  it.links = {};
  if (it.bgg_id) it.links.BoardGameGeek = `https://boardgamegeek.com/boardgame/${it.bgg_id}`;
  if (it.tmdb_id) it.links.TMDB = `https://www.themoviedb.org/${it.type === 'tv' ? 'tv' : 'movie'}/${it.tmdb_id}`;
  if (it.imdb_id) it.links.IMDb = `https://www.imdb.com/title/${it.imdb_id}/`;
  return it;
}

async function people() {
  try { return (await api('/api/people')).names; } catch (e) { return []; }
}

function chips(it) {
  const d = it.data;
  const out = [];
  const r = v => (v && typeof v === 'object') ? (v.min === v.max || v.max == null ? `${v.min}` : `${v.min}–${v.max}`) : v;
  if (d.players) out.push(`${r(d.players)} players`);
  if (d.playtime) out.push(`${r(d.playtime)} min`);
  if (d.min_age) out.push(`${d.min_age}+`);
  if (d.weight) out.push(`Weight ${d.weight}`);
  if (d.bgg_rating) out.push(`BGG ${d.bgg_rating}`);
  if (d.runtime) out.push(`${d.runtime} min`);
  if (d.mpaa) out.push(d.mpaa);
  if (d.network) out.push(d.network);
  if (d.total_seasons) out.push(`${d.total_seasons} season${d.total_seasons > 1 ? 's' : ''}`);
  if (d.format) out.push(d.format);
  if (d.tmdb_score) out.push(`TMDB ${d.tmdb_score}`);
  if (it.my_rating) out.push(`Mine ${it.my_rating}/10`);
  return out.map(c => `<span class="chip big">${esc(c)}</span>`).join('');
}

function detailRows(it, t) {
  const rows = [];
  for (const fd of t.fields) {
    if (!fd.visible || fd.kind === 'longtext') continue;
    if (fd.kind === 'itemlink') {
      const res = it.expands_resolved || [];
      if (!res.length) continue;
      const html = res.map(e => e.item_id ? `<a href="#/item/${it.type}/${e.item_id}" class="ext">${esc(e.name)}</a>` : esc(e.name)).join(', ');
      rows.push([fd.label, html]);
      continue;
    }
    const v = fmtField(fd, fieldValue(it, fd));
    if (v) rows.push([fd.label, v]);
  }
  if ((it.expansions_owned || []).length) {
    rows.push(['Expansions in Vault', it.expansions_owned.map(e => `<a class="ext" href="#/item/${it.type}/${e.id}">${esc(e.title)}</a>${e.status === 'wishlist' ? ' <small>(wishlist)</small>' : ''}`).join('<br>')]);
  }
  return rows;
}

function copyRows(it) {
  const rows = [];
  const add = (l, v) => { if (v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) rows.push([l, v]); };
  add('Status', STATUS_LABEL[it.status] || 'Owned');
  add('Group', it.group_name ? `<a class="ext" href="#/c/${it.type}?group=${encodeURIComponent(it.group_name)}">${esc(it.group_name)}</a>` : '');
  add('Condition', esc(it.condition || ''));
  add('Location', esc(it.location || ''));
  add('My rating', it.my_rating ? `${it.my_rating} / 10` : '');
  add('Purchase date', fmtDate(it.purchase_date));
  add('Purchase price', it.purchase_price != null ? `$${Number(it.purchase_price).toFixed(2)}` : '');
  add('Where acquired', esc(it.acquired_from || ''));
  add('Tags', (it.tags || []).map(x => `<span class="chip">${esc(x)}</span>`).join(' '));
  add('Barcode', esc(it.barcode || ''));
  add('Added', fmtDate(it.date_added));
  return rows;
}

const table = rows => rows.length ? `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>` : '';

export async function lendDialog(it) {
  const names = await people();
  const res = await modal({
    title: `Lend “${it.title}”`,
    body: `<label class="fld"><span>Borrower</span><input name="borrower" list="borrowers" required>
      <datalist id="borrowers">${names.map(n => `<option value="${esc(n)}">`).join('')}</datalist></label>
      <div class="pair"><label class="fld"><span>Date lent</span><input type="date" name="date_lent" value="${today()}"></label>
      <label class="fld"><span>Due back (optional)</span><input type="date" name="due"></label></div>
      <label class="fld"><span>Notes</span><input name="notes"></label>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Lend', kind: 'primary', handler: async root => {
        const body = Object.fromEntries(['borrower', 'date_lent', 'due', 'notes'].map(k => [k, root.querySelector(`[name=${k}]`).value]));
        if (!body.borrower.trim()) { toast('Who borrowed it?', 'warn'); return false; }
        await api(`/api/items/${it.id}/loans`, { method: 'POST', body });
        return true;
      },
    }],
  });
  return !!res;
}

export async function playDialog(it, play = null) {
  const names = await people();
  const ni = namesInput(play ? play.players : [], names);
  const res = await modal({
    title: play ? 'Edit play' : `Log a play · ${it.title}`,
    body: `<label class="fld"><span>Date</span><input type="date" name="date" value="${esc(play ? play.date : today())}"></label>
      <div class="fld"><span>Players</span><div data-names></div></div>
      <label class="fld"><span>Winner</span><input name="winner" list="winners" value="${esc(play ? play.winner || '' : '')}" placeholder="Optional"><datalist id="winners"></datalist></label>
      <label class="fld"><span>Notes</span><textarea name="notes" rows="2">${esc(play ? play.notes || '' : '')}</textarea></label>`,
    onOpen: root => {
      root.querySelector('[data-names]').appendChild(ni.el);
      const dl = root.querySelector('#winners');
      const upd = () => { dl.innerHTML = ni.get().map(n => `<option value="${esc(n)}">`).join(''); };
      ni.el.addEventListener('names-changed', upd);
      ni.el.addEventListener('focusout', upd);
      upd();
    },
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Save', kind: 'primary', handler: async root => {
        const body = { date: root.querySelector('[name=date]').value, players: ni.get(),
          winner: root.querySelector('[name=winner]').value, notes: root.querySelector('[name=notes]').value };
        if (play) await api(`/api/plays/${play.id}`, { method: 'PUT', body });
        else await api(`/api/items/${it.id}/plays`, { method: 'POST', body });
        return true;
      },
    }],
  });
  return !!res;
}

async function watchDialog(it, season = null) {
  const res = await modal({
    title: season ? `Watched season ${season}` : `Mark “${it.title}” watched`,
    body: `<label class="fld"><span>Date watched</span><input type="date" name="date" value="${today()}"></label>
      <label class="fld"><span>Notes</span><input name="notes" placeholder="Optional"></label>`,
    actions: [{ label: 'Cancel', value: null }, {
      label: 'Save', kind: 'primary', handler: async root => {
        await api(`/api/items/${it.id}/watches`, { method: 'POST', body: {
          date: root.querySelector('[name=date]').value, notes: root.querySelector('[name=notes]').value, season } });
        return true;
      },
    }],
  });
  return !!res;
}

function seasonCount(it) {
  const total = Number(it.data.total_seasons) || 0;
  const owned = String(it.data.seasons_owned || '');
  const nums = [];
  owned.split(',').forEach(part => {
    const m = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
    if (m) for (let i = Number(m[1]); i <= Number(m[2]); i++) nums.push(i);
    else if (/^\d+$/.test(part.trim())) nums.push(Number(part.trim()));
  });
  if (nums.length) return [...new Set(nums)].sort((a, b) => a - b);
  return Array.from({ length: total }, (_, i) => i + 1);
}

export async function renderItem(ctx, typeKey, id) {
  const t = typeOf(typeKey);
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  let it;
  try { it = await loadItem(id); } catch (e) {
    ctx.view.innerHTML = `<div class="empty"><h2>Not found</h2><p>${esc(e.message)}</p></div>`; return;
  }
  if (!ctx.isCurrent()) return;
  const type = typeOf(it.type) || t;
  setTitle(`<a href="#/c/${type.key}" class="crumb">${icon(type.icon)} ${esc(type.name)}</a>`);
  setBackdrop(backdropOf(it));
  const cover = coverUrl(it);
  const longs = type.fields.filter(f => f.visible && f.kind === 'longtext' && fieldValue(it, f));
  const hasSource = !!(it.bgg_id || it.tmdb_id);
  const activeLoan = (it.loans || []).find(l => !l.returned);

  const actions = [];
  const archived = it.data.archive && it.data.archive.id;
  if (archived) actions.push(`<button class="btn primary" data-act="ia-play">${icon('play')} Play</button>`);
  if (it.status === 'wishlist') actions.push(`<button class="btn primary" data-act="gotit">${icon('check')} Got it</button>`);
  if (it.status === 'watchlist') actions.push(`<button class="btn" data-act="gotit" title="Move it to your owned collection">${icon('check')} I own it now</button>`);
  if (it.type === 'boardgame' && it.status === 'owned') actions.push(`<button class="btn primary" data-act="play">${icon('play')} Log play</button>`);
  if (it.type === 'movie' && it.status !== 'wishlist') actions.push(`<button class="btn ${it.watched ? '' : 'primary'}" data-act="watch">${icon('eye')} ${it.watched ? 'Watched again' : 'Mark watched'}</button>`);
  if (it.status === 'owned') actions.push(activeLoan
    ? `<button class="btn" data-act="return">${icon('check')} Mark returned</button>`
    : `<button class="btn" data-act="lend">${icon('handoff')} Lend</button>`);
  actions.push(`<a class="btn" href="#/edit/${it.type}/${it.id}">${icon('edit')} Edit</a>`);
  if (hasSource) actions.push(`<button class="btn" data-act="refresh" title="Re-pull details from the source. Your own fields are never changed.">${icon('refresh')} Refresh</button>`);
  actions.push(`<button class="icon-btn" data-act="delete" title="Delete">${icon('trash')}</button>`);

  const links = Object.entries(it.links || {}).map(([k, u]) => `<a class="btn small ghost" href="${esc(u)}" target="_blank" rel="noopener">${icon('link')} ${esc(k)}</a>`).join('');

  let extras = '';
  if (it.type === 'boardgame') {
    extras += `<section class="panel"><div class="panel-head"><h2>Play log</h2>
      <span class="muted">${it.play_count ? `${it.play_count} play${it.play_count > 1 ? 's' : ''} · last ${fmtDate(it.last_played)}` : 'No plays logged yet'}</span></div>
      ${(it.plays || []).length ? `<ul class="log">${it.plays.map(p => `<li><b>${fmtDate(p.date)}</b>
        <span>${p.players.length ? esc(p.players.join(', ')) : '<span class="muted">No players listed</span>'}${p.winner ? ` · <span class="win">★ ${esc(p.winner)}</span>` : ''}${p.quantity > 1 ? ` · ${p.quantity}×` : ''}</span>
        ${p.notes ? `<em>${esc(p.notes)}</em>` : ''}
        <span class="row-acts"><button class="icon-btn sm" data-editplay="${p.id}" title="Edit">${icon('edit')}</button><button class="icon-btn sm" data-delplay="${p.id}" title="Delete">${icon('trash')}</button></span></li>`).join('')}</ul>` : ''}
    </section>`;
  }
  if (it.type === 'tv' && it.status !== 'wishlist') {
    const seasons = seasonCount(it);
    const watched = new Set(it.seasons_watched || []);
    extras += `<section class="panel"><div class="panel-head"><h2>Seasons watched</h2><span class="muted">Tap a season to mark it watched</span></div>
      ${seasons.length ? `<div class="seasons">${seasons.map(s => `<button class="season ${watched.has(s) ? 'on' : ''}" data-season="${s}">${watched.has(s) ? icon('check') : ''}S${s}</button>`).join('')}</div>`
        : '<p class="muted">Set “Total seasons” or “Seasons owned” to track seasons.</p>'}
    </section>`;
  }
  if ((it.type === 'movie' || it.type === 'tv') && (it.watches || []).length) {
    extras += `<section class="panel"><div class="panel-head"><h2>Watch history</h2></div><ul class="log">
      ${it.watches.map(w => `<li><b>${fmtDate(w.date)}</b><span>${w.season ? `Season ${w.season}` : 'Watched'}</span>${w.notes ? `<em>${esc(w.notes)}</em>` : ''}
      <span class="row-acts"><button class="icon-btn sm" data-delwatch="${w.id}" title="Remove">${icon('trash')}</button></span></li>`).join('')}</ul></section>`;
  }
  if ((it.loans || []).length) {
    extras += `<section class="panel"><div class="panel-head"><h2>Loans</h2></div><ul class="log">
      ${it.loans.map(l => `<li><b>${esc(l.borrower)}</b><span>Lent ${fmtDate(l.date_lent)}${l.due ? ` · due ${fmtDate(l.due)}` : ''}${l.returned ? ` · returned ${fmtDate(l.returned)}` : ' · <b class="warn">still out</b>'}</span>
      ${l.notes ? `<em>${esc(l.notes)}</em>` : ''}<span class="row-acts"><button class="icon-btn sm" data-delloan="${l.id}" title="Delete record">${icon('trash')}</button></span></li>`).join('')}</ul></section>`;
  }

  const photos = `<section class="panel"><div class="panel-head"><h2>My photos</h2>
      <button class="btn small" data-act="photo">${icon('camera')} Add photo</button></div>
      ${(it.photos || []).length ? `<div class="photos">${it.photos.map(p => `<button class="photo" data-photo="${p.id}" data-file="${esc(p.file)}"><img src="/media/thumbs/p_${encodeURIComponent(p.file)}" alt="" loading="lazy"></button>`).join('')}</div>`
        : '<p class="muted">Snap the box, the contents, or anything worth remembering about this copy.</p>'}
    </section>`;

  ctx.view.innerHTML = `
    <div class="item-page">
      <div class="item-cover">
        ${cover ? `<img src="${cover}" alt="">` : `<div class="noimg big">${icon(type.icon)}</div>`}
        <button class="btn small ghost" data-act="cover">${icon('image')} Replace cover</button>
      </div>
      <div class="item-main">
        <div class="eyebrow">${icon(type.icon)} ${esc(type.name)}${it.status === 'wishlist' ? ' · <span class="wish-tag">Wishlist</span>' : ''}${it.status === 'watchlist' ? ' · <span class="watch-tag">Watchlist</span>' : ''}</div>
        <h1>${esc(it.title)}</h1>
        <div class="item-sub">${esc(itemSubtitle(it))}</div>
        <div class="chips">${chips(it)}</div>
        ${activeLoan ? `<div class="notice">${icon('handoff')} On loan to <b>${esc(activeLoan.borrower)}</b> since ${fmtDate(activeLoan.date_lent)}${activeLoan.due ? `, due ${fmtDate(activeLoan.due)}` : ''}</div>` : ''}
        <div class="btn-row">${actions.join('')}</div>
        ${links ? `<div class="btn-row links">${links}</div>` : ''}
        ${it.type === 'movie' || it.type === 'tv' ? '<div id="wtw-host"></div>' : ''}
        ${longs.map(f => `<div class="about"><h3>${esc(f.label)}</h3>${fmtField(f, fieldValue(it, f))}</div>`).join('')}
        ${it.notes ? `<div class="about"><h3>My notes</h3><div class="prose">${esc(it.notes)}</div></div>` : ''}
      </div>
    </div>
    <div class="item-panels">
      <section class="panel"><div class="panel-head"><h2>Details</h2></div>${table(detailRows(it, type)) || '<p class="muted">No details yet.</p>'}</section>
      <section class="panel"><div class="panel-head"><h2>My copy</h2></div>${table(copyRows(it))}</section>
      ${extras}
      ${photos}
    </div>`;

  const reload = async () => { invalidate(it.type); await refreshBoot(); refreshNav(); renderItem(ctx, typeKey, id); };
  const v = ctx.view;
  const on = (sel, fn) => $$(sel, v).forEach(b => b.onclick = async () => { try { await fn(b); } catch (e) { toast(e.message, 'error'); } });

  // ---- Where to watch
  const host = v.querySelector('#wtw-host');
  const drawWtw = () => {
    if (!host || !ctx.isCurrent()) return;
    host.innerHTML = whereToWatchHtml(it);
    const wire = (sel, fn) => $$(sel, host).forEach(b => b.onclick = async () => { try { await fn(b); } catch (e) { toast(e.message, 'error'); } });
    wire('[data-wtw=recheck]', async b => { b.disabled = true; await checkItem(it); invalidate(it.type); drawWtw(); });
    wire('[data-wtw=confirm]', async () => {
      const c = it.data.watch.archive_candidate;
      await setArchive(it, { id: c.id, title: c.title, year: c.year || null });
      invalidate(it.type);
      toast('Linked to the Internet Archive.', 'ok');
      reload();
    });
    wire('[data-wtw=decline]', async () => { await setArchive(it, false); invalidate(it.type); drawWtw(); });
    wire('[data-wtw=unlink]', async () => {
      if (!await confirmBox('Unlink film', 'Remove the Internet Archive film from this item? You can check again later.', 'Unlink')) return;
      await setArchive(it, false); invalidate(it.type); reload();
    });
    wire('[data-wtw=ma-fix]', async () => {
      const url = await modal({
        title: 'Movies Anywhere link',
        body: `<p class="muted">Vault guesses the address from the title. If it opens the wrong page, find the movie on Movies Anywhere and paste its address here.</p>
          <label class="fld"><span>Address</span><input id="ma_url" value="${esc(it.data.ma_url || '')}" placeholder="https://moviesanywhere.com/movie/..."></label>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Save', kind: 'primary', handler: root => {
          const val = root.querySelector('#ma_url').value.trim();
          if (val && !/^https:\/\/(www\.)?moviesanywhere\.com\//.test(val)) { toast('That isn\u2019t a Movies Anywhere address.', 'warn'); return false; }
          return val || '';
        } }],
      });
      if (url === null || url === true) return;
      await setMoviesAnywhereUrl(it, url);
      invalidate(it.type);
      drawWtw();
    });
  };
  if (host) {
    drawWtw();
    if (needsCheck(it)) checkItem(it).then(() => { invalidate(it.type); drawWtw(); }).catch(() => {});
  }
  on('[data-act=ia-play]', async () => {
    await modal({ title: it.title, wide: true, cls: 'player-modal', body: archivePlayer(it.data.archive.id, it.data.archive.title) });
  });

  on('[data-act=play]', async () => { if (await playDialog(it)) { toast('Play logged.', 'ok'); reload(); } });
  on('[data-act=watch]', async () => { if (await watchDialog(it)) { toast('Marked watched.', 'ok'); reload(); } });
  on('[data-act=lend]', async () => { if (await lendDialog(it)) { toast('Loan recorded.', 'ok'); reload(); } });
  on('[data-act=return]', async () => { await api(`/api/loans/${activeLoan.id}`, { method: 'PUT', body: { return: true } }); toast('Marked returned.', 'ok'); reload(); });
  on('[data-act=gotit]', async () => {
    await api(`/api/items/${it.id}`, { method: 'PUT', body: { status: 'owned', acquired_now: true, purchase_date: it.purchase_date || today() } });
    toast(`“${it.title}” moved to your collection.`, 'ok');
    reload();
  });
  on('[data-act=refresh]', async () => {
    const done = busy('Refreshing from the source…');
    try {
      const warnings = await refreshItem(it);
      warnings.forEach(w => toast(w, 'warn'));
      toast('Details refreshed.', 'ok');
    } finally { done(); }
    reload();
  });
  on('[data-act=delete]', async () => {
    if (!await confirmBox('Delete item', `Delete “${it.title}” and its photos, plays and loan records? This can’t be undone.`)) return;
    await api(`/api/items/${it.id}`, { method: 'DELETE' });
    invalidate(it.type); await refreshBoot(); refreshNav();
    toast('Deleted.', 'ok');
    location.hash = `#/c/${it.type}`;
  });
  on('[data-act=cover]', async () => {
    const files = await pickFile({ accept: 'image/*' });
    if (!files.length) return;
    const done = busy('Saving cover…');
    try { await setCustomCover(it.id, files[0]); } finally { done(); }
    reload();
  });
  on('[data-act=photo]', async () => {
    const files = await pickFile({ accept: 'image/*', multiple: true });
    if (!files.length) return;
    const done = busy(`Saving ${files.length > 1 ? `${files.length} photos` : 'photo'}…`);
    try { await addPhotos(it.id, files); } finally { done(); }
    reload();
  });
  on('[data-photo]', async b => {
    const r = await modal({
      title: 'Photo', wide: true,
      body: `<img class="lightbox" src="/media/photos/${encodeURIComponent(b.dataset.file)}" alt="">`,
      actions: [{ label: 'Delete photo', kind: 'danger', value: 'del' }, { label: 'Close', kind: 'primary', value: null }],
    });
    if (r === 'del') { await api(`/api/photos/${b.dataset.photo}`, { method: 'DELETE' }); reload(); }
  });
  on('[data-editplay]', async b => {
    const p = it.plays.find(x => String(x.id) === b.dataset.editplay);
    if (await playDialog(it, p)) reload();
  });
  on('[data-delplay]', async b => {
    if (!await confirmBox('Delete play', 'Remove this play from the log?')) return;
    await api(`/api/plays/${b.dataset.delplay}`, { method: 'DELETE' }); reload();
  });
  on('[data-delwatch]', async b => { await api(`/api/watches/${b.dataset.delwatch}`, { method: 'DELETE' }); reload(); });
  on('[data-delloan]', async b => {
    if (!await confirmBox('Delete loan record', 'Remove this loan record?')) return;
    await api(`/api/loans/${b.dataset.delloan}`, { method: 'DELETE' }); reload();
  });
  on('[data-season]', async b => {
    const s = Number(b.dataset.season);
    if (b.classList.contains('on')) {
      const w = (it.watches || []).find(x => x.season === s);
      if (w) await api(`/api/watches/${w.id}`, { method: 'DELETE' });
      reload();
    } else if (await watchDialog(it, s)) reload();
  });
}
