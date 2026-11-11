// Review layer: a tldraw canvas over any same-origin page, plus in-place copy editing and a TL;DR box.
// Claude reads everything back with window.__review.get() (JSON) or window.__review.markdown().
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, toRichText, DefaultToolbar, SelectToolbarItem, DrawToolbarItem, EraserToolbarItem, ArrowToolbarItem, TextToolbarItem, NoteToolbarItem, RectangleToolbarItem } from 'tldraw';

const params = new URLSearchParams(location.search);
const targetUrl = params.get('url') || '/';
const SEND_URL = '/__review/send';
const storeKey = 'review:' + targetUrl;
const $ = (s) => document.querySelector(s);
const iframe = $('#page');
const body = document.body;
let editor = null;
let doc = null;       // iframe document
let win = null;       // iframe window
let originals = {};   // data-rv id -> { selector, text }
let savedEdits = {};  // data-rv id -> { html, before }  (before = the page text the edit was made against)
try {
  const raw = JSON.parse(localStorage.getItem(storeKey + ':edits') || '{}');
  // Entries saved by an older version are bare innerHTML strings with nothing to verify them against; drop them.
  Object.keys(raw).forEach((id) => { if (raw[id] && typeof raw[id] === 'object' && (typeof raw[id].html === 'string' || raw[id].deleted)) savedEdits[id] = raw[id]; });
} catch (e) {}

let images = [];      // placed screenshots: { id, name, type, dataUrl, w, h, dpr, alt, caption, anchor, place, slot? }
let slots = [];       // screenshot slots the reviewer added: { id, anchor, text }. They are not in the source yet.
try { slots = JSON.parse(localStorage.getItem(storeKey + ':slots') || '[]'); if (!Array.isArray(slots)) slots = []; } catch (e) { slots = []; }
function saveSlots() { try { localStorage.setItem(storeKey + ':slots', JSON.stringify(slots)); } catch (e) {} }

// Image files are too big for localStorage, so they live in IndexedDB under the page's key.
const idb = {
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open('markup-review', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('images');
      r.onsuccess = () => { this._db = r.result; res(this._db); };
      r.onerror = () => rej(r.error);
    });
  },
  async get(key) { const db = await this.open(); return new Promise((res, rej) => { const r = db.transaction('images').objectStore('images').get(key); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); },
  async set(key, val) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('images', 'readwrite'); t.objectStore('images').put(val, key); t.oncomplete = res; t.onerror = () => rej(t.error); }); },
};
async function saveImages() { try { await idb.set(storeKey, images); } catch (e) {} }

$('#urlLabel').textContent = targetUrl;
iframe.src = targetUrl;

// Static folders: the server rescans the root every second and reports the newest mtime. When it moves (Claude
// applied the notes, or the source was edited by hand), reload the frame so the review shows the current page.
// Saved edits, deletions and placed images come back through the usual restore. Held off while the user is typing.
let lastInput = 0, changeStamp;
async function pollChanges() {
  try {
    const r = await fetch('/__review/changes', { cache: 'no-store' });
    const { stamp } = await r.json();
    if (stamp && changeStamp && stamp !== changeStamp && Date.now() - lastInput > 2000) {
      changeStamp = stamp;
      toast('Page changed on disk, reloading');
      iframe.contentWindow.location.reload();
    } else if (stamp) changeStamp = stamp;
  } catch (e) {}
  setTimeout(pollChanges, 1500);
}
pollChanges();

// ---------- modes ----------
function setMode(mode) {
  body.setAttribute('data-mode', mode);
  document.querySelectorAll('#bar .modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  if (doc) {
    doc.designMode = mode === 'edit' ? 'on' : 'off';
    if (mode === 'edit') doc.body.focus();
  }
  if (editor && mode === 'draw') editor.getContainer().focus();
  $('#hint').textContent = mode === 'draw' ? 'Draw, arrow, note, text. Press ` to flip between drawing and editing.'
    : mode === 'edit' ? 'Click into any text and change it. Cmd+Shift+X strikes it through. Press ` to go back to drawing.'
    : 'The page works normally. Press ` to draw again.';
  try { localStorage.setItem(storeKey + ':mode', mode); } catch (e) {}
}
document.querySelectorAll('#bar .modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

function onKey(e) {
  const typing = e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if (e.ctrlKey && !e.metaKey && ['1', '2', '3'].includes(e.key)) { e.preventDefault(); setMode(['draw', 'edit', 'browse'][+e.key - 1]); return; }
  if (e.ctrlKey && e.key === '/') { e.preventDefault(); toggleTldr(); return; }
  if (e.key === 'i' && !e.metaKey && !e.ctrlKey && !e.altKey && body.dataset.mode === 'draw' && !typing) { e.preventDefault(); togglePlacing(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); return; }
  if (e.key === 'Escape' && placing) { e.preventDefault(); stopPlacing(); toast('Cancelled'); return; }
  if (e.key === '`' && !typing) { e.preventDefault(); setMode(body.dataset.mode === 'draw' ? 'edit' : 'draw'); return; }
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'x' && doc && body.dataset.mode === 'edit') { e.preventDefault(); doc.execCommand('strikeThrough'); }
}
document.addEventListener('keydown', onKey, true);

