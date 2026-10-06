// HTML catalog export, built in the browser and downloaded as a .zip.
import { api, typeOf, normalizeItem, loadScript, downloadBlob, fieldValue, thumbUrl, isSquare } from './util.js';

export const CORE_EXPORT_FIELDS = [
  ['group_name', 'Group'], ['condition', 'Condition'], ['location', 'Location'], ['my_rating', 'My rating'],
  ['tags', 'Tags'], ['purchase_date', 'Purchase date'], ['purchase_price', 'Purchase price'],
  ['acquired_from', 'Where acquired'], ['notes', 'Notes'],
];

const THEMES = {
  dark: { bg: '#0f1116', panel: '#181b23', panel2: '#202430', text: '#eef0f5', muted: '#9aa1b2', accent: '#3fa9f5', line: '#2a2f3c', shade: 'rgba(10,12,16,.82)' },
  light: { bg: '#f3f4f7', panel: '#ffffff', panel2: '#eceef3', text: '#171a21', muted: '#5d6475', accent: '#0b78d0', line: '#dde0e7', shade: 'rgba(243,244,247,.86)' },
};

const CSS = `*{box-sizing:border-box}html,body{margin:0}
body{background:{bg};color:{text};font:15px/1.5 "Segoe UI",Roboto,system-ui,-apple-system,sans-serif}
a{color:inherit;text-decoration:none}
header{position:sticky;top:0;z-index:5;background:{shade};backdrop-filter:blur(12px);border-bottom:1px solid {line};padding:14px 24px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header h1{font-size:20px;margin:0;font-weight:600;letter-spacing:.02em}
header .count{color:{muted};font-size:13px}
header input{margin-left:auto;background:{panel2};color:{text};border:1px solid {line};border-radius:8px;padding:8px 12px;font:inherit;min-width:220px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:22px;padding:24px}
.card .poster{aspect-ratio:2/3;border-radius:8px;overflow:hidden;background:{panel2};box-shadow:0 6px 18px rgba(0,0,0,.35);transition:transform .18s ease}
.card:hover .poster{transform:translateY(-4px) scale(1.03)}
.card img{width:100%;height:100%;object-fit:cover;display:block}
.card.sq .poster{aspect-ratio:1}
.card.sq img{object-fit:contain}
.card .noimg{display:flex;align-items:center;justify-content:center;height:100%;padding:12px;text-align:center;color:{muted}}
.card .t{margin-top:8px;font-weight:600;font-size:14px;line-height:1.3}
.card .s{color:{muted};font-size:12.5px}
.bd{position:fixed;inset:0;z-index:-1;background-size:cover;background-position:center;filter:blur(6px);transform:scale(1.05)}
.bd.soft{filter:blur(40px) saturate(1.2);transform:scale(1.2)}
.bd:after{content:"";position:absolute;inset:0;background:{shade}}
.item{max-width:1000px;margin:0 auto;padding:32px 24px;display:grid;grid-template-columns:280px 1fr;gap:32px}
.item .cover img{width:100%;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
.item h2{font-size:32px;margin:0 0 4px;line-height:1.15}
.item .sub{color:{muted};margin-bottom:18px}
table{border-collapse:collapse;width:100%;background:{panel};border-radius:10px;overflow:hidden}
td{padding:9px 14px;border-bottom:1px solid {line};vertical-align:top}
td:first-child{color:{muted};width:34%;white-space:nowrap}
.desc{white-space:pre-wrap;margin-top:18px}
.back{display:inline-block;margin:18px 24px 0;color:{accent}}
footer{color:{muted};font-size:12px;padding:24px;text-align:center}
@media(max-width:700px){.item{grid-template-columns:1fr}.item .cover{max-width:240px}.grid{grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:14px;padding:14px}header input{min-width:0;width:100%}}`;

const SEARCH_JS = "document.getElementById('q').addEventListener('input',function(){var v=this.value.toLowerCase();"
  + "document.querySelectorAll('.card').forEach(function(c){c.style.display=c.dataset.k.indexOf(v)>-1?'':'none'})});";

const e = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmt(kind, v) {
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (kind === 'range' && typeof v === 'object') return v.min === v.max || v.max == null ? e(v.min) : `${e(v.min)}–${e(v.max)}`;
  if (kind === 'bool') return v ? 'Yes' : 'No';
  if (kind === 'list' && Array.isArray(v)) return e(v.join(', '));
  if (kind === 'itemlink' && Array.isArray(v)) return e(v.map(x => x.name).join(', '));
  if (kind === 'url') return `<a href="${e(v)}" style="text-decoration:underline">${e(v)}</a>`;
  if (kind === 'rating') return `${e(v)} / 10`;
  return e(v);
}

const slug = t => (String(t).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'catalog');

async function fetchBlob(url) {
  try {
    const r = await fetch(url, { credentials: 'same-origin' });
    return r.ok ? await r.blob() : null;
  } catch (err) { return null; }
}

export async function fetchFullItems(type) {
  const out = [];
  for (let offset = 0; ; offset += 100) {
    const r = await api(`/api/items/full?type=${encodeURIComponent(type)}&offset=${offset}&limit=100`);
    out.push(...r.items.map(normalizeItem));
    if (!r.more) break;
  }
  return out;
}

