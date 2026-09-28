/* Client data layer for the plat-todo task grid. No DOM code: the UI (tasks.js) only calls
 * load() / createTask() / saveTask() / deleteTask() and listens to onChange / onStatus.
 *
 * Edits are applied locally at once, queued per task, debounced (1.5 s) into one batch and sent
 * to /api/plat/tasks/batch, where the server does the read-merge-write against plat-kv. Updates
 * carry only the fields that changed, so a concurrent edit to another field on the other page
 * survives. A failed save stays queued (also in localStorage, so a reload keeps it) and retries
 * with backoff. The list is refreshed from the server on window focus and every 60 s.
 */
(function () {
  'use strict';
  const DONE = '完了';
  const HEAVY = new Set(['重い', 'L', 'M']);

  // ---- business rules (must match the plat-todo page; mirrored in server/plat_tasks.py)
  const pad = (n) => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const isOpen = (t) => t.status !== DONE;
  const isOverdue = (t, now = today()) => isOpen(t) && !!t.end && String(t.end) < now;
  const isHeavy = (t) => HEAVY.has(t.effort);
  function applyDoneAt(t, prevStatus, now = today()) {
    if (t.status === DONE) { if (prevStatus !== DONE || !t.done_at) t.done_at = now; }
    else t.done_at = null;
  }
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

  const DEBOUNCE_MS = 1500;
  const REFRESH_MS = 60000;
  const RETRY_MS = [3000, 10000, 30000, 60000];

  function PlatTaskStore({ api, onChange, onStatus, onNotice }) {
    let server = [];            // tasks as last received from the server
    let meta = { key: '', writable: false };
    let projectTasks = [];
    // id -> { op: 'save'|'delete', create: bool, changes: {}, v: n }  (v bumps on every local edit)
    let pending = new Map();
    let timer = null, retryTimer = null, inflight = null, failures = 0, lastError = '';
    let refreshSeq = 0, savedSeq = 0, destroyed = false;
    const storageKey = () => 'plat-pending:' + meta.key;

    // ---- persistence of unsent edits (a reload or a closed tab must not lose them)
    function persist() {
      try {
        if (pending.size) localStorage.setItem(storageKey(), JSON.stringify([...pending.entries()]));
        else localStorage.removeItem(storageKey());
      } catch (_) { /* private mode etc.: the in-memory queue still works */ }
    }
    function restore() {
      try {
        const raw = localStorage.getItem(storageKey());
        if (raw) for (const [id, e] of JSON.parse(raw)) if (!pending.has(id)) pending.set(id, e);
      } catch (_) {}
    }

    // ---- the view: server tasks with pending local edits laid over them
    function tasks() {
      const out = [];
      const seen = new Set();
      for (const t of server) {
        seen.add(t.id);
        const p = pending.get(t.id);
        if (p && p.op === 'delete') continue;
        if (p) {
          const merged = { ...t, ...p.changes };
          if ('status' in p.changes) applyDoneAt(merged, t.status);
          out.push(Object.assign(merged, { _pending: true }));
        } else out.push(t);
      }
      for (const [id, p] of pending) {
        if (p.op === 'save' && p.create && !seen.has(id)) {
          const t = { id, status: '未着手', priority: '通常', assignees: [], workspace: 'その他', project: 'その他', end: null, done_at: null, memo: '', ...p.changes, _pending: true };
          applyDoneAt(t, null);
          out.push(t);
        }
      }
      return out;
    }

    function status() {
      const count = pending.size;
      let state = 'saved';
      if (inflight) state = 'saving';
      else if (lastError && count) state = 'error';
      else if (count) state = 'pending';
      onStatus && onStatus({ state, count, message: lastError });
    }
    const changed = () => { if (!destroyed) { onChange && onChange(); status(); } };

    // ---- reads
    async function load() {
      const seq = ++refreshSeq;
      const d = await api('GET', '/api/plat/tasks');
      if (destroyed) return;
      const firstLoad = !meta.key;
      meta = { key: d.key, production: d.production, writable: d.writable };
      if (firstLoad) { restore(); if (pending.size) schedule(0); }
      // A save that finished while this GET was in flight has newer data than this response.
      if (seq > savedSeq) server = d.tasks;
      projectTasks = d.project_tasks || [];
      changed();
    }

    // ---- writes
    function edit(id, fn) {
      if (!meta.writable) throw new Error('書き込み用トークンが未設定のため、閲覧のみです');
      const e = pending.get(id) || { op: 'save', create: false, changes: {}, v: 0 };
      fn(e);
      e.v += 1;
      pending.set(id, e);
      persist();
      lastError = '';
      schedule(DEBOUNCE_MS);
      changed();
    }
    function createTask(fields) {
      if (!String(fields.title || '').trim()) return null;  // empty cards never become data
      const id = newId();
      edit(id, (e) => { e.create = true; e.changes = { ...fields, title: String(fields.title).trim() }; });
      return id;
    }
    function saveTask(id, changes) {
      if ('title' in changes && !String(changes.title || '').trim()) throw new Error('タイトルは空にできません');
      edit(id, (e) => {
        if (e.op === 'delete') return;
        Object.assign(e.changes, changes);
      });
    }
    function deleteTask(id) {
      const e = pending.get(id);
      if (e && e.create && !server.some((t) => t.id === id)) {  // never sent: just forget it
        pending.delete(id); persist(); changed(); return;
      }
      edit(id, (x) => { x.op = 'delete'; x.changes = {}; });
    }

    function schedule(ms) {
      clearTimeout(timer);
      timer = setTimeout(flush, ms);
    }

    async function flush() {
      clearTimeout(timer); clearTimeout(retryTimer);
      if (inflight || !pending.size || destroyed) return inflight;
      const batch = [...pending.entries()].map(([id, e]) => ({ id, v: e.v, e: JSON.parse(JSON.stringify(e)) }));
      const ops = batch.map(({ id, e }) => (e.op === 'delete' ? { op: 'delete', id } : { op: 'save', id, create: e.create, changes: e.changes }));
      inflight = (async () => {
        status();
        try {
          const d = await api('POST', '/api/plat/tasks/batch', { ops, today: today() });
          savedSeq = ++refreshSeq;
          server = d.tasks;
          batch.forEach(({ id, v }, i) => {
            const cur = pending.get(id);
            const r = d.results[i] || {};
            if (!r.ok) onNotice && onNotice(r.error || '保存できない変更がありました', true);
            if (!cur) return;
            if (cur.v === v) pending.delete(id);          // nothing new since we sent it
            else if (cur.op === 'save') cur.create = false; // edited again meanwhile: keep the rest queued
          });
          failures = 0; lastError = '';
        } catch (err) {
          failures += 1;
          lastError = err.message || '保存に失敗しました';
          const wait = RETRY_MS[Math.min(failures - 1, RETRY_MS.length - 1)];
          if (!destroyed) retryTimer = setTimeout(flush, wait);
          if (failures === 1) onNotice && onNotice(`保存に失敗しました: ${lastError}（${Math.round(wait / 1000)}秒後に再試行します）`, true);
        } finally {
          persist();
          inflight = null;
          if (pending.size && !lastError) schedule(DEBOUNCE_MS);
          changed();
        }
      })();
      return inflight;
    }

    // ---- background refresh
    const onFocus = () => { load().catch(() => {}); };
    window.addEventListener('focus', onFocus);
    const poll = setInterval(onFocus, REFRESH_MS);
    const onUnload = (e) => { if (pending.size) { persist(); e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onUnload);

    return {
      load, createTask, saveTask, deleteTask, flush, tasks,
      projectTasks: () => projectTasks,
      meta: () => meta,
      isPending: (id) => pending.has(id),
      pendingCount: () => pending.size,
      retryNow: () => { failures = 0; lastError = ''; return flush(); },
      destroy() {
        if (pending.size) { persist(); flush(); }  // best effort; the queue is in localStorage anyway
        destroyed = true;
        clearTimeout(timer); clearTimeout(retryTimer); clearInterval(poll);
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('beforeunload', onUnload);
      },
    };
  }
  // A read-only store over an archived board (same interface as the live one, never talks to the server).
  PlatTaskStore.frozen = function (snap) {
    const meta = { key: snap.key, production: false, writable: false, frozen: true };
    const fail = () => { throw new Error('記録は閲覧のみです'); };
    return {
      load: async () => {}, flush: async () => {}, retryNow: async () => {}, destroy() {},
      tasks: () => snap.tasks || [], projectTasks: () => snap.project_tasks || [], meta: () => meta,
      isPending: () => false, pendingCount: () => 0, createTask: fail, saveTask: fail, deleteTask: fail,
    };
  };
  PlatTaskStore.rules = { today, isOpen, isOverdue, isHeavy, applyDoneAt, DONE };
  window.PlatTaskStore = PlatTaskStore;
})();