// ---------- TL;DR ----------
const tldr = $('#tldr'), tldrText = $('#tldrText');
try { tldrText.value = localStorage.getItem(storeKey + ':tldr') || ''; } catch (e) {}
function toggleTldr(force) { tldr.classList.toggle('open', force); if (tldr.classList.contains('open')) tldrText.focus(); $('#tldrBtn').setAttribute('aria-pressed', tldr.classList.contains('open')); }
$('#tldrBtn').addEventListener('click', () => toggleTldr());
$('#tldrClose').addEventListener('click', () => toggleTldr(false));
tldrText.addEventListener('keydown', onKey);
tldrText.addEventListener('input', () => { try { localStorage.setItem(storeKey + ':tldr', tldrText.value); } catch (e) {} updateCount(); });

// ---------- toast ----------
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600); }

// ---------- the page under review ----------
function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== doc.body && parts.length < 5) {
    let seg = node.tagName.toLowerCase();
    if (node.id) { parts.unshift('#' + node.id); break; }
    if (node.dataset && node.dataset.label) { seg += '[data-label="' + node.dataset.label + '"]'; parts.unshift(seg); break; }
    const sibs = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName && !c.hasAttribute('data-rv-new') && !c.hasAttribute('data-rv-image')) : [];
    if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
    parts.unshift(seg);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
function hasOwnText(el) { return Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()); }
// Text of an element with strike-throughs rendered as ~~text~~.
// Line breaks and nested blocks that contenteditable creates when the reviewer presses Enter would otherwise
// glue two sentences together ("person.Pick"), so they become a ¶ marker: "the reviewer split the paragraph here".
function readText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('strike, s, del').forEach((s) => { s.replaceWith(doc.createTextNode('~~' + s.textContent + '~~')); });
  clone.querySelectorAll('[style*="line-through"]').forEach((s) => { s.replaceWith(doc.createTextNode('~~' + s.textContent + '~~')); });
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(doc.createTextNode(' ¶ ')));
  clone.querySelectorAll('div, p, li, h1, h2, h3, h4, h5, h6, blockquote').forEach((b) => { b.before(doc.createTextNode(' ¶ ')); b.after(doc.createTextNode(' ¶ ')); });
  return clone.textContent.replace(/\s+/g, ' ').replace(/(?:¶ )+¶/g, '¶').replace(/^¶ |\s¶$/g, '').trim();
}
function indexPage() {
  originals = {};
  let n = 0;
  doc.querySelectorAll('body *').forEach((el) => {
    if (!hasOwnText(el)) return;
    if (/^(SCRIPT|STYLE|TEXTAREA|BUTTON)$/.test(el.tagName)) return;
    if (el.closest('.switcher')) return;
    const id = String(n++);
    el.setAttribute('data-rv', id);
    const up = el.parentElement && el.parentElement.closest('[data-rv]');
    originals[id] = { selector: cssPath(el), text: readText(el), parent: up ? up.getAttribute('data-rv') : null };
  });
  // Re-apply edits saved from a previous visit, but only onto the text they were made against. When the
  // source has changed since (Claude applied the edit, or elements were added and the ids shifted), the
  // edit is stale: drop it rather than paint it onto the wrong element.
  let dropped = 0;
  Object.keys(savedEdits).forEach((id) => {
    const el = doc.querySelector('[data-rv="' + id + '"]');
    const saved = savedEdits[id];
    if (el && originals[id] && saved.before === originals[id].text) { if (saved.deleted) el.remove(); else el.innerHTML = saved.html; }
    else { delete savedEdits[id]; dropped++; }
  });
  if (dropped) {
    try { localStorage.setItem(storeKey + ':edits', JSON.stringify(savedEdits)); } catch (e) {}
    setTimeout(() => toast(dropped + (dropped === 1 ? ' edit' : ' edits') + ' already in the source, dropped'), 300);
  }
}
function onPageLoad() {
  doc = iframe.contentDocument; win = iframe.contentWindow;
  const lift = doc.createElement('style'); lift.textContent = '.switcher{bottom:74px !important} html{scroll-behavior:auto !important}'; doc.head.appendChild(lift);
  indexPage();
  restoreSlots();
  markDropZones();
  doc.addEventListener('input', () => { lastInput = Date.now(); recordEdits(); });
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', (e) => onPointerDown(e, e.clientX, e.clientY), true);
  // Drops and pastes that land in the frame itself (edit and browse modes, where the canvas lets pointer events through).
  doc.addEventListener('dragover', (e) => { if (hasImageFiles(e.dataTransfer)) { e.preventDefault(); dragging(true, e.clientX + win.scrollX, e.clientY + win.scrollY); } }, true);
  doc.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dragging(false); }, true);
  doc.addEventListener('drop', (e) => { dragging(false); if (!hasImageFiles(e.dataTransfer)) return; e.preventDefault(); e.stopImmediatePropagation(); void dropFiles(e.dataTransfer.files, e.clientX + win.scrollX, e.clientY + win.scrollY); }, true);
  doc.addEventListener('paste', (e) => { const files = imageFiles(e.clipboardData); if (!files.length) return; e.preventDefault(); e.stopImmediatePropagation(); void pasteFiles(files); }, true);
  void restoreImages();
  win.addEventListener('scroll', syncCamera, { passive: true });
  // Inside the page, Tab would leave the frame; harmless. Links open in the frame, which is fine for review.
  setMode(body.dataset.mode);
  syncCamera();
  updateCount();
}
iframe.addEventListener('load', onPageLoad);