export async function exportCatalog({ type, ids, theme = 'dark', fields, title }, onProgress = () => {}) {
  await loadScript('/vendor/jszip.min.js');
  const t = typeOf(type);
  const wanted = new Set(ids.map(Number));
  const items = (await fetchFullItems(type)).filter(i => wanted.has(i.id))
    .sort((a, b) => (a.sort_title || '').localeCompare(b.sort_title || ''));
  const tmpl = Object.fromEntries(t.fields.map(fd => [fd.key, fd]));
  const coreLabels = Object.fromEntries(CORE_EXPORT_FIELDS);
  title = title || `${t.name} Collection`;
  const zip = new window.JSZip();
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const root = zip.folder(`${slug(title)}_${stamp}`);
  let css = CSS;
  for (const [k, v] of Object.entries(THEMES[theme] || THEMES.dark)) css = css.split(`{${k}}`).join(v);
  root.file('style.css', css);
  const longKeys = new Set(fields.filter(k => tmpl[k] && tmpl[k].kind === 'longtext'));
  const cards = [];
  let n = 0;
  for (const it of items) {
    n += 1;
    onProgress(`Adding ${it.title} (${n} of ${items.length})…`);
    let cover = null, thumb = null, bd = null, soft = false;
    if (it.cover) {
      const [cb, tb] = await Promise.all([fetchBlob(`/media/covers/${encodeURIComponent(it.cover)}`), fetchBlob(thumbUrl(it))]);
      if (cb) { cover = `c_${it.cover}`; root.file(`images/${cover}`, cb); }
      if (tb) { thumb = `t_${it.cover}`; root.file(`images/${thumb}`, tb); }
    }
    if (it.backdrop) {
      const bb = await fetchBlob(`/media/backdrops/${encodeURIComponent(it.backdrop)}`);
      if (bb) { bd = `b_${it.backdrop}`; root.file(`images/${bd}`, bb); }
    } else if (cover) { bd = cover; soft = true; }
    const dd = it.data || {};
    const year = dd.year || dd.years_aired || '';
    const sub = [year, dd.edition || dd.format].filter(Boolean).join(' · ');
    const rows = [];
    for (const k of fields) {
      if (longKeys.has(k)) continue;
      let label, val;
      if (tmpl[k]) { label = tmpl[k].label; val = fmt(tmpl[k].kind, fieldValue(it, tmpl[k])); }
      else if (coreLabels[k] && k !== 'notes') {
        label = coreLabels[k];
        const v = it[k];
        if (k === 'tags') val = fmt('list', v);
        else if (k === 'my_rating') val = fmt('rating', v);
        else if (k === 'purchase_price') val = v == null || v === '' ? null : e(`$${Number(v).toFixed(2)}`);
        else val = fmt('text', v);
      }
      if (label && val) rows.push(`<tr><td>${e(label)}</td><td>${val}</td></tr>`);
    }
    let longs = [...longKeys].map(k => {
      const v = fieldValue(it, tmpl[k]);
      return v ? `<div class="desc"><strong>${e(tmpl[k].label)}</strong><br>${e(v)}</div>` : '';
    }).join('');
    if (fields.includes('notes') && it.notes) longs += `<div class="desc"><strong>Notes</strong><br>${e(it.notes)}</div>`;
    const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(it.title)}</title><link rel="stylesheet" href="../style.css"></head><body>
${bd ? `<div class="bd${soft ? ' soft' : ''}" style="background-image:url('../images/${e(bd)}')"></div>` : ''}
<a class="back" href="../index.html">← ${e(title)}</a>
<div class="item"><div class="cover">${cover ? `<img src="../images/${e(cover)}" alt="">` : ''}</div><div>
<h2>${e(it.title)}</h2><div class="sub">${e(sub)}</div><table>${rows.join('')}</table>${longs}</div></div>
<footer>Catalog generated by Vault</footer></body></html>`;
    root.file(`items/${it.id}.html`, page);
    const img = thumb || cover;
    const poster = img ? `<img src="images/${e(img)}" alt="" loading="lazy">` : `<div class="noimg">${e(it.title)}</div>`;
    const key = [it.title, year, dd.edition || '', it.group_name || ''].join(' ').toLowerCase();
    cards.push(`<a class="card${isSquare(it) ? ' sq' : ''}" data-k="${e(key)}" href="items/${it.id}.html"><div class="poster">${poster}</div>`
      + `<div class="t">${e(it.title)}</div><div class="s">${e(sub)}</div></a>`);
  }
  const dateWords = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  root.file('index.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><link rel="stylesheet" href="style.css"></head><body>
<header><h1>${e(title)}</h1><span class="count">${items.length} items · ${e(dateWords)}</span><input id="q" type="search" placeholder="Search this catalog"></header>
<div class="grid">${cards.join('')}</div><footer>Catalog generated by Vault</footer><script>${SEARCH_JS}</script></body></html>`);
  onProgress('Compressing…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const name = `${slug(title)}_${stamp}.zip`;
  downloadBlob(blob, name);
  return { count: items.length, name };
}
