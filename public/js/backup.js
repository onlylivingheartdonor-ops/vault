// Full backup (data + images) to a .zip on this computer, and restore from one.
import { api, loadScript, downloadBlob, invalidate } from './util.js';

const TABLES = ['settings', 'types', 'items', 'photos', 'loans', 'plays', 'watches'];

export async function makeBackup({ images = true } = {}, onProgress = () => {}) {
  await loadScript('/vendor/jszip.min.js');
  const data = { app: 'Vault', format: 1, created: new Date().toISOString(), tables: {} };
  for (const table of TABLES) {
    onProgress(`Saving ${table}…`);
    const rows = [];
    for (let offset = 0; ; offset += 200) {
      const r = await api(`/api/backup/${table}?offset=${offset}`);
      rows.push(...r.rows);
      if (!r.more) break;
    }
    data.tables[table] = rows;
  }
  const zip = new window.JSZip();
  zip.file('vault-data.json', JSON.stringify(data));
  let count = 0;
  if (images) {
    const keys = [];
    let cursor = null;
    do {
      const r = await api(`/api/media-list${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
      keys.push(...r.keys);
      cursor = r.cursor;
    } while (cursor);
    // Download a few at a time
    let i = 0;
    const worker = async () => {
      while (i < keys.length) {
        const k = keys[i++];
        try {
          const res = await fetch(`/media/${k.split('/').map(encodeURIComponent).join('/')}`, { credentials: 'same-origin' });
          if (res.ok) { zip.file(`media/${k}`, await res.blob()); count += 1; }
        } catch (e) { /* skip one image */ }
        onProgress(`Saving images (${count} of ${keys.length})…`);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  onProgress('Compressing…');
  const blob = await zip.generateAsync({ type: 'blob' });
  const d = new Date();
  const name = `Vault-backup_${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.zip`;
  downloadBlob(blob, name);
  return { name, items: data.tables.items.length, images: count };
}

export async function restoreBackup(file, onProgress = () => {}) {
  await loadScript('/vendor/jszip.min.js');
  onProgress('Reading the backup…');
  const zip = await window.JSZip.loadAsync(file);
  const jf = zip.file('vault-data.json');
  if (!jf) throw new Error('That file isn’t a Vault backup.');
  const data = JSON.parse(await jf.async('string'));
  if (data.app !== 'Vault' || !data.tables) throw new Error('That file isn’t a Vault backup.');
  await api('/api/restore/begin', { method: 'POST', body: { confirm: 'REPLACE' } });
  for (const table of TABLES) {
    const rows = data.tables[table] || [];
    for (let i = 0; i < rows.length; i += 50) {
      onProgress(`Restoring ${table} (${Math.min(i + 50, rows.length)} of ${rows.length})…`);
      await api('/api/restore/rows', { method: 'POST', body: { table, rows: rows.slice(i, i + 50) } });
    }
  }
  const media = Object.keys(zip.files).filter(n => n.startsWith('media/') && !zip.files[n].dir);
  let done = 0;
  for (const name of media) {
    const key = name.slice('media/'.length);
    const blob = await zip.files[name].async('blob');
    await api(`/api/upload/${encodeURIComponent(key)}`, { method: 'PUT', raw: blob, contentType: 'image/jpeg' });
    done += 1;
    onProgress(`Restoring images (${done} of ${media.length})…`);
  }
  invalidate();
  return { items: (data.tables.items || []).length, images: done };
}
