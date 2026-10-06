// Settings: theme, data sources, collection templates, import, export, backup, about.
import { icon, ICON_NAMES } from '../icons.js';
import { S, api, esc, $, $$, typeOf, toast, busy, modal, confirmBox, refreshBoot, invalidate, store, getItems, getAllItems, pickFile } from '../util.js';
import { setTitle, setBackdrop, refreshNav, getThemeMode, setThemeMode } from '../app.js';
import { testSource } from '../sources/index.js';
import { importFromBgg } from '../importer.js';
import { exportCatalog, CORE_EXPORT_FIELDS } from '../exporter.js';
import { makeBackup, restoreBackup } from '../backup.js';
import { watchStatus, startWatchChecks, ATTRIBUTION } from '../watch.js';
import { thumbStatus, startThumbFixes, needsThumb } from '../thumbs.js';

const TABS = [
  ['general', 'General', 'gear'], ['sources', 'Sources', 'link'], ['collections', 'Collections', 'grid'],
  ['import', 'Import', 'download'], ['export', 'Export', 'export'], ['backup', 'Backup', 'folder'], ['about', 'About', 'info'],
];

export async function renderSettings(ctx, tab) {
  setTitle(`${icon('gear')} Settings`);
  setBackdrop(null);
  await refreshBoot();
  if (!ctx.isCurrent()) return;
  ctx.view.innerHTML = `<div class="settings">
    <nav class="set-tabs">${TABS.map(([k, l, ic]) => `<a href="#/settings/${k}" class="${k === tab ? 'on' : ''}">${icon(ic)} ${l}</a>`).join('')}</nav>
    <div class="set-body" id="set-body"></div></div>`;
  const body = $('#set-body', ctx.view);
  const fn = { general, sources, collections, import: importTab, export: exportTab, backup: backupTab, about }[tab] || general;
  await fn(body, ctx);
}

