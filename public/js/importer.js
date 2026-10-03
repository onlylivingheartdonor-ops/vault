// BoardGameGeek collection import, run from the browser in small batches.
import { api, getItems, invalidate } from './util.js';
import * as bgg from './sources/bgg.js';

// onProgress({stage, done, total, added, skipped, plays, errors})
export async function importFromBgg(username, { wishlist = true, plays = true } = {}, onProgress = () => {}, isCancelled = () => false) {
  const st = { stage: 'Asking BoardGameGeek for your collection… (this can take a minute)', done: 0, total: 0, added: 0, skipped: 0, plays: 0, errors: [] };
  const report = () => onProgress({ ...st, errors: [...st.errors] });
  report();
  await api('/api/settings', { method: 'PUT', body: { bgg_username: username } });

  let entries = await bgg.collection(username);
  if (!wishlist) entries = entries.filter(e => e.status === 'owned');
  invalidate('boardgame');
  const existing = new Set((await getItems('boardgame')).map(i => i.bgg_id).filter(Boolean));
  const todo = entries.filter(e => !existing.has(e.bgg_id));
  st.skipped = entries.length - todo.length;
  st.total = todo.length;
  st.stage = todo.length ? 'Fetching game details…' : 'Everything is already in Vault.';
  report();

  // Details in batches of 20 (with versions for entries that name one)
  for (let i = 0; i < todo.length; i += 20) {
    if (isCancelled()) { st.stage = 'Import stopped.'; report(); return st; }
    const chunk = todo.slice(i, i + 20);
    const withVer = chunk.filter(e => e.version_id).map(e => e.bgg_id);
    const plain = chunk.filter(e => !e.version_id).map(e => e.bgg_id);
    let els = new Map();
    try {
      if (plain.length) els = await bgg.things(plain, { stats: true, versions: false, gap: 2000 });
      if (withVer.length) (await bgg.things(withVer, { stats: true, versions: true, gap: 2000 })).forEach((v, k) => els.set(k, v));
    } catch (e) {
      st.errors.push(e.message);
    }
    for (const e of chunk) {
      if (isCancelled()) break;
      st.stage = `Adding ${e.name}…`;
      report();
      try {
        const el = els.get(e.bgg_id);
        if (!el) throw new Error('details not returned');
        const pre = bgg.mapThing(el, e.version_id);
        await api('/api/items', { method: 'POST', body: {
          type: 'boardgame', status: e.status, title: pre.title || e.name, notes: e.comment || null,
          data: pre.data, text: pre.text, bgg_id: pre.ids.bgg_id, version_id: pre.ids.version_id,
          cover_url: pre.cover_url, thumb_url: pre.thumb_url,
        } });
        st.added += 1;
      } catch (err) {
        st.errors.push(`${e.name}: ${err.message}`);
      }
      st.done += 1;
      report();
    }
  }

  if (plays && !isCancelled()) {
    st.stage = 'Importing logged plays…';
    report();
    invalidate('boardgame');
    const items = await getItems('boardgame');
    const byBgg = new Map();
    [...items].sort((a, b) => (a.status === 'owned' ? 0 : 1) - (b.status === 'owned' ? 0 : 1) || a.id - b.id)
      .forEach(i => { if (i.bgg_id && !byBgg.has(i.bgg_id)) byBgg.set(i.bgg_id, i.id); });
    const known = new Set((await api('/api/plays/bgg-ids')).ids);
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await api('/api/plays/bulk', { method: 'POST', body: { plays: batch } });
      st.plays += batch.length;
      batch = [];
      report();
    };
    try {
      for await (const p of bgg.plays(username)) {
        if (isCancelled()) break;
        const itemId = byBgg.get(p.bgg_id);
        if (!itemId || known.has(p.bgg_play_id)) continue;
        batch.push({ ...p, item_id: itemId });
        if (batch.length >= 50) await flush();
      }
      await flush();
    } catch (e) {
      st.errors.push(`Plays: ${e.message}`);
    }
  }
  invalidate();
  st.stage = isCancelled() ? 'Import stopped.' : 'Import finished.';
  report();
  return st;
}
