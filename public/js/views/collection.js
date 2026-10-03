// Collection view: poster wall or list, with sorting, grouping and filters.
import { icon } from '../icons.js';
import { esc, $, $$, getItems, typeOf, store, plainField, thumbUrl, itemYear, debounce, backdropOf } from '../util.js';
import { setTitle, setBackdrop } from '../app.js';
import { posterCard, wireHoverBackdrop, emptyState } from './components.js';

const FILTERABLE = ['choice', 'list', 'bool', 'range', 'number'];

function defaultState(type) {
  return { view: 'wall', sort: 'title', group: true, status: 'owned', text: '', f: {}, type };
}

function sortOptions(t) {
  const o = [['title', 'Title'], ['added', 'Date added'], ['year', 'Year'], ['my_rating', 'My rating']];
  if (t.fields.some(f => f.key === 'bgg_rating')) o.push(['bgg_rating', 'BGG rating']);
  if (t.fields.some(f => f.key === 'tmdb_score')) o.push(['tmdb_score', 'TMDB score']);
  if (t.key === 'boardgame') o.push(['play_count', 'Most played'], ['last_played', 'Last played']);
  if (t.key === 'movie' || t.key === 'tv') o.push(['last_watched', 'Last watched']);
  return o;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object' && v.min !== undefined) return Number(v.min);
  const n = Number(String(v).match(/-?\d+(\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

function sorter(key) {
  const byTitle = (a, b) => (a.sort_title || '').localeCompare(b.sort_title || '');
  const desc = get => (a, b) => {
    const x = get(a), y = get(b);
    if (x === y) return byTitle(a, b);
    if (x === null || x === undefined || x === '') return 1;
    if (y === null || y === undefined || y === '') return -1;
    return x < y ? 1 : -1;
  };
  switch (key) {
    case 'added': return desc(i => i.date_added || '');
    case 'year': return desc(i => num(itemYear(i)));
    case 'my_rating': return desc(i => i.my_rating);
    case 'bgg_rating': return desc(i => num(i.data.bgg_rating));
    case 'tmdb_score': return desc(i => num(i.data.tmdb_score));
    case 'play_count': return desc(i => i.play_count || null);
    case 'last_played': return desc(i => i.last_played || '');
    case 'last_watched': return desc(i => i.last_watched || '');
    default: return byTitle;
  }
}

function coreFilterDefs(t) {
  const defs = [
    { key: '__condition', label: 'Condition', kind: 'choice', get: i => i.condition },
    { key: '__location', label: 'Location', kind: 'choice', get: i => i.location },
    { key: '__tags', label: 'Tags', kind: 'list', get: i => i.tags },
    { key: '__group', label: 'Group', kind: 'choice', get: i => i.group_name },
  ];
  const fields = t.fields.filter(f => f.visible && FILTERABLE.includes(f.kind))
    .map(f => ({ key: f.key, label: f.label, kind: f.kind, get: i => i.data[f.key] }));
  return [...fields, ...defs];
}

function applyFilters(items, st, t) {
  const text = st.text.trim().toLowerCase();
  const defs = coreFilterDefs(t);
  return items.filter(i => {
    if (st.status !== 'all' && i.status !== st.status) return false;
    if (text && !(`${i.title} ${i.group_name || ''} ${i.data.edition || ''}`.toLowerCase().includes(text))) return false;
    if (st.f.__loan && !i.on_loan) return false;
    if (st.f.__unwatched && i.watched) return false;
    if (st.f.__watched && !i.watched) return false;
    if (st.f.__neverplayed && i.play_count) return false;
    if (st.f.__played && !i.play_count) return false;
    for (const d of defs) {
      const want = st.f[d.key];
      if (want === undefined || want === '' || want === null) continue;
      const v = d.get(i);
      if (d.kind === 'choice') { if ((v || '') !== want) return false; }
      else if (d.kind === 'list') { if (!(Array.isArray(v) ? v : []).includes(want)) return false; }
      else if (d.kind === 'bool') { if (want === 'yes' ? !v : !!v) return false; }
      else if (d.kind === 'range') {
        const n = Number(want);
        if (!v || typeof v !== 'object') return false;
        if (n < Number(v.min) || n > Number(v.max ?? v.min)) return false;
      } else if (d.kind === 'number') {
        const lo = want.min !== '' && want.min != null ? Number(want.min) : null;
        const hi = want.max !== '' && want.max != null ? Number(want.max) : null;
        const n = num(v);
        if ((lo !== null || hi !== null) && n === null) return false;
        if (lo !== null && n < lo) return false;
        if (hi !== null && n > hi) return false;
      }
    }
    return true;
  });
}

function activeFilterCount(st) {
  return Object.values(st.f).filter(v => {
    if (v === undefined || v === null || v === '' || v === false) return false;
    if (typeof v === 'object') return (v.min !== undefined && v.min !== '') || (v.max !== undefined && v.max !== '');
    return true;
  }).length;
}

function filterPanel(items, st, t) {
  const defs = coreFilterDefs(t);
  const quick = [];
  quick.push(['__loan', 'On loan']);
  if (t.key === 'movie' || t.key === 'tv') quick.push(['__unwatched', 'Unwatched'], ['__watched', 'Watched']);
  if (t.key === 'boardgame') quick.push(['__played', 'Played'], ['__neverplayed', 'Never played']);
  const quickHtml = quick.map(([k, l]) => `<label class="check"><input type="checkbox" data-q="${k}" ${st.f[k] ? 'checked' : ''}> ${l}</label>`).join('');
  const blocks = defs.map(d => {
    const cur = st.f[d.key];
    if (d.kind === 'choice' || d.kind === 'list') {
      const counts = new Map();
      items.forEach(i => {
        const v = d.get(i);
        (Array.isArray(v) ? v : (v ? [v] : [])).forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
      });
      if (!counts.size) return '';
      const opts = [...counts.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return `<label class="fld"><span>${esc(d.label)}</span><select data-f="${d.key}"><option value="">Any</option>
        ${opts.map(([v, c]) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(v)} (${c})</option>`).join('')}</select></label>`;
    }
    if (d.kind === 'bool') {
      return `<label class="fld"><span>${esc(d.label)}</span><select data-f="${d.key}"><option value="">Any</option>
        <option value="yes" ${cur === 'yes' ? 'selected' : ''}>Yes</option><option value="no" ${cur === 'no' ? 'selected' : ''}>No</option></select></label>`;
    }
    if (d.kind === 'range') {
      return `<label class="fld"><span>${esc(d.label)} includes</span><input type="number" min="0" data-f="${d.key}" value="${esc(cur ?? '')}" placeholder="e.g. 4"></label>`;
    }
    if (d.kind === 'number') {
      const c = cur || {};
      return `<div class="fld"><span>${esc(d.label)}</span><div class="pair"><input type="number" step="any" data-fmin="${d.key}" value="${esc(c.min ?? '')}" placeholder="min">
        <input type="number" step="any" data-fmax="${d.key}" value="${esc(c.max ?? '')}" placeholder="max"></div></div>`;
    }
    return '';
  }).join('');
  return `<div class="filter-panel">
    <div class="fp-head"><h3>Filters</h3><button class="btn small" data-clear>Clear all</button></div>
    <div class="quick">${quickHtml}</div>
    <div class="fp-grid">${blocks}</div>
  </div>`;
}

function listView(items, t) {
  const cols = t.fields.filter(f => f.visible && ['number', 'range', 'choice', 'text', 'list'].includes(f.kind)
    && !['year', 'edition', 'description', 'synopsis'].includes(f.key)).slice(0, 4);
  return `<div class="table-wrap"><table class="list">
    <thead><tr><th></th><th>Title</th><th>Year</th>${cols.map(c => `<th>${esc(c.label)}</th>`).join('')}<th>Mine</th><th></th></tr></thead>
    <tbody>${items.map(i => {
      const th = thumbUrl(i);
      const marks = [];
      if (i.on_loan) marks.push(`<span class="tag loan">${icon('handoff')} ${esc(i.on_loan)}</span>`);
      if (i.status === 'wishlist') marks.push(`<span class="tag wish">${icon('heart')} Wishlist</span>`);
      if (i.play_count) marks.push(`<span class="tag">${i.play_count}× played</span>`);
      if ((i.type === 'movie' || i.type === 'tv') && i.status === 'owned') marks.push(i.watched ? `<span class="tag">${icon('check')} Watched</span>` : '<span class="tag dim">Unwatched</span>');
      const bd = backdropOf(i);
      return `<tr data-href="#/item/${i.type}/${i.id}" tabindex="0" data-bd="${esc(bd ? bd.url : '')}" data-soft="${bd && bd.soft ? 1 : 0}">
        <td class="lt">${th ? `<img src="${th}" alt="" loading="lazy">` : ''}</td>
        <td class="ttl"><b>${esc(i.title)}</b>${i.data.edition ? `<small>${esc(i.data.edition)}</small>` : ''}</td>
        <td>${esc(itemYear(i))}</td>
        ${cols.map(c => `<td>${esc(plainField(c, i.data[c.key]))}</td>`).join('')}
        <td>${i.my_rating ? `${i.my_rating}/10` : ''}</td><td class="marks">${marks.join('')}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

export async function renderCollection(ctx, typeKey) {
  const t = typeOf(typeKey);
  if (!t) { location.hash = '#/home'; return; }
  const saved = store(`col:${typeKey}`);
  const st = Object.assign(defaultState(typeKey), saved || {});
  st.f = Object.assign({}, st.f || {});
  st.text = '';
  // URL shortcuts from Home ("See all" links)
  if (ctx.params.f === 'unwatched') { st.f = { __unwatched: true }; st.status = 'owned'; }
  if (ctx.params.sort) st.sort = ctx.params.sort;
  const groupFilter = ctx.params.group || null;
  setTitle(`${icon(t.icon)} ${esc(t.name)}`);
  ctx.view.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
  const items = await getItems(typeKey);
  if (!ctx.isCurrent()) return;
  setBackdrop(null);
  let panelOpen = false;
  const save = () => store(`col:${typeKey}`, { view: st.view, sort: st.sort, group: st.group, status: st.status, f: st.f });

  const draw = () => {
    let list = applyFilters(items, st, t);
    if (groupFilter) list = list.filter(i => i.group_name === groupFilter);
    list.sort(sorter(st.sort));
    const nFilters = activeFilterCount(st);
    let body;
    if (!items.length) {
      body = emptyState(`No ${t.name.toLowerCase()} yet`, 'Add items by name, scan a barcode, or import from a source.',
        `<div class="btn-row center"><a class="btn primary" href="#/add?type=${t.key}">${icon('plus')} Add</a>${t.key === 'boardgame' ? '<a class="btn" href="#/settings/import">Import from BGG</a>' : ''}</div>`);
    } else if (!list.length) {
      body = `<div class="empty small"><p>Nothing matches these filters.</p><button class="btn" data-clear>Clear filters</button></div>`;
    } else if (st.view === 'list') {
      body = listView(list, t);
    } else {
      let cards = '';
      if (st.group && !groupFilter) {
        const seen = new Map();
        list.forEach(i => { if (i.group_name) seen.set(i.group_name, (seen.get(i.group_name) || 0) + 1); });
        const done = new Set();
        list.forEach(i => {
          const g = i.group_name;
          if (g && seen.get(g) > 1) {
            if (done.has(g)) return;
            done.add(g);
            cards += posterCard(i, { stackCount: seen.get(g), href: `#/c/${t.key}?group=${encodeURIComponent(g)}` });
          } else cards += posterCard(i);
        });
      } else cards = list.map(i => posterCard(i)).join('');
      body = `<div class="wall">${cards}</div>`;
    }
    const statusSeg = ['owned', 'wishlist', 'all'].map(s =>
      `<button data-status="${s}" class="${st.status === s ? 'on' : ''}">${s === 'owned' ? 'Owned' : s === 'wishlist' ? 'Wishlist' : 'All'}</button>`).join('');
    ctx.view.innerHTML = `
      <div class="col-head">
        ${groupFilter ? `<a class="back-link" href="#/c/${t.key}">${icon('chevL')} ${esc(t.name)}</a><h1>${esc(groupFilter)}</h1>` : `<h1>${esc(t.name)}</h1>`}
        <span class="count">${list.length}${list.length !== items.length ? ` of ${items.length}` : ''} items</span>
      </div>
      <div class="toolbar">
        <div class="seg">${statusSeg}</div>
        <div class="tb-search">${icon('search')}<input type="search" id="col-text" placeholder="Filter by title" value="${esc(st.text)}"></div>
        <label class="tb-sort">Sort <select id="col-sort">${sortOptions(t).map(([k, l]) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn ${panelOpen || nFilters ? 'on' : ''}" id="col-filter">${icon('filter')} Filters${nFilters ? ` <em class="pill">${nFilters}</em>` : ''}</button>
        <div class="seg icons">
          <button data-view="wall" class="${st.view === 'wall' ? 'on' : ''}" title="Poster wall">${icon('grid')}</button>
          <button data-view="list" class="${st.view === 'list' ? 'on' : ''}" title="List">${icon('list')}</button>
        </div>
        ${!groupFilter ? `<button class="icon-btn ${st.group ? 'on' : ''}" id="col-group" title="Stack items that share a group name">${icon('stack')}</button>` : ''}
        <button class="icon-btn" id="col-export" title="Export this view as an HTML catalog">${icon('export')}</button>
      </div>
      ${panelOpen ? filterPanel(items.filter(i => st.status === 'all' || i.status === st.status), st, t) : ''}
      ${body}`;
    wire(list);
  };

  const wire = list => {
    const v = ctx.view;
    $$('[data-status]', v).forEach(b => b.onclick = () => { st.status = b.dataset.status; save(); draw(); });
    $$('[data-view]', v).forEach(b => b.onclick = () => { st.view = b.dataset.view; save(); draw(); });
    $('#col-sort', v).onchange = e => { st.sort = e.target.value; save(); draw(); };
    const txt = $('#col-text', v);
    txt.oninput = debounce(() => {
      st.text = txt.value;
      const pos = txt.selectionStart;
      draw();
      const n = $('#col-text', ctx.view);
      n.focus();
      try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ }
    }, 200);
    $('#col-filter', v).onclick = () => { panelOpen = !panelOpen; draw(); };
    const g = $('#col-group', v);
    if (g) g.onclick = () => { st.group = !st.group; save(); draw(); };
    $('#col-export', v).onclick = () => {
      store('export-request', { type: t.key, ids: list.map(i => i.id), label: groupFilter || t.name });
      location.hash = '#/settings/export?from=view';
    };
    $$('[data-clear]', v).forEach(b => b.onclick = () => { st.f = {}; st.text = ''; save(); draw(); });
    $$('[data-q]', v).forEach(c => c.onchange = () => {
      const k = c.dataset.q;
      st.f[k] = c.checked;
      if (c.checked && k === '__watched') st.f.__unwatched = false;
      if (c.checked && k === '__unwatched') st.f.__watched = false;
      if (c.checked && k === '__played') st.f.__neverplayed = false;
      if (c.checked && k === '__neverplayed') st.f.__played = false;
      save(); draw();
    });
    $$('[data-f]', v).forEach(s => s.onchange = () => { st.f[s.dataset.f] = s.value; save(); draw(); });
    $$('[data-fmin],[data-fmax]', v).forEach(inp => inp.onchange = () => {
      const k = inp.dataset.fmin || inp.dataset.fmax;
      const cur = st.f[k] || { min: '', max: '' };
      if (inp.dataset.fmin) cur.min = inp.value; else cur.max = inp.value;
      st.f[k] = (cur.min === '' && cur.max === '') ? undefined : cur;
      save(); draw();
    });
    $$('tr[data-href]', v).forEach(tr => {
      tr.onclick = () => { location.hash = tr.dataset.href; };
      tr.onkeydown = e => { if (e.key === 'Enter') location.hash = tr.dataset.href; };
    });
  };

  draw();
  wireHoverBackdrop(ctx.view, null);
}
