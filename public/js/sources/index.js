// One front door to the online sources, keyed by collection type.
import * as bgg from './bgg.js';
import * as tmdb from './tmdb.js';
import { api, typeOf, getAllItems } from '../util.js';

export const SOURCE_NAMES = { bgg: 'BoardGameGeek', tmdb_movie: 'TMDB', tmdb_tv: 'TMDB' };

export function sourceOf(typeKey) {
  const t = typeOf(typeKey);
  return t ? t.source : 'none';
}

export async function lookupSearch(typeKey, query, page = 1) {
  const src = sourceOf(typeKey);
  if (src === 'bgg') return bgg.search(query, page);
  if (src === 'tmdb_movie') return tmdb.search('movie', query, page);
  if (src === 'tmdb_tv') return tmdb.search('tv', query, page);
  throw new Error('This collection has no online source. Use manual entry.');
}

export async function lookupDetails(typeKey, id, versionId = null) {
  const src = sourceOf(typeKey);
  let pre;
  if (src === 'bgg') pre = await bgg.details(id, versionId);
  else if (src === 'tmdb_movie') pre = await tmdb.details('movie', id);
  else if (src === 'tmdb_tv') pre = await tmdb.details('tv', id);
  else throw new Error('This collection has no online source.');
  pre.type = typeKey;
  // Duplicate check against what's already in Vault
  const all = await getAllItems();
  pre.duplicates = all.filter(i => i.type === typeKey && (
    (pre.ids.bgg_id && i.bgg_id === pre.ids.bgg_id) || (pre.ids.tmdb_id && i.tmdb_id === pre.ids.tmdb_id)))
    .map(i => ({ id: i.id, title: i.title, status: i.status, edition: i.data.edition || '' }));
  return pre;
}

export const versions = id => bgg.versions(id);

// Re-pull source details. Only fields marked as source-filled change; Dave's own fields never do.
export async function refreshItem(item) {
  const src = sourceOf(item.type);
  let pre;
  if (src === 'bgg' && item.bgg_id) pre = await bgg.details(item.bgg_id, item.version_id);
  else if (src === 'tmdb_movie' && item.tmdb_id) pre = await tmdb.details('movie', item.tmdb_id);
  else if (src === 'tmdb_tv' && item.tmdb_id) pre = await tmdb.details('tv', item.tmdb_id);
  else throw new Error('This item isn’t linked to an online source, so there’s nothing to refresh.');
  const t = typeOf(item.type);
  const sourceKeys = new Set(t.fields.filter(fd => fd.source).map(fd => fd.key));
  const data = { ...(item.data || {}) };
  const text = { ...(item.text || {}) };
  for (const [k, v] of Object.entries(pre.data)) if (sourceKeys.has(k)) data[k] = v;
  for (const [k, v] of Object.entries(pre.text || {})) if (sourceKeys.has(k)) text[k] = v;
  const body = { data, text };
  if (pre.ids.imdb_id) body.imdb_id = pre.ids.imdb_id;
  await api(`/api/items/${item.id}`, { method: 'PUT', body });
  const media = await api(`/api/items/${item.id}/media`, { method: 'POST', body: {
    cover_url: item.cover_custom ? null : pre.cover_url, thumb_url: pre.thumb_url, backdrop_url: pre.backdrop_url } });
  return media.warnings || [];
}

export async function testSource(which) {
  return which === 'bgg' ? bgg.test() : tmdb.test();
}

// ---- barcode text helpers
const NOISE = [
  /\bblu[\s-]?ray\b/gi, /\bdvd\b/gi, /\b4k\b/gi, /\bultra\s*hd\b/gi, /\buhd\b/gi, /\bdigital\b/gi,
  /\bwidescreen\b/gi, /\bfull\s*screen\b/gi, /\bspecial edition\b/gi, /\bcollector'?s edition\b/gi,
  /\bdeluxe edition\b/gi, /\banniversary edition\b/gi, /\bsteelbook\b/gi,
  /\bboard\s*game\b/gi, /\bfamily\s*game\b/gi, /\bstrategy\s*game\b/gi, /\bcard\s*game\b/gi,
  /\bparty\s*game\b/gi, /\bfor (ages|kids).*$/gi, /\bages?\s*\d+\+?.*$/gi,
  /\b\d+\s*-\s*\d+\s*players?\b/gi, /\bfactory sealed\b/gi, /\b\d+[\s-]*disc\b/gi,
  /\bcombo\s*pack\b/gi, /\bwith bonus.*$/gi,
];

export function cleanProductTitle(title, brand) {
  let t = title || '';
  if (brand && brand.length >= 3) t = t.replace(new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ');
  t = t.replace(/[([].*?[)\]]/g, ' ');
  for (const rx of NOISE) t = t.replace(rx, ' ');
  t = t.replace(/\s{2,}/g, ' ').replace(/^[\s\-–:|,]+|[\s\-–:|,]+$/g, '');
  return t;
}

export function guessType(title, category) {
  const text = `${title} ${category}`.toLowerCase();
  if (/season|series|complete series|tv show/.test(text) && /dvd|blu|video|tv/.test(text)) return 'tv';
  if (/dvd|blu-?ray|video|movie|film|4k/.test(text)) return 'movie';
  if (/game|puzzle|toys/.test(text)) return 'boardgame';
  return null;
}

export async function lookupBarcode(code) {
  const r = await api(`/api/upc/${code}`);
  if (!r.product) return null;
  const p = r.product;
  return { ...p, query: cleanProductTitle(p.title, p.brand), type: guessType(p.title, p.category) };
}
