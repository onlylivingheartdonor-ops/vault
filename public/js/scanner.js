// Barcode scanning: live camera viewfinder, with photo and typed-number fallbacks.
import { icon } from './icons.js';
import { esc, modal, toast, busy, loadScript, pickFile, getAllItems, typeOf } from './util.js';
import { lookupBarcode } from './sources/index.js';

const FORMATS = ['EAN13', 'EAN8', 'UPCA', 'UPCE'];
let zxingReady = null;

function prepareZxing() {
  if (!zxingReady) {
    zxingReady = loadScript('/vendor/zxing-reader.js').then(() => window.ZXingWASM.prepareZXingModule({
      overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? '/vendor/zxing_reader.wasm' : prefix + path) },
      fireImmediately: true,
    }));
    zxingReady.catch(() => { zxingReady = null; });
  }
  return zxingReady;
}

function normalize(text) {
  let t = String(text || '').replace(/\D/g, '');
  if (![8, 12, 13, 14].includes(t.length)) return null;
  if (t.length === 13 && t.startsWith('0')) t = t.slice(1);   // EAN-13 with a leading 0 is a UPC-A
  return t;
}

async function decode(input) {
  await prepareZxing();
  const res = await window.ZXingWASM.readBarcodes(input, { formats: FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
  for (const r of res) {
    if (r.isValid === false) continue;
    const code = normalize(r.text);
    if (code) return code;
  }
  return null;
}

async function decodePhoto() {
  const files = await pickFile({ accept: 'image/*', capture: 'environment' });
  if (!files.length) return null;
  const done = busy('Reading the barcode…');
  try { return await decode(files[0]); }
  finally { done(); }
}

// Opens the camera and resolves with a barcode string, or null if cancelled.
function liveScan() {
  return new Promise(resolve => {
    let stream = null, timer = null, stopped = false, detector = null;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach(t => t.stop());
    };
    modal({
      title: 'Scan a barcode', cls: 'scan-modal',
      body: `<div class="scan-view"><video playsinline muted autoplay></video><div class="scan-frame"><span></span></div>
          <div class="scan-status">Starting the camera…</div></div>
        <div class="scan-alt">
          <button class="btn" data-photo>${icon('camera')} Take a photo instead</button>
          <button class="btn" data-type>${icon('edit')} Type the number</button>
        </div>`,
      onOpen: async (root, close, wrap) => {
        wrap.addEventListener('modal-close', stop);
        const video = root.querySelector('video');
        const status = root.querySelector('.scan-status');
        const finish = code => { stop(); close(code); };
        root.querySelector('[data-photo]').onclick = async () => {
          stop();
          const code = await decodePhoto().catch(e => { toast(e.message, 'error'); return null; });
          if (code) close(code);
          else { toast('Couldn’t read a barcode in that photo. Try again closer, with the barcode flat and in focus.', 'warn', 6000); close(null); }
        };
        root.querySelector('[data-type]').onclick = async () => {
          stop();
          close('__type__');
        };
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          status.textContent = 'This browser can’t use the live camera. Take a photo instead.';
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
          });
        } catch (e) {
          status.textContent = 'Camera permission was blocked. Allow the camera for this site, or take a photo instead.';
          return;
        }
        if (stopped) { stream.getTracks().forEach(t => t.stop()); return; }
        video.srcObject = stream;
        try { await video.play(); } catch (e) { /* autoplay */ }
        status.textContent = 'Line the barcode up inside the frame';
        if ('BarcodeDetector' in window) {
          try {
            const supported = await window.BarcodeDetector.getSupportedFormats();
            const want = ['ean_13', 'ean_8', 'upc_a', 'upc_e'].filter(x => supported.includes(x));
            if (want.length) detector = new window.BarcodeDetector({ formats: want });
          } catch (e) { detector = null; }
        }
        if (!detector) prepareZxing().catch(() => { status.textContent = 'The barcode reader didn’t load. Take a photo instead.'; });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (stopped) return;
          try {
            if (video.readyState >= 2 && video.videoWidth) {
              let code = null;
              if (detector) {
                const found = await detector.detect(video);
                code = found.map(b => normalize(b.rawValue)).find(Boolean) || null;
              } else if (window.ZXingWASM) {
                // Read the middle band of the picture, where the guide frame is.
                const vw = video.videoWidth, vh = video.videoHeight;
                const cw = Math.round(vw * 0.9), ch = Math.round(vh * 0.5);
                const scale = Math.min(1, 1280 / cw);
                canvas.width = Math.round(cw * scale); canvas.height = Math.round(ch * scale);
                ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, canvas.width, canvas.height);
                code = await decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
              }
              if (code) {
                if (navigator.vibrate) navigator.vibrate(60);
                status.textContent = `Found ${code}`;
                finish(code);
                return;
              }
            }
          } catch (e) { /* keep trying */ }
          timer = setTimeout(tick, 180);
        };
        tick();
      },
    }).then(v => { stop(); resolve(v); });
  });
}

async function typeNumber() {
  return modal({
    title: 'Type the barcode number',
    body: '<label class="fld"><span>Digits under the barcode</span><input name="code" inputmode="numeric" autocomplete="off" placeholder="e.g. 630509578896"></label>',
    actions: [{ label: 'Cancel', value: null }, { label: 'Look up', kind: 'primary', handler: root => {
      const c = normalize(root.querySelector('[name=code]').value);
      if (!c) { toast('That doesn’t look like a full barcode number (8, 12 or 13 digits).', 'warn'); return false; }
      return c;
    } }],
  });
}

// Full flow: scan, check Vault for it, look it up, and head to the Add page.
export async function scanBarcode(opts = {}) {
  let code = await liveScan();
  if (code === '__type__') code = await typeNumber();
  if (!code || code === true) return;
  const alt = code.length === 12 ? `0${code}` : code;
  const all = await getAllItems();
  const existing = all.filter(i => i.barcode && (i.barcode === code || i.barcode === alt));
  if (existing.length) {
    const ex = existing[0];
    const t = typeOf(ex.type);
    const choice = await modal({
      title: 'Already in Vault',
      body: `<p><b>${esc(ex.title)}</b> (${esc(t ? t.name : ex.type)}${ex.status === 'wishlist' ? ', on your wishlist' : ''}) has this barcode.</p>`,
      actions: [{ label: 'Add another copy', value: 'add' }, { label: 'Open it', kind: 'primary', value: 'open' }],
    });
    if (choice === 'open') location.hash = `#/item/${ex.type}/${ex.id}`;
    if (choice === 'add') location.hash = `#/add?type=${ex.type}&q=${encodeURIComponent(ex.title)}&barcode=${code}`;
    return;
  }
  const done = busy('Looking up the barcode…');
  let p = null;
  try { p = await lookupBarcode(code); }
  catch (e) { toast(e.message, 'warn', 6000); }
  finally { done(); }
  const type = opts.type || (p && p.type && typeOf(p.type) ? p.type : null) || 'boardgame';
  if (!p) toast(`Barcode ${code} isn’t in the lookup database. Search by name instead.`, 'warn', 6000);
  const q = p ? (p.query || p.title) : '';
  location.hash = `#/add?type=${type}&barcode=${code}${q ? `&q=${encodeURIComponent(q)}` : ''}${opts.status ? `&status=${opts.status}` : ''}`;
}

export { decode as decodeBarcode };