// Snapshot what the reviewer has changed in the page into localStorage: retyped elements, deletions, captions, slot text.
function recordEdits() {
  if (!doc) return;
  const changed = {};
  doc.querySelectorAll('[data-rv]').forEach((el) => { const id = el.getAttribute('data-rv'); if (originals[id] && readText(el) !== originals[id].text) changed[id] = { html: el.innerHTML, before: originals[id].text }; });
  edits().forEach((e) => { if (e.deleted) { const id = Object.keys(originals).find((k) => originals[k].selector === e.selector && originals[k].text === e.before); if (id) changed[id] = { deleted: true, before: e.before }; } });
  savedEdits = changed;
  try { localStorage.setItem(storeKey + ':edits', JSON.stringify(changed)); } catch (e) {}
  // Captions typed under placed images and the text of added slots live in the page; keep the records in step.
  let captionsChanged = false;
  images.forEach((r) => { const cap = doc.querySelector('[data-rv-caption="' + r.id + '"]'); if (cap && cap.textContent !== r.caption) { r.caption = cap.textContent; captionsChanged = true; } });
  if (captionsChanged) void saveImages();
  let slotsChanged = false;
  slots.forEach((x) => { const el = slotEl(x.id); if (el && readText(el) !== x.text) { x.text = readText(el); slotsChanged = true; } });
  if (slotsChanged) saveSlots();
  updateCount();
}

function edits() {
  if (!doc) return [];
  const out = [];
  const changed = Array.from(doc.querySelectorAll('[data-rv]')).filter((el) => { const o = originals[el.getAttribute('data-rv')]; return o && readText(el) !== o.text; });
  changed.forEach((el) => {
    if (changed.some((other) => other !== el && other.contains(el))) return;
    const o = originals[el.getAttribute('data-rv')];
    out.push({ selector: o.selector, before: o.text, after: readText(el) });
  });
  // Elements the reviewer deleted outright (select across blocks, press Delete) are gone from the document, so
  // the loop above never sees them. Report each removed subtree once, by its topmost element, as deleted.
  const gone = (id) => !doc.querySelector('[data-rv="' + id + '"]');
  Object.keys(originals).forEach((id) => {
    if (!gone(id)) return;
    let p = originals[id].parent;
    while (p !== null && p !== undefined && !gone(p)) p = originals[p].parent;
    if (p !== null && p !== undefined) return;  // an ancestor is reported instead
    out.push({ selector: originals[id].selector, before: originals[id].text, after: '', deleted: true });
  });
  return out;
}

// Which element is under a page-space point? Smallest one that contains it, else the nearest within 80px.
function anchorFor(px, py) {
  if (!doc) return null;
  const sx = win.scrollX, sy = win.scrollY;
  let best = null, bestArea = Infinity, near = null, nearD = 80;
  doc.querySelectorAll('[data-rv], img, svg, button, textarea, .clock, .step, .out, .receipts li').forEach((el) => {
    if (el.closest('.switcher')) return;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
    const x = r.left + sx, y = r.top + sy;
    const inside = px >= x && px <= x + r.width && py >= y && py <= y + r.height;
    const area = r.width * r.height;
    if (inside && area < bestArea) { best = el; bestArea = area; }
    if (!inside) {
      const dx = Math.max(x - px, 0, px - (x + r.width)), dy = Math.max(y - py, 0, py - (y + r.height));
      const d = Math.hypot(dx, dy); if (d < nearD) { nearD = d; near = el; }
    }
  });
  const el = best || near; if (!el) return null;
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  return { selector: cssPath(el), text, exact: !!best };
}

