// Item form: used for new items (pre-filled from a source or blank) and for editing.
import { icon } from '../icons.js';
import { S, api, esc, $, typeOf, coverUrl, toast, busy, namesInput, getItems, invalidate,
  refreshBoot, today, normalizeItem, fieldValue, backdropOf, setCustomCover } from '../util.js';
import { setTitle, setBackdrop, refreshNav } from '../app.js';

let pending = null;   // prefill handed over from the Add page
export function setPrefill(p) { pending = p; }

function fieldInput(fd, v, sugg) {
  const id = `f_${fd.key}`;
  const opts = fd.options || [];
  switch (fd.kind) {
    case 'longtext':
      return `<textarea id="${id}" rows="5">${esc(v ?? '')}</textarea>`;
    case 'number':
      return `<input id="${id}" type="number" step="any" value="${esc(v ?? '')}">`;
    case 'range': {
      const r = v && typeof v === 'object' ? v : {};
      return `<div class="pair"><input id="${id}_min" type="number" step="any" placeholder="min" value="${esc(r.min ?? '')}">
        <input id="${id}_max" type="number" step="any" placeholder="max" value="${esc(r.max ?? '')}"></div>`;
    }
    case 'date':
      return `<input id="${id}" type="date" value="${esc(v ?? '')}">`;
    case 'bool':
      return `<select id="${id}"><option value="">—</option><option value="1" ${v === true ? 'selected' : ''}>Yes</option><option value="0" ${v === false ? 'selected' : ''}>No</option></select>`;
    case 'rating':
      return `<select id="${id}"><option value="">—</option>${Array.from({ length: 10 }, (_, i) => i + 1).map(n => `<option ${Number(v) === n ? 'selected' : ''}>${n}</option>`).join('')}</select>`;
    case 'choice': {
      const all = [...new Set([...opts, ...(sugg || [])])];
      return `<input id="${id}" list="${id}_dl" value="${esc(v ?? '')}" placeholder="Pick or type"><datalist id="${id}_dl">${all.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
    }
    case 'list':
      return `<div id="${id}" data-list></div>`;
    case 'url':
      return `<input id="${id}" type="url" value="${esc(v ?? '')}" placeholder="https://">`;
    case 'itemlink':
      return `<div class="static">${(Array.isArray(v) ? v : []).map(x => esc(x.name)).join(', ') || '<span class="muted">—</span>'}</div>`;
    default:
      return `<input id="${id}" value="${esc(v ?? '')}">`;
  }
}

function readField(root, fd, listInputs) {
  const id = `f_${fd.key}`;
  const el = $(`#${id}`, root);
  switch (fd.kind) {
    case 'number': return el.value === '' ? null : Number(el.value);
    case 'range': {
      const lo = $(`#${id}_min`, root).value, hi = $(`#${id}_max`, root).value;
      if (lo === '' && hi === '') return null;
      const a = Number(lo === '' ? hi : lo), b = Number(hi === '' ? lo : hi);
      return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    case 'bool': return el.value === '' ? null : el.value === '1';
    case 'rating': return el.value === '' ? null : Number(el.value);
    case 'list': return listInputs[fd.key] ? listInputs[fd.key].get() : [];
    case 'itemlink': return undefined;   // kept as-is
    default: return el.value.trim() === '' ? null : el.value.trim();
  }
}

export async function renderEdit(ctx, typeKey, id) {
  let t = typeOf(typeKey);
  let item, pre = null;
  if (id) {
    item = normalizeItem((await api(`/api/items/${id}`)).item);
    t = typeOf(item.type);
  } else {
    pre = pending || {};
    pending = null;
    item = {
      type: typeKey, status: pre.status || 'owned', title: pre.title || '', data: { ...(pre.data || {}) },
      text: { ...(pre.text || {}) }, tags: [], barcode: pre.barcode || '', group_name: '',
    };
  }
  if (!ctx.isCurrent()) return;
  setTitle(`${icon(t.icon)} ${id ? 'Edit' : 'New'} · ${esc(t.name)}`);
  if (pre) setBackdrop(pre.backdrop_url ? { url: pre.backdrop_url } : (pre.cover_url ? { url: pre.cover_url, soft: true } : null));
  else setBackdrop(backdropOf(item));

  // Suggestions from what's already in this collection
  const existing = await getItems(t.key);
  const sugg = {};
  const groups = new Set(), locations = new Set(), tags = new Set();
  existing.forEach(i => {
    if (i.group_name) groups.add(i.group_name);
    if (i.location) locations.add(i.location);
    (i.tags || []).forEach(x => tags.add(x));
    t.fields.forEach(fd => {
      const v = i.data[fd.key];
      if (fd.kind === 'list' || fd.kind === 'choice') {
        (Array.isArray(v) ? v : (v ? [v] : [])).forEach(x => (sugg[fd.key] = sugg[fd.key] || new Set()).add(x));
      }
    });
  });

  const cover = pre ? pre.cover_url : coverUrl(item);
  const visible = t.fields.filter(f => f.visible);
  const hidden = t.fields.filter(f => !f.visible);
  const fieldBlock = fd => `<label class="fld ${fd.kind === 'longtext' ? 'span2' : ''}"><span>${esc(fd.label)}${fd.source ? ' <i class="src" title="Filled from the online source">•</i>' : ''}</span>
    ${fieldInput(fd, fieldValue(item, fd), sugg[fd.key] ? [...sugg[fd.key]] : [])}</label>`;
  const dupes = pre && pre.duplicates && pre.duplicates.length
    ? `<div class="notice warn">${icon('info')} Already in Vault: ${pre.duplicates.map(d => `<a href="#/item/${t.key}/${d.id}">${esc(d.title)}${d.edition ? ` (${esc(d.edition)})` : ''}</a>${d.status === 'wishlist' ? ' on your wishlist' : ''}`).join(', ')}. Saving adds another copy.</div>` : '';

  ctx.view.innerHTML = `
    <form class="edit-form" autocomplete="off">
      ${dupes}
      <div class="edit-top">
        <div class="edit-cover">
          <div class="cover-box">${cover ? `<img src="${esc(cover)}" alt="" id="cover-preview">` : `<div class="noimg big" id="cover-preview">${icon(t.icon)}</div>`}</div>
          <label class="btn small ghost file-btn">${icon('image')} ${cover ? 'Replace' : 'Add'} cover<input type="file" accept="image/*" id="cover-file" hidden></label>
        </div>
        <div class="edit-basics">
          <label class="fld"><span>Title</span><input id="c_title" required value="${esc(item.title)}"></label>
          <div class="pair">
            <label class="fld"><span>Status</span><select id="c_status"><option value="owned" ${item.status === 'owned' ? 'selected' : ''}>Owned</option><option value="wishlist" ${item.status === 'wishlist' ? 'selected' : ''}>Wishlist</option></select></label>
            <label class="fld"><span>Group name <small>(stacks related items)</small></span><input id="c_group" list="groups_dl" value="${esc(item.group_name || '')}" placeholder="e.g. Monopoly"><datalist id="groups_dl">${[...groups].map(g => `<option value="${esc(g)}">`).join('')}</datalist></label>
          </div>
        </div>
      </div>
      <section class="panel"><div class="panel-head"><h2>Details</h2></div>
        <div class="form-grid">${visible.map(fieldBlock).join('')}</div>
        ${hidden.length ? `<details class="more-fields"><summary>Hidden fields (${hidden.length})</summary><div class="form-grid">${hidden.map(fieldBlock).join('')}</div></details>` : ''}
      </section>
      <section class="panel"><div class="panel-head"><h2>My copy</h2></div>
        <div class="form-grid">
          <label class="fld"><span>Condition</span><input id="c_condition" list="cond_dl" value="${esc(item.condition || '')}" placeholder="Pick or type"><datalist id="cond_dl">${S.boot.conditions.map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="fld"><span>Location</span><input id="c_location" list="loc_dl" value="${esc(item.location || '')}" placeholder="Shelf, room or box"><datalist id="loc_dl">${[...locations].map(c => `<option value="${esc(c)}">`).join('')}</datalist></label>
          <label class="fld"><span>Purchase date</span><input id="c_purchase_date" type="date" value="${esc(item.purchase_date || '')}"></label>
          <label class="fld"><span>Purchase price</span><input id="c_purchase_price" type="number" step="0.01" min="0" value="${esc(item.purchase_price ?? '')}" placeholder="0.00"></label>
          <label class="fld"><span>Where acquired</span><input id="c_acquired_from" value="${esc(item.acquired_from || '')}" placeholder="Store, gift, yard sale"></label>
          <label class="fld"><span>My rating</span><select id="c_my_rating"><option value="">—</option>${Array.from({ length: 10 }, (_, i) => i + 1).map(n => `<option ${Number(item.my_rating) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
          <div class="fld span2"><span>Tags</span><div id="c_tags"></div></div>
          <label class="fld span2"><span>Notes</span><textarea id="c_notes" rows="3" placeholder="e.g. 1985 Parker Brothers, wooden houses">${esc(item.notes || '')}</textarea></label>
          <label class="fld"><span>Barcode</span><input id="c_barcode" value="${esc(item.barcode || '')}" inputmode="numeric"></label>
        </div>
      </section>
      <div class="form-actions">
        <a class="btn" href="${id ? `#/item/${t.key}/${id}` : `#/add?type=${t.key}`}">Cancel</a>
        <button class="btn primary" type="submit">${icon('check')} ${id ? 'Save changes' : 'Save to Vault'}</button>
      </div>
    </form>`;

  const root = ctx.view;
  const listInputs = {};
  t.fields.filter(f => f.kind === 'list').forEach(fd => {
    const host = $(`#f_${fd.key}`, root);
    const cur = fieldValue(item, fd);
    const ni = namesInput(Array.isArray(cur) ? cur : (cur ? [cur] : []), sugg[fd.key] ? [...sugg[fd.key]] : [], 'Type and press Enter');
    host.appendChild(ni.el);
    listInputs[fd.key] = ni;
  });
  const tagInput = namesInput(item.tags || [], [...tags], 'Add a tag and press Enter');
  $('#c_tags', root).appendChild(tagInput.el);

  let coverFile = null;
  $('#cover-file', root).onchange = e => {
    coverFile = e.target.files[0] || null;
    if (coverFile) {
      const url = URL.createObjectURL(coverFile);
      $('.cover-box', root).innerHTML = `<img src="${url}" alt="" id="cover-preview">`;
    }
  };

  // Enter in a chip input shouldn't submit the form.
  root.querySelector('form').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.closest('.names-input')) e.preventDefault();
  });

  root.querySelector('form').onsubmit = async e => {
    e.preventDefault();
    const title = $('#c_title', root).value.trim();
    if (!title) { toast('Give it a title.', 'warn'); return; }
    // Long text fields are stored apart from the rest so collection lists stay light.
    const data = { ...(item.data || {}) };
    const text = { ...(item.text || {}) };
    t.fields.forEach(fd => {
      const v = readField(root, fd, listInputs);
      if (v === undefined) return;
      const target = fd.kind === 'longtext' ? text : data;
      delete data[fd.key];
      delete text[fd.key];
      if (!(v === null || (Array.isArray(v) && !v.length))) target[fd.key] = v;
    });
    const body = {
      type: t.key, title, status: $('#c_status', root).value, group_name: $('#c_group', root).value.trim() || null,
      condition: $('#c_condition', root).value.trim() || null, location: $('#c_location', root).value.trim() || null,
      purchase_date: $('#c_purchase_date', root).value || null, purchase_price: $('#c_purchase_price', root).value,
      acquired_from: $('#c_acquired_from', root).value.trim() || null, my_rating: $('#c_my_rating', root).value,
      tags: tagInput.get(), notes: $('#c_notes', root).value.trim() || null,
      barcode: $('#c_barcode', root).value.replace(/\D/g, '') || null, data, text,
    };
    if (!id && pre) {
      Object.assign(body, pre.ids || {});
      if (!coverFile) { body.cover_url = pre.cover_url || null; body.thumb_url = pre.thumb_url || null; }
      body.backdrop_url = pre.backdrop_url || null;
    }
    if (!id && body.status === 'owned' && !body.purchase_date && pre && pre.fromWishlist) body.purchase_date = today();
    const btn = root.querySelector('button[type=submit]');
    btn.disabled = true;
    const done = busy(id ? 'Saving…' : 'Saving and fetching cover art…');
    try {
      let newId = id;
      if (id) await api(`/api/items/${id}`, { method: 'PUT', body });
      else {
        const r = await api('/api/items', { method: 'POST', body });
        newId = r.id;
        (r.warnings || []).forEach(w => toast(w, 'warn'));
      }
      if (coverFile) await setCustomCover(newId, coverFile);
      invalidate(t.key);
      await refreshBoot(); refreshNav();
      toast(id ? 'Saved.' : `“${title}” added to ${body.status === 'wishlist' ? 'your wishlist' : t.name}.`, 'ok');
      location.hash = `#/item/${t.key}/${newId}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    } finally { done(); }
  };
}