// ---------------- General ----------------
async function general(body) {
  const mode = getThemeMode();
  const b = S.boot;
  body.innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Theme</h2><span class="muted">Remembered separately on each device</span></div>
      <div class="theme-pick">${[['dark', 'Dark', 'moon'], ['light', 'Light', 'sun'], ['system', 'Follow system', 'auto']].map(([k, l, ic]) =>
        `<button class="theme-opt ${mode === k ? 'on' : ''}" data-theme-opt="${k}"><span class="swatch ${k}"></span>${icon(ic)} ${l}</button>`).join('')}</div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Using Vault anywhere</h2></div>
      <p>Vault lives at this address. Open it on any computer or phone and sign in with your email code:</p>
      <div class="lan-url"><code>${esc(location.origin)}</code><button class="btn small" id="copy-url">Copy</button></div>
      <p class="muted">On your phone, use the browser’s “Add to Home Screen” so Vault opens like an app.${b.user ? ` Signed in as <b>${esc(b.user)}</b>.` : ''}</p>
    </section>
    <section class="panel"><div class="panel-head"><h2>Where to watch</h2><span class="muted" id="wtw-status"></span></div>
      <p>Vault quietly checks your movies and TV shows for free streaming and public-domain copies, and re-checks each one about once a month, since what\u2019s free changes often. It runs in the background whenever Vault is open.</p>
      <div class="btn-row"><button class="btn" id="wtw-run">${icon('refresh')} Check now</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Sharp poster images</h2><span class="muted" id="thumb-status"></span></div>
      <p>The poster grid uses a smaller copy of each cover. Vault now makes those copies large enough to stay sharp on big screens and TVs, and upgrades older ones by itself whenever Vault is open on a computer. You can also do them all now; keep this page open while it runs.</p>
      <div class="btn-row"><button class="btn" id="thumb-run">${icon('image')} Sharpen remaining images now</button>
        <button class="btn ghost" id="thumb-all" title="Rebuilds every grid image, even ones already done">Rebuild all</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Your data</h2></div>
      <p>Your collection is stored in your Cloudflare account. For an extra copy you control, use <a class="ext" href="#/settings/backup">Backup</a> and save the file to OneDrive.</p>
    </section>`;
  $$('[data-theme-opt]', body).forEach(btn => btn.onclick = () => {
    setThemeMode(btn.dataset.themeOpt);
    $$('[data-theme-opt]', body).forEach(x => x.classList.toggle('on', x === btn));
  });
  const showWtw = () => {
    const el = $('#wtw-status', body);
    if (!el) { document.removeEventListener('vault-watch-progress', showWtw); return; }
    el.textContent = watchStatus.running ? `Checking: ${watchStatus.done} of ${watchStatus.total}`
      : watchStatus.total ? `Last run checked ${watchStatus.done} titles` : 'Up to date';
  };
  showWtw();
  document.addEventListener('vault-watch-progress', showWtw);
  $('#wtw-run', body).onclick = () => { startWatchChecks().catch(e => toast(e.message, 'error')); setTimeout(showWtw, 300); };
  const showThumbs = async () => {
    const el = $('#thumb-status', body);
    if (!el) { document.removeEventListener('vault-thumb-progress', showThumbs); return; }
    if (thumbStatus.running) {
      el.textContent = `Working: ${thumbStatus.done} of ${thumbStatus.total}`;
    } else {
      let left = 0;
      try { left = (await getAllItems()).filter(needsThumb).length; } catch (e) { /* ignore */ }
      el.textContent = left ? `${left} still to do` : 'All sharp';
      if (thumbStatus.failed) el.textContent += ` \u00b7 ${thumbStatus.failed} couldn\u2019t be done`;
    }
  };
  showThumbs();
  document.addEventListener('vault-thumb-progress', showThumbs);
  $('#thumb-run', body).onclick = () => { startThumbFixes({ pace: 150 }).catch(e => toast(e.message, 'error')); };
  $('#thumb-all', body).onclick = async () => {
    if (!await confirmBox('Rebuild every grid image?', 'This redoes the sharp copy for every item, including ones already done. It takes a few minutes for a large collection.', 'Rebuild all', 'primary')) return;
    startThumbFixes({ force: true, pace: 150 }).catch(e => toast(e.message, 'error'));
  };
  $('#copy-url', body).onclick = async () => {
    try { await navigator.clipboard.writeText(location.origin); toast('Copied.', 'ok'); } catch (e) { toast(location.origin); }
  };
}

// ---------------- Sources ----------------
async function sources(body) {
  const st = S.settings;
  body.innerHTML = `
    <section class="panel"><div class="panel-head"><h2>BoardGameGeek</h2><span class="status ${st.has_bgg_token ? 'ok' : ''}">${st.has_bgg_token ? 'Token saved' : 'Not connected'}</span></div>
      <p>Register Vault at <a class="ext" href="https://boardgamegeek.com/applications" target="_blank" rel="noopener">boardgamegeek.com/applications</a> (non-commercial). Once approved, create a token on that page and paste it here.</p>
      <label class="fld"><span>API token</span><div class="secret"><input type="password" id="bgg_token" placeholder="${st.has_bgg_token ? '•••••••• (saved; paste a new one to replace)' : 'Paste your BGG token'}" autocomplete="off"><button class="icon-btn" data-show="bgg_token" title="Show">${icon('eye')}</button></div></label>
      <div class="btn-row"><button class="btn primary" data-save="bgg_token">Save</button><button class="btn" data-test="bgg">Test connection</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>TMDB (movies & TV)</h2><span class="status ${st.has_tmdb_key ? 'ok' : ''}">${st.has_tmdb_key ? 'Key saved' : 'Not connected'}</span></div>
      <p>Get a free key at <a class="ext" href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">themoviedb.org → Settings → API</a>. Either the API Key or the longer Read Access Token works.</p>
      <label class="fld"><span>API key or Read Access Token</span><div class="secret"><input type="password" id="tmdb_key" placeholder="${st.has_tmdb_key ? '•••••••• (saved; paste a new one to replace)' : 'Paste your TMDB key'}" autocomplete="off"><button class="icon-btn" data-show="tmdb_key" title="Show">${icon('eye')}</button></div></label>
      <div class="btn-row"><button class="btn primary" data-save="tmdb_key">Save</button><button class="btn" data-test="tmdb">Test connection</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Watchmode (free streaming)</h2><span class="status ${st.has_watchmode_key ? 'ok' : ''}">${st.has_watchmode_key ? 'Key saved' : 'Not connected'}</span></div>
      <p>Finds which free services (Pluto TV, Tubi and others) have a movie or show, with direct links. Get a free key at <a class="ext" href="https://api.watchmode.com" target="_blank" rel="noopener">api.watchmode.com</a>.</p>
      ${st.has_watchmode_key ? `<p class="muted">This month: about ${st.watchmode_used} of ${st.watchmode_budget} free lookups used. Vault checks a title when you open its page, at most once a month per title. Each check uses 2.</p>` : ''}
      <label class="fld"><span>API key</span><div class="secret"><input type="password" id="watchmode_key" placeholder="${st.has_watchmode_key ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022 (saved; paste a new one to replace)' : 'Paste your Watchmode key'}" autocomplete="off"><button class="icon-btn" data-show="watchmode_key" title="Show">${icon('eye')}</button></div></label>
      <div class="btn-row"><button class="btn primary" data-save="watchmode_key">Save</button><button class="btn" data-test="watchmode">Test connection</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Barcode lookup</h2><span class="status ok">No key needed</span></div>
      <p>Barcodes are turned into product names with UPCitemdb’s free service (about 100 lookups a day). Items already in Vault are recognized without using a lookup.</p>
    </section>`;
  $$('[data-show]', body).forEach(b => b.onclick = e => {
    e.preventDefault();
    const inp = $(`#${b.dataset.show}`, body);
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
  $$('[data-save]', body).forEach(b => b.onclick = async () => {
    const key = b.dataset.save;
    const val = $(`#${key}`, body).value.trim();
    if (!val) { toast('Paste the key first.', 'warn'); return; }
    try {
      await api('/api/settings', { method: 'PUT', body: { [key]: val } });
      await refreshBoot();
      toast('Saved.', 'ok');
      sources(body);
    } catch (e) { toast(e.message, 'error'); }
  });
  $$('[data-test]', body).forEach(b => b.onclick = async () => {
    const done = busy('Testing…');
    try { toast(await testSource(b.dataset.test), 'ok'); }
    catch (e) { toast(e.message, 'error', 6000); }
    finally { done(); }
  });
}

