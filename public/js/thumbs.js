// Sharp grid images. The poster grid shows a smaller copy of each cover ("thumb"). Vault now makes that
// copy itself, from the full cover, at up to 720 x 1080 — sharp on large screens and TVs. Older copies
// (360 px, or BGG's tiny thumbnails) are rebuilt in the background and from Settings.
import { S, api, getAllItems, resizeImage, uploadBlob, coverUrl, normalizeItem } from './util.js';

export const THUMB_W = 720;
export const THUMB_H = 1080;
export const THUMB_Q = 0.88;

// data.thumb = { for: <cover file name>, v: <version> } marks a sharp copy made for the current cover.
// A new cover has a new file name, so an old mark no longer matches and the item is rebuilt again.
export const hasSharpThumb = it => !!(it && it.cover && it.data && it.data.thumb && it.data.thumb.for === it.cover);
export const needsThumb = it => !!(it && it.cover) && !hasSharpThumb(it);

export async function markThumb(it, cover) {
  const mark = { for: cover, v: Date.now().toString(36) };
  await api(`/api/items/${it.id}/data`, { method: 'PATCH', body: { thumb: mark } });
  it.data = it.data || {};
  it.data.thumb = mark;
}

export async function rebuildThumb(it) {
  const r = await fetch(coverUrl(it), { credentials: 'same-origin', cache: 'no-store' });
  if (!r.ok) throw new Error(`Couldn’t read the cover for “${it.title}” (${r.status}).`);
  const small = await resizeImage(await r.blob(), THUMB_W, THUMB_H, THUMB_Q);
  await uploadBlob(`thumbs/${it.cover}`, small);
  await markThumb(it, it.cover);
}

// After an item gets a cover fetched from BGG or TMDB (new item, refresh), make its sharp grid copy right away.
// Never fails loudly: if it can't, the background run picks the item up later.
export async function sharpenItem(id) {
  try {
    const it = normalizeItem((await api(`/api/items/${id}`)).item);
    if (needsThumb(it)) await rebuildThumb(it);
  } catch (e) { /* the background run will retry */ }
}

// ---------------------------------------------------------------- background / Settings runs
export const thumbStatus = { running: false, total: 0, done: 0, failed: 0 };
const LOCK = 'vault:thumblock';
const tabId = Math.random().toString(36).slice(2);

function takeLock() {
  try {
    const cur = JSON.parse(localStorage.getItem(LOCK) || 'null');
    if (cur && cur.id !== tabId && Date.now() - cur.t < 30000) return false;   // another tab is working
    localStorage.setItem(LOCK, JSON.stringify({ id: tabId, t: Date.now() }));
    return true;
  } catch (e) { return true; }
}

const progress = () => document.dispatchEvent(new CustomEvent('vault-thumb-progress'));

// Works through every item whose grid image isn't the sharp kind yet. `force` redoes all of them.
// `pace` is the pause between items (the background run goes gently; the Settings button goes faster).
export async function startThumbFixes({ force = false, pace = 600 } = {}) {
  if (thumbStatus.running) return;
  thumbStatus.running = true;
  try {
    const items = await getAllItems();
    const todo = items.filter(it => it.cover && (force || needsThumb(it)));
    Object.assign(thumbStatus, { total: todo.length, done: 0, failed: 0 });
    progress();
    for (const it of todo) {
      if (!takeLock()) break;
      if (!force && !needsThumb(it)) { thumbStatus.done += 1; continue; }
      try { await rebuildThumb(it); } catch (e) {
        thumbStatus.failed += 1;
        if (/sign-in|signed in|reach Vault/i.test(e.message)) break;
      }
      thumbStatus.done += 1;
      progress();
      if (pace) await new Promise(r => setTimeout(r, pace));
    }
  } finally {
    thumbStatus.running = false;
    progress();
  }
}

// The quiet background run only happens on larger screens, so a phone on mobile data isn't asked to
// download every full-size cover.
export function startBackgroundThumbFixes() {
  const wide = window.matchMedia('(min-width: 900px)').matches;
  const saver = navigator.connection && navigator.connection.saveData;
  if (!wide || saver || !S.types.length) return Promise.resolve();
  return startThumbFixes({ pace: 600 });
}
