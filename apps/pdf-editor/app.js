/* PDF編集ソフト — 全処理クライアントサイド
 * 表示: pdf.js 3.11.174 / 書き出し: pdf-lib 1.17.1
 *
 * 座標系メモ:
 *   要素(テキスト/画像/矩形/ペン)は「表示座標」で保持する。
 *   表示座標 = 回転適用後のページを左上原点・下向きY・単位pt で表したもの。
 *   書き出し時は表示座標→PDFユーザー空間の変換行列(cm)を掛けてから描画する。
 */
'use strict';

(function () {
  if (!window.pdfjsLib || !window.PDFLib) {
    document.addEventListener('DOMContentLoaded', () => {
      alert('ライブラリ(pdf.js / pdf-lib)をCDNから読み込めませんでした。ネットワーク接続を確認してください。');
    });
    return;
  }

  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';

  const TEXT_FONT = '"Hiragino Sans","Hiragino Kaku Gothic ProN","Yu Gothic","Meiryo","Noto Sans JP","Noto Sans CJK JP",sans-serif';
  const LINE_HEIGHT = 1.25;
  const HIGHLIGHT_OPACITY = 0.35;
  const EXPORT_TEXT_SCALE = 4; // テキスト画像の解像度 (1pt あたり4px ≒ 288dpi)

  // ---------------- 状態 ----------------
  const state = {
    sources: [],      // {bytes: Uint8Array, doc: PDFDocumentProxy, name}
    pages: [],        // {id, src, index, baseRot, rot, view:[x0,y0,x1,y1], elements:[]}
    currentId: null,
    selected: new Set(),
    lastClickedId: null,
    selectedElId: null,
    tool: 'select',
    zoom: 1,
    baseName: 'document',
  };
  let nextId = 1;
  const uid = () => nextId++;

  const $ = (id) => document.getElementById(id);
  const viewer = $('viewer'), pageWrap = $('pageWrap'), pageCanvas = $('pageCanvas'), overlay = $('overlay');
  const thumbs = $('thumbs');

  // ---------------- ユーティリティ ----------------
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = isError ? 'error' : '';
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3000);
  }
  function busy(on, msg) {
    $('busyMsg').textContent = msg || '処理中…';
    $('busy').hidden = !on;
  }
  const totalRot = (p) => (((p.baseRot + p.rot) % 360) + 360) % 360;
  function displaySize(p) {
    const w = p.view[2] - p.view[0], h = p.view[3] - p.view[1];
    return totalRot(p) % 180 === 90 ? { w: h, h: w } : { w, h };
  }
  const getPage = (id) => state.pages.find((p) => p.id === id);
  const currentPage = () => getPage(state.currentId);
  function hexToRgb01(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function readFile(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(new Uint8Array(r.result));
      r.onerror = () => rej(r.error);
      r.readAsArrayBuffer(file);
    });
  }
  function download(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------------- テキスト描画（画面・書き出し共通） ----------------
  const measureCtx = document.createElement('canvas').getContext('2d');
  function textFont(sizePx) { return `${sizePx}px ${TEXT_FONT}`; }
  function layoutText(el) {
    const lines = (el.text || '').split('\n');
    measureCtx.font = textFont(el.fontSize);
    let maxW = 0;
    for (const ln of lines) maxW = Math.max(maxW, measureCtx.measureText(ln).width);
    const pad = el.fontSize * 0.15;
    const lh = el.fontSize * LINE_HEIGHT;
    el.w = Math.max(maxW, el.fontSize * 0.5) + pad * 2;
    el.h = lines.length * lh + pad * 2;
    return { lines, pad, lh };
  }
  /** scale: 1pt あたりのピクセル数 */
  function drawTextToCanvas(el, scale, canvas) {
    const { lines, pad, lh } = layoutText(el);
    canvas = canvas || document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(el.w * scale));
    canvas.height = Math.max(1, Math.ceil(el.h * scale));
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / el.w, canvas.height / el.h);
    ctx.font = textFont(el.fontSize);
    ctx.fillStyle = el.color;
    ctx.textBaseline = 'middle';
    lines.forEach((ln, i) => ctx.fillText(ln, pad, pad + lh * i + lh / 2));
    return canvas;
  }

  // ---------------- PDF 読み込み ----------------
  async function loadPdfFiles(files, append) {
    files = Array.from(files).filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!files.length) { toast('PDFファイルを選択してください', true); return; }
    busy(true, 'PDFを読み込み中…');
    try {
      if (!append) resetDocument();
      for (const f of files) {
        const bytes = await readFile(f);
        let doc;
        try {
          // pdf.js は渡したバッファを転送してしまうためコピーを渡す
          doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
        } catch (e) {
          toast(`「${f.name}」を開けませんでした: ${e.message}`, true);
          continue;
        }
        const srcIdx = state.sources.push({ bytes, doc, name: f.name }) - 1;
        if (state.pages.length === 0) {
          // 非ASCIIのファイル名はブラウザによってダウンロード名が「download」になるため英数字名にする
          const b = f.name.replace(/\.pdf$/i, '');
          state.baseName = /^[\x20-\x7e]+$/.test(b) ? b : 'document';
        }
        for (let i = 0; i < doc.numPages; i++) {
          const pg = await doc.getPage(i + 1);
          state.pages.push({
            id: uid(), src: srcIdx, index: i,
            baseRot: pg.rotate || 0, rot: 0,
            view: pg.view.slice(), elements: [],
          });
        }
      }
      if (!state.currentId && state.pages.length) state.currentId = state.pages[0].id;
      refreshAll(true);
      if (append && state.pages.length) toast('PDFを末尾に追加しました');
    } catch (e) {
      console.error(e);
      toast('読み込みに失敗しました: ' + e.message, true);
    } finally {
      busy(false);
    }
  }
  function resetDocument() {
    for (const s of state.sources) s.doc.destroy();
    for (const p of state.pages) for (const el of p.elements) if (el.url) URL.revokeObjectURL(el.url);
    state.sources = []; state.pages = [];
    state.currentId = null; state.selected.clear(); state.selectedElId = null; state.lastClickedId = null;
  }

  // ---------------- サムネイル ----------------
  const thumbCache = new Map(); // pageId -> {rot, canvas}
  async function renderThumbCanvas(p) {
    const key = totalRot(p);
    const cached = thumbCache.get(p.id);
    if (cached && cached.rot === key) return cached.canvas;
    const pg = await state.sources[p.src].doc.getPage(p.index + 1);
    const vp0 = pg.getViewport({ scale: 1, rotation: key });
    const scale = 150 / Math.max(vp0.width, vp0.height);
    const vp = pg.getViewport({ scale, rotation: key });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    thumbCache.set(p.id, { rot: key, canvas: c });
    return c;
  }
  function renderThumbs() {
    thumbs.innerHTML = '';
    $('pageCount').textContent = state.pages.length ? `${state.pages.length} ページ` : '';
    state.pages.forEach((p, i) => {
      const d = document.createElement('div');
      d.className = 'thumb';
      if (p.id === state.currentId) d.classList.add('current');
      if (state.selected.has(p.id)) d.classList.add('selected');
      d.draggable = true;
      d.dataset.id = p.id;
      const holder = document.createElement('div');
      holder.style.minHeight = '60px';
      d.appendChild(holder);
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = `${i + 1}`;
      d.appendChild(num);
      if (p.elements.length) {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = `編集 ${p.elements.length}`;
        d.appendChild(b);
      }
      renderThumbCanvas(p).then((c) => {
        const cc = document.createElement('canvas');
        cc.width = c.width; cc.height = c.height;
        cc.getContext('2d').drawImage(c, 0, 0);
        holder.replaceChildren(cc);
      }).catch((e) => console.error(e));
      thumbs.appendChild(d);
    });
    updateButtons();
  }
  thumbs.addEventListener('click', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    const id = +t.dataset.id;
    if (e.shiftKey && state.lastClickedId != null) {
      const a = state.pages.findIndex((p) => p.id === state.lastClickedId);
      const b = state.pages.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
      for (let i = lo; i <= hi; i++) state.selected.add(state.pages[i].id);
    } else if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      state.lastClickedId = id;
    } else {
      state.selected.clear(); state.selected.add(id);
      state.lastClickedId = id;
    }
    if (state.currentId !== id) { state.currentId = id; state.selectedElId = null; renderPage(); }
    renderThumbs();
  });

  // 並べ替え（HTML5 ドラッグ＆ドロップ）
  let dragId = null;
  thumbs.addEventListener('dragstart', (e) => {
    const t = e.target.closest('.thumb');
    if (!t) return;
    dragId = +t.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/x-page-id', String(dragId));
    t.classList.add('dragging');
  });
  thumbs.addEventListener('dragend', () => {
    dragId = null;
    thumbs.querySelectorAll('.thumb').forEach((t) => t.classList.remove('dragging', 'drop-before', 'drop-after'));
  });
  function dropPosition(e) {
    const t = e.target.closest('.thumb');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { el: t, id: +t.dataset.id, after: e.clientY > r.top + r.height / 2 };
  }
  thumbs.addEventListener('dragover', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    thumbs.querySelectorAll('.thumb').forEach((t) => t.classList.remove('drop-before', 'drop-after'));
    const pos = dropPosition(e);
    if (pos && pos.id !== dragId) pos.el.classList.add(pos.after ? 'drop-after' : 'drop-before');
  });
  thumbs.addEventListener('drop', (e) => {
    if (dragId == null) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = dropPosition(e);
    if (pos && pos.id !== dragId) movePage(dragId, pos.id, pos.after);
    dragId = null;
  });
  function movePage(id, targetId, after) {
    const from = state.pages.findIndex((p) => p.id === id);
    const [p] = state.pages.splice(from, 1);
    let to = state.pages.findIndex((q) => q.id === targetId);
    if (after) to++;
    state.pages.splice(to, 0, p);
    renderThumbs();
  }

  // ページ操作
  function targetPageIds() {
    if (state.selected.size) return state.pages.filter((p) => state.selected.has(p.id)).map((p) => p.id);
    return state.currentId ? [state.currentId] : [];
  }
  function rotatePages(delta) {
    for (const id of targetPageIds()) {
      const p = getPage(id);
      const old = displaySize(p);
      for (const el of p.elements) rotateElement(el, delta, old);
      p.rot = (p.rot + delta + 360) % 360;
    }
    renderThumbs();
    renderPage();
  }
  /** ページ回転時、要素がページ内容に追従するよう表示座標を変換する */
  function rotateElement(el, delta, old) {
    const tp = delta > 0
      ? (x, y) => [old.h - y, x]          // 時計回り90度
      : (x, y) => [y, old.w - x];         // 反時計回り90度
    if (el.type === 'pen') {
      const abs = el.points.map(([x, y]) => tp(el.x + x, el.y + y));
      setPenBounds(el, abs);
    } else if (el.type === 'whiteout' || el.type === 'highlight') {
      const [ax, ay] = tp(el.x, el.y), [bx, by] = tp(el.x + el.w, el.y + el.h);
      el.x = Math.min(ax, bx); el.y = Math.min(ay, by);
      el.w = Math.abs(bx - ax); el.h = Math.abs(by - ay);
    } else {
      // テキスト・画像は向きを保ったまま中心位置だけ追従させる
      const [cx, cy] = tp(el.x + el.w / 2, el.y + el.h / 2);
      el.x = cx - el.w / 2; el.y = cy - el.h / 2;
    }
  }
  function deletePages() {
    const ids = targetPageIds();
    if (!ids.length) return;
    if (!confirm(`${ids.length} ページを削除します。よろしいですか？`)) return;
    const idx = state.pages.findIndex((p) => p.id === ids[0]);
    state.pages = state.pages.filter((p) => !ids.includes(p.id));
    state.selected.clear();
    if (!getPage(state.currentId)) {
      const np = state.pages[Math.min(idx, state.pages.length - 1)];
      state.currentId = np ? np.id : null;
      state.selectedElId = null;
    }
    refreshAll(false);
  }
  $('btnRotL').onclick = () => rotatePages(-90);
  $('btnRotR').onclick = () => rotatePages(90);
  $('btnDelPages').onclick = deletePages;
  $('btnSelAll').onclick = () => { state.pages.forEach((p) => state.selected.add(p.id)); renderThumbs(); };
  $('btnExtract').onclick = async () => {
    const pages = state.pages.filter((p) => state.selected.has(p.id));
    if (!pages.length) { toast('抽出するページをサムネイルで選択してください', true); return; }
    await doExport(pages, `${state.baseName}_extract.pdf`);
  };
  $('btnSave').onclick = () => doExport(state.pages, `${state.baseName}_edited.pdf`);

  function updateButtons() {
    const has = state.pages.length > 0;
    $('btnSave').disabled = !has;
    for (const id of ['btnRotL', 'btnRotR', 'btnDelPages', 'btnSelAll']) $(id).disabled = !has;
    $('btnExtract').disabled = state.selected.size === 0;
    $('dropHint').hidden = has;
    pageWrap.hidden = !has;
  }

  // ---------------- 編集ページ表示 ----------------
  let renderTask = null, renderSeq = 0;
  async function renderPage() {
    const p = currentPage();
    renderOverlay();
    if (!p) return;
    const seq = ++renderSeq;
    const ds = displaySize(p);
    const dpr = window.devicePixelRatio || 1;
    pageWrap.style.width = ds.w * state.zoom + 'px';
    pageWrap.style.height = ds.h * state.zoom + 'px';
    $('zoomLabel').textContent = Math.round(state.zoom * 100) + '%';
    if (renderTask) { try { renderTask.cancel(); } catch (_) { /* ignore */ } }
    const pg = await state.sources[p.src].doc.getPage(p.index + 1);
    if (seq !== renderSeq) return;
    const vp = pg.getViewport({ scale: state.zoom * dpr, rotation: totalRot(p) });
    const off = document.createElement('canvas');
    off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
    renderTask = pg.render({ canvasContext: off.getContext('2d'), viewport: vp });
    try {
      await renderTask.promise;
    } catch (e) {
      if (e && e.name === 'RenderingCancelledException') return;
      console.error(e); return;
    }
    if (seq !== renderSeq) return;
    pageCanvas.width = off.width; pageCanvas.height = off.height;
    pageCanvas.style.width = ds.w * state.zoom + 'px';
    pageCanvas.style.height = ds.h * state.zoom + 'px';
    pageCanvas.getContext('2d').drawImage(off, 0, 0);
    pageWrap.dataset.rendered = String(p.id); // テスト用マーカー
  }
  function refreshAll(fit) {
    if (fit) fitWidth(false);
    renderThumbs();
    renderPage();
    updateProps();
  }

  // ズーム
  function setZoom(z) {
    state.zoom = Math.min(5, Math.max(0.25, z));
    renderPage();
  }
  function fitWidth(render = true) {
    const p = currentPage();
    if (!p) return;
    const avail = viewer.clientWidth - 40;
    state.zoom = Math.min(5, Math.max(0.25, avail / displaySize(p).w));
    if (render) renderPage();
  }
  $('zoomIn').onclick = () => setZoom(state.zoom * 1.25);
  $('zoomOut').onclick = () => setZoom(state.zoom / 1.25);
  $('zoomFit').onclick = () => fitWidth();

  // ---------------- 配置要素の表示 ----------------
  function elStyle(div, el) {
    const z = state.zoom;
    div.style.left = el.x * z + 'px';
    div.style.top = el.y * z + 'px';
    div.style.width = el.w * z + 'px';
    div.style.height = el.h * z + 'px';
  }
  function buildElementDom(el) {
    const div = document.createElement('div');
    div.className = 'el el-' + el.type;
    div.dataset.elId = el.id;
    if (el.id === state.selectedElId) div.classList.add('selected');
    const z = state.zoom, dpr = window.devicePixelRatio || 1;
    if (el.type === 'text') {
      div.appendChild(drawTextToCanvas(el, z * dpr));
    } else if (el.type === 'image') {
      const img = document.createElement('img');
      img.src = el.url; img.draggable = false;
      div.appendChild(img);
    } else if (el.type === 'whiteout') {
      div.style.background = '#ffffff';
    } else if (el.type === 'highlight') {
      div.style.background = el.color;
      div.style.opacity = HIGHLIGHT_OPACITY;
    } else if (el.type === 'pen') {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.setAttribute('viewBox', `0 0 ${el.w} ${el.h}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('points', el.points.map((pt) => pt.join(',')).join(' '));
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', el.color);
      pl.setAttribute('stroke-width', el.width);
      pl.setAttribute('stroke-linecap', 'round');
      pl.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(pl);
      div.appendChild(svg);
    }
    if (el.type === 'image' || el.type === 'whiteout' || el.type === 'highlight') {
      const h = document.createElement('div');
      h.className = 'handle';
      div.appendChild(h);
    }
    elStyle(div, el);
    return div;
  }
  function renderOverlay() {
    overlay.innerHTML = '';
    overlay.className = 'tool-' + state.tool;
    const p = currentPage();
    if (!p) return;
    for (const el of p.elements) overlay.appendChild(buildElementDom(el));
  }
  function selectedElement() {
    const p = currentPage();
    return p ? p.elements.find((e) => e.id === state.selectedElId) : null;
  }
  function selectElement(id) {
    state.selectedElId = id;
    overlay.querySelectorAll('.el').forEach((d) => d.classList.toggle('selected', +d.dataset.elId === id));
    updateProps();
  }
  function rerenderElement(el) {
    const old = overlay.querySelector(`[data-el-id="${el.id}"]`);
    const n = buildElementDom(el);
    if (old) old.replaceWith(n); else overlay.appendChild(n);
  }
  function deleteSelectedElement() {
    const p = currentPage();
    const el = selectedElement();
    if (!p || !el) return;
    p.elements = p.elements.filter((e) => e !== el);
    if (el.url) URL.revokeObjectURL(el.url);
    state.selectedElId = null;
    renderOverlay(); updateProps(); renderThumbs();
  }
  function addElement(el) {
    const p = currentPage();
    el.id = uid();
    p.elements.push(el);
    state.selectedElId = el.id;
    renderOverlay(); updateProps(); renderThumbs();
    return el;
  }
  function setPenBounds(el, absPts) {
    const pad = el.width / 2 + 1;
    const xs = absPts.map((p) => p[0]), ys = absPts.map((p) => p[1]);
    el.x = Math.min(...xs) - pad; el.y = Math.min(...ys) - pad;
    el.w = Math.max(...xs) - Math.min(...xs) + pad * 2;
    el.h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    el.points = absPts.map(([x, y]) => [x - el.x, y - el.y]);
  }

  // ---------------- ツール ----------------
  function setTool(t) {
    state.tool = t;
    document.querySelectorAll('.btn.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
    overlay.className = 'tool-' + t;
  }
  document.querySelectorAll('.btn.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });

  function pagePoint(e) {
    const r = overlay.getBoundingClientRect();
    return [(e.clientX - r.left) / state.zoom, (e.clientY - r.top) / state.zoom];
  }

  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    const p = currentPage();
    if (!p || e.button !== 0) return;
    const [x, y] = pagePoint(e);
    const elDiv = e.target.closest('.el');
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();

    if (state.tool === 'select') {
      if (!elDiv) { selectElement(null); return; }
      const el = p.elements.find((q) => q.id === +elDiv.dataset.elId);
      selectElement(el.id);
      if (e.target.classList.contains('handle')) {
        drag = { mode: 'resize', el, div: elDiv, sx: x, sy: y, ow: el.w, oh: el.h };
      } else {
        drag = { mode: 'move', el, div: elDiv, sx: x, sy: y, ox: el.x, oy: el.y };
      }
    } else if (state.tool === 'text') {
      const el = {
        type: 'text', x, y, text: 'テキスト',
        fontSize: +$('defFontSize').value || 16, color: $('defTextColor').value,
      };
      layoutText(el);
      el.y -= el.h / 2;
      addElement(el);
      setTool('select');
      const ta = $('pText'); ta.focus(); ta.select();
    } else if (state.tool === 'whiteout' || state.tool === 'highlight') {
      const d = document.createElement('div');
      d.className = 'draft';
      overlay.appendChild(d);
      drag = { mode: 'rect', sx: x, sy: y, x, y, draft: d };
    } else if (state.tool === 'pen') {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      const pl = document.createElementNS(ns, 'polyline');
      pl.setAttribute('fill', 'none');
      pl.setAttribute('stroke', $('defPenColor').value);
      pl.setAttribute('stroke-width', (+$('defPenWidth').value || 2) * state.zoom);
      pl.setAttribute('stroke-linecap', 'round');
      pl.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(pl);
      overlay.appendChild(svg);
      drag = { mode: 'pen', pts: [[x, y]], svg, pl };
      pl.setAttribute('points', `${x * state.zoom},${y * state.zoom}`);
    }
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const [x, y] = pagePoint(e);
    const ds = displaySize(currentPage());
    if (drag.mode === 'move') {
      const el = drag.el;
      el.x = Math.min(ds.w - 5, Math.max(5 - el.w, drag.ox + x - drag.sx));
      el.y = Math.min(ds.h - 5, Math.max(5 - el.h, drag.oy + y - drag.sy));
      elStyle(drag.div, el);
    } else if (drag.mode === 'resize') {
      const el = drag.el;
      let w = Math.max(5, drag.ow + x - drag.sx), h = Math.max(5, drag.oh + y - drag.sy);
      if (el.type === 'image') { // 縦横比を維持
        const ratio = drag.oh / drag.ow;
        if (w * ratio >= h) h = w * ratio; else w = h / ratio;
      }
      el.w = w; el.h = h;
      elStyle(drag.div, el);
    } else if (drag.mode === 'rect') {
      drag.x = x; drag.y = y;
      const z = state.zoom, d = drag.draft;
      d.style.left = Math.min(x, drag.sx) * z + 'px';
      d.style.top = Math.min(y, drag.sy) * z + 'px';
      d.style.width = Math.abs(x - drag.sx) * z + 'px';
      d.style.height = Math.abs(y - drag.sy) * z + 'px';
      d.style.background = state.tool === 'whiteout' ? 'rgba(255,255,255,.9)' : $('defHlColor').value;
      d.style.opacity = state.tool === 'whiteout' ? 1 : HIGHLIGHT_OPACITY;
    } else if (drag.mode === 'pen') {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of (evs.length ? evs : [e])) drag.pts.push(pagePoint(ev));
      drag.pl.setAttribute('points', drag.pts.map(([px, py]) => `${px * state.zoom},${py * state.zoom}`).join(' '));
    }
  });
  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.mode === 'rect') {
      d.draft.remove();
      const x = Math.min(d.x, d.sx), y = Math.min(d.y, d.sy);
      const w = Math.abs(d.x - d.sx), h = Math.abs(d.y - d.sy);
      if (w < 3 || h < 3) return;
      addElement(state.tool === 'whiteout'
        ? { type: 'whiteout', x, y, w, h, color: '#ffffff' }
        : { type: 'highlight', x, y, w, h, color: $('defHlColor').value });
    } else if (d.mode === 'pen') {
      d.svg.remove();
      const el = { type: 'pen', color: $('defPenColor').value, width: +$('defPenWidth').value || 2 };
      setPenBounds(el, d.pts);
      addElement(el);
    } else {
      updateProps();
    }
  }
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);
  overlay.addEventListener('dblclick', (e) => {
    const elDiv = e.target.closest('.el-text');
    if (elDiv) { const ta = $('pText'); ta.focus(); ta.select(); }
  });

  // 画像追加
  $('fileImage').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!currentPage()) { toast('先にPDFを開いてください', true); return; }
    const bytes = await readFile(f);
    let mime = null;
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) mime = 'image/png';
    else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
    if (!mime) { toast('PNGまたはJPEG画像を選択してください', true); return; }
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const img = new Image();
    try {
      await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('画像を読み込めません')); img.src = url; });
    } catch (err) { URL.revokeObjectURL(url); toast(err.message, true); return; }
    const ds = displaySize(currentPage());
    let w = img.naturalWidth * 0.75, h = img.naturalHeight * 0.75; // px → pt (96dpi想定)
    const maxW = ds.w * 0.5, maxH = ds.h * 0.5;
    const s = Math.min(1, maxW / w, maxH / h);
    w *= s; h *= s;
    addElement({ type: 'image', x: (ds.w - w) / 2, y: (ds.h - h) / 2, w, h, bytes, mime, url });
    setTool('select');
  });

  // ---------------- プロパティパネル ----------------
  const TYPE_NAMES = { text: 'テキスト', image: '画像', whiteout: '白塗り矩形', highlight: 'ハイライト', pen: 'ペン描画' };
  function updateProps() {
    const el = selectedElement();
    $('propsDefault').hidden = !!el;
    $('propsElement').hidden = !el;
    if (!el) return;
    $('propsType').textContent = TYPE_NAMES[el.type];
    document.querySelectorAll('#propsElement [data-for]').forEach((d) => {
      d.hidden = !d.dataset.for.split(' ').includes(el.type);
    });
    if (el.type === 'text') {
      if (document.activeElement !== $('pText')) $('pText').value = el.text;
      if (document.activeElement !== $('pFontSize')) $('pFontSize').value = el.fontSize;
    }
    if (el.color) $('pColor').value = el.color;
    if (el.type === 'pen') $('pWidth').value = el.width;
  }
  $('pText').addEventListener('input', (e) => {
    const el = selectedElement();
    if (el && el.type === 'text') { el.text = e.target.value; rerenderElement(el); }
  });
  $('pFontSize').addEventListener('input', (e) => {
    const el = selectedElement();
    const v = +e.target.value;
    if (el && el.type === 'text' && v >= 4 && v <= 300) { el.fontSize = v; rerenderElement(el); }
  });
  $('pColor').addEventListener('input', (e) => {
    const el = selectedElement();
    if (el && el.color) { el.color = e.target.value; rerenderElement(el); }
  });
  $('pWidth').addEventListener('input', (e) => {
    const el = selectedElement();
    const v = +e.target.value;
    if (el && el.type === 'pen' && v > 0) {
      const abs = el.points.map(([x, y]) => [x + el.x, y + el.y]);
      el.width = v; setPenBounds(el, abs); rerenderElement(el);
    }
  });
  $('btnDelEl').onclick = deleteSelectedElement;

  // キーボード
  document.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedElId != null) { e.preventDefault(); deleteSelectedElement(); }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const map = { v: 'select', t: 'text', w: 'whiteout', h: 'highlight', p: 'pen' };
      if (map[e.key.toLowerCase()]) setTool(map[e.key.toLowerCase()]);
    }
  });

  // ---------------- ファイル入力・ドラッグ＆ドロップ ----------------
  $('fileOpen').addEventListener('change', (e) => { const f = e.target.files; if (f.length) loadPdfFiles(f, false); e.target.value = ''; });
  $('fileAppend').addEventListener('change', (e) => { const f = e.target.files; if (f.length) loadPdfFiles(f, true); e.target.value = ''; });
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    viewer.classList.add('dragover');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.target === viewer || !e.relatedTarget) viewer.classList.remove('dragover');
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    viewer.classList.remove('dragover');
    // 既にPDFが開かれていれば末尾に追加（結合）、なければ新規に開く
    loadPdfFiles(e.dataTransfer.files, state.pages.length > 0);
  });

  // ---------------- 書き出し ----------------
  /** 表示座標(左下原点・上向きY)→PDFユーザー空間 の変換行列 */
  function displayToUserMatrix(p) {
    const [x0, y0, x1, y1] = p.view;
    switch (totalRot(p)) {
      case 90: return [0, 1, -1, 0, x1, y0];
      case 180: return [-1, 0, 0, -1, x1, y1];
      case 270: return [0, -1, 1, 0, x0, y1];
      default: return [1, 0, 0, 1, x0, y0];
    }
  }
  async function canvasToPngBytes(canvas) {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function buildPdf(pages) {
    const {
      PDFDocument, degrees, rgb, pushGraphicsState, popGraphicsState, concatTransformationMatrix,
      setStrokingRgbColor, setLineWidth, setLineCap, setLineJoin, moveTo, lineTo, stroke,
      LineCapStyle, LineJoinStyle,
    } = PDFLib;
    const out = await PDFDocument.create();

    // 元PDFごとにまとめてページをコピー（フォント等の共有リソースの重複を避ける）
    const srcDocs = new Map();
    const copied = new Map(); // page.id -> PDFPage
    for (const p of pages) if (!srcDocs.has(p.src)) srcDocs.set(p.src, null);
    for (const src of srcDocs.keys()) {
      const sdoc = await PDFDocument.load(state.sources[src].bytes, { ignoreEncryption: true });
      const list = pages.filter((p) => p.src === src);
      const cps = await out.copyPages(sdoc, list.map((p) => p.index));
      list.forEach((p, i) => copied.set(p.id, cps[i]));
    }

    for (const p of pages) {
      const page = out.addPage(copied.get(p.id));
      page.setRotation(degrees(totalRot(p)));
      if (!p.elements.length) continue;
      const H = displaySize(p).h;
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...displayToUserMatrix(p)));
      for (const el of p.elements) {
        const by = H - el.y - el.h; // 下端のY（上向き座標）
        if (el.type === 'whiteout' || el.type === 'highlight') {
          const [r, g, b] = hexToRgb01(el.color);
          page.drawRectangle({
            x: el.x, y: by, width: el.w, height: el.h, color: rgb(r, g, b),
            opacity: el.type === 'highlight' ? HIGHLIGHT_OPACITY : 1, borderWidth: 0,
          });
        } else if (el.type === 'image') {
          const img = el.mime === 'image/png' ? await out.embedPng(el.bytes) : await out.embedJpg(el.bytes);
          page.drawImage(img, { x: el.x, y: by, width: el.w, height: el.h });
        } else if (el.type === 'text') {
          // 日本語対応のため、キャンバスで描画したテキストをPNG画像として埋め込む
          let scale = EXPORT_TEXT_SCALE;
          const maxSide = 8000;
          scale = Math.min(scale, maxSide / el.w, maxSide / el.h);
          const c = drawTextToCanvas(el, scale);
          const img = await out.embedPng(await canvasToPngBytes(c));
          page.drawImage(img, { x: el.x, y: by, width: el.w, height: el.h });
        } else if (el.type === 'pen') {
          const [r, g, b] = hexToRgb01(el.color);
          const pts = el.points.map(([x, y]) => [el.x + x, H - (el.y + y)]);
          const ops = [pushGraphicsState(), setStrokingRgbColor(r, g, b), setLineWidth(el.width),
            setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round), moveTo(pts[0][0], pts[0][1])];
          if (pts.length === 1) ops.push(lineTo(pts[0][0], pts[0][1]));
          for (let i = 1; i < pts.length; i++) ops.push(lineTo(pts[i][0], pts[i][1]));
          ops.push(stroke(), popGraphicsState());
          page.pushOperators(...ops);
        }
      }
      page.pushOperators(popGraphicsState());
    }
    return out.save();
  }

  async function doExport(pages, filename) {
    if (!pages.length) return;
    busy(true, 'PDFを書き出し中…');
    try {
      const bytes = await buildPdf(pages);
      window.__lastExport = bytes; // 動作確認用
      download(bytes, filename);
      toast(`保存しました（${pages.length} ページ）`);
    } catch (e) {
      console.error(e);
      toast('書き出しに失敗しました: ' + e.message, true);
    } finally {
      busy(false);
    }
  }

  // テスト・デバッグ用に内部状態を公開
  window.__pdfEditor = { state, buildPdf, loadPdfFiles, addElement, selectElement, setTool, rotatePages, movePage };

  updateButtons();
})();