// ---------------- Collections (template editor) ----------------
async function collections(body, ctx) {
  const selKey = ctx.params.type && typeOf(ctx.params.type) ? ctx.params.type : S.types[0].key;
  const t = JSON.parse(JSON.stringify(typeOf(selKey)));
  const kinds = S.boot.field_kinds;
  let fields = t.fields;
  let dirty = false;

  const draw = () => {
    body.innerHTML = `
      <div class="coll-pick">${S.types.map(x => `<a class="${x.key === selKey ? 'on' : ''}" href="#/settings/collections?type=${x.key}">${icon(x.icon)} ${esc(x.name)}</a>`).join('')}
        <button class="btn small" id="new-type">${icon('plus')} New collection</button></div>
      <section class="panel">
        <div class="panel-head"><h2>${esc(t.name)}</h2><span class="muted">${t.builtin ? 'Built-in collection' : 'Custom collection · manual entry'}</span></div>
        <div class="pair">
          <label class="fld"><span>Name</span><input id="t_name" value="${esc(t.name)}"></label>
          <div class="fld"><span>Icon</span><div class="icon-pick">${S.boot.icons.filter(n => ICON_NAMES.includes(n)).map(n => `<button class="icon-btn ${t.icon === n ? 'on' : ''}" data-icon="${n}" title="${n}">${icon(n)}</button>`).join('')}</div></div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Fields</h2><span class="muted">Reorder, rename, show or hide. Core fields (title, condition, location, price, tags, notes…) are on every item.</span></div>
        <div class="field-list">${fields.map((f, i) => `
          <div class="field-row ${f.visible ? '' : 'off'}" data-i="${i}">
            <div class="fr-move"><button class="icon-btn sm" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Move up">${icon('up')}</button><button class="icon-btn sm" data-down="${i}" ${i === fields.length - 1 ? 'disabled' : ''} title="Move down">${icon('down')}</button></div>
            <input class="fr-label" data-label="${i}" value="${esc(f.label)}">
            <select data-kind="${i}" ${f.builtin ? 'disabled title="Built-in field type can’t change"' : ''}>${[...kinds, ...(f.kind === 'itemlink' ? [['itemlink', 'Linked item']] : [])].map(([k, l]) => `<option value="${k}" ${f.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
            ${f.kind === 'choice' || f.kind === 'list' ? `<button class="btn small" data-opts="${i}">Options${(f.options || []).length ? ` (${f.options.length})` : ''}</button>` : '<span class="fr-gap"></span>'}
            <label class="check"><input type="checkbox" data-vis="${i}" ${f.visible ? 'checked' : ''}> Show</label>
            ${f.source ? `<span class="src-tag" title="Filled from the online source">auto</span>` : '<span class="src-tag none"></span>'}
            ${f.builtin ? '<span class="fr-gap sm"></span>' : `<button class="icon-btn sm" data-del="${i}" title="Remove field">${icon('trash')}</button>`}
          </div>`).join('')}</div>
        <div class="btn-row"><button class="btn" id="add-field">${icon('plus')} Add field</button></div>
      </section>
      <div class="form-actions sticky">
        ${t.builtin ? '' : `<button class="btn danger" id="del-type">${icon('trash')} Delete collection</button>`}
        <span class="grow"></span>
        <button class="btn primary" id="save-type" ${dirty ? '' : 'disabled'}>${icon('check')} Save changes</button>
      </div>`;
    wire();
  };
  const mark = () => { dirty = true; const s = $('#save-type', body); if (s) s.disabled = false; };
  const wire = () => {
    $('#t_name', body).oninput = e => { t.name = e.target.value; mark(); };
    $$('[data-icon]', body).forEach(b => b.onclick = () => { t.icon = b.dataset.icon; dirty = true; draw(); });
    $$('[data-up]', body).forEach(b => b.onclick = () => { const i = Number(b.dataset.up); [fields[i - 1], fields[i]] = [fields[i], fields[i - 1]]; dirty = true; draw(); });
    $$('[data-down]', body).forEach(b => b.onclick = () => { const i = Number(b.dataset.down); [fields[i + 1], fields[i]] = [fields[i], fields[i + 1]]; dirty = true; draw(); });
    $$('[data-label]', body).forEach(inp => inp.oninput = () => { fields[Number(inp.dataset.label)].label = inp.value; mark(); });
    $$('[data-kind]', body).forEach(s => s.onchange = () => { fields[Number(s.dataset.kind)].kind = s.value; dirty = true; draw(); });
    $$('[data-vis]', body).forEach(c => c.onchange = () => { fields[Number(c.dataset.vis)].visible = c.checked; dirty = true; draw(); });
    $$('[data-del]', body).forEach(b => b.onclick = async () => {
      const f = fields[Number(b.dataset.del)];
      if (!await confirmBox('Remove field', `Remove “${f.label}”? Values already entered stay stored but won’t be shown.`, 'Remove')) return;
      fields.splice(Number(b.dataset.del), 1); dirty = true; draw();
    });
    $$('[data-opts]', body).forEach(b => b.onclick = async () => {
      const f = fields[Number(b.dataset.opts)];
      const r = await modal({
        title: `Options for “${f.label}”`,
        body: `<p class="muted">One per line. These are suggestions; you can still type something else on an item.</p><textarea rows="8" id="opts">${esc((f.options || []).join('\n'))}</textarea>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Done', kind: 'primary', handler: root => root.querySelector('#opts').value }],
      });
      if (r !== null && r !== true) { f.options = r.split('\n').map(s => s.trim()).filter(Boolean); dirty = true; draw(); }
    });
    $('#add-field', body).onclick = async () => {
      const r = await modal({
        title: 'Add a field',
        body: `<label class="fld"><span>Label</span><input id="nf_label" placeholder="e.g. Shelf number"></label>
          <label class="fld"><span>Kind</span><select id="nf_kind">${kinds.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Add', kind: 'primary', handler: root => {
          const label = root.querySelector('#nf_label').value.trim();
          if (!label) { toast('Give the field a label.', 'warn'); return false; }
          return { label, kind: root.querySelector('#nf_kind').value };
        } }],
      });
      if (r && r.label) { fields.push({ key: '', label: r.label, kind: r.kind, visible: true, source: false, builtin: false }); dirty = true; draw(); }
    };
    $('#save-type', body).onclick = async () => {
      try {
        await api(`/api/types/${t.key}`, { method: 'PUT', body: { name: t.name, icon: t.icon, fields } });
        await refreshBoot(); refreshNav(); invalidate(t.key);
        toast('Collection saved.', 'ok');
        dirty = false;
        const fresh = typeOf(t.key);
        fields = JSON.parse(JSON.stringify(fresh.fields));
        draw();
      } catch (e) { toast(e.message, 'error'); }
    };
    const dt = $('#del-type', body);
    if (dt) dt.onclick = async () => {
      if (!await confirmBox('Delete collection', `Delete the “${t.name}” collection? It must be empty first.`)) return;
      try {
        await api(`/api/types/${t.key}`, { method: 'DELETE' });
        await refreshBoot(); refreshNav();
        location.hash = '#/settings/collections';
      } catch (e) { toast(e.message, 'error'); }
    };
    $('#new-type', body).onclick = async () => {
      const r = await modal({
        title: 'New collection',
        body: `<label class="fld"><span>Name</span><input id="nt_name" placeholder="e.g. Books, Vinyl, Coins"></label>
          <label class="fld"><span>Start with fields from</span><select id="nt_copy"><option value="">Nothing (blank)</option>${S.types.map(x => `<option value="${x.key}">${esc(x.name)}</option>`).join('')}</select></label>
          <label class="fld"><span>Icon</span><select id="nt_icon">${S.boot.icons.map(n => `<option>${n}</option>`).join('')}</select></label>
          <p class="muted">Custom collections use manual entry. Online lookup for other kinds (books, music) can come in a later version.</p>`,
        actions: [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', handler: async root => {
          const name = root.querySelector('#nt_name').value.trim();
          if (!name) { toast('Give it a name.', 'warn'); return false; }
          const res = await api('/api/types', { method: 'POST', body: { name, copy_from: root.querySelector('#nt_copy').value, icon: root.querySelector('#nt_icon').value } });
          return res.type.key;
        } }],
      });
      if (r && r !== true) { await refreshBoot(); refreshNav(); location.hash = `#/settings/collections?type=${r}`; }
    };
  };
  draw();
}

