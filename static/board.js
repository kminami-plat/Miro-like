/* Board editor: infinite canvas with realtime sync. Exposes window.BoardEditor(container, opts). */
(function () {
  'use strict';

  const STICKY_COLORS = ['#fff176', '#ffd54f', '#ffab91', '#f8bbd0', '#ce93d8', '#90caf9', '#80deea', '#a5d6a7', '#dce775', '#e0e0e0', '#ffffff'];
  const INK_COLORS = ['#1c1f2b', '#e5484d', '#f76b15', '#f5b301', '#12a150', '#0090ff', '#3d5afe', '#8e4ec6', '#8b8d98'];
  const SHAPE_FILLS = ['#ffffff', '#fff9c4', '#ffe0b2', '#f8bbd0', '#e1bee7', '#bbdefb', '#b2ebf2', '#c8e6c9', '#f5f5f5', 'transparent'];
  const FRAME_FILLS = ['rgba(255,255,255,.55)', 'rgba(255,241,118,.25)', 'rgba(144,202,249,.25)', 'rgba(165,214,167,.25)', 'rgba(248,187,208,.25)', 'rgba(206,147,216,.25)', 'rgba(224,224,224,.4)'];
  const GRID = 20;
  const MIN_SCALE = 0.05, MAX_SCALE = 6;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const h = (tag, attrs, html) => { const e = document.createElement(tag); if (attrs) for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]); } if (html != null) e.innerHTML = html; return e; };
  const svgEl = (tag, attrs) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
  const throttle = (fn, ms) => { let t = 0, pend = null, timer = null; return (...a) => { const now = Date.now(); if (now - t >= ms) { t = now; fn(...a); } else { pend = a; clearTimeout(timer); timer = setTimeout(() => { t = Date.now(); timer = null; fn(...pend); }, ms - (now - t)); } }; };

  const ICONS = {
    select: '<svg viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z"/></svg>',
    hand: '<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 013 0V12M11 6a1.5 1.5 0 013 0v6M14 7.5a1.5 1.5 0 013 0V13M17 10.5a1.5 1.5 0 013 0V16a6 6 0 01-6 6h-2a6 6 0 01-5-2.7L4.3 15.6a1.5 1.5 0 012.5-1.6L8 15.5"/></svg>',
    sticky: '<svg viewBox="0 0 24 24"><path d="M4 5a1 1 0 011-1h14a1 1 0 011 1v9l-6 6H5a1 1 0 01-1-1z"/><path d="M14 20v-6h6"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M5 6V4h14v2M12 4v16M9 20h6"/></svg>',
    shape: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="9" height="9" rx="1.5"/><circle cx="16" cy="16" r="4.5"/></svg>',
    frame: '<svg viewBox="0 0 24 24"><path d="M6 3v18M18 3v18M3 6h18M3 18h18"/></svg>',
    line: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M5 19L19 5M10 5h9v9"/></svg>',
    pen: '<svg viewBox="0 0 24 24"><path d="M4 20c4-1 3-5 6-8s6-6 8-4-1 5-4 8-7 2-8 6"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
    dup: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>',
    front: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="12" height="12" rx="2"/><path d="M15 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h4"/></svg>',
    back: '<svg viewBox="0 0 24 24"><rect x="3" y="9" width="12" height="12" rx="2"/><path d="M9 9V5a2 2 0 012-2h8a2 2 0 012 2v8a2 2 0 01-2 2h-4"/></svg>',
    bold: '<svg viewBox="0 0 24 24"><path d="M7 4h6a4 4 0 010 8H7zM7 12h7a4 4 0 010 8H7z"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>',
    unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 017.5-2"/></svg>',
  };

  window.BoardEditor = function BoardEditor(container, opts) {
    const state = {
      boardId: opts.boardId,
      board: opts.initial.board,
      perm: opts.initial.permission,
      me: opts.initial.me,
      members: opts.initial.members || [],
      items: new Map(),
      els: new Map(),
      view: { x: 0, y: 0, s: 1 },
      tool: 'select',
      shapeKind: 'rect',
      selection: new Set(),
      undo: [], redo: [],
      clipboard: null,
      lastStickyColor: STICKY_COLORS[0],
      lastInk: INK_COLORS[0],
      presence: [],
      cursors: new Map(),
      remoteSel: new Map(),
      editing: null,
      ws: null, connected: false, myConn: null,
      spaceDown: false,
      pointers: new Map(),
      names: new Map(),
    };
    for (const m of state.members) state.names.set(m.id, m.display_name);
    const canEdit = () => state.perm === 'edit' || state.perm === 'owner';

    // ------------------------------------------------------------ DOM
    container.innerHTML = '';
    const root = h('div', { class: 'board-view' });
    const canvas = h('div', { id: 'canvas' });
    const world = h('div', { id: 'world' });
    const htmlLayer = h('div', { id: 'html-layer' });
    const svgLayer = svgEl('svg', { id: 'svg-layer' });
    const defs = svgEl('defs');
    svgLayer.appendChild(defs);
    world.append(htmlLayer, svgLayer);
    const overlay = h('div', { id: 'overlay' });
    canvas.append(world);
    root.append(canvas, overlay);

    // top bar
    const top = h('div', { class: 'board-top' });
    const leftPanel = h('div', { class: 'panel' });
    const backBtn = h('button', { class: 'btn ghost icon', title: 'Back to boards' }, '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>');
    backBtn.onclick = () => opts.onBack && opts.onBack();
    const nameEl = h('div', { class: 'board-name', contenteditable: canEdit() ? 'true' : 'false', spellcheck: 'false' });
    nameEl.textContent = state.board.name;
    nameEl.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } if (e.key === 'Escape') { nameEl.textContent = state.board.name; nameEl.blur(); } };
    nameEl.onblur = () => { const n = nameEl.textContent.trim(); if (n && n !== state.board.name) opts.onRename && opts.onRename(n); else nameEl.textContent = state.board.name; };
    const statusDot = h('span', { class: 'status-dot', title: 'Connecting…' });
    leftPanel.append(backBtn, nameEl, statusDot);
    const menuBtn = h('button', { class: 'btn ghost icon', title: 'Board menu' }, '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>');
    menuBtn.onclick = (e) => { e.stopPropagation(); showBoardMenu(menuBtn); };
    leftPanel.append(menuBtn);
    const spacer = h('div', { class: 'grow', style: 'pointer-events:none' });
    const rightPanel = h('div', { class: 'panel' });
    const presenceEl = h('div', { class: 'presence' });
    const shareBtn = h('button', { class: 'btn primary sm' }, 'Share');
    shareBtn.onclick = () => opts.onShare && opts.onShare();
    rightPanel.append(presenceEl, shareBtn);
    top.append(leftPanel, spacer, rightPanel);

    // toolbar
    const toolbar = h('div', { class: 'panel toolbar' });
    const TOOLS = [
      ['select', 'Select', 'V'], ['hand', 'Pan', 'H'], null,
      ['sticky', 'Sticky note', 'N'], ['text', 'Text', 'T'], ['shape', 'Shape', 'S'], ['frame', 'Frame', 'F'], null,
      ['line', 'Line', 'L'], ['arrow', 'Arrow', 'A'], ['pen', 'Pen', 'P'],
    ];
    const toolBtns = {};
    for (const t of TOOLS) {
      if (!t) { toolbar.append(h('div', { class: 'sep' })); continue; }
      const b = h('button', { class: 'tool', 'data-tip': `${t[1]} (${t[2]})` }, ICONS[t[0]] + `<span class="kbd">${t[2]}</span>`);
      b.onclick = () => setTool(t[0]);
      toolBtns[t[0]] = b;
      toolbar.append(b);
    }
    const zoombar = h('div', { class: 'panel zoombar' });
    const zoomOut = h('button', { title: 'Zoom out (−)' }, '−');
    const zoomLabel = h('button', { title: 'Reset zoom (Ctrl+0)' }, '100%');
    const zoomIn = h('button', { title: 'Zoom in (+)' }, '+');
    const fitBtn = h('button', { title: 'Fit to content (Shift+1)' }, '⤢');
    zoomOut.onclick = () => zoomBy(1 / 1.25);
    zoomIn.onclick = () => zoomBy(1.25);
    zoomLabel.onclick = () => setView({ s: 1 });
    fitBtn.onclick = fitToContent;
    zoombar.append(zoomOut, zoomLabel, zoomIn, fitBtn);
    const hint = h('div', { class: 'hint hidden' });
    const viewOnly = h('div', { class: 'viewonly hidden' }, 'View only — ask the board owner for edit access');
    const propbar = h('div', { class: 'panel propbar hidden' });
    root.append(top, toolbar, zoombar, hint, viewOnly, propbar);
    container.append(root);

    // ------------------------------------------------------------ view
    const toWorld = (sx, sy) => ({ x: (sx - state.view.x) / state.view.s, y: (sy - state.view.y) / state.view.s });
    const toScreen = (wx, wy) => ({ x: wx * state.view.s + state.view.x, y: wy * state.view.s + state.view.y });

    function applyView() {
      const { x, y, s } = state.view;
      world.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
      const g = GRID * s;
      canvas.style.backgroundSize = `${g}px ${g}px`;
      canvas.style.backgroundPosition = `${x}px ${y}px`;
      canvas.style.backgroundImage = s < 0.35 ? 'none' : '';
      zoomLabel.textContent = Math.round(s * 100) + '%';
      renderSelection();
      renderCursors();
      renderRemoteSelections();
      positionPropbar();
      try { localStorage.setItem('wb_view_' + state.boardId, JSON.stringify(state.view)); } catch (_) {}
    }
    function setView(v) {
      if (v.s != null) {
        const ns = clamp(v.s, MIN_SCALE, MAX_SCALE);
        const cx = v.cx ?? canvas.clientWidth / 2, cy = v.cy ?? canvas.clientHeight / 2;
        const w = toWorld(cx, cy);
        state.view.s = ns;
        state.view.x = cx - w.x * ns;
        state.view.y = cy - w.y * ns;
      }
      if (v.x != null) state.view.x = v.x;
      if (v.y != null) state.view.y = v.y;
      applyView();
    }
    function zoomBy(f, cx, cy) { setView({ s: state.view.s * f, cx, cy }); }
    function fitToContent() {
      const bb = itemsBBox([...state.items.values()]);
      if (!bb) { setView({ x: canvas.clientWidth / 2, y: canvas.clientHeight / 2, s: 1 }); return; }
      fitBBox(bb);
    }
    function fitBBox(bb, pad = 80) {
      const W = canvas.clientWidth, H = canvas.clientHeight;
      const s = clamp(Math.min((W - pad * 2) / Math.max(bb.w, 1), (H - pad * 2) / Math.max(bb.h, 1)), MIN_SCALE, 1.5);
      state.view.s = s;
      state.view.x = W / 2 - (bb.x + bb.w / 2) * s;
      state.view.y = H / 2 - (bb.y + bb.h / 2) * s;
      applyView();
    }
    function itemBBox(it) { return { x: it.x, y: it.y, w: it.w, h: it.h }; }
    function itemsBBox(list) {
      if (!list.length) return null;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const it of list) { x1 = Math.min(x1, it.x); y1 = Math.min(y1, it.y); x2 = Math.max(x2, it.x + it.w); y2 = Math.max(y2, it.y + it.h); }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    // ------------------------------------------------------------ rendering items
    function maxZ() { let z = 0; for (const it of state.items.values()) if (it.type !== 'frame') z = Math.max(z, it.z || 0); return z; }
    function minZ() { let z = 0; for (const it of state.items.values()) z = Math.min(z, it.z || 0); return z; }

    function renderItem(it) {
      let el = state.els.get(it.id);
      const isSvg = it.type === 'line' || it.type === 'draw';
      if (el && (el.dataset.type !== it.type)) { el.remove(); el = null; }
      if (!el) {
        el = isSvg ? svgEl('g', { class: 'item-svg' }) : h('div', { class: 'item' });
        el.dataset.id = it.id; el.dataset.type = it.type;
        if (isSvg) svgLayer.appendChild(el); else htmlLayer.appendChild(el);
        state.els.set(it.id, el);
        if (!isSvg) buildHtmlItem(el, it);
      }
      if (isSvg) renderSvgItem(el, it); else updateHtmlItem(el, it);
      el.classList.toggle('selected', state.selection.has(it.id));
      el.classList.toggle('locked', !!it.props.locked);
    }

    function buildHtmlItem(el, it) {
      el.className = 'item ' + it.type;
      if (it.type === 'sticky' || it.type === 'text') {
        el.append(h('div', { class: 'txt', 'data-ph': it.type === 'sticky' ? 'Type here' : 'Text' }));
        if (it.type === 'sticky') el.append(h('div', { class: 'author' }));
      } else if (it.type === 'shape') {
        const s = svgEl('svg', { class: 'shape-bg', viewBox: '0 0 100 100', preserveAspectRatio: 'none' });
        el.append(s, h('div', { class: 'txt', 'data-ph': '' }));
      } else if (it.type === 'frame') {
        el.append(h('div', { class: 'frame-hit' }), h('div', { class: 'frame-title', spellcheck: 'false' }));
      }
    }

    function updateHtmlItem(el, it) {
      const p = it.props || {};
      el.style.transform = `translate(${it.x}px, ${it.y}px)` + (it.rotation ? ` rotate(${it.rotation}deg)` : '');
      el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
      el.style.zIndex = it.type === 'frame' ? (-1000000 + (it.z || 0)) : (it.z || 0);
      const editingThis = state.editing && state.editing.id === it.id;
      if (it.type === 'sticky') {
        el.style.background = p.color || STICKY_COLORS[0];
        const t = el.querySelector('.txt');
        if (!editingThis && t.innerText !== (p.text || '')) t.innerText = p.text || '';
        t.style.textAlign = p.align || 'center';
        t.style.fontWeight = p.bold ? '700' : '500';
        fitText(t, p.fontSize || 0, it);
        const a = el.querySelector('.author'); if (a) a.textContent = nameOf(it.created_by);
      } else if (it.type === 'text') {
        const t = el.querySelector('.txt');
        if (!editingThis && t.innerText !== (p.text || '')) t.innerText = p.text || '';
        t.style.fontSize = (p.fontSize || 20) + 'px';
        t.style.color = p.color || INK_COLORS[0];
        t.style.fontWeight = p.bold ? '700' : '500';
        t.style.textAlign = p.align || 'left';
      } else if (it.type === 'shape') {
        const svg = el.querySelector('.shape-bg');
        svg.innerHTML = shapePath(p.kind || 'rect', p.fill || '#fff', p.stroke || INK_COLORS[0], it);
        const t = el.querySelector('.txt');
        if (!editingThis && t.innerText !== (p.text || '')) t.innerText = p.text || '';
        t.style.color = p.color || INK_COLORS[0];
        t.style.fontWeight = p.bold ? '700' : '500';
        fitText(t, p.fontSize || 0, it);
      } else if (it.type === 'frame') {
        el.style.background = p.fill || FRAME_FILLS[0];
        const t = el.querySelector('.frame-title');
        if (!editingThis && t.innerText !== (p.title || '')) t.innerText = p.title || '';
      }
    }

    function shapePath(kind, fill, stroke, it) {
      // Non-scaling stroke via vector-effect; coordinates in a 0-100 box stretched to item size.
      const common = `fill="${fill}" stroke="${stroke}" stroke-width="2" vector-effect="non-scaling-stroke"`;
      if (kind === 'ellipse') return `<ellipse cx="50" cy="50" rx="49" ry="49" ${common}/>`;
      if (kind === 'diamond') return `<polygon points="50,1 99,50 50,99 1,50" ${common}/>`;
      if (kind === 'triangle') return `<polygon points="50,1 99,99 1,99" ${common}/>`;
      if (kind === 'round') { const rx = 12 * 100 / Math.max(it.w, 1), ry = 12 * 100 / Math.max(it.h, 1); return `<rect x="1" y="1" width="98" height="98" rx="${rx}" ry="${ry}" ${common}/>`; }
      return `<rect x="1" y="1" width="98" height="98" ${common}/>`;
    }

    function fitText(t, fixed, it) {
      if (fixed) { t.style.fontSize = fixed + 'px'; return; }
      // auto-fit: choose the largest size (<= 48, based on box) where text fits.
      const base = clamp(Math.min(it.w, it.h) / 6, 12, 48);
      let size = base;
      t.style.fontSize = size + 'px';
      let guard = 0;
      while (t.scrollHeight > t.clientHeight + 1 && size > 9 && guard++ < 30) { size -= size > 20 ? 2 : 1; t.style.fontSize = size + 'px'; }
    }

    function renderSvgItem(g, it) {
      const p = it.props || {};
      const pts = (p.points || []).map(([px, py]) => [it.x + px, it.y + py]);
      if (pts.length < 2) { g.innerHTML = ''; return; }
      const stroke = p.stroke || INK_COLORS[0], width = p.width || 3;
      let d;
      if (it.type === 'draw') {
        d = smoothPath(pts);
      } else {
        d = `M${pts[0][0]} ${pts[0][1]} L${pts[pts.length - 1][0]} ${pts[pts.length - 1][1]}`;
      }
      let vis = g.querySelector('.vis'), hit = g.querySelector('.stroke-hit');
      if (!vis) { vis = svgEl('path', { class: 'vis', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); hit = svgEl('path', { class: 'stroke-hit', 'stroke-linecap': 'round' }); g.append(vis, hit); }
      vis.setAttribute('d', d); hit.setAttribute('d', d);
      vis.setAttribute('stroke', stroke); vis.setAttribute('stroke-width', width);
      vis.setAttribute('stroke-dasharray', p.dashed ? `${width * 3} ${width * 2.5}` : 'none');
      hit.setAttribute('stroke-width', Math.max(14 / state.view.s, width + 8));
      if (it.type === 'line' && p.arrow) {
        const mid = 'arrow-' + it.id;
        let m = defs.querySelector('#' + mid);
        if (!m) { m = svgEl('marker', { id: mid, markerWidth: '10', markerHeight: '10', refX: '8', refY: '5', orient: 'auto', markerUnits: 'strokeWidth', viewBox: '0 0 10 10' }); m.appendChild(svgEl('path', { d: 'M0 0.5 L9 5 L0 9.5 z' })); defs.appendChild(m); }
        m.firstChild.setAttribute('fill', stroke);
        vis.setAttribute('marker-end', `url(#${mid})`);
        if (p.arrowStart) {
          const sid = 'arrows-' + it.id; let ms = defs.querySelector('#' + sid);
          if (!ms) { ms = svgEl('marker', { id: sid, markerWidth: '10', markerHeight: '10', refX: '2', refY: '5', orient: 'auto-start-reverse', markerUnits: 'strokeWidth', viewBox: '0 0 10 10' }); ms.appendChild(svgEl('path', { d: 'M0 0.5 L9 5 L0 9.5 z' })); defs.appendChild(ms); }
          ms.firstChild.setAttribute('fill', stroke); vis.setAttribute('marker-start', `url(#${sid})`);
        } else vis.removeAttribute('marker-start');
      } else { vis.removeAttribute('marker-end'); vis.removeAttribute('marker-start'); }
      g.style.opacity = '1';
    }
    function smoothPath(pts) {
      if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;
      let d = `M${pts[0][0]} ${pts[0][1]}`;
      for (let i = 1; i < pts.length - 1; i++) { const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2; d += ` Q${pts[i][0]} ${pts[i][1]} ${mx} ${my}`; }
      const l = pts[pts.length - 1]; d += ` L${l[0]} ${l[1]}`;
      return d;
    }
    function sortSvg() {
      const gs = [...svgLayer.querySelectorAll('g.item-svg')].sort((a, b) => (state.items.get(a.dataset.id)?.z || 0) - (state.items.get(b.dataset.id)?.z || 0));
      for (const g of gs) svgLayer.appendChild(g);
    }
    function removeItemEl(id) { const el = state.els.get(id); if (el) el.remove(); state.els.delete(id); defs.querySelector('#arrow-' + id)?.remove(); defs.querySelector('#arrows-' + id)?.remove(); }
    function nameOf(id) { if (!id) return ''; if (state.names.has(id)) return state.names.get(id); const p = state.presence.find((u) => u.id === id); if (p) { state.names.set(id, p.display_name); return p.display_name; } return String(id).startsWith('guest_') ? 'Guest' : ''; }

    function renderAll() {
      for (const el of state.els.values()) el.remove();
      state.els.clear();
      for (const it of [...state.items.values()].sort((a, b) => (a.z || 0) - (b.z || 0))) renderItem(it);
      renderSelection();
    }

    // ------------------------------------------------------------ ops (local apply + network + undo)
    function applyOps(ops) {
      let zChanged = false;
      for (const op of ops) {
        if (op.a === 'delete') {
          for (const id of op.ids) { state.items.delete(id); removeItemEl(id); state.selection.delete(id); if (state.editing && state.editing.id === id) stopEditing(false); }
        } else if (op.a === 'create' || op.a === 'update') {
          const prev = state.items.get(op.item.id);
          const it = { ...op.item, props: { ...(op.item.props || {}) } };
          state.items.set(it.id, it);
          if (!prev || prev.z !== it.z || prev.type !== it.type) zChanged = true;
          renderItem(it);
        }
      }
      if (zChanged) sortSvg();
      renderSelection();
      positionPropbar();
    }
    function send(msg) { if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(msg)); }
    function sendOps(ops) { if (!ops.length) return; send({ t: 'op', ops }); }
    const snapshot = (it) => JSON.parse(JSON.stringify(it));

    // commit: apply ops locally, send them, and push an undo entry
    function commit(ops, undoOps) {
      if (!canEdit()) return;
      applyOps(ops); sendOps(ops);
      state.undo.push({ ops, undo: undoOps }); if (state.undo.length > 200) state.undo.shift();
      state.redo = [];
    }
    function createItems(items) {
      const ops = items.map((it) => ({ a: 'create', item: it }));
      commit(ops, [{ a: 'delete', ids: items.map((i) => i.id) }]);
    }
    function deleteItems(ids) {
      ids = ids.filter((id) => state.items.has(id) && !state.items.get(id).props.locked);
      if (!ids.length) return;
      const undo = ids.map((id) => ({ a: 'create', item: snapshot(state.items.get(id)) }));
      commit([{ a: 'delete', ids }], undo);
      state.selection.clear(); syncSelection();
    }
    // updateItems(fn) : fn(itemCopy) mutates; commits update with undo snapshots
    function updateItems(ids, fn, opt = {}) {
      const ops = [], undo = [];
      for (const id of ids) {
        const cur = state.items.get(id); if (!cur) continue;
        if (cur.props.locked && !opt.allowLocked) continue;
        const before = snapshot(cur), after = snapshot(cur);
        fn(after, before);
        ops.push({ a: 'update', item: after }); undo.push({ a: 'update', item: before });
      }
      if (ops.length) commit(ops, undo);
    }
    function doUndo() { const e = state.undo.pop(); if (!e) return; applyOps(e.undo); sendOps(e.undo); state.redo.push(e); syncSelection(); }
    function doRedo() { const e = state.redo.pop(); if (!e) return; applyOps(e.ops); sendOps(e.ops); state.undo.push(e); syncSelection(); }

    // ------------------------------------------------------------ item factories
    function newBase(type, x, y, w, h) { return { id: uid(), type, x, y, w, h, rotation: 0, z: type === 'frame' ? minZ() - 1 : maxZ() + 1, props: {}, created_by: state.me.id }; }
    function makeSticky(x, y) { const it = newBase('sticky', x - 100, y - 100, 200, 200); it.props = { text: '', color: state.lastStickyColor }; return it; }
    function makeText(x, y) { const it = newBase('text', x, y - 16, 240, 40); it.props = { text: '', fontSize: 20, color: state.lastInk }; return it; }
    function makeShape(x, y, w, h) { const it = newBase('shape', x, y, w, h); it.props = { kind: state.shapeKind, fill: '#ffffff', stroke: INK_COLORS[0], text: '' }; return it; }
    function makeFrame(x, y, w, h) { const it = newBase('frame', x, y, w, h); it.props = { title: 'Frame ' + (1 + [...state.items.values()].filter((i) => i.type === 'frame').length), fill: FRAME_FILLS[0] }; return it; }
    function makeLine(p1, p2, arrow) {
      const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
      const it = newBase('line', x, y, Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y));
      it.props = { points: [[p1.x - x, p1.y - y], [p2.x - x, p2.y - y]], stroke: state.lastInk, width: 3, arrow: !!arrow };
      return it;
    }
    function makeDraw(pts) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [px, py] of pts) { x1 = Math.min(x1, px); y1 = Math.min(y1, py); x2 = Math.max(x2, px); y2 = Math.max(y2, py); }
      const it = newBase('draw', x1, y1, x2 - x1, y2 - y1);
      it.props = { points: pts.map(([px, py]) => [px - x1, py - y1]), stroke: state.lastInk, width: 3 };
      return it;
    }

    // ------------------------------------------------------------ selection
    function syncSelection() {
      for (const [id, el] of state.els) el.classList.toggle('selected', state.selection.has(id));
      renderSelection(); renderPropbar();
      send({ t: 'select', ids: [...state.selection] });
    }
    function select(ids, additive) { if (!additive) state.selection.clear(); for (const id of ids) state.selection.add(id); syncSelection(); }
    function selectedItems() { return [...state.selection].map((id) => state.items.get(id)).filter(Boolean); }

    let selLayer = h('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    let remoteLayer = h('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    let cursorLayer = h('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    overlay.append(remoteLayer, selLayer, cursorLayer);

    function renderSelection() {
      selLayer.innerHTML = '';
      const items = selectedItems();
      if (!items.length) return;
      const s = state.view.s;
      for (const it of items) {
        const sc = toScreen(it.x, it.y);
        const box = h('div', { class: 'sel-box', style: `left:${sc.x}px;top:${sc.y}px;width:${it.w * s}px;height:${it.h * s}px` });
        if (it.props.locked) box.style.borderStyle = 'dotted';
        selLayer.append(box);
      }
      if (!canEdit()) return;
      if (items.length === 1) {
        const it = items[0];
        if (it.props.locked) return;
        if (it.type === 'line') {
          const pts = it.props.points || [];
          pts.forEach((pt, i) => {
            const sc = toScreen(it.x + pt[0], it.y + pt[1]);
            const hd = h('div', { class: 'handle pt', style: `left:${sc.x}px;top:${sc.y}px;pointer-events:auto` });
            hd.dataset.handle = 'pt' + i; hd.dataset.id = it.id;
            selLayer.append(hd);
          });
          return;
        }
        const sc = toScreen(it.x, it.y), W = it.w * s, H = it.h * s;
        for (const [k, dx, dy] of [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]) {
          const hd = h('div', { class: 'handle ' + k, style: `left:${sc.x + dx * W}px;top:${sc.y + dy * H}px;pointer-events:auto` });
          hd.dataset.handle = k; hd.dataset.id = it.id;
          selLayer.append(hd);
        }
      } else {
        const bb = itemsBBox(items); const sc = toScreen(bb.x, bb.y);
        const box = h('div', { class: 'sel-box', style: `left:${sc.x - 3}px;top:${sc.y - 3}px;width:${bb.w * s + 6}px;height:${bb.h * s + 6}px;border-style:dashed;opacity:.6` });
        selLayer.append(box);
      }
    }

    function renderRemoteSelections() {
      remoteLayer.innerHTML = '';
      const s = state.view.s;
      for (const [conn, sel] of state.remoteSel) {
        if (conn === state.myConn) continue;
        const items = sel.ids.map((id) => state.items.get(id)).filter(Boolean);
        if (!items.length) continue;
        const bb = itemsBBox(items); const sc = toScreen(bb.x, bb.y);
        const box = h('div', { class: 'sel-box remote', style: `left:${sc.x - 2}px;top:${sc.y - 2}px;width:${bb.w * s + 4}px;height:${bb.h * s + 4}px;border-color:${sel.user.color}` });
        box.append(h('div', { class: 'label', style: `background:${sel.user.color}` }, esc(sel.user.display_name)));
        remoteLayer.append(box);
      }
    }

    function renderCursors() {
      for (const [conn, c] of state.cursors) {
        if (!c.el) {
          c.el = h('div', { class: 'cursor' }, `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M5 3l14 8-6 2-3 6z" fill="${c.user.color}" stroke="#fff" stroke-width="1.5"/></svg><div class="name" style="background:${c.user.color}">${esc(c.user.display_name)}</div>`);
          cursorLayer.append(c.el);
        }
        if (!c.cursor) { c.el.style.display = 'none'; continue; }
        c.el.style.display = '';
        const sc = toScreen(c.cursor.x, c.cursor.y);
        c.el.style.transform = `translate(${sc.x}px, ${sc.y}px)`;
      }
    }
    function renderPresence() {
      presenceEl.innerHTML = '';
      const seen = new Map();
      for (const u of state.presence) { if (!seen.has(u.id)) seen.set(u.id, { ...u, n: 0 }); seen.get(u.id).n++; }
      const list = [...seen.values()];
      list.slice(0, 8).forEach((u) => {
        const a = h('div', { class: 'avatar', style: `background:${u.color}`, title: `${u.display_name}${u.guest ? ' (guest)' : ''} · ${u.perm === 'view' ? 'viewer' : u.perm}${u.conn === state.myConn ? ' (you)' : ''}` }, esc(initials(u.display_name)));
        if (u.conn !== state.myConn) { a.style.cursor = 'pointer'; a.onclick = () => { const c = state.cursors.get(u.conn); if (c && c.cursor) setView({ x: canvas.clientWidth / 2 - c.cursor.x * state.view.s, y: canvas.clientHeight / 2 - c.cursor.y * state.view.s }); }; }
        presenceEl.append(a);
      });
      if (list.length > 8) presenceEl.append(h('div', { class: 'avatar', style: 'background:#8b8d98' }, '+' + (list.length - 8)));
    }
    const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('');

    // ------------------------------------------------------------ property bar
    function renderPropbar() {
      const items = selectedItems();
      if (!items.length || !canEdit()) { propbar.classList.add('hidden'); return; }
      propbar.classList.remove('hidden');
      propbar.innerHTML = '';
      const ids = items.map((i) => i.id);
      const types = new Set(items.map((i) => i.type));
      const only = (t) => types.size === 1 && types.has(t);
      const allLocked = items.every((i) => i.props.locked);
      const sw = (color, active, onclick, title) => { const b = h('button', { class: 'sw' + (active ? ' active' : ''), style: `background:${color === 'transparent' ? 'repeating-conic-gradient(#ddd 0 25%, #fff 0 50%) 0 0/8px 8px' : color};${color === '#ffffff' || color === 'transparent' ? 'box-shadow:inset 0 0 0 1px #ddd' : ''}`, title: title || '' }); b.onclick = onclick; return b; };
      const pb = (html, onclick, title, active) => { const b = h('button', { class: 'pb' + (active ? ' active' : ''), title: title || '' }, html); b.onclick = onclick; return b; };
      const sep = () => h('div', { class: 'sep' });
      if (allLocked) {
        propbar.append(pb(ICONS.unlock, () => updateItems(ids, (it) => { delete it.props.locked; }, { allowLocked: true }), 'Unlock'));
        positionPropbar(); return;
      }
      const first = items[0];
      if (only('sticky')) {
        for (const c of STICKY_COLORS) propbar.append(sw(c, first.props.color === c, () => { state.lastStickyColor = c; updateItems(ids, (it) => { it.props.color = c; }); }));
        propbar.append(sep());
        const sizes = [['A', 0, 'Auto size'], ['S', 14, 'Small'], ['M', 20, 'Medium'], ['L', 28, 'Large']];
        for (const [l, v, t] of sizes) propbar.append(pb(l, () => updateItems(ids, (it) => { it.props.fontSize = v; }), t, (first.props.fontSize || 0) === v));
        propbar.append(pb(ICONS.bold, () => updateItems(ids, (it) => { it.props.bold = !first.props.bold; }), 'Bold', first.props.bold));
        propbar.append(sep());
      } else if (only('text')) {
        for (const c of INK_COLORS) propbar.append(sw(c, first.props.color === c, () => { state.lastInk = c; updateItems(ids, (it) => { it.props.color = c; }); }));
        propbar.append(sep());
        const sel = h('select'); for (const v of [12, 14, 16, 20, 24, 32, 40, 56, 72, 96]) sel.append(h('option', { value: v }, v + 'px'));
        sel.value = first.props.fontSize || 20;
        sel.onchange = () => updateItems(ids, (it) => { it.props.fontSize = +sel.value; });
        propbar.append(sel, pb(ICONS.bold, () => updateItems(ids, (it) => { it.props.bold = !first.props.bold; }), 'Bold', first.props.bold));
        for (const [al, ch] of [['left', '≡'], ['center', '☰'], ['right', '≡']]) propbar.append(pb(ch, () => updateItems(ids, (it) => { it.props.align = al; }), 'Align ' + al, (first.props.align || 'left') === al));
        propbar.append(sep());
      } else if (only('shape')) {
        for (const [k, l] of [['rect', '▭'], ['round', '▢'], ['ellipse', '◯'], ['diamond', '◇'], ['triangle', '△']]) propbar.append(pb(l, () => { state.shapeKind = k; updateItems(ids, (it) => { it.props.kind = k; }); }, k, (first.props.kind || 'rect') === k));
        propbar.append(sep());
        for (const c of SHAPE_FILLS) propbar.append(sw(c, first.props.fill === c, () => updateItems(ids, (it) => { it.props.fill = c; }), 'Fill'));
        propbar.append(sep());
        for (const c of INK_COLORS.slice(0, 6)) propbar.append(sw(c, first.props.stroke === c, () => updateItems(ids, (it) => { it.props.stroke = c; it.props.color = c; }), 'Border'));
        propbar.append(sep());
      } else if (only('frame')) {
        for (const c of FRAME_FILLS) propbar.append(sw(c.replace(/,[.\d]+\)$/, ',.7)'), first.props.fill === c, () => updateItems(ids, (it) => { it.props.fill = c; })));
        propbar.append(sep());
      } else if (types.size && [...types].every((t) => t === 'line' || t === 'draw')) {
        for (const c of INK_COLORS) propbar.append(sw(c, first.props.stroke === c, () => { state.lastInk = c; updateItems(ids, (it) => { it.props.stroke = c; }); }));
        propbar.append(sep());
        for (const [l, v] of [['thin', 2], ['med', 4], ['thick', 8]]) propbar.append(pb(`<span style="display:inline-block;width:18px;height:${v}px;background:currentColor;border-radius:2px;vertical-align:middle"></span>`, () => updateItems(ids, (it) => { it.props.width = v; }), l, (first.props.width || 3) === v));
        propbar.append(pb('- -', () => updateItems(ids, (it) => { it.props.dashed = !first.props.dashed; }), 'Dashed', first.props.dashed));
        if (only('line')) {
          propbar.append(pb('→', () => updateItems(ids, (it) => { it.props.arrow = !first.props.arrow; }), 'Arrow head', first.props.arrow));
          propbar.append(pb('↔', () => updateItems(ids, (it) => { it.props.arrow = true; it.props.arrowStart = !first.props.arrowStart; }), 'Both ends', first.props.arrowStart));
        }
        propbar.append(sep());
      }
      propbar.append(pb(ICONS.dup, () => duplicateSelection(), 'Duplicate (Ctrl+D)'));
      propbar.append(pb(ICONS.front, () => { const z = maxZ(); updateItems(ids, (it, b) => { it.z = z + 1 + ids.indexOf(it.id); }); }, 'Bring to front (])'));
      propbar.append(pb(ICONS.back, () => { const z = minZ(); updateItems(ids, (it) => { it.z = z - 1 - ids.indexOf(it.id); }); }, 'Send to back ([)'));
      propbar.append(pb(ICONS.lock, () => updateItems(ids, (it) => { it.props.locked = true; }), 'Lock'));
      propbar.append(pb(ICONS.trash, () => deleteItems(ids), 'Delete (Del)'));
      positionPropbar();
    }
    function positionPropbar() {
      if (propbar.classList.contains('hidden')) return;
      const items = selectedItems(); if (!items.length) return;
      const bb = itemsBBox(items); const sc = toScreen(bb.x, bb.y);
      const w = propbar.offsetWidth || 300;
      const cx = clamp(sc.x + bb.w * state.view.s / 2, w / 2 + 8, canvas.clientWidth - w / 2 - 8);
      const ty = clamp(sc.y, 120, canvas.clientHeight - 20);
      propbar.style.left = cx + 'px'; propbar.style.top = ty + 'px';
    }

    // ------------------------------------------------------------ tools
    function setTool(t) {
      if (!canEdit() && t !== 'select' && t !== 'hand') return;
      state.tool = t;
      for (const k in toolBtns) toolBtns[k].classList.toggle('active', k === t);
      canvas.className = 'tool-' + t;
      const hints = { sticky: 'Click to place a sticky note · Esc to cancel', text: 'Click to add text', shape: 'Drag to draw a shape (click for default size)', frame: 'Drag to draw a frame — items inside move with it', line: 'Drag to draw a line', arrow: 'Drag to draw an arrow', pen: 'Draw freehand', hand: 'Drag to pan · Scroll to move · Ctrl+scroll to zoom' };
      hint.textContent = hints[t] || ''; hint.classList.toggle('hidden', !hints[t]);
      if (t !== 'select') { state.selection.clear(); syncSelection(); }
    }

    // ------------------------------------------------------------ text editing
    function startEditing(it, selectAll) {
      if (!canEdit() || it.props.locked) return;
      if (state.editing && state.editing.id !== it.id) stopEditing(true);
      const el = state.els.get(it.id); if (!el) return;
      const t = el.querySelector(it.type === 'frame' ? '.frame-title' : '.txt'); if (!t) return;
      state.editing = { id: it.id, el: t, start: snapshot(it) };
      t.contentEditable = 'true';
      t.focus();
      const range = document.createRange(); range.selectNodeContents(t); if (!selectAll) range.collapse(false);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      t.oninput = () => {
        const cur = state.items.get(it.id); if (!cur) return;
        if (it.type === 'frame') cur.props.title = t.innerText.replace(/\n/g, ' ');
        else cur.props.text = t.innerText;
        if (it.type === 'sticky' || it.type === 'shape') fitText(t, cur.props.fontSize || 0, cur);
        if (it.type === 'text') autoGrowText(cur, t);
        liveSend(cur);
      };
      t.onkeydown = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); stopEditing(true); }
        if (e.key === 'Enter' && (it.type === 'frame' || e.metaKey || e.ctrlKey)) { e.preventDefault(); stopEditing(true); }
        if (e.key === 'Tab') { e.preventDefault(); stopEditing(true); }
        e.stopPropagation();
      };
      t.onblur = () => { if (state.editing && state.editing.id === it.id) stopEditing(true); };
      t.onpaste = (e) => { e.preventDefault(); const txt = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, txt); };
    }
    function autoGrowText(cur, t) {
      // Text boxes grow vertically with their content.
      const el = state.els.get(cur.id);
      const needed = t.scrollHeight;
      if (needed > cur.h) { cur.h = needed; el.style.height = cur.h + 'px'; renderSelection(); }
    }
    function stopEditing(commitChange) {
      const ed = state.editing; if (!ed) return;
      state.editing = null;
      const t = ed.el; t.contentEditable = 'false'; t.oninput = t.onkeydown = t.onblur = t.onpaste = null;
      window.getSelection()?.removeAllRanges();
      const cur = state.items.get(ed.id); if (!cur) return;
      const after = snapshot(cur);
      if (cur.type === 'text' && !(cur.props.text || '').trim()) {
        // Empty text box: remove it (undo entry only if it existed before editing).
        applyOps([{ a: 'delete', ids: [cur.id] }]); sendOps([{ a: 'delete', ids: [cur.id] }]);
        state.selection.delete(cur.id); syncSelection();
        // drop the create entry from undo if it was created just now
        const last = state.undo[state.undo.length - 1];
        if (last && last.ops.length === 1 && last.ops[0].a === 'create' && last.ops[0].item.id === cur.id) state.undo.pop();
        return;
      }
      if (commitChange && JSON.stringify(after) !== JSON.stringify(ed.start)) {
        sendOps([{ a: 'update', item: after }]);
        state.undo.push({ ops: [{ a: 'update', item: after }], undo: [{ a: 'update', item: ed.start }] }); state.redo = [];
      }
      renderItem(cur);
    }
    const liveSend = throttle((it) => sendOps([{ a: 'update', item: snapshot(it) }]), 80);
    const liveSendMany = throttle((items) => sendOps(items.map((it) => ({ a: 'update', item: snapshot(it) }))), 50);
    const sendCursor = throttle((x, y) => send({ t: 'cursor', x, y }), 50);

    // ------------------------------------------------------------ pointer interaction
    let drag = null; // current gesture
    let rubberEl = null;

    canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); const t = e.target.closest('.item, .item-svg'); if (t) { if (!state.selection.has(t.dataset.id)) select([t.dataset.id]); showContextMenu(e.clientX, e.clientY); } });
    canvas.addEventListener('dblclick', (e) => {
      const t = e.target.closest('.item, .item-svg');
      if (t) {
        const it = state.items.get(t.dataset.id); if (!it) return;
        if (it.type === 'sticky' || it.type === 'text' || it.type === 'shape' || it.type === 'frame') { select([it.id]); startEditing(it, false); }
        return;
      }
      if (state.tool === 'select' && canEdit()) {
        const w = toWorld(e.clientX, e.clientY);
        const it = makeSticky(w.x, w.y); createItems([it]); select([it.id]); startEditing(it, false);
      }
    });

    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    overlay.addEventListener('pointerdown', onDown);

    function onDown(e) {
      if (e.target.closest('.panel, .menu, .modal-backdrop')) return;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (state.pointers.size === 2) { // pinch start
        const [a, b] = [...state.pointers.values()];
        drag = { mode: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...state.view } };
        return;
      }
      if (e.button === 2) return;
      const handle = e.target.closest('.handle');
      const itemEl = e.target.closest('.item, .item-svg');
      const w = toWorld(e.clientX, e.clientY);
      if (state.editing) {
        if (itemEl && itemEl.dataset.id === state.editing.id && e.target.isContentEditable) return; // let the browser handle caret
        stopEditing(true);
      }
      if (!(itemEl && e.target.isContentEditable)) e.preventDefault(); // keep focus where it is; no native text selection
      if (e.button === 1 || state.spaceDown || state.tool === 'hand') {
        drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, vx: state.view.x, vy: state.view.y };
        canvas.classList.add('panning'); e.preventDefault(); return;
      }
      if (!canEdit() && state.tool !== 'select') return;

      if (state.tool === 'select') {
        if (handle && canEdit()) {
          const it = state.items.get(handle.dataset.id);
          drag = { mode: 'resize', handle: handle.dataset.handle, it, start: snapshot(it), sw: w };
          return;
        }
        if (itemEl) {
          const id = itemEl.dataset.id; const it = state.items.get(id);
          if (!it) return;
          if (e.shiftKey) { if (state.selection.has(id)) state.selection.delete(id); else state.selection.add(id); syncSelection(); }
          else if (!state.selection.has(id)) select([id]);
          if (!canEdit()) return;
          // moving set: selection + items contained in selected frames
          const moving = new Map();
          for (const sid of state.selection) {
            const si = state.items.get(sid); if (!si || si.props.locked) continue;
            moving.set(sid, snapshot(si));
            if (si.type === 'frame') for (const o of state.items.values()) {
              if (o.type !== 'frame' && !o.props.locked && o.x + o.w / 2 >= si.x && o.x + o.w / 2 <= si.x + si.w && o.y + o.h / 2 >= si.y && o.y + o.h / 2 <= si.y + si.h) moving.set(o.id, snapshot(o));
            }
          }
          drag = { mode: 'move', sw: w, moving, moved: false };
          return;
        }
        drag = { mode: 'rubber', sw: w, sx: e.clientX, sy: e.clientY, additive: e.shiftKey };
        if (!e.shiftKey && state.selection.size) { state.selection.clear(); syncSelection(); }
        return;
      }
      if (state.tool === 'sticky') { e.preventDefault(); const it = makeSticky(snap(w.x), snap(w.y)); createItems([it]); select([it.id]); setTool('select'); drag = { mode: 'edit-after', it }; return; }
      if (state.tool === 'text') { e.preventDefault(); const it = makeText(w.x, w.y); createItems([it]); select([it.id]); setTool('select'); drag = { mode: 'edit-after', it }; return; }
      if (state.tool === 'shape' || state.tool === 'frame' || state.tool === 'line' || state.tool === 'arrow') { drag = { mode: 'create', tool: state.tool, sw: w, temp: null }; return; }
      if (state.tool === 'pen') { drag = { mode: 'pen', pts: [[w.x, w.y]], temp: null }; return; }
    }

    function snap(v) { return v; }

    function onMove(e) {
      if (state.pointers.has(e.pointerId)) state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const w = toWorld(e.clientX, e.clientY);
      if (!drag || drag.mode !== 'pinch') sendCursor(Math.round(w.x), Math.round(w.y));
      if (!drag) return;
      switch (drag.mode) {
        case 'pinch': {
          if (state.pointers.size < 2) return;
          const [a, b] = [...state.pointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y), mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const f = dist / drag.dist;
          const ns = clamp(drag.view.s * f, MIN_SCALE, MAX_SCALE);
          const wm = { x: (drag.mid.x - drag.view.x) / drag.view.s, y: (drag.mid.y - drag.view.y) / drag.view.s };
          state.view.s = ns; state.view.x = mid.x - wm.x * ns; state.view.y = mid.y - wm.y * ns;
          applyView(); return;
        }
        case 'pan': setView({ x: drag.vx + e.clientX - drag.sx, y: drag.vy + e.clientY - drag.sy }); return;
        case 'move': {
          const dx = w.x - drag.sw.x, dy = w.y - drag.sw.y;
          if (!drag.moved && Math.hypot(dx * state.view.s, dy * state.view.s) < 3) return;
          drag.moved = true;
          const changed = [];
          for (const [id, start] of drag.moving) { const it = state.items.get(id); if (!it) continue; it.x = start.x + dx; it.y = start.y + dy; renderItem(it); changed.push(it); }
          renderSelection(); positionPropbar(); liveSendMany(changed); return;
        }
        case 'resize': {
          const it = drag.it, st = drag.start;
          if (drag.handle.startsWith('pt')) {
            const i = +drag.handle.slice(2);
            const abs = st.props.points.map(([px, py]) => [st.x + px, st.y + py]);
            abs[i] = [w.x, w.y];
            const x = Math.min(...abs.map((p) => p[0])), y = Math.min(...abs.map((p) => p[1]));
            it.x = x; it.y = y; it.w = Math.max(...abs.map((p) => p[0])) - x; it.h = Math.max(...abs.map((p) => p[1])) - y;
            it.props.points = abs.map(([px, py]) => [px - x, py - y]);
          } else {
            let x1 = st.x, y1 = st.y, x2 = st.x + st.w, y2 = st.y + st.h;
            if (drag.handle.includes('w')) x1 = Math.min(w.x, x2 - 20); if (drag.handle.includes('e')) x2 = Math.max(w.x, x1 + 20);
            if (drag.handle.includes('n')) y1 = Math.min(w.y, y2 - 20); if (drag.handle.includes('s')) y2 = Math.max(w.y, y1 + 20);
            if (e.shiftKey || (it.type === 'sticky' && !e.altKey)) { // keep aspect ratio
              const ar = st.w / st.h; let nw = x2 - x1, nh = y2 - y1;
              if (nw / nh > ar) nw = nh * ar; else nh = nw / ar;
              if (drag.handle.includes('w')) x1 = x2 - nw; else x2 = x1 + nw;
              if (drag.handle.includes('n')) y1 = y2 - nh; else y2 = y1 + nh;
            }
            it.x = x1; it.y = y1; it.w = x2 - x1; it.h = y2 - y1;
            if (it.type === 'draw' && st.props.points) { const fx = it.w / Math.max(st.w, 0.001), fy = it.h / Math.max(st.h, 0.001); it.props.points = st.props.points.map(([px, py]) => [px * fx, py * fy]); }
          }
          renderItem(it); renderSelection(); positionPropbar(); liveSend(it); return;
        }
        case 'rubber': {
          if (!rubberEl) { rubberEl = h('div', { class: 'rubber' }); overlay.append(rubberEl); }
          const x = Math.min(e.clientX, drag.sx), y = Math.min(e.clientY, drag.sy);
          rubberEl.style.cssText = `left:${x}px;top:${y}px;width:${Math.abs(e.clientX - drag.sx)}px;height:${Math.abs(e.clientY - drag.sy)}px`;
          const a = toWorld(x, y), b = toWorld(x + Math.abs(e.clientX - drag.sx), y + Math.abs(e.clientY - drag.sy));
          const hits = [];
          for (const it of state.items.values()) if (it.x < b.x && it.x + it.w > a.x && it.y < b.y && it.y + it.h > a.y) hits.push(it.id);
          state.selection = new Set(drag.additive ? [...(drag.base || (drag.base = [...state.selection])), ...hits] : hits);
          for (const [id, el] of state.els) el.classList.toggle('selected', state.selection.has(id));
          renderSelection(); return;
        }
        case 'create': {
          const a = drag.sw;
          if (Math.hypot((w.x - a.x) * state.view.s, (w.y - a.y) * state.view.s) < 4) return;
          let it;
          if (drag.tool === 'line' || drag.tool === 'arrow') it = makeLine(a, w, drag.tool === 'arrow');
          else { const x = Math.min(a.x, w.x), y = Math.min(a.y, w.y), ww = Math.abs(w.x - a.x), hh = Math.abs(w.y - a.y); it = drag.tool === 'frame' ? makeFrame(x, y, ww, hh) : makeShape(x, y, ww, hh); }
          if (drag.temp) { it.id = drag.temp.id; it.z = drag.temp.z; if (drag.tool === 'frame') it.props.title = drag.temp.props.title; }
          drag.temp = it; state.items.set(it.id, it); renderItem(it); return;
        }
        case 'pen': {
          const last = drag.pts[drag.pts.length - 1];
          if (Math.hypot(w.x - last[0], w.y - last[1]) < 1.5 / state.view.s) return;
          drag.pts.push([w.x, w.y]);
          const it = makeDraw(drag.pts); if (drag.temp) { it.id = drag.temp.id; it.z = drag.temp.z; }
          drag.temp = it; state.items.set(it.id, it); renderItem(it); return;
        }
      }
    }

    function onUp(e) {
      state.pointers.delete(e.pointerId);
      if (!drag) return;
      const d = drag;
      if (d.mode === 'pinch') { if (state.pointers.size === 0) drag = null; return; }
      drag = null;
      canvas.classList.remove('panning');
      if (rubberEl) { rubberEl.remove(); rubberEl = null; }
      const w = toWorld(e.clientX, e.clientY);
      switch (d.mode) {
        case 'edit-after': startEditing(d.it, false); return;
        case 'move': {
          if (!d.moved) return;
          const ops = [], undo = [];
          for (const [id, start] of d.moving) { const it = state.items.get(id); if (!it) continue; ops.push({ a: 'update', item: snapshot(it) }); undo.push({ a: 'update', item: start }); }
          sendOps(ops); state.undo.push({ ops, undo }); state.redo = [];
          return;
        }
        case 'resize': {
          const it = d.it; const after = snapshot(it);
          if (JSON.stringify(after) === JSON.stringify(d.start)) return;
          if (it.type === 'sticky' || it.type === 'shape') renderItem(it);
          sendOps([{ a: 'update', item: after }]); state.undo.push({ ops: [{ a: 'update', item: after }], undo: [{ a: 'update', item: d.start }] }); state.redo = [];
          return;
        }
        case 'rubber': syncSelection(); return;
        case 'create': {
          let it = d.temp;
          if (!it) { // click without drag: default size
            const a = d.sw;
            if (d.tool === 'line' || d.tool === 'arrow') it = makeLine(a, { x: a.x + 200, y: a.y }, d.tool === 'arrow');
            else if (d.tool === 'frame') it = makeFrame(a.x, a.y, 600, 400);
            else it = makeShape(a.x - 80, a.y - 60, 160, 120);
          } else { state.items.delete(it.id); removeItemEl(it.id); }
          createItems([it]); select([it.id]);
          if (!e.shiftKey) setTool('select');
          if (d.tool === 'frame') startEditing(it, true);
          return;
        }
        case 'pen': {
          const it = d.temp; if (!it) return;
          state.items.delete(it.id); removeItemEl(it.id);
          createItems([it]);
          return;
        }
      }
    }

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025));
        zoomBy(f, e.clientX, e.clientY);
      } else {
        const k = e.deltaMode === 1 ? 20 : 1;
        setView({ x: state.view.x - e.deltaX * k, y: state.view.y - e.deltaY * k });
      }
    }, { passive: false });
    canvas.addEventListener('pointerleave', () => send({ t: 'cursor', x: null, y: null }));

    // ------------------------------------------------------------ keyboard
    function onKey(e) {
      const inEdit = document.activeElement && (document.activeElement.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName));
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === ' ' && !inEdit) { if (!state.spaceDown) { state.spaceDown = true; canvas.classList.add('panning'); } e.preventDefault(); return; }
      if (inEdit) return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if (mod && k === 'y') { e.preventDefault(); doRedo(); return; }
      if (mod && k === 'a') { e.preventDefault(); select([...state.items.keys()]); return; }
      if (mod && k === 'c') { e.preventDefault(); copySelection(); return; }
      if (mod && k === 'x') { e.preventDefault(); copySelection(); deleteItems([...state.selection]); return; }
      if (mod && k === 'v') { e.preventDefault(); pasteClipboard(); return; }
      if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); return; }
      if (mod && (k === '=' || k === '+')) { e.preventDefault(); zoomBy(1.25); return; }
      if (mod && k === '-') { e.preventDefault(); zoomBy(1 / 1.25); return; }
      if (mod && k === '0') { e.preventDefault(); setView({ s: 1 }); return; }
      if (mod) return;
      if (e.shiftKey && e.key === '!') { fitToContent(); return; }
      if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteItems([...state.selection]); return; }
      if (k === 'escape') { if (state.tool !== 'select') setTool('select'); else { state.selection.clear(); syncSelection(); } closeMenus(); return; }
      if (k === 'enter' && state.selection.size === 1) { const it = selectedItems()[0]; if (['sticky', 'text', 'shape', 'frame'].includes(it.type)) { e.preventDefault(); startEditing(it, false); } return; }
      if (k.startsWith('arrow') && state.selection.size) {
        e.preventDefault(); const step = e.shiftKey ? 10 : 1;
        const dx = k === 'arrowleft' ? -step : k === 'arrowright' ? step : 0, dy = k === 'arrowup' ? -step : k === 'arrowdown' ? step : 0;
        updateItems([...state.selection], (it) => { it.x += dx; it.y += dy; }); return;
      }
      if (k === ']' && state.selection.size) { const z = maxZ(); updateItems([...state.selection], (it) => { it.z = z + 1; }); return; }
      if (k === '[' && state.selection.size) { const z = minZ(); updateItems([...state.selection], (it) => { it.z = z - 1; }); return; }
      const map = { v: 'select', h: 'hand', n: 'sticky', t: 'text', s: 'shape', f: 'frame', l: 'line', a: 'arrow', p: 'pen' };
      if (map[k]) { setTool(map[k]); return; }
      if (k === '+' || k === '=') zoomBy(1.25); if (k === '-') zoomBy(1 / 1.25);
    }
    function onKeyUp(e) { if (e.key === ' ') { state.spaceDown = false; if (!drag) canvas.classList.remove('panning'); } }
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);

    function copySelection() { const items = selectedItems(); if (!items.length) return; state.clipboard = items.map(snapshot); toast(`Copied ${items.length} item${items.length > 1 ? 's' : ''}`); }
    function pasteClipboard() {
      if (!state.clipboard || !state.clipboard.length || !canEdit()) return;
      const z = maxZ();
      const items = state.clipboard.map((it, i) => ({ ...it, id: uid(), x: it.x + 30, y: it.y + 30, z: it.type === 'frame' ? it.z : z + 1 + i, created_by: state.me.id, props: { ...it.props, locked: false } }));
      state.clipboard = items.map(snapshot);
      createItems(items); select(items.map((i) => i.id));
    }
    function duplicateSelection() {
      const items = selectedItems(); if (!items.length || !canEdit()) return;
      const z = maxZ();
      const copies = items.map((it, i) => ({ ...snapshot(it), id: uid(), x: it.x + 30, y: it.y + 30, z: it.type === 'frame' ? it.z : z + 1 + i, created_by: state.me.id }));
      createItems(copies); select(copies.map((i) => i.id));
    }

    // ------------------------------------------------------------ menus
    function closeMenus() { document.querySelectorAll('.menu').forEach((m) => m.remove()); }
    document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); }, true);
    function menu(x, y, entries) {
      closeMenus();
      const m = h('div', { class: 'menu', style: `left:${x}px;top:${y}px` });
      for (const en of entries) {
        if (en === '-') { m.append(h('div', { class: 'sep' })); continue; }
        const b = h('button', { class: en.danger ? 'danger' : '' }, `${esc(en.label)}${en.k ? `<span class="k">${esc(en.k)}</span>` : ''}`);
        if (en.disabled) b.disabled = true;
        b.onclick = () => { closeMenus(); en.action(); };
        m.append(b);
      }
      root.append(m);
      const r = m.getBoundingClientRect();
      if (r.right > window.innerWidth) m.style.left = (x - r.width) + 'px';
      if (r.bottom > window.innerHeight) m.style.top = (y - r.height) + 'px';
    }
    function showContextMenu(x, y) {
      const ids = [...state.selection]; if (!ids.length) return;
      const ed = canEdit();
      menu(x, y, [
        { label: 'Copy', k: 'Ctrl+C', action: copySelection },
        { label: 'Duplicate', k: 'Ctrl+D', action: duplicateSelection, disabled: !ed },
        '-',
        { label: 'Bring to front', k: ']', action: () => { const z = maxZ(); updateItems(ids, (it) => { it.z = z + 1; }); }, disabled: !ed },
        { label: 'Send to back', k: '[', action: () => { const z = minZ(); updateItems(ids, (it) => { it.z = z - 1; }); }, disabled: !ed },
        { label: selectedItems().every((i) => i.props.locked) ? 'Unlock' : 'Lock', action: () => { const lock = !selectedItems().every((i) => i.props.locked); updateItems(ids, (it) => { it.props.locked = lock; }, { allowLocked: true }); }, disabled: !ed },
        '-',
        { label: 'Delete', k: 'Del', action: () => deleteItems(ids), danger: true, disabled: !ed },
      ]);
    }
    function showBoardMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      menu(r.left, r.bottom + 6, [
        { label: 'Fit to content', k: 'Shift+1', action: fitToContent },
        { label: 'Select all', k: 'Ctrl+A', action: () => select([...state.items.keys()]) },
        '-',
        { label: 'Export as JSON', action: () => { window.location.href = `/api/boards/${state.boardId}/export`; } },
        { label: 'Export as PNG', action: exportPng },
        { label: 'Duplicate board', action: () => opts.onDuplicate && opts.onDuplicate(), disabled: state.me.guest },
        '-',
        { label: 'Keyboard shortcuts', action: () => opts.onShortcuts && opts.onShortcuts() },
        '-',
        { label: 'Delete board', action: () => opts.onDelete && opts.onDelete(), danger: true, disabled: state.perm !== 'owner' },
      ]);
    }

    // ------------------------------------------------------------ PNG export (simple rasterization)
    function exportPng() {
      const items = [...state.items.values()].sort((a, b) => (a.type === 'frame' ? -1e9 : a.z || 0) - (b.type === 'frame' ? -1e9 : b.z || 0));
      const bb = itemsBBox(items); if (!bb) { toast('Nothing to export'); return; }
      const pad = 60, scale = Math.min(2, 8000 / Math.max(bb.w + pad * 2, bb.h + pad * 2));
      const c = document.createElement('canvas'); c.width = Math.ceil((bb.w + pad * 2) * scale); c.height = Math.ceil((bb.h + pad * 2) * scale);
      const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.translate(pad - bb.x, pad - bb.y);
      ctx.fillStyle = '#f7f8fa'; ctx.fillRect(bb.x - pad, bb.y - pad, bb.w + pad * 2, bb.h + pad * 2);
      const wrapText = (text, x, y, w, hgt, size, align, color, bold, vcenter) => {
        ctx.font = `${bold ? 700 : 500} ${size}px ${getComputedStyle(document.body).fontFamily}`; ctx.fillStyle = color; ctx.textBaseline = 'top';
        const lines = []; for (const para of String(text || '').split('\n')) { let line = ''; for (const word of para.split(/(\s+)/)) { if (ctx.measureText(line + word).width > w && line) { lines.push(line); line = word.trimStart(); } else line += word; } lines.push(line); }
        const lh = size * 1.3; let ty = vcenter ? y + (hgt - lines.length * lh) / 2 : y;
        for (const ln of lines) { const tw = ctx.measureText(ln).width; const tx = align === 'center' ? x + (w - tw) / 2 : align === 'right' ? x + w - tw : x; ctx.fillText(ln, tx, ty); ty += lh; }
      };
      for (const it of items) {
        const p = it.props || {};
        if (it.type === 'frame') { ctx.fillStyle = p.fill || 'rgba(255,255,255,.55)'; ctx.fillRect(it.x, it.y, it.w, it.h); ctx.strokeStyle = '#c7ccd9'; ctx.lineWidth = 2; ctx.strokeRect(it.x, it.y, it.w, it.h); ctx.font = '700 13px sans-serif'; ctx.fillStyle = '#5b6178'; ctx.textBaseline = 'bottom'; ctx.fillText(p.title || 'Frame', it.x, it.y - 6); }
        else if (it.type === 'sticky') { ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3; ctx.fillStyle = p.color || '#fff176'; ctx.fillRect(it.x, it.y, it.w, it.h); ctx.shadowColor = 'transparent'; const el = state.els.get(it.id)?.querySelector('.txt'); const fs = el ? parseFloat(el.style.fontSize) || 18 : 18; wrapText(p.text, it.x + 14, it.y + 14, it.w - 28, it.h - 28, fs, p.align || 'center', '#222', p.bold, true); }
        else if (it.type === 'text') wrapText(p.text, it.x + 8, it.y + 6, it.w - 16, it.h - 12, p.fontSize || 20, p.align || 'left', p.color || '#1c1f2b', p.bold, false);
        else if (it.type === 'shape') {
          ctx.beginPath(); const k = p.kind || 'rect';
          if (k === 'ellipse') ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, it.w / 2, it.h / 2, 0, 0, Math.PI * 2);
          else if (k === 'diamond') { ctx.moveTo(it.x + it.w / 2, it.y); ctx.lineTo(it.x + it.w, it.y + it.h / 2); ctx.lineTo(it.x + it.w / 2, it.y + it.h); ctx.lineTo(it.x, it.y + it.h / 2); ctx.closePath(); }
          else if (k === 'triangle') { ctx.moveTo(it.x + it.w / 2, it.y); ctx.lineTo(it.x + it.w, it.y + it.h); ctx.lineTo(it.x, it.y + it.h); ctx.closePath(); }
          else if (k === 'round') ctx.roundRect(it.x, it.y, it.w, it.h, 12); else ctx.rect(it.x, it.y, it.w, it.h);
          if (p.fill && p.fill !== 'transparent') { ctx.fillStyle = p.fill; ctx.fill(); } ctx.strokeStyle = p.stroke || '#1c1f2b'; ctx.lineWidth = 2; ctx.stroke();
          const el = state.els.get(it.id)?.querySelector('.txt'); const fs = el ? parseFloat(el.style.fontSize) || 16 : 16; wrapText(p.text, it.x + 14, it.y + 14, it.w - 28, it.h - 28, fs, 'center', p.color || '#1c1f2b', p.bold, true);
        } else if (it.type === 'line' || it.type === 'draw') {
          const pts = (p.points || []).map(([px, py]) => [it.x + px, it.y + py]); if (pts.length < 2) continue;
          ctx.strokeStyle = p.stroke || '#1c1f2b'; ctx.lineWidth = p.width || 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.setLineDash(p.dashed ? [(p.width || 3) * 3, (p.width || 3) * 2.5] : []);
          ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
          if (it.type === 'draw') { for (let i = 1; i < pts.length - 1; i++) ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2); ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]); }
          else ctx.lineTo(pts[1][0], pts[1][1]);
          ctx.stroke(); ctx.setLineDash([]);
          if (it.type === 'line' && p.arrow) { const [a, b] = [pts[0], pts[1]]; const ang = Math.atan2(b[1] - a[1], b[0] - a[0]); const L = (p.width || 3) * 4; ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.moveTo(b[0], b[1]); ctx.lineTo(b[0] - L * Math.cos(ang - 0.45), b[1] - L * Math.sin(ang - 0.45)); ctx.lineTo(b[0] - L * Math.cos(ang + 0.45), b[1] - L * Math.sin(ang + 0.45)); ctx.closePath(); ctx.fill(); }
        }
      }
      const a = document.createElement('a'); a.download = (state.board.name || 'board').replace(/[^\w\-]+/g, '_') + '.png'; a.href = c.toDataURL('image/png'); a.click();
    }

    // ------------------------------------------------------------ websocket
    let reconnectDelay = 800, closed = false, pingTimer = null;
    function connect() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws/boards/${state.boardId}`);
      state.ws = ws;
      ws.onopen = () => { state.connected = true; reconnectDelay = 800; statusDot.className = 'status-dot on'; statusDot.title = 'Connected — changes sync live'; pingTimer = setInterval(() => send({ t: 'ping' }), 25000); };
      ws.onclose = (ev) => {
        state.connected = false; clearInterval(pingTimer); statusDot.className = 'status-dot off'; statusDot.title = 'Disconnected — reconnecting…';
        if (closed) return;
        if (ev.code === 4403 || ev.code === 4404) { opts.onKicked && opts.onKicked(ev.code); return; }
        setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(reconnectDelay * 1.6, 10000);
      };
      ws.onerror = () => {};
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        switch (m.t) {
          case 'init': {
            state.myConn = m.you.conn; state.perm = m.you.perm;
            // Replace items with server truth (handles reconnects).
            const editingId = state.editing?.id;
            state.items.clear(); for (const it of m.items) state.items.set(it.id, it);
            renderAll(); if (editingId && !state.items.has(editingId)) stopEditing(false);
            for (const id of [...state.selection]) if (!state.items.has(id)) state.selection.delete(id);
            state.presence = m.users; renderPresence(); updatePermUI();
            break;
          }
          case 'op': if (m.conn !== state.myConn) applyOps(m.ops); break;
          case 'presence': {
            state.presence = m.users; renderPresence();
            const live = new Set(m.users.map((u) => u.conn));
            for (const [conn, c] of state.cursors) if (!live.has(conn)) { c.el?.remove(); state.cursors.delete(conn); }
            for (const conn of [...state.remoteSel.keys()]) if (!live.has(conn)) state.remoteSel.delete(conn);
            for (const u of m.users) { if (u.conn === state.myConn) continue; if (u.selection?.length) state.remoteSel.set(u.conn, { ids: u.selection, user: u }); }
            renderRemoteSelections(); renderCursors();
            for (const u of m.users) state.names.set(u.id, u.display_name);
            break;
          }
          case 'cursor': { if (m.conn === state.myConn) break; let c = state.cursors.get(m.conn); if (!c) { c = { user: m.user }; state.cursors.set(m.conn, c); } c.cursor = m.cursor; renderCursors(); break; }
          case 'select': if (m.conn !== state.myConn) { if (m.ids.length) state.remoteSel.set(m.conn, { ids: m.ids, user: m.user }); else state.remoteSel.delete(m.conn); renderRemoteSelections(); } break;
          case 'board': state.board = m.board; nameEl.textContent = m.board.name; opts.onBoardUpdate && opts.onBoardUpdate(m.board); break;
          case 'members': state.members = m.members; for (const mm of m.members) state.names.set(mm.id, mm.display_name); opts.onMembers && opts.onMembers(m.members); break;
          case 'perm': state.perm = m.permission; updatePermUI(); toast(state.perm === 'view' ? 'Your access changed to view only' : 'You can now edit this board'); break;
          case 'kicked': closed = true; opts.onKicked && opts.onKicked(4403); break;
          case 'deleted': closed = true; opts.onDeleted && opts.onDeleted(); break;
          case 'error': toast(m.message, true); break;
        }
      };
    }
    function updatePermUI() {
      const ed = canEdit();
      viewOnly.classList.toggle('hidden', ed);
      nameEl.contentEditable = ed ? 'true' : 'false';
      for (const k in toolBtns) toolBtns[k].style.display = (ed || k === 'select' || k === 'hand') ? '' : 'none';
      if (!ed) { if (state.editing) stopEditing(false); if (state.tool !== 'select' && state.tool !== 'hand') setTool('select'); }
      renderSelection(); renderPropbar();
    }

    function toast(msg, isErr) { opts.toast ? opts.toast(msg, isErr) : console.log(msg); }

    // ------------------------------------------------------------ init
    for (const it of opts.initial.items || []) state.items.set(it.id, it);
    renderAll();
    let saved = null; try { saved = JSON.parse(localStorage.getItem('wb_view_' + state.boardId) || 'null'); } catch (_) {}
    if (saved && saved.s) { state.view = saved; applyView(); } else fitToContent();
    setTool('select'); updatePermUI(); connect();
    const onResize = () => { applyView(); };
    window.addEventListener('resize', onResize);

    return {
      destroy() {
        closed = true; clearInterval(pingTimer); try { state.ws && state.ws.close(); } catch (_) {}
        window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); window.removeEventListener('pointercancel', onUp);
        window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('resize', onResize);
        container.innerHTML = '';
      },
      setBoard(b) { state.board = b; nameEl.textContent = b.name; },
      setMembers(m) { state.members = m; for (const mm of m) state.names.set(mm.id, mm.display_name); },
      get state() { return state; },
      fitToContent,
    };
  };
})();
