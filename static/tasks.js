/* The task board: a fixed employees × status grid of post cards over the shared plat-todo task list.
 *
 * window.TaskGrid(container, opts) -> { destroy }
 *   opts: { api, toast, esc, modal, confirmDialog, isAdmin,
 *           archive?  — a snapshot from /api/archives/<day>: draws that day frozen and read-only,
 *           title, subtitle, extraHtml, onMount(root) — header content supplied by app.js }
 * All data access goes through window.PlatTaskStore (plat_store.js); this file is UI only.
 */
(function () {
  'use strict';
  const PROJECT_URL = 'https://pm.plat-yonezawa.com/dashboard/projects/project.html?id=';
  const DONE_PREVIEW = 5;
  const FILTER_KEY = 'plat-grid-filters';

  function TaskGrid(root, opts) {
    const { api, toast, esc, modal, confirmDialog } = opts;
    const R = window.PlatTaskStore.rules;
    const frozen = !!opts.archive;
    // Overdue is judged as of the board's own day: an archive shows what was late *then*.
    const asOf = () => (frozen ? opts.archive.day : R.today());
    const st = { meta: null, showAllDone: false, inline: null, editing: null, composing: false, dirty: false, dragging: null };
    st.filters = { workspace: '', project: '', overdue: false, schedule: true };
    try { Object.assign(st.filters, JSON.parse(localStorage.getItem(FILTER_KEY) || '{}')); } catch (_) {}

    root.innerHTML = `<div class="tg${frozen ? ' frozen' : ''}">
      <div class="tg-bar">
        <div><h1>${esc(opts.title || '')}</h1>${opts.subtitle ? `<div class="tg-sub">${opts.subtitle}</div>` : ''}</div>
        <span id="tg-key"></span>
        <div class="grow"></div>
        ${opts.extraHtml || ''}
        ${frozen ? '' : '<span class="tg-save" id="tg-save"></span><button class="btn sm hidden" id="tg-rows">行を編集</button><button class="btn primary sm hidden" id="tg-new">+ 付箋を追加</button>'}
      </div>
      <div class="tg-filters">
        <select id="f-ws"></select>
        <select id="f-pj"></select>
        <label class="tg-check"><input type="checkbox" id="f-od"> 期限切れのみ</label>
        <label class="tg-check"><input type="checkbox" id="f-sc"> プロジェクト日程も表示</label>
      </div>
      <div id="tg-notice"></div>
      <div class="tg-scroll"><div class="tg-grid" id="tg-grid"><p class="muted" style="padding:20px">読み込み中…</p></div></div>
    </div>`;
    const $ = (s) => root.querySelector(s);
    const grid = $('#tg-grid');
    if (opts.onMount) opts.onMount(root);

    const store = frozen ? window.PlatTaskStore.frozen(opts.archive) : window.PlatTaskStore({
      api,
      onChange: () => { if (st.meta && !root.querySelector('.tg-filters select:focus')) drawFilters(); render(); },
      onStatus: drawStatus,
      onNotice: (m, err) => toast(m, err),
    });
    const canEdit = () => !frozen && store.meta().writable;

    // ---------------------------------------------------------------- derived data
    const people = () => (st.meta ? st.meta.people : []);
    const projectsMeta = () => (st.meta ? st.meta.projects : []);
    function rows() {
      const known = new Map(people().map((p) => [p.id, p]));
      const all = [...store.tasks(), ...store.projectTasks()];
      const used = new Set(all.flatMap((t) => t.assignees || []));
      const extra = [...used].filter((a) => !known.has(a)).sort();
      // Hidden rows (e.g. someone who left) still show while they have cards, so no card disappears.
      return [
        ...people().filter((p) => !p.hidden || used.has(p.id)),
        ...extra.map((id) => ({ id, name: id, initials: id[0] || '?', color: '', role: '名簿にないID', unknown: true })),
        { id: null, name: '担当なし', initials: '—', color: '#b6bac6', role: '' },
      ];
    }
    const personName = (id) => (people().find((p) => p.id === id) || { name: id }).name;
    function projectLabel(pid) {
      const m = projectsMeta().find((p) => p.id === pid);
      if (m) return m.label;
      const t = store.tasks().find((x) => x.projectId === pid && x.project);
      return t ? t.project : pid;
    }
    function projectWorkspace(pid) {
      const m = projectsMeta().find((p) => p.id === pid);
      if (m && m.workspace) return m.workspace;
      const t = store.tasks().find((x) => x.projectId === pid && x.workspace);
      return t ? t.workspace : '';
    }
    function scheduleCards() {
      if (!st.filters.schedule) return [];
      return store.projectTasks().map((t) => ({ ...t, _schedule: true, id: `pj:${t.projectId}:${t.node}:${t.index}`, project: projectLabel(t.projectId), workspace: projectWorkspace(t.projectId) }));
    }
    const statusOf = (t) => (st.meta.statuses.includes(t.status) ? t.status : st.meta.statuses[0]);
    function visible(t) {
      const f = st.filters;
      if (f.workspace && t.workspace !== f.workspace) return false;
      if (f.project && t.project !== f.project) return false;
      if (f.overdue && !R.isOverdue(t, asOf())) return false;
      return true;
    }
    const inRow = (t, row) => (row.id === null ? !(t.assignees || []).length : (t.assignees || []).includes(row.id));
    const prioRank = (p) => ({ 今日やる: 0, 重要: 1 }[p] ?? 2);
    function sortCards(list, status) {
      if (status === R.DONE) return list.sort((a, b) => String(b.done_at || '').localeCompare(String(a.done_at || '')));
      const now = asOf();
      return list.sort((a, b) => (R.isOverdue(b, now) - R.isOverdue(a, now)) || (prioRank(a.priority) - prioRank(b.priority))
        || String(a.end || '9999').localeCompare(String(b.end || '9999')) || String(a.title).localeCompare(String(b.title), 'ja'));
    }

    // ---------------------------------------------------------------- rendering
    const avatarHtml = (p, sm) => `<span class="avatar${sm ? ' xs' : ''}" style="background:${esc(p.color || '#8b8d98')}" title="${esc(p.name)}">${esc(p.initials || (p.name || '?')[0])}</span>`;
    const fmtDate = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${+m[2]}/${+m[3]}` : ''; };

    function cardHtml(t, row) {
      const od = R.isOverdue(t, asOf());
      const others = (t.assignees || []).filter((a) => a !== row.id);
      const prio = t.priority === '今日やる' ? '<span class="tb red">今日やる</span>' : t.priority === '重要' ? '<span class="tb amber">重要</span>' : '';
      const meta = `${t.project && t.project !== 'その他' ? `<span class="t-proj">${esc(t.project)}</span>` : ''}${t.end ? `<span class="t-due${od ? ' od' : ''}">〆 ${fmtDate(t.end)}</span>` : ''}${t.status === R.DONE && t.done_at ? `<span class="t-due">完了 ${fmtDate(t.done_at)}</span>` : ''}`;
      const badges = `${prio}${R.isHeavy(t) ? '<span class="tb gray">重い</span>' : ''}${t._schedule ? '<span class="tb blue">プロジェクト</span>' : ''}${others.length ? `<span class="t-others" title="${esc(others.map(personName).join('、'))}">＋${others.map((a) => esc(personName(a))).join('・')}</span>` : ''}`;
      const cls = `tcard prio-${t.priority === '今日やる' ? 'today' : t.priority === '重要' ? 'high' : 'normal'}${od ? ' overdue' : ''}${t._pending ? ' pending' : ''}${t.status === R.DONE ? ' done' : ''}`;
      const editingThis = st.editing && st.editing.id === t.id && st.editing.row === row.id;
      const text = editingThis
        ? `<textarea class="t-edit" rows="2" maxlength="500">${esc(t.title)}</textarea>`
        : `<div class="t-title">${od ? '<span class="t-warn" title="期限切れ">⚠</span>' : ''}${esc(t.title)}</div>`;
      const memo = t.memo && !editingThis ? `<div class="t-memo">${esc(t.memo)}</div>` : '';
      const body = `${text}${memo}${meta ? `<div class="t-meta">${meta}</div>` : ''}${badges ? `<div class="t-badges">${badges}</div>` : ''}`;
      if (t._schedule) return `<a class="${cls} schedule" href="${PROJECT_URL}${encodeURIComponent(t.projectId)}" target="_blank" rel="noopener" title="プロジェクトの日程タスク（ここでは編集できません）">${body}</a>`;
      const more = `<button class="t-more" data-detail title="${canEdit() ? '詳細を編集' : '詳細'}">⋯</button>`;
      return `<div class="${cls}${editingThis ? ' editing' : ''}" data-id="${esc(t.id)}" data-row="${esc(row.id ?? '')}" ${canEdit() && !editingThis ? 'draggable="true"' : ''} tabindex="0">${more}${body}</div>`;
    }

    function render() {
      if (!st.meta) return;
      if (st.composing) { st.dirty = true; return; }  // never break an IME composition mid-word
      const keep = grid.querySelector('.tcard.new textarea, .t-edit');
      const draft = keep ? { value: keep.value, start: keep.selectionStart } : null;
      const scroll = { x: grid.parentElement.scrollLeft, y: grid.parentElement.scrollTop };

      const statuses = st.meta.statuses;
      const all = [...store.tasks(), ...scheduleCards()].filter(visible);
      const now = asOf();
      const cols = statuses.map((s) => ({ s, n: all.filter((t) => statusOf(t) === s).length }));
      let html = `<div class="tg-h corner">メンバー</div>${cols.map(({ s, n }) => `<div class="tg-h st-${statuses.indexOf(s)}">${esc(s)} <span class="n">${n}</span>${s === R.DONE ? `<button class="btn ghost sm" id="tg-done">${st.showAllDone ? `最新${DONE_PREVIEW}件のみ` : 'すべて表示'}</button>` : ''}</div>`).join('')}`;
      for (const row of rows()) {
        const mine = all.filter((t) => inRow(t, row));
        const open = mine.filter(R.isOpen);
        const heavy = open.filter(R.isHeavy).length;
        const overdue = open.filter((t) => R.isOverdue(t, now)).length;
        html += `<div class="tg-row-h${row.unknown ? ' unknown' : ''}${row.id === null ? ' nobody' : ''}${row.hidden ? ' hidden-row' : ''}">
          <div class="row" style="gap:8px">${avatarHtml(row)}<div class="grow"><div class="rn">${esc(row.name)}</div>${row.role ? `<div class="small muted">${esc(row.role)}</div>` : ''}</div></div>
          <div class="rs"><span title="未完了">未完了 <b>${open.length}</b></span><span title="重い" class="${heavy ? 'hv' : ''}">重い <b>${heavy}</b></span><span title="期限切れ" class="${overdue ? 'od' : ''}">期限切れ <b>${overdue}</b></span></div>
        </div>`;
        for (const s of statuses) {
          let list = sortCards(mine.filter((t) => statusOf(t) === s), s);
          let more = 0;
          if (s === R.DONE && !st.showAllDone && list.length > DONE_PREVIEW) { more = list.length - DONE_PREVIEW; list = list.slice(0, DONE_PREVIEW); }
          const isInline = st.inline && st.inline.row === row.id && st.inline.status === s;
          html += `<div class="tg-cell" data-row="${esc(row.id ?? '')}" data-status="${esc(s)}">${list.map((t) => cardHtml(t, row)).join('')}${more ? `<button class="tg-more" data-more>他 ${more} 件を表示</button>` : ''}${isInline ? '<div class="tcard new"><textarea rows="2" placeholder="付箋に書く（Enterで追加、Escで閉じる）"></textarea></div>' : ''}${canEdit() && !isInline ? '<button class="cell-add" data-add title="このマスに付箋を追加">＋</button>' : ''}</div>`;
        }
      }
      grid.innerHTML = html;
      grid.parentElement.scrollLeft = scroll.x; grid.parentElement.scrollTop = scroll.y;
      const ta = grid.querySelector('.tcard.new textarea, .t-edit');
      if (ta) {
        if (draft) ta.value = draft.value;
        const pos = draft ? draft.start : ta.value.length;
        ta.setSelectionRange(pos, pos);
        ta.focus({ preventScroll: true });
      }
    }

    function drawStatus({ state, count, message }) {
      const el = $('#tg-save'); if (!el) return;
      const txt = { saved: '✓ 保存済み', pending: `未保存 ${count} 件…`, saving: '保存中…', error: `⚠ 保存できていない変更 ${count} 件` }[state];
      el.className = 'tg-save ' + state;
      el.innerHTML = `${esc(txt)}${state === 'error' ? ` <button class="btn sm" id="tg-retry" title="${esc(message)}">今すぐ再試行</button>` : ''}`;
      const b = el.querySelector('#tg-retry'); if (b) b.onclick = () => store.retryNow();
    }

    function drawChrome() {
      const m = store.meta();
      const key = frozen ? opts.archive.key : m.key;
      $('#tg-key').innerHTML = key === 'plat-todo-tasks' ? (frozen ? '' : '<span class="pill green">本番データ</span>')
        : `<span class="pill amber" title="本番に切り替えるには PLAT_TASKS_KEY を設定します">サンドボックス: ${esc(key)}</span>`;
      if (!frozen) {
        $('#tg-new').classList.toggle('hidden', !m.writable);
        $('#tg-rows').classList.toggle('hidden', !opts.isAdmin);
        const notes = [];
        if (m.local_only) notes.push('ローカル編集モードです。変更はこのサーバーにだけ保存され、plat-todo には同期されません。');
        if (!m.writable) notes.push('サーバーに書き込み用トークン（PLAT_KV_TOKEN）が設定されていないため、閲覧のみです。');
        if (st.meta.sources.people === 'none' && !people().length) notes.push('社員名簿を読み込めないため、担当者IDを行名にしています。管理者は「行を編集」で名前を付けられます。');
        $('#tg-notice').innerHTML = notes.map((n) => `<div class="tg-note">${esc(n)}</div>`).join('');
      }
      drawFilters();
    }

    function drawFilters() {
      const f = st.filters;
      const labels = new Set(projectsMeta().filter((p) => !f.workspace || !p.workspace || p.workspace === f.workspace).map((p) => p.label));
      for (const t of store.tasks()) if (t.project && (!f.workspace || t.workspace === f.workspace)) labels.add(t.project);
      const wss = [...new Set([...st.meta.workspaces, ...store.tasks().map((t) => t.workspace).filter(Boolean)])];
      $('#f-ws').innerHTML = `<option value="">すべての事業領域</option>${wss.map((w) => `<option ${w === f.workspace ? 'selected' : ''}>${esc(w)}</option>`).join('')}`;
      $('#f-pj').innerHTML = `<option value="">すべてのプロジェクト</option>${[...labels].sort((a, b) => a.localeCompare(b, 'ja')).map((p) => `<option ${p === f.project ? 'selected' : ''}>${esc(p)}</option>`).join('')}`;
      $('#f-od').checked = f.overdue; $('#f-sc').checked = f.schedule;
    }
    const saveFilters = () => { try { localStorage.setItem(FILTER_KEY, JSON.stringify(st.filters)); } catch (_) {} drawFilters(); render(); };
    $('#f-ws').onchange = (e) => { st.filters.workspace = e.target.value; st.filters.project = ''; saveFilters(); };
    $('#f-pj').onchange = (e) => { st.filters.project = e.target.value; saveFilters(); };
    $('#f-od').onchange = (e) => { st.filters.overdue = e.target.checked; saveFilters(); };
    $('#f-sc').onchange = (e) => { st.filters.schedule = e.target.checked; saveFilters(); };

    // ---------------------------------------------------------------- create / edit
    function defaults() {
      const f = st.filters;
      const pj = projectsMeta().find((p) => p.label === f.project);
      return { workspace: f.workspace || (pj && pj.workspace) || 'その他', project: f.project || 'その他', ...(pj ? { projectId: pj.id } : {}) };
    }
    const projectIdFor = (label) => { const p = projectsMeta().find((x) => x.label === label); return p ? p.id : null; };
    const oneLine = (s) => String(s || '').replace(/\s*\n\s*/g, ' ').trim();

    // Empty inline cards are simply closed: they never reach the data.
    function commitInline(text, target, keepOpen) {
      const title = oneLine(text);
      if (!keepOpen && st.inline === target) st.inline = null;
      if (title) {
        try { store.createTask({ title, status: target.status, assignees: target.row === null ? [] : [target.row], ...defaults() }); } catch (e) { toast(e.message, true); }
      }
      render();
    }
    // Editing a card's text in place. Clearing the text asks before deleting the card.
    async function commitEdit(text, target) {
      if (st.editing === target) st.editing = null;
      const t = store.tasks().find((x) => x.id === target.id);
      const title = oneLine(text);
      render();
      if (!t || title === t.title) return;
      if (!title) {
        if (await confirmDialog('付箋を削除しますか？', `文字を消したので「${t.title}」を削除します。既存のタスクページからも消えます。`)) store.deleteTask(t.id);
        return;
      }
      try { store.saveTask(t.id, { title }); } catch (e) { toast(e.message, true); }
    }

    function taskModal(task) {
      const isNew = !task;
      const t = task || { title: '', status: st.meta.statuses[1], priority: '通常', assignees: [], ...defaults(), end: null, memo: '' };
      const editable = canEdit();
      const ro = editable ? '' : 'disabled';
      const everyone = rows().filter((r) => r.id !== null);
      const wss = [...new Set([...st.meta.workspaces, t.workspace].filter(Boolean))];
      const pjs = [...new Set([...projectsMeta().map((p) => p.label), ...store.tasks().map((x) => x.project)].filter(Boolean))];
      const { el, close } = modal(`<h2>${isNew ? '付箋を追加' : editable ? '付箋を編集' : '付箋'}</h2>
        <label class="field"><span>内容</span><input type="text" id="m-title" value="${esc(t.title)}" ${ro} maxlength="500"></label>
        <div class="tg-form2">
          <label class="field"><span>ステータス</span><select id="m-status" ${ro}>${st.meta.statuses.map((s) => `<option ${s === t.status ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
          <label class="field"><span>優先度</span><select id="m-prio" ${ro}>${(t.priority === '' ? [''] : []).concat(st.meta.priorities).map((p) => `<option value="${esc(p)}" ${p === t.priority ? 'selected' : ''}>${esc(p || '（未設定）')}</option>`).join('')}</select></label>
        </div>
        <div class="field"><span class="lbl">担当者</span><div class="tg-people" id="m-people">${everyone.map((p) => `<label class="chip ${(t.assignees || []).includes(p.id) ? 'on' : ''}"><input type="checkbox" value="${esc(p.id)}" ${(t.assignees || []).includes(p.id) ? 'checked' : ''} ${ro}>${avatarHtml(p, true)}${esc(p.name)}</label>`).join('')}</div></div>
        <div class="tg-form2">
          <label class="field"><span>事業領域</span><select id="m-ws" ${ro}>${wss.map((w) => `<option ${w === t.workspace ? 'selected' : ''}>${esc(w)}</option>`).join('')}</select></label>
          <label class="field"><span>プロジェクト</span><input type="text" id="m-pj" list="m-pjlist" value="${esc(t.project)}" ${ro}><datalist id="m-pjlist">${pjs.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
        </div>
        <label class="field" style="max-width:220px"><span>期限</span><input type="date" id="m-end" value="${esc(t.end || '')}" ${ro}></label>
        <label class="field"><span>メモ</span><textarea id="m-memo" rows="4" ${ro}>${esc(t.memo || '')}</textarea></label>
        ${isNew ? '' : `<p class="small muted">${[t.created ? `作成 ${esc(t.created)}` : '', t.source ? `登録元 ${esc(t.source)}` : '', t.done_at ? `完了 ${esc(t.done_at)}` : ''].filter(Boolean).join(' · ')}</p>`}
        <div class="err" id="m-err"></div>
        <div class="actions">${!isNew && editable ? '<button class="btn danger" id="m-del" style="margin-right:auto">削除</button>' : ''}<button class="btn" data-close>${editable ? 'キャンセル' : '閉じる'}</button>${editable ? `<button class="btn primary" id="m-save">${isNew ? '追加' : '保存'}</button>` : ''}</div>`, { wide: true });
      el.querySelectorAll('#m-people input').forEach((c) => (c.onchange = () => c.parentElement.classList.toggle('on', c.checked)));
      const title = el.querySelector('#m-title'); title.focus();
      if (!editable) return;
      const save = () => {
        const v = {
          title: oneLine(title.value),
          status: el.querySelector('#m-status').value,
          priority: el.querySelector('#m-prio').value,
          assignees: [...el.querySelectorAll('#m-people input:checked')].map((c) => c.value),
          workspace: el.querySelector('#m-ws').value,
          project: el.querySelector('#m-pj').value.trim() || 'その他',
          end: el.querySelector('#m-end').value || null,
          memo: el.querySelector('#m-memo').value,
        };
        if (!v.title) { el.querySelector('#m-err').textContent = '内容を入力してください'; return; }
        if (v.project !== t.project || isNew) v.projectId = projectIdFor(v.project);
        try {
          if (isNew) store.createTask(v);
          else {
            // Send only what changed so a concurrent edit to another field on the other page survives.
            const changes = {};
            for (const [k, val] of Object.entries(v)) if (JSON.stringify(val ?? null) !== JSON.stringify(t[k] ?? null)) changes[k] = val;
            if (Object.keys(changes).length) store.saveTask(t.id, changes);
          }
          close();
        } catch (e) { el.querySelector('#m-err').textContent = e.message; }
      };
      el.querySelector('#m-save').onclick = save;
      title.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) save(); };
      const del = el.querySelector('#m-del');
      if (del) del.onclick = async () => { close(); if (await confirmDialog('付箋を削除しますか？', `「${t.title}」を削除します。既存のタスクページからも消えます。`)) store.deleteTask(t.id); };
    }

    // Admins name, order and hide rows here (e.g. add a new hire before people.json knows them).
    function rowsModal() {
      let list = (st.meta.roster || []).map((r) => ({ ...r }));
      for (const p of people()) if (!list.some((r) => r.id === p.id)) list.push({ id: p.id, name: p.name, role: p.role, hidden: !!p.hidden });
      for (const r of rows()) if (r.unknown && !list.some((x) => x.id === r.id)) list.push({ id: r.id, name: '', role: '', hidden: false });
      const { el, close } = modal(`<h2>行を編集</h2>
        <p class="small muted">行の名前・並び順・表示を決めます。ID はタスクの担当者として既存のタスクページと共有されるので、名簿（people.json）と同じ ID を使ってください。非表示にしても、付箋が残っている間は表示されます。</p>
        <div id="r-list"></div>
        <div class="row" style="margin-top:10px"><input type="text" id="r-id" placeholder="ID（例: sato-hanako）" style="flex:1"><input type="text" id="r-name" placeholder="表示名（例: 佐藤）" style="flex:1"><button class="btn" id="r-add">追加</button></div>
        <div class="err" id="r-err"></div>
        <div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="r-save">保存</button></div>`, { wide: true });
      const draw = () => {
        el.querySelector('#r-list').innerHTML = `<table class="tbl"><tr><th>ID</th><th>表示名</th><th>役職</th><th>表示</th><th></th></tr>${list.map((r, i) => `<tr data-i="${i}">
          <td class="small" style="font-family:ui-monospace,Menlo,monospace">${esc(r.id)}</td>
          <td><input type="text" data-f="name" value="${esc(r.name)}" placeholder="${esc(r.id)}"></td>
          <td><input type="text" data-f="role" value="${esc(r.role || '')}"></td>
          <td><input type="checkbox" data-f="shown" ${r.hidden ? '' : 'checked'}></td>
          <td style="white-space:nowrap"><button class="btn ghost sm" data-up ${i ? '' : 'disabled'}>↑</button><button class="btn ghost sm" data-down ${i < list.length - 1 ? '' : 'disabled'}>↓</button></td></tr>`).join('')}</table>`;
        el.querySelectorAll('#r-list tr[data-i]').forEach((tr) => {
          const i = +tr.dataset.i;
          tr.querySelector('[data-f=name]').oninput = (e) => { list[i].name = e.target.value; };
          tr.querySelector('[data-f=role]').oninput = (e) => { list[i].role = e.target.value; };
          tr.querySelector('[data-f=shown]').onchange = (e) => { list[i].hidden = !e.target.checked; };
          tr.querySelector('[data-up]').onclick = () => { [list[i - 1], list[i]] = [list[i], list[i - 1]]; draw(); };
          tr.querySelector('[data-down]').onclick = () => { [list[i + 1], list[i]] = [list[i], list[i + 1]]; draw(); };
        });
      };
      draw();
      el.querySelector('#r-add').onclick = () => {
        const id = el.querySelector('#r-id').value.trim(), name = el.querySelector('#r-name').value.trim();
        if (!/^[\w.-]{1,80}$/.test(id)) { el.querySelector('#r-err').textContent = 'ID は半角英数字と - _ . で入力してください'; return; }
        if (list.some((r) => r.id === id)) { el.querySelector('#r-err').textContent = 'その ID はすでにあります'; return; }
        list.push({ id, name, role: '', hidden: false });
        el.querySelector('#r-id').value = ''; el.querySelector('#r-name').value = ''; el.querySelector('#r-err').textContent = '';
        draw();
      };
      el.querySelector('#r-save').onclick = async () => {
        try { st.meta = await api('PUT', '/api/plat/roster', { rows: list }); close(); toast('行を保存しました'); render(); }
        catch (e) { el.querySelector('#r-err').textContent = e.message; }
      };
    }

    // ---------------------------------------------------------------- events
    if (!frozen) { $('#tg-new').onclick = () => taskModal(null); $('#tg-rows').onclick = rowsModal; }
    grid.addEventListener('click', (e) => {
      if (e.target.closest('#tg-done') || e.target.closest('[data-more]')) { st.showAllDone = !st.showAllDone; render(); return; }
      const add = e.target.closest('[data-add]');
      if (add) { const c = add.closest('.tg-cell'); st.inline = { row: c.dataset.row || null, status: c.dataset.status }; render(); return; }
      const card = e.target.closest('.tcard[data-id]');
      if (!card || e.target.closest('.t-edit')) return;
      const t = store.tasks().find((x) => x.id === card.dataset.id); if (!t) return;
      // Click writes on the card; ⋯ (or any click on a read-only board) opens the details.
      if (e.target.closest('[data-detail]') || !canEdit()) { taskModal(t); return; }
      st.editing = { id: t.id, row: card.dataset.row || null };
      render();
    });
    grid.addEventListener('keydown', (e) => {
      const ta = e.target.closest('.tcard.new textarea');
      const ed = e.target.closest('.t-edit');
      const enter = e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
      if (ta) {
        if (enter) { e.preventDefault(); const text = ta.value; ta.value = ''; commitInline(text, st.inline, true); }
        else if (e.key === 'Escape') { ta.value = ''; st.inline = null; render(); }
        return;
      }
      if (ed) {
        if (enter) { e.preventDefault(); const target = st.editing; st.editing = null; commitEdit(ed.value, target); }
        else if (e.key === 'Escape') { st.editing = null; render(); }
        return;
      }
      const card = e.target.closest('.tcard[data-id]');
      if (card && e.key === 'Enter') card.click();
    });
    grid.addEventListener('focusout', (e) => {
      const ta = e.target.closest('.tcard.new textarea');
      const ed = e.target.closest('.t-edit');
      if (ta && st.inline) {
        // Capture now: a click elsewhere (e.g. another ＋) may re-render and remove this textarea.
        const text = ta.value, target = st.inline;
        setTimeout(() => {
          const cur = grid.querySelector('.tcard.new textarea');
          if (cur && document.activeElement === cur && st.inline === target) return;  // our own re-render refocused it
          commitInline(text, target, false);
        }, 0);
      } else if (ed && st.editing) {
        const text = ed.value, target = st.editing;
        setTimeout(() => {
          const cur = grid.querySelector('.t-edit');
          if (cur && document.activeElement === cur && st.editing === target) return;
          commitEdit(text, target);
        }, 0);
      }
    });
    grid.addEventListener('compositionstart', () => { st.composing = true; });
    grid.addEventListener('compositionend', () => { st.composing = false; if (st.dirty) { st.dirty = false; render(); } });

    // drag a card: another column = status, another row = reassign
    grid.addEventListener('dragstart', (e) => {
      const card = e.target.closest('.tcard[data-id]'); if (!card) return;
      st.dragging = { id: card.dataset.id, row: card.dataset.row || null };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.id);
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    grid.addEventListener('dragend', () => { st.dragging = null; grid.querySelectorAll('.drop-hover, .dragging').forEach((x) => x.classList.remove('drop-hover', 'dragging')); });
    grid.addEventListener('dragover', (e) => {
      const cell = e.target.closest('.tg-cell'); if (!cell || !st.dragging) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      if (!cell.classList.contains('drop-hover')) { grid.querySelectorAll('.drop-hover').forEach((x) => x.classList.remove('drop-hover')); cell.classList.add('drop-hover'); }
    });
    grid.addEventListener('drop', (e) => {
      const cell = e.target.closest('.tg-cell'); if (!cell || !st.dragging) return;
      e.preventDefault();
      const { id, row: from } = st.dragging;
      st.dragging = null;
      const t = store.tasks().find((x) => x.id === id); if (!t) return;
      const to = cell.dataset.row || null;
      const changes = {};
      if (cell.dataset.status !== t.status) changes.status = cell.dataset.status;
      if (to !== from) {
        let a = (t.assignees || []).filter((x) => x !== from);
        if (to !== null && !a.includes(to)) a = [...a, to];
        changes.assignees = a;
      }
      if (!Object.keys(changes).length) { render(); return; }
      try { store.saveTask(id, changes); } catch (err) { toast(err.message, true); }
      if (changes.assignees && to === null && changes.assignees.length) toast(`${personName(from)} さんを担当から外しました`);
    });

    // ---------------------------------------------------------------- boot
    (async () => {
      try {
        if (frozen) st.meta = { ...opts.archive, sources: {} };
        else [st.meta] = await Promise.all([api('GET', '/api/plat/meta'), store.load()]);
        drawChrome();
        render();
      } catch (e) {
        grid.innerHTML = `<div class="empty" style="margin:20px">ボードを読み込めませんでした: ${esc(e.message)}</div>`;
      }
    })();

    return { destroy() { store.destroy(); } };
  }
  window.TaskGrid = TaskGrid;
})();