// ---------------- Import ----------------
let importRun = null;   // survives switching tabs while an import is running

async function importTab(body, ctx) {
  const st = S.settings;
  body.innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Import from BoardGameGeek</h2></div>
      <p>Brings in the games on your BGG account. Owned games join your collection, wishlist games go to your Wishlist, and logged plays fill the play log. You can run it again later; games already in Vault are skipped.</p>
      ${!st.has_bgg_token ? `<div class="notice warn">${icon('info')} Add your BGG token in <a href="#/settings/sources">Sources</a> first.</div>` : ''}
      <label class="fld"><span>BGG username</span><input id="bgg_user" value="${esc(st.bgg_username || '')}" autocomplete="off"></label>
      <div class="quick"><label class="check"><input type="checkbox" id="imp_wish" checked> Include wishlist games</label>
      <label class="check"><input type="checkbox" id="imp_plays" checked> Include logged plays</label></div>
      <div class="btn-row"><button class="btn primary" id="imp_go">${icon('download')} Start import</button>
        <button class="btn" id="imp_stop" hidden>Stop</button></div>
      <p class="muted">Keep this page open while the import runs. BoardGameGeek asks apps to go slowly, so a large collection can take several minutes.</p>
      <div id="imp_status"></div>
    </section>`;
  const box = $('#imp_status', body);
  const show = s => {
    if (!ctx.isCurrent() || !document.body.contains(box)) return;
    const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
    const running = importRun && importRun.running;
    box.innerHTML = `<div class="progress-card">
      <div class="pc-stage">${running ? '<div class="spinner sm"></div>' : icon(s.errors.length && !s.added ? 'info' : 'check')} ${esc(s.stage)}</div>
      ${s.total ? `<div class="bar"><div style="width:${pct}%"></div></div>` : ''}
      <div class="muted">${s.added} added · ${s.skipped} already in Vault · ${s.plays} plays${s.total ? ` · ${s.done}/${s.total}` : ''}</div>
      ${s.errors.length ? `<details ${s.added ? '' : 'open'}><summary>${s.errors.length} problem${s.errors.length > 1 ? 's' : ''}</summary><ul>${s.errors.slice(0, 40).map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : ''}
      ${!running && s.added ? '<a class="btn small" href="#/c/boardgame">See your games</a>' : ''}
    </div>`;
    $('#imp_go', body).disabled = !!running;
    $('#imp_stop', body).hidden = !running;
  };
  if (importRun) { importRun.show = show; show(importRun.state); }
  $('#imp_stop', body).onclick = () => { if (importRun) importRun.cancel = true; };
  $('#imp_go', body).onclick = async () => {
    const username = $('#bgg_user', body).value.trim();
    if (!username) { toast('Enter your BGG username.', 'warn'); return; }
    importRun = { running: true, cancel: false, show, state: null };
    const run = importRun;
    try {
      await importFromBgg(username, { wishlist: $('#imp_wish', body).checked, plays: $('#imp_plays', body).checked },
        s => { run.state = s; run.show(s); }, () => run.cancel);
    } catch (e) {
      const s = run.state || { stage: '', done: 0, total: 0, added: 0, skipped: 0, plays: 0, errors: [] };
      s.errors = [...s.errors, e.message];
      s.stage = 'Import stopped.';
      run.state = s;
    } finally {
      run.running = false;
      run.show(run.state);
      await refreshBoot(); refreshNav();
      invalidate('boardgame');
      startThumbFixes({ pace: 300 }).catch(() => {});   // sharp grid images for the newly imported games
    }
  };
}