// ---------- screenshots dropped onto the page ----------
// A dropped or pasted image goes into the page itself, as a figure with a caption, at the element under the
// pointer. Text flows around it the way it will on the site, and the caption is edited like any other copy.
const PLACEHOLDER = /\[(screenshot|image|photo|figure|img)\b/i;
const ZONE_CSS = `
[data-rv-dropzone]{position:relative;border:2px dashed #b9b9c2;border-radius:10px;padding:.75em 1em 2.1em;background:#fafafc;transition:border-color .15s,background .15s}
[data-rv-dropzone]::before{content:'×';position:absolute;top:5px;right:7px;width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font:700 18px/1 system-ui,-apple-system,sans-serif;color:#8a8a96;background:#ececf1;cursor:pointer}
[data-rv-dropzone]:hover::before{color:#fff;background:#d64545}
[data-rv-new]::after{content:'New slot. Retype this line in edit mode, drop a screenshot on it, or × to remove it' !important}
[data-rv-dropzone]::after{content:'Drop a screenshot here, paste, or × to remove the slot';position:absolute;left:1em;bottom:.6em;font:600 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em;color:#8a8a96;text-transform:none}
body.rv-dragging [data-rv-dropzone]{border-color:#e6b500;background:#fff7d6}
body.rv-dragging [data-rv-dropzone]::after{content:'Drop here';color:#8a6a00}
body.rv-dragging [data-rv-dropzone].rv-over{border-style:solid;border-color:#d99e00;background:#ffe9a3;box-shadow:0 0 0 4px rgba(255,213,74,.35)}
`;
// Placeholder lines ([Screenshot: ...], [Image: ...]) are shown as drop targets so nobody has to guess.
function markDropZones() {
  if (!doc.getElementById('rv-zone-css')) { const st = doc.createElement('style'); st.id = 'rv-zone-css'; st.textContent = ZONE_CSS; doc.head.appendChild(st); }
  doc.querySelectorAll('[data-rv]').forEach((el) => {
    if (!PLACEHOLDER.test((el.textContent || '').trim().slice(0, 40))) return;
    const block = blockOf(el);
    if (!block.closest('figure') && !block.hasAttribute('data-rv-hidden')) block.setAttribute('data-rv-dropzone', '');
  });
}
let dragRaf = 0;
// Light up the zones while an image is being dragged; brightest on the one under the pointer.
function dragging(on, px, py) {
  if (!doc) return;
  doc.body.classList.toggle('rv-dragging', !!on);
  if (!on) { doc.querySelectorAll('.rv-over').forEach((z) => z.classList.remove('rv-over')); return; }
  if (dragRaf) return;
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0;
    const a = anchorFor(px, py);
    let el = null; if (a) { try { el = doc.querySelector(a.selector); } catch (e) {} }
    const zone = el ? blockOf(el).closest('[data-rv-dropzone]') : null;
    doc.querySelectorAll('.rv-over').forEach((z) => { if (z !== zone) z.classList.remove('rv-over'); });
    if (zone) zone.classList.add('rv-over');
  });
}
function imageFiles(dt) { return dt ? Array.from(dt.files || []).filter((f) => /^image\//.test(f.type)) : []; }
function hasImageFiles(dt) { return !!dt && Array.from(dt.items || []).some((i) => i.kind === 'file' && /^image\//.test(i.type)); }
function readFile(file) {
  return new Promise((res, rej) => {
    if (file.size > 25 * 1024 * 1024) return rej(new Error(file.name + ' is over 25 MB'));
    const r = new FileReader();
    r.onload = () => { const im = new Image(); im.onload = () => res({ dataUrl: r.result, w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => rej(new Error('not an image')); im.src = r.result; };
    r.onerror = () => rej(r.error); r.readAsDataURL(file);
  });
}
function blockOf(el) { return el.closest('figure, p, li, blockquote, h1, h2, h3, h4, h5, h6, pre, table, section, article, div') || el; }
function humanName(name) {
  const base = name.replace(/\.[a-z0-9]+$/i, '');
  if (/^(screen ?shot|image|cleanshot|capture|img_?\d*|photo)\b/i.test(base) || /^\d{4}-\d{2}-\d{2}/.test(base)) return '';
  return base.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// Decide where an image goes relative to the element under the pointer, and what to call it.
function planFor(el, file) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const anchor = { selector: cssPath(el), text: text.slice(0, 90) };
  if (el.tagName === 'IMG') {
    const cap = el.closest('figure') && el.closest('figure').querySelector('figcaption');
    return { place: 'image', anchor, alt: el.alt || '', caption: cap ? cap.textContent.trim() : '' };
  }
  const block = blockOf(el);
  const btext = (block.textContent || '').replace(/\s+/g, ' ').trim();
  if (PLACEHOLDER.test(btext)) {
    const m = btext.match(/^\[?\s*(?:screenshot|image|photo|figure|img)\s*:?\s*(.*?)(?:\s*caption:\s*(.*?))?\s*\]?$/i);
    let alt = m && m[1] ? m[1].replace(/[.\s]+$/, '') : '';
    let caption = m && m[2] ? m[2].replace(/\]$/, '').trim() : '';
    if (block.hasAttribute('data-rv-new')) {
      const slot = slots.find((x) => x.id === block.getAttribute('data-rv-new'));
      if (/^what it shows$/i.test(alt)) alt = '';
      if (/^what to say under it$/i.test(caption)) caption = '';
      return { place: 'after', slot: block.getAttribute('data-rv-new'), anchor: slot ? slot.anchor : { selector: cssPath(block), text: btext.slice(0, 90) }, alt, caption: caption || humanName(file.name) || 'Add a caption' };
    }
    return { place: 'replace', anchor: { selector: cssPath(block), text: btext.slice(0, 90) }, alt, caption: caption || humanName(file.name) || 'Add a caption' };
  }
  return { place: 'after', anchor: { selector: cssPath(block), text: btext.slice(0, 90) }, alt: '', caption: humanName(file.name) || 'Add a caption' };
}
function resolveAnchor(anchor) {
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  let el = null;
  try { el = doc.querySelector(anchor.selector); } catch (e) {}
  if (el && textOf(el) === anchor.text) return el;
  // Selectors count source elements only, so with added slots or placed figures in the page the nth-of-type can
  // point one off. Fall back to the one element of that tag with the same text.
  const tag = (anchor.selector.split('>').pop() || '').trim().replace(/[:#.[].*$/, '');
  if (!tag) return null;
  const same = Array.from(doc.querySelectorAll(tag)).filter((c) => !c.hasAttribute('data-rv-new') && !c.hasAttribute('data-rv-image') && textOf(c) === anchor.text);
  return same.length === 1 ? same[0] : null;
}
function buildFigure(rec) {
  const fig = doc.createElement('figure');
  fig.setAttribute('data-rv-image', rec.id);
  const img = doc.createElement('img');
  img.src = rec.dataUrl; img.alt = rec.alt || ''; img.width = Math.round(rec.w / (rec.dpr || 1)); img.height = Math.round(rec.h / (rec.dpr || 1));
  img.style.maxWidth = '100%'; img.style.height = 'auto';
  const cap = doc.createElement('figcaption');
  cap.setAttribute('data-rv-caption', rec.id); cap.textContent = rec.caption || '';
  fig.append(img, cap);
  return fig;
}
// Put a record into the page. Returns false when its anchor is no longer there.
function mountImage(rec) {
  const el = resolveAnchor(rec.anchor);
  if (!el) return false;
  if (rec.place === 'image') {
    if (!el.dataset.rvOrigSrc) el.dataset.rvOrigSrc = el.getAttribute('src') || '';
    el.src = rec.dataUrl; el.setAttribute('data-rv-image', rec.id);
    return true;
  }
  const fig = buildFigure(rec);
  if (rec.place === 'replace') { el.setAttribute('data-rv-hidden', rec.id); el.removeAttribute('data-rv-dropzone'); el.style.display = 'none'; }
  let after = el;
  if (rec.slot) { const sl = slotEl(rec.slot); if (sl) { sl.setAttribute('data-rv-hidden', rec.id); sl.removeAttribute('data-rv-dropzone'); sl.style.display = 'none'; after = sl; } }
  after.insertAdjacentElement('afterend', fig);
  return true;
}
function unmountImage(rec) {
  const fig = doc.querySelector('figure[data-rv-image="' + rec.id + '"]'); if (fig) fig.remove();
  const hid = doc.querySelector('[data-rv-hidden="' + rec.id + '"]'); if (hid) { hid.style.display = ''; hid.removeAttribute('data-rv-hidden'); hid.setAttribute('data-rv-dropzone', ''); }
  const img = doc.querySelector('img[data-rv-image="' + rec.id + '"]'); if (img) { img.src = img.dataset.rvOrigSrc || ''; img.removeAttribute('data-rv-image'); }
}
// A placed image the user deleted from the page (select it in edit mode, Backspace) is gone for good.
function pruneImages() {
  const before = images.length;
  images = images.filter((r) => doc && doc.querySelector((r.place === 'image' ? 'img' : 'figure') + '[data-rv-image="' + r.id + '"]'));
  if (images.length !== before) void saveImages();
}
async function removeImage(id) {
  const rec = images.find((r) => r.id === id); if (!rec) return false;
  unmountImage(rec); images = images.filter((r) => r !== rec); await saveImages(); updateCount(); return true;
}
function captionOf(rec) {
  if (rec.place === 'image') { const el = doc.querySelector('img[data-rv-image="' + rec.id + '"]'); const cap = el && el.closest('figure') && el.closest('figure').querySelector('figcaption'); return cap ? cap.textContent.trim() : rec.caption; }
  const cap = doc.querySelector('[data-rv-caption="' + rec.id + '"]');
  const text = cap ? cap.textContent.trim() : rec.caption;
  return text === 'Add a caption' ? '' : text;
}
async function placeFile(file, el) {
  let data;
  try { data = await readFile(file); } catch (err) { toast(err.message); return null; }
  const plan = planFor(el, file);
  const rec = { id: 'img-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: file.name || 'image.png', type: file.type, dataUrl: data.dataUrl, w: data.w, h: data.h, dpr: window.devicePixelRatio || 1, ...plan };
  if (!mountImage(rec)) { toast('Could not place that here'); return null; }
  images.push(rec);
  await saveImages();
  updateCount();
  return rec;
}
async function dropFiles(files, px, py, at) {
  let el = at || null;
  if (!el) { const a = anchorFor(px, py); if (a) { try { el = doc.querySelector(a.selector); } catch (e) {} } }
  if (!el) el = doc.elementFromPoint(px - win.scrollX, py - win.scrollY) || doc.body;
  let rec = null;
  for (const f of imageFiles({ files })) { const r = await placeFile(f, el); if (r) { rec = r; el = doc.querySelector('figure[data-rv-image="' + r.id + '"] figcaption') || el; } }
  if (rec) toast(rec.place === 'image' ? 'Replaced the image. Press ` to edit its caption.' : 'Placed. Press ` to edit the caption.');
}
function visiblePlaceholder() {
  const top = win.scrollY, bottom = top + win.innerHeight;
  for (const el of doc.querySelectorAll('[data-rv], [data-rv-new]')) {
    if (!PLACEHOLDER.test(el.textContent || '') || el.closest('[data-rv-hidden]') || el.hasAttribute('data-rv-hidden')) continue;
    const r = el.getBoundingClientRect(); const y = r.top + top;
    if (y >= top && y <= bottom) return el;
  }
  return null;
}
async function pasteFiles(files) {
  let el = null;
  const sel = doc.getSelection && doc.getSelection();
  if (body.dataset.mode === 'edit' && sel && sel.anchorNode && doc.body.contains(sel.anchorNode)) el = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
  if (!el) el = visiblePlaceholder();
  if (!el) { toast('Click into the text where it goes (press ` first), then paste'); return; }
  await dropFiles(files, 0, 0, el);
}
async function restoreImages() {
  let stored = [];
  try { stored = await idb.get(storeKey); } catch (e) {}
  const kept = [];
  let dropped = 0;
  for (const rec of stored) { if (mountImage(rec)) kept.push(rec); else dropped++; }
  images = kept;
  if (dropped) { await saveImages(); setTimeout(() => toast(dropped + (dropped === 1 ? ' image' : ' images') + ' already in the source, dropped'), 300); }
  updateCount();
}
// ---------- screenshot slots the reviewer adds ----------
// "+ Image" then a click puts an empty placeholder line after the block under the pointer, as a drop zone. It is
// not in the source, so the notes list it by the element it follows. Dropping a file on it places a figure there.
const SLOT_TEXT = '[Screenshot: what it shows. Caption: what to say under it]';
function slotEl(id) { return doc ? doc.querySelector('[data-rv-new="' + id + '"]') : null; }
function mountSlot(rec) {
  const el = resolveAnchor(rec.anchor); if (!el) return false;
  const p = doc.createElement('p'); p.setAttribute('data-rv-new', rec.id); p.setAttribute('data-rv-dropzone', '');
  const b = doc.createElement('strong'); b.textContent = rec.text || SLOT_TEXT; p.appendChild(b);
  el.insertAdjacentElement('afterend', p);
  return true;
}
function restoreSlots() {
  const kept = []; let dropped = 0;
  slots.forEach((rec) => { if (mountSlot(rec)) kept.push(rec); else dropped++; });
  slots = kept; if (dropped) saveSlots();
}
function addSlotAfter(el) {
  let block = blockOf(el);
  // After a placed figure or a hidden placeholder, anchor to the source element they sit on.
  if (block.hasAttribute('data-rv-image') || block.hasAttribute('data-rv-hidden')) { const prev = block.previousElementSibling; if (prev) block = prev; }
  const text = (block.textContent || '').replace(/\s+/g, ' ').trim();
  const rec = { id: 'slot-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), anchor: { selector: cssPath(block), text: text.slice(0, 90) }, text: SLOT_TEXT };
  if (!mountSlot(rec)) return null;
  slots.push(rec); saveSlots(); updateCount();
  return slotEl(rec.id);
}
// Remove a drop zone: a slot the reviewer added goes away quietly; a placeholder from the source is a deletion.
function removeSlot(zone) {
  const id = zone.getAttribute('data-rv-new');
  zone.remove();
  if (id) { slots = slots.filter((x) => x.id !== id); saveSlots(); } else recordEdits();
  updateCount();
  toast(id ? 'Slot removed' : 'Placeholder removed. Claude will take it out of the source.');
}
// Is this point (frame client coordinates) on the × of a drop zone?
function closeHit(cx, cy) {
  if (!doc) return null;
  const el = doc.elementFromPoint(cx, cy); const zone = el && el.closest('[data-rv-dropzone]'); if (!zone) return null;
  const r = zone.getBoundingClientRect();
  return cx >= r.right - 40 && cy <= r.top + 40 ? zone : null;
}
function slotRecords() { return slots.filter((x) => { const el = slotEl(x.id); return el && !el.hasAttribute('data-rv-hidden'); }).map((x) => ({ id: x.id, anchor: x.anchor, text: x.text })); }

// Placing: after "+ Image", the next click on the page chooses where the slot goes, then the file picker opens.
let placing = false;
const fileInput = $('#fileInput');
let pendingSlot = null;
function startPlacing() { placing = true; body.classList.add('rv-placing'); $('#hint').textContent = 'Click where the image goes. Esc to cancel.'; $('#addBtn').setAttribute('aria-pressed', 'true'); }
function stopPlacing() { placing = false; body.classList.remove('rv-placing'); setMode(body.dataset.mode); $('#addBtn').setAttribute('aria-pressed', 'false'); }
function togglePlacing() { placing ? stopPlacing() : startPlacing(); }
$('#addBtn').addEventListener('click', togglePlacing);
fileInput.addEventListener('change', () => {
  const files = Array.from(fileInput.files || []); const slot = pendingSlot; pendingSlot = null; fileInput.value = '';
  if (files.length && slot && doc.contains(slot)) void dropFiles(files, 0, 0, slot);
});
// One handler for clicks that reach the review page (draw mode, canvas on top) and clicks inside the frame.
function onPointerDown(e, cx, cy) {
  if (!doc || e.button !== 0) return;
  if (placing) {
    e.preventDefault(); e.stopImmediatePropagation();
    const a = anchorFor(cx + win.scrollX, cy + win.scrollY);
    let el = null; if (a) { try { el = doc.querySelector(a.selector); } catch (err) {} }
    if (!el) el = doc.elementFromPoint(cx, cy) || doc.body;
    const slot = addSlotAfter(el);
    stopPlacing();
    if (!slot) { toast('Could not add a slot there'); return; }
    pendingSlot = slot;
    toast('Slot added. Pick a file, or cancel to leave it empty and drop one later.');
    fileInput.click();
    return;
  }
  const zone = closeHit(cx, cy);
  if (zone) { e.preventDefault(); e.stopImmediatePropagation(); removeSlot(zone); }
}
window.addEventListener('pointerdown', (e) => { const r = iframe.getBoundingClientRect(); const cx = e.clientX - r.left, cy = e.clientY - r.top; if (cy >= 0) onPointerDown(e, cx, cy); }, true);

// Drops and pastes on the review page itself (draw mode, where the canvas is on top). Capture phase, so tldraw
// never sees them and does not make its own image shape.
window.addEventListener('dragover', (e) => {
  if (!hasImageFiles(e.dataTransfer)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (doc) { const r = iframe.getBoundingClientRect(); dragging(true, e.clientX - r.left + win.scrollX, e.clientY - r.top + win.scrollY); }
}, true);
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dragging(false); }, true);
window.addEventListener('dragend', () => dragging(false), true);
window.addEventListener('drop', (e) => {
  dragging(false);
  if (!hasImageFiles(e.dataTransfer) || !doc) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const r = iframe.getBoundingClientRect();
  void dropFiles(e.dataTransfer.files, e.clientX - r.left + win.scrollX, e.clientY - r.top + win.scrollY);
}, true);
window.addEventListener('paste', (e) => {
  const files = imageFiles(e.clipboardData);
  if (!files.length || !doc) return;
  e.preventDefault(); e.stopImmediatePropagation();
  void pasteFiles(files);
}, true);

// ---------- tldraw ----------
function shapeText(shape) {
  const p = shape.props || {};
  if (typeof p.text === 'string') return p.text;
  if (p.richText) { const acc = []; (function walk(n) { if (!n) return; if (typeof n.text === 'string') acc.push(n.text); if (n.content) n.content.forEach(walk); if (n.type === 'paragraph') acc.push('\n'); })(p.richText); return acc.join('').replace(/\n+$/, '').trim(); }
  return '';
}
function marks() {
  if (!editor) return [];
  return editor.getCurrentPageShapes().map((shape) => {
    const b = editor.getShapePageBounds(shape.id); if (!b) return null;
    let ax = b.midX, ay = b.midY;
    if (shape.type === 'arrow' && shape.props.end) { ax = shape.x + shape.props.end.x; ay = shape.y + shape.props.end.y; }
    const text = shapeText(shape);
    const kind = shape.type === 'draw' ? (b.w < 12 && b.h < 12 ? 'dot' : b.w > b.h * 4 && b.h < 40 ? 'underline' : 'scribble') : shape.type;
    return { id: shape.id, kind, text, bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, anchor: anchorFor(ax, ay) };
  }).filter(Boolean).sort((a, b) => a.bounds.y - b.bounds.y);
}
function syncCamera() {
  if (!editor || !win) return;
  editor.setCamera({ x: -win.scrollX, y: -win.scrollY, z: 1 }, { force: true, immediate: true });
}
function updateCount() {
  if (doc) pruneImages();
  const n = (editor ? editor.getCurrentPageShapeIds().size : 0) + edits().length + images.length + slotRecords().length + (tldrText.value.trim() ? 1 : 0);
  $('#count').textContent = n;
}

const hidden = { PageMenu: null, NavigationPanel: null, MainMenu: null, HelpMenu: null, DebugMenu: null, DebugPanel: null, ActionsMenu: null, QuickActions: null, Minimap: null, ZoomMenu: null, SharePanel: null, TopPanel: null, Background: null, HelperButtons: null };

// The tldraw toolbar keeps its drawing tools, minus the media tool (images go onto the page, not the canvas)
// and the hand (the camera is locked; the wheel scrolls the page). Our two page controls, + Image and TL;DR,
// sit in #pagetools, a pill the page positions just right of that toolbar so the whole bottom row reads as one.
function ReviewToolbar() {
  return React.createElement(DefaultToolbar, null,
    React.createElement(SelectToolbarItem), React.createElement(DrawToolbarItem), React.createElement(EraserToolbarItem),
    React.createElement(ArrowToolbarItem), React.createElement(TextToolbarItem), React.createElement(NoteToolbarItem),
    React.createElement(RectangleToolbarItem));
}
function placePageTools() {
  const bar = document.querySelector('.tlui-main-toolbar__inner'), pill = $('#pagetools');
  if (!bar || !pill) return;
  const r = bar.getBoundingClientRect();
  if (!r.width) return;
  pill.style.left = Math.round(r.right + 8) + 'px';
  pill.style.top = Math.round(r.top + (r.height - pill.offsetHeight) / 2) + 'px';
  pill.classList.add('placed');
}
window.addEventListener('resize', placePageTools);

function App() {
  return React.createElement(Tldraw, {
    persistenceKey: storeKey,
    cameraOptions: { isLocked: true },
    components: { ...hidden, Toolbar: ReviewToolbar },
    onMount(ed) {
      editor = ed;
      ed.setCurrentTool('draw');
      ed.user.updateUserPreferences({ colorScheme: 'light' });
      ed.store.listen(() => updateCount(), { scope: 'document' });
      $('#loading').remove();
      placePageTools();
      const inner = document.querySelector('.tlui-main-toolbar__inner');
      if (inner && 'ResizeObserver' in window) new ResizeObserver(placePageTools).observe(inner);
      syncCamera();
      updateCount();
      ed.getContainer().focus();
    }
  });
}
createRoot($('#canvas')).render(React.createElement(App));

// Wheel over the canvas scrolls the page underneath.
window.addEventListener('wheel', (e) => {
  if (!win || body.dataset.mode !== 'draw') return;
  if (!$('#canvas').contains(e.target)) return;
  e.preventDefault(); e.stopImmediatePropagation();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? win.innerHeight : 1;
  win.scrollBy({ left: e.deltaX * k, top: e.deltaY * k, behavior: 'instant' });
}, { capture: true, passive: false });

// ---------- read-back ----------
function markdown() {
  const d = get();
  const L = [];
  L.push('# Review notes for ' + d.url, '');
  if (d.tldr) L.push('## TL;DR', '', d.tldr, '');
  if (d.edits.length) {
    L.push('## Copy edits (' + d.edits.length + ')', '');
    d.edits.forEach((e) => L.push('- `' + e.selector + '`', '  - before: ' + e.before, e.deleted ? '  - deleted: the whole element is gone from the page' : '  - after: ' + e.after));
    L.push('');
  }
  if (d.marks.length) {
    L.push('## Marks on the page (' + d.marks.length + ', top to bottom)', '');
    d.marks.forEach((m, i) => {
      const where = m.anchor ? (m.anchor.exact ? 'on' : 'near') + ' `' + m.anchor.selector + '` ("' + m.anchor.text.slice(0, 60) + '")' : 'at y=' + m.bounds.y;
      L.push((i + 1) + '. ' + m.kind + (m.text ? ': "' + m.text + '"' : '') + ' ' + where + (m.kind === 'dot' ? ' (a ' + m.bounds.w + '×' + m.bounds.h + ' px pen tap, probably accidental)' : ''));
    });
    L.push('');
  }
  if (d.images.length) {
    L.push('## Images (' + d.images.length + ')', '');
    d.images.forEach((im, i) => {
      const verb = im.place === 'image' ? 'replacing the image' : im.place === 'replace' ? 'replacing the placeholder' : 'after';
      L.push((i + 1) + '. `' + im.name + '` (' + im.w + '×' + im.h + (im.dpr > 1 ? ', ' + im.dpr + 'x screen' : '') + ') ' + verb + ' `' + im.anchor.selector + '` ("' + im.anchor.text.slice(0, 60) + '")');
      L.push('   - file: {{' + im.id + '}}');
      if (im.caption) L.push('   - caption: ' + im.caption);
      if (im.alt) L.push('   - alt: ' + im.alt);
    });
    L.push('');
  }
  if (d.slots.length) {
    L.push('## New screenshot slots (' + d.slots.length + ')', '');
    d.slots.forEach((x, i) => L.push((i + 1) + '. after `' + x.anchor.selector + '` ("' + x.anchor.text.slice(0, 60) + '"): ' + x.text));
    L.push('');
  }
  if (!d.tldr && !d.edits.length && !d.marks.length && !d.images.length && !d.slots.length) L.push('_No notes yet._');
  return L.join('\n');
}
function imageRecords() {
  pruneImages();
  return images.map((r) => ({ id: r.id, name: r.name, type: r.type, w: r.w, h: r.h, dpr: r.dpr, alt: r.alt, caption: captionOf(r), anchor: r.anchor, place: r.place }));
}
function get() {
  return { url: targetUrl, mode: body.dataset.mode, tldr: tldrText.value.trim(), edits: edits(), marks: marks(), images: imageRecords(), slots: slotRecords(), scrollY: win ? win.scrollY : 0 };
}
async function png() {
  if (!editor) return null;
  const ids = Array.from(editor.getCurrentPageShapeIds()); if (!ids.length) return null;
  const { blob } = await editor.toImage(ids, { format: 'png', background: true, scale: 1 });
  return await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
}
async function clearAll() {
  if (editor) editor.deleteShapes(Array.from(editor.getCurrentPageShapeIds()));
  savedEdits = {}; tldrText.value = '';
  images.forEach(unmountImage); images = []; slots = [];
  try { await idb.set(storeKey, []); } catch (e) {}
  try { localStorage.removeItem(storeKey + ':edits'); localStorage.removeItem(storeKey + ':tldr'); localStorage.removeItem(storeKey + ':slots'); } catch (e) {}
  iframe.contentWindow.location.reload();
  toast('Cleared');
}
$('#copyBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText(markdown()); toast('Copied as markdown'); } catch (e) { toast('Copy failed'); } });
let clearArmed = 0;
$('#clearBtn').addEventListener('click', () => {
  if (Date.now() - clearArmed < 3000) { clearArmed = 0; clearAll(); return; }
  clearArmed = Date.now(); toast('Click Clear all again to wipe everything');
});

// ---------- send ----------
let sending = false;
async function send() {
  if (sending) return;
  const d = get();
  if (!d.tldr && !d.edits.length && !d.marks.length && !d.images.length && !d.slots.length) { toast('Nothing to send yet'); return; }
  sending = true; const btn = $('#sendBtn'); btn.disabled = true; btn.firstChild.textContent = 'Sending';
  try {
    const image = await png();
    const res = await fetch(SEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: targetUrl, markdown: markdown(), json: d, png: image, images: images.map((r) => ({ id: r.id, name: r.name, type: r.type, dataUrl: r.dataUrl })) }) });
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    toast('Sent to Claude: ' + (j.path || '').split('/').pop());
    try { localStorage.setItem(storeKey + ':sent', new Date().toISOString()); } catch (e) {}
    // The TL;DR is a note for this send. Once delivered, clear it so the next round starts blank instead of
    // repeating it; edits and marks stay until the source catches up with them.
    tldrText.value = ''; toggleTldr(false); updateCount();
    try { localStorage.removeItem(storeKey + ':tldr'); } catch (e) {}
  } catch (err) {
    toast('Send failed. Is the review server running? (' + err.message + ')');
  } finally {
    sending = false; btn.disabled = false; btn.firstChild.textContent = 'Send to Claude';
  }
}
$('#sendBtn').addEventListener('click', send);

window.__review = { get, markdown, png, send, clear: clearAll, setMode, placeFile, removeImage, addSlotAfter, removeSlot, startPlacing, images: () => images, slots: () => slots, scrollTo: (y) => win && win.scrollTo({ top: y, behavior: 'instant' }), get editor() { return editor; }, toRichText };
try { const m = localStorage.getItem(storeKey + ':mode'); if (m) setMode(m); } catch (e) {}
