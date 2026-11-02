// Review layer: a tldraw canvas over any same-origin page, plus in-place copy editing and a TL;DR box.
// Claude reads everything back with window.__review.get() (JSON) or window.__review.markdown().
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, createShapeId } from 'tldraw';

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
let savedEdits = {};  // data-rv id -> innerHTML
try { savedEdits = JSON.parse(localStorage.getItem(storeKey + ':edits') || '{}'); } catch (e) {}

$('#urlLabel').textContent = targetUrl;
iframe.src = targetUrl;

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
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); return; }
  if (e.key === '`' && !typing) { e.preventDefault(); setMode(body.dataset.mode === 'draw' ? 'edit' : 'draw'); return; }
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'x' && doc && body.dataset.mode === 'edit') { e.preventDefault(); doc.execCommand('strikeThrough'); }
}
document.addEventListener('keydown', onKey, true);

// ---------- TL;DR ----------
const tldr = $('#tldr'), tldrText = $('#tldrText');
try { tldrText.value = localStorage.getItem(storeKey + ':tldr') || ''; } catch (e) {}
function toggleTldr(force) { tldr.classList.toggle('open', force); if (tldr.classList.contains('open')) tldrText.focus(); }
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
    const sibs = node.parentElement ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName) : [];
    if (sibs.length > 1) seg += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')';
    parts.unshift(seg);
    node = node.parentElement;
  }
  return parts.join(' > ');
}
function hasOwnText(el) { return Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim()); }
// Text of an element with strike-throughs rendered as ~~text~~.
function readText(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('strike, s, del').forEach((s) => { s.replaceWith(doc.createTextNode('~~' + s.textContent + '~~')); });
  clone.querySelectorAll('[style*="line-through"]').forEach((s) => { s.replaceWith(doc.createTextNode('~~' + s.textContent + '~~')); });
  return clone.textContent.replace(/\s+/g, ' ').trim();
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
    originals[id] = { selector: cssPath(el), text: readText(el) };
  });
  // Re-apply edits saved from a previous visit.
  Object.keys(savedEdits).forEach((id) => { const el = doc.querySelector('[data-rv="' + id + '"]'); if (el) el.innerHTML = savedEdits[id]; });
}
function onPageLoad() {
  doc = iframe.contentDocument; win = iframe.contentWindow;
  const lift = doc.createElement('style'); lift.textContent = '.switcher{bottom:74px !important} html{scroll-behavior:auto !important}'; doc.head.appendChild(lift);
  indexPage();
  doc.addEventListener('input', () => {
    const changed = {};
    doc.querySelectorAll('[data-rv]').forEach((el) => { const id = el.getAttribute('data-rv'); if (originals[id] && readText(el) !== originals[id].text) changed[id] = el.innerHTML; });
    savedEdits = changed;
    try { localStorage.setItem(storeKey + ':edits', JSON.stringify(changed)); } catch (e) {}
    updateCount();
  });
  doc.addEventListener('keydown', onKey, true);
  win.addEventListener('scroll', syncCamera, { passive: true });
  // Inside the page, Tab would leave the frame; harmless. Links open in the frame, which is fine for review.
  setMode(body.dataset.mode);
  syncCamera();
  updateCount();
}
iframe.addEventListener('load', onPageLoad);

function edits() {
  if (!doc) return [];
  const out = [];
  const changed = Array.from(doc.querySelectorAll('[data-rv]')).filter((el) => { const o = originals[el.getAttribute('data-rv')]; return o && readText(el) !== o.text; });
  changed.forEach((el) => {
    if (changed.some((other) => other !== el && other.contains(el))) return;
    const o = originals[el.getAttribute('data-rv')];
    out.push({ selector: o.selector, before: o.text, after: readText(el) });
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
    const kind = shape.type === 'draw' ? (b.w > b.h * 4 && b.h < 40 ? 'underline' : 'scribble') : shape.type;
    return { id: shape.id, kind, text, bounds: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }, anchor: anchorFor(ax, ay) };
  }).filter(Boolean).sort((a, b) => a.bounds.y - b.bounds.y);
}
function syncCamera() {
  if (!editor || !win) return;
  editor.setCamera({ x: -win.scrollX, y: -win.scrollY, z: 1 }, { force: true, immediate: true });
}
function updateCount() {
  const n = (editor ? editor.getCurrentPageShapeIds().size : 0) + edits().length + (tldrText.value.trim() ? 1 : 0);
  $('#count').textContent = n;
}

const hidden = { PageMenu: null, NavigationPanel: null, MainMenu: null, HelpMenu: null, DebugMenu: null, DebugPanel: null, ActionsMenu: null, QuickActions: null, Minimap: null, ZoomMenu: null, SharePanel: null, TopPanel: null, Background: null, HelperButtons: null };

function App() {
  return React.createElement(Tldraw, {
    persistenceKey: storeKey,
    cameraOptions: { isLocked: true },
    components: hidden,
    onMount(ed) {
      editor = ed;
      ed.setCurrentTool('draw');
      ed.user.updateUserPreferences({ colorScheme: 'light' });
      ed.store.listen(() => updateCount(), { scope: 'document' });
      $('#loading').remove();
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
    d.edits.forEach((e) => L.push('- `' + e.selector + '`', '  - before: ' + e.before, '  - after: ' + e.after));
    L.push('');
  }
  if (d.marks.length) {
    L.push('## Marks on the page (' + d.marks.length + ', top to bottom)', '');
    d.marks.forEach((m, i) => {
      const where = m.anchor ? (m.anchor.exact ? 'on' : 'near') + ' `' + m.anchor.selector + '` ("' + m.anchor.text.slice(0, 60) + '")' : 'at y=' + m.bounds.y;
      L.push((i + 1) + '. ' + m.kind + (m.text ? ': "' + m.text + '"' : '') + ' ' + where);
    });
    L.push('');
  }
  if (!d.tldr && !d.edits.length && !d.marks.length) L.push('_No notes yet._');
  return L.join('\n');
}
function get() {
  return { url: targetUrl, mode: body.dataset.mode, tldr: tldrText.value.trim(), edits: edits(), marks: marks(), scrollY: win ? win.scrollY : 0 };
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
  try { localStorage.removeItem(storeKey + ':edits'); localStorage.removeItem(storeKey + ':tldr'); } catch (e) {}
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
  if (!d.tldr && !d.edits.length && !d.marks.length) { toast('Nothing to send yet'); return; }
  sending = true; const btn = $('#sendBtn'); btn.disabled = true; btn.firstChild.textContent = 'Sending';
  try {
    const image = await png();
    const res = await fetch(SEND_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: targetUrl, markdown: markdown(), json: d, png: image }) });
    if (!res.ok) throw new Error(res.status);
    const j = await res.json();
    toast('Sent to Claude: ' + (j.path || '').split('/').pop());
    try { localStorage.setItem(storeKey + ':sent', new Date().toISOString()); } catch (e) {}
  } catch (err) {
    toast('Send failed. Is the review server running? (' + err.message + ')');
  } finally {
    sending = false; btn.disabled = false; btn.firstChild.textContent = 'Send to Claude';
  }
}
$('#sendBtn').addEventListener('click', send);

window.__review = { get, markdown, png, send, clear: clearAll, setMode, scrollTo: (y) => win && win.scrollTo({ top: y, behavior: 'instant' }) };
try { const m = localStorage.getItem(storeKey + ':mode'); if (m) setMode(m); } catch (e) {}