// ---------------- Export ----------------
async function exportTab(body, ctx) {
  const req = ctx.params.from === 'view' ? store('export-request') : null;
  let typeKey = req ? req.type : S.types[0].key;
  const draw = async () => {
    const t = typeOf(typeKey);
    const items = await getItems(typeKey);
    const owned = items.filter(i => i.status === 'owned').length;
    const defaultsOff = new Set(['purchase_price', 'purchase_date', 'acquired_from', 'notes', 'location']);
    body.innerHTML = `
      <section class="panel"><div class="panel-head"><h2>HTML catalog</h2></div>
        <p>Builds a catalog with an index page, a cover wall and a page for each item, and downloads it as a .zip to this computer. Unzip it and open <b>index.html</b> in any browser; no internet or server needed.</p>
        ${req && req.type === typeKey ? `<div class="notice">${icon('filter')} Exporting your current view: <b>${req.ids.length}</b> items from ${esc(req.label)}. <a href="#/settings/export">Export everything instead</a></div>` : ''}
        <div class="pair">
          <label class="fld"><span>Collection</span><select id="ex_type" ${req ? 'disabled' : ''}>${S.types.map(x => `<option value="${x.key}" ${x.key === typeKey ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
          ${req ? '' : `<label class="fld"><span>Include</span><select id="ex_scope"><option value="owned">Owned (${owned})</option><option value="wishlist">Wishlist (${items.filter(i => i.status === 'wishlist').length})</option>${items.some(i => i.status === 'watchlist') ? `<option value="watchlist">Watchlist (${items.filter(i => i.status === 'watchlist').length})</option>` : ''}<option value="all">Everything (${items.length})</option></select></label>`}
        </div>
        <div class="pair">
          <label class="fld"><span>Catalog title</span><input id="ex_title" value="${esc(req ? req.label : `${t.name} Collection`)}"></label>
          <div class="fld"><span>Theme</span><div class="seg"><button data-th="dark" class="on">Dark</button><button data-th="light">Light</button></div></div>
        </div>
        <div class="fld"><span>Fields to show</span><div class="check-grid">
          ${t.fields.filter(f => f.kind !== 'itemlink').map(f => `<label class="check"><input type="checkbox" data-fk="${f.key}" ${f.visible ? 'checked' : ''}> ${esc(f.label)}</label>`).join('')}
          ${CORE_EXPORT_FIELDS.map(([k, l]) => `<label class="check"><input type="checkbox" data-fk="${k}" ${defaultsOff.has(k) ? '' : 'checked'}> ${esc(l)}</label>`).join('')}
        </div></div>
        <div class="btn-row"><button class="btn primary" id="ex_go">${icon('download')} Create and download</button></div>
      </section>`;
    let theme = 'dark';
    $$('[data-th]', body).forEach(b => b.onclick = () => { theme = b.dataset.th; $$('[data-th]', body).forEach(x => x.classList.toggle('on', x === b)); });
    const ts = $('#ex_type', body);
    if (ts) ts.onchange = () => { typeKey = ts.value; draw(); };
    $('#ex_go', body).onclick = async () => {
      let ids;
      if (req && req.type === typeKey) ids = req.ids;
      else {
        const scope = $('#ex_scope', body).value;
        ids = items.filter(i => scope === 'all' || i.status === scope).map(i => i.id);
      }
      if (!ids.length) { toast('Nothing to export in that selection.', 'warn'); return; }
      const fields = $$('[data-fk]', body).filter(c => c.checked).map(c => c.dataset.fk);
      const done = busy('Building the catalog…');
      try {
        const r = await exportCatalog({ type: typeKey, ids, theme, fields, title: $('#ex_title', body).value.trim() }, m => done.update(m));
        toast(`Catalog with ${r.count} items downloaded as ${r.name}.`, 'ok', 6000);
      } catch (e) { toast(e.message, 'error'); }
      finally { done(); }
    };
  };
  await draw();
}

// ---------------- Backup ----------------
async function backupTab(body) {
  body.innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Export backup</h2></div>
      <p>Downloads your whole collection as one .zip file: every item, play, loan and setting, plus covers and your photos. Save it somewhere safe, such as OneDrive.</p>
      <label class="check"><input type="checkbox" id="bk_images" checked> Include images (larger file)</label>
      <div class="btn-row"><button class="btn primary" id="bk_go">${icon('download')} Download backup</button></div>
    </section>
    <section class="panel"><div class="panel-head"><h2>Restore from a backup</h2></div>
      <p>Replaces everything in Vault with the contents of a backup file. Use this to recover, or to start over from a saved copy.</p>
      <div class="btn-row"><button class="btn danger" id="bk_restore">${icon('refresh')} Restore a backup…</button></div>
    </section>`;
  $('#bk_go', body).onclick = async () => {
    const done = busy('Preparing the backup…');
    try {
      const r = await makeBackup({ images: $('#bk_images', body).checked }, m => done.update(m));
      toast(`Backup saved as ${r.name} (${r.items} items, ${r.images} images).`, 'ok', 7000);
    } catch (e) { toast(e.message, 'error'); }
    finally { done(); }
  };
  $('#bk_restore', body).onclick = async () => {
    const files = await pickFile({ accept: '.zip,application/zip' });
    if (!files.length) return;
    const ok = await modal({
      title: 'Replace everything?',
      body: `<p>This deletes the collection currently in Vault and replaces it with <b>${esc(files[0].name)}</b>. It can’t be undone.</p>
        <label class="fld"><span>Type REPLACE to confirm</span><input id="bk_confirm" autocomplete="off"></label>`,
      actions: [{ label: 'Cancel', value: false }, { label: 'Restore', kind: 'danger', handler: root => {
        if (root.querySelector('#bk_confirm').value.trim().toUpperCase() !== 'REPLACE') { toast('Type REPLACE to confirm.', 'warn'); return false; }
        return true;
      } }],
    });
    if (!ok) return;
    const done = busy('Restoring…');
    try {
      const r = await restoreBackup(files[0], m => done.update(m));
      await refreshBoot(); refreshNav(); invalidate();
      toast(`Restored ${r.items} items and ${r.images} images.`, 'ok', 7000);
    } catch (e) { toast(e.message, 'error', 8000); }
    finally { done(); }
  };
}

// ---------------- About ----------------
async function about(body) {
  body.innerHTML = `
    <section class="panel"><div class="panel-head"><h2>Vault ${esc(S.boot.version)}</h2></div>
      <p>A personal collection catalog for board games, movies, TV series and anything else you collect.</p>
    </section>
    <section class="panel"><div class="panel-head"><h2>Data sources</h2></div>
      <ul class="plain">
        <li><b>Powered by BGG.</b> Board game information comes from <a class="ext" href="https://boardgamegeek.com" target="_blank" rel="noopener">BoardGameGeek</a>.</li>
        <li><b>TMDB.</b> This product uses the TMDB API but is not endorsed or certified by TMDB. Movie and TV information and images come from <a class="ext" href="https://www.themoviedb.org" target="_blank" rel="noopener">The Movie Database</a>.</li>
        <li><b>Where to watch.</b> ${ATTRIBUTION} The \u201cSearch for it on\u201d buttons open each service\u2019s own search page.</li>
        <li><b>Internet Archive.</b> Public-domain films play from the <a class="ext" href="https://archive.org" target="_blank" rel="noopener">Internet Archive</a>, and each one links back to its page there.</li>
        <li><b>IMDb</b> links are provided for reference. No data is taken from IMDb.</li>
        <li><b>Barcode lookups</b> come from <a class="ext" href="https://www.upcitemdb.com" target="_blank" rel="noopener">UPCitemdb</a>. Barcode reading uses <a class="ext" href="https://github.com/Sec-ant/zxing-wasm" target="_blank" rel="noopener">zxing-wasm</a>; zip files use <a class="ext" href="https://stuk.github.io/jszip/" target="_blank" rel="noopener">JSZip</a>.</li>
      </ul>
    </section>`;
}
