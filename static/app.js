/* App shell: routing, auth, dashboard, sharing UI, admin panel. */
(function () {
  'use strict';
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${esc(u.color || '#8b8d98')}" title="${esc(u.display_name)}">${esc(initials(u.display_name))}</span>`;
  const timeAgo = (t) => { if (!t) return ''; const d = (Date.now() / 1000 - t); if (d < 60) return 'たった今'; if (d < 3600) return Math.floor(d / 60) + '分前'; if (d < 86400) return Math.floor(d / 3600) + '時間前'; if (d < 86400 * 30) return Math.floor(d / 86400) + '日前'; return new Date(t * 1000).toLocaleDateString('ja-JP'); };

  function toast(msg, isErr) {
    const t = document.createElement('div'); t.className = 'toast' + (isErr ? ' error' : ''); t.textContent = msg;
    document.getElementById('toasts').append(t); setTimeout(() => t.remove(), 3200);
  }
  async function api(method, url, body) {
    const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    let data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) { const err = new Error((data && data.detail) ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : r.statusText); err.status = r.status; throw err; }
    return data;
  }

  // ---------------------------------------------------------------- modal helper
  function modal(html, { wide } = {}) {
    const bd = document.createElement('div'); bd.className = 'modal-backdrop';
    const m = document.createElement('div'); m.className = 'modal' + (wide ? ' wide' : ''); m.innerHTML = html;
    bd.append(m); document.body.append(bd);
    const close = () => bd.remove();
    bd.addEventListener('pointerdown', (e) => { if (e.target === bd) close(); });
    const onKey = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    m.querySelectorAll('[data-close]').forEach((b) => (b.onclick = close));
    return { el: m, close };
  }
  function confirmDialog(title, text, okLabel = '削除') {
    return new Promise((res) => {
      const { el, close } = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`);
      el.querySelector('#ok').onclick = () => { close(); res(true); };
      el.querySelector('[data-close]').addEventListener('click', () => res(false));
    });
  }
  function promptDialog(title, label, value = '', okLabel = '保存') {
    return new Promise((res) => {
      const { el, close } = modal(`<h2>${esc(title)}</h2><label class="field"><span>${esc(label)}</span><input id="v" type="text" value="${esc(value)}"></label><div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="ok">${esc(okLabel)}</button></div>`);
      const inp = el.querySelector('#v'); inp.focus(); inp.select();
      const ok = () => { close(); res(inp.value.trim()); };
      el.querySelector('#ok').onclick = ok; inp.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
      el.querySelector('[data-close]').addEventListener('click', () => res(null));
    });
  }

  // ---------------------------------------------------------------- state & routing
  const S = { user: null, guest: null, settings: {}, editor: null };
  function nav(path) { history.pushState(null, '', path); route(); }
  window.addEventListener('popstate', route);
  document.addEventListener('click', (e) => { const a = e.target.closest('a[data-nav]'); if (a) { e.preventDefault(); nav(a.getAttribute('href')); } });

  async function loadMe() { const d = await api('GET', '/api/auth/me'); S.user = d.user; S.guest = d.guest; S.settings = d.settings; document.title = S.settings.org_name || 'ホワイトボード'; }

  async function route() {
    if (S.editor) { S.editor.destroy(); S.editor = null; }
    const p = location.pathname;
    let m;
    if ((m = p.match(/^\/s\/([\w-]+)$/))) return renderShareLanding(m[1]);
    if ((m = p.match(/^\/b\/([\w-]+)$/))) return renderBoard(m[1]);
    if (!S.user) return renderAuth();
    if (p === '/admin') return S.user.role === 'admin' ? renderAdmin() : nav('/');
    return renderDashboard();
  }

  // ---------------------------------------------------------------- auth
  function renderAuth(next) {
    // First-run admin setup screen disabled: it made the sign-up flow confusing for
    // new colleagues. Everyone now sees the same sign-in / register card.
    // const setup = S.settings.setup_needed;
    let mode = 'login';
    const draw = () => {
      app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
        <div class="brand"><span class="logo"></span>${esc(S.settings.org_name || 'ホワイトボード')}</div>
        <p class="muted" style="margin:14px 0 20px">${mode === 'login' ? 'IDとパスワードでサインインしてください。' : 'アカウントを作成します。'}</p>
        <form id="f">
          <label class="field"><span>ユーザーID（半角英数字）</span><input name="username" autocomplete="username" required autofocus placeholder="例: k.minami"></label>
          ${mode === 'register' ? '<label class="field"><span>表示名</span><input name="display_name" placeholder="他のメンバーに表示される名前"></label>' : ''}
          <label class="field"><span>パスワード${mode === 'register' ? '（8文字以上）' : ''}</span><input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="${mode === 'login' ? 1 : 8}"></label>
          ${mode === 'register' && S.settings.registration_code_required ? '<label class="field"><span>招待コード</span><input name="code" autocomplete="off" required placeholder="管理者から受け取ったコード"></label>' : ''}
          <button class="btn primary" style="width:100%;justify-content:center;padding:10px" type="submit">${mode === 'login' ? 'サインイン' : 'アカウントを作成'}</button>
          <div class="err" id="err"></div>
        </form>
        <div class="divider"></div>${mode === 'login'
          ? '<button type="button" class="btn" id="sw" style="width:100%;justify-content:center">新しいアカウントを登録</button>'
          : '<div class="small muted" style="text-align:center">すでにアカウントをお持ちですか？ <a href="#" id="sw">サインイン</a></div>'}
      </div></div>`;
      const sw = app.querySelector('#sw'); if (sw) sw.onclick = (e) => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; draw(); };
      app.querySelector('#f').onsubmit = async (e) => {
        e.preventDefault(); const fd = new FormData(e.target); const body = Object.fromEntries(fd.entries());
        try { await api('POST', mode === 'login' ? '/api/auth/login' : '/api/auth/register', body); await loadMe(); if (next) next(); else route(); }
        catch (err) { app.querySelector('#err').textContent = err.message; }
      };
    };
    draw();
  }

  function topbar(extra = '') {
    const u = S.user;
    return `<div class="topbar">
      <a href="/" data-nav class="brand" style="color:inherit"><span class="logo"></span>${esc(S.settings.org_name || 'ホワイトボード')}</a>
      <div class="grow"></div>${extra}
      ${u.role === 'admin' ? `<a href="/admin" data-nav class="btn ghost sm">管理</a>` : ''}
      <button class="btn ghost sm" id="profile" title="プロフィール">${avatar(u)} <span>${esc(u.display_name)}</span></button>
      <button class="btn ghost sm" id="logout">サインアウト</button>
    </div>`;
  }
  function wireTopbar() {
    app.querySelector('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); S.user = null; S.guest = null; nav('/'); };
    app.querySelector('#profile').onclick = profileModal;
  }
  function profileModal() {
    const u = S.user;
    const colors = ['#F24E1E', '#FF7262', '#A259FF', '#1ABCFE', '#0ACF83', '#FFB800', '#E91E63', '#3F51B5', '#009688', '#795548', '#607D8B', '#8BC34A'];
    const { el, close } = modal(`<h2>プロフィール</h2>
      <div class="row" style="margin-bottom:14px">${avatar(u, 'lg')}<div><div style="font-weight:650">${esc(u.display_name)}</div><div class="small muted">ID: ${esc(u.username)} · ${u.role === 'admin' ? '管理者' : 'メンバー'}</div></div></div>
      <label class="field"><span>表示名</span><input id="dn" value="${esc(u.display_name)}"></label>
      <label class="field"><span>アバターの色</span><div class="row" style="flex-wrap:wrap;gap:6px">${colors.map((c) => `<button type="button" class="sw-c" data-c="${c}" style="width:26px;height:26px;border-radius:50%;background:${c};border:3px solid ${c === u.color ? '#1c1f2b' : 'transparent'}"></button>`).join('')}</div></label>
      <div class="divider"></div>
      <label class="field"><span>現在のパスワード（パスワード変更時のみ）</span><input id="cp" type="password" autocomplete="current-password"></label>
      <label class="field"><span>新しいパスワード（8文字以上）</span><input id="np" type="password" autocomplete="new-password" minlength="8"></label>
      <div class="err" id="err"></div>
      <div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="save">保存</button></div>`);
    let color = u.color;
    el.querySelectorAll('.sw-c').forEach((b) => (b.onclick = () => { color = b.dataset.c; el.querySelectorAll('.sw-c').forEach((x) => (x.style.borderColor = x.dataset.c === color ? '#1c1f2b' : 'transparent')); }));
    el.querySelector('#save').onclick = async () => {
      const body = { display_name: el.querySelector('#dn').value, color };
      const np = el.querySelector('#np').value; if (np) { body.new_password = np; body.current_password = el.querySelector('#cp').value; }
      try { const d = await api('PATCH', '/api/auth/me', body); S.user = d.user; close(); toast('プロフィールを保存しました'); route(); } catch (e) { el.querySelector('#err').textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- dashboard
  async function renderDashboard() {
    app.innerHTML = topbar() + `<div class="dash"><div class="row between" style="flex-wrap:wrap;gap:12px"><h1 style="font-size:22px">ボード</h1><div class="row"><input type="search" id="q" placeholder="ボードを検索…" style="width:220px"><button class="btn" id="import">JSONをインポート</button><button class="btn primary" id="new">+ 新しいボード</button></div></div><div id="lists"><p class="muted" style="margin-top:30px">読み込み中…</p></div></div>`;
    wireTopbar();
    app.querySelector('#new').onclick = newBoardModal;
    app.querySelector('#import').onclick = importBoard;
    let data;
    try { data = await api('GET', '/api/boards'); } catch (e) { toast(e.message, true); return; }
    const lists = app.querySelector('#lists');
    const draw = () => {
      const q = (app.querySelector('#q').value || '').toLowerCase();
      const f = (arr) => arr.filter((b) => !q || b.name.toLowerCase().includes(q) || (b.owner && b.owner.display_name.toLowerCase().includes(q)));
      const all = [...data.owned, ...data.shared, ...data.team];
      const favs = f(all.filter((b) => b.favorite));
      let html = '';
      if (data.invitations.length) html += `<h2>招待</h2><div class="card">${data.invitations.map((i) => `<div class="invite-row"><div class="grow"><b>${esc(i.inviter_name || '誰か')}</b> さんから <b>${esc(i.name)}</b> に${roleLabel(i.role)}として招待されています</div><button class="btn sm" data-decline="${i.board_id}">辞退</button><button class="btn primary sm" data-accept="${i.board_id}">参加</button></div>`).join('')}</div>`;
      if (favs.length) html += `<h2>スター付き</h2><div class="board-grid">${favs.map(cardHtml).join('')}</div>`;
      html += `<h2>自分のボード <span class="pill gray">${data.owned.length}</span></h2><div class="board-grid">${!q ? '<button class="new-card" id="new2">+ 新しいボード</button>' : ''}${f(data.owned).map(cardHtml).join('')}</div>`;
      html += `<h2>共有されたボード <span class="pill gray">${data.shared.length}</span></h2>${data.shared.length ? `<div class="board-grid">${f(data.shared).map(cardHtml).join('')}</div>` : '<div class="empty">他のメンバーから招待されたボードがここに表示されます。</div>'}`;
      html += `<h2>チームボード <span class="pill gray">${data.team.length}</span></h2>${data.team.length ? `<div class="board-grid">${f(data.team).map(cardHtml).join('')}</div>` : '<div class="empty">「チーム全員」に公開されたボードがここに表示されます。</div>'}`;
      lists.innerHTML = html;
      lists.querySelector('#new2')?.addEventListener('click', newBoardModal);
      lists.querySelectorAll('.board-card').forEach((c) => {
        c.onclick = (e) => { if (e.target.closest('.fav, .card-menu')) return; nav('/b/' + c.dataset.id); };
        c.querySelector('.fav').onclick = async (e) => { e.stopPropagation(); const r = await api('POST', `/api/boards/${c.dataset.id}/favorite`); for (const b of all) if (b.id === c.dataset.id) b.favorite = r.favorite; draw(); };
        c.querySelector('.card-menu').onclick = (e) => { e.stopPropagation(); boardCardMenu(all.find((b) => b.id === c.dataset.id), e.currentTarget, async () => { data = await api('GET', '/api/boards'); draw(); }); };
      });
      lists.querySelectorAll('[data-accept]').forEach((b) => (b.onclick = async () => { await api('POST', `/api/invitations/${b.dataset.accept}/accept`); nav('/b/' + b.dataset.accept); }));
      lists.querySelectorAll('[data-decline]').forEach((b) => (b.onclick = async () => { await api('POST', `/api/invitations/${b.dataset.decline}/decline`); data = await api('GET', '/api/boards'); draw(); }));
    };
    app.querySelector('#q').oninput = draw;
    draw();
  }
  const roleLabel = (r) => ({ owner: 'オーナー', editor: '編集者', viewer: '閲覧者', admin: '管理者', member: 'メンバー' }[r] || r);
  function cardHtml(b) {
    const notes = ['#fff176', '#90caf9', '#f8bbd0', '#a5d6a7', '#ffab91'];
    const n = Math.min(5, Math.max(0, b.item_count));
    const thumbs = Array.from({ length: n }, (_, i) => `<span class="note" style="background:${notes[i % notes.length]};left:${18 + i * 34}px;top:${28 + (i % 2) * 22}px;transform:rotate(${(i % 3) * 3 - 3}deg)"></span>`).join('');
    const vis = b.visibility === 'team' ? `<span class="pill">チーム · ${b.team_permission === 'edit' ? '編集可' : '閲覧のみ'}</span>` : '<span class="pill gray">プライベート</span>';
    const mine = S.user && b.owner_id === S.user.id;
    return `<div class="card board-card" data-id="${b.id}">
      <div class="thumb">${thumbs}${b.online ? `<span class="pill green online">● ${b.online}人が閲覧中</span>` : ''}<button class="fav ${b.favorite ? 'on' : ''}" title="スター">★</button></div>
      <div class="meta"><div class="name">${esc(b.name)}</div>
        <div class="row between"><div class="small muted">${mine ? '自分' : esc(b.owner?.display_name || '')} · ${b.item_count}件 · ${timeAgo(b.updated_at)}</div><button class="btn ghost icon sm card-menu" title="メニュー">⋯</button></div>
        <div style="margin-top:8px">${vis}${b.my_role ? ` <span class="pill gray">${roleLabel(b.my_role)}</span>` : ''}</div></div></div>`;
  }
  function boardCardMenu(b, anchor, refresh) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const m = document.createElement('div'); m.className = 'menu'; m.style.cssText = `position:fixed;left:${Math.min(r.left, window.innerWidth - 220)}px;top:${r.bottom + 4}px`;
    const mine = b.owner_id === S.user.id || S.user.role === 'admin';
    m.innerHTML = `<button data-a="open">開く</button><button data-a="dup">複製</button><button data-a="export">JSONをエクスポート</button>${mine ? '<div class="sep"></div><button data-a="rename">名前を変更</button><button data-a="share">共有設定…</button><button data-a="delete" class="danger">ボードを削除</button>' : '<div class="sep"></div><button data-a="leave" class="danger">ボードから退出</button>'}`;
    document.body.append(m);
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    m.onclick = async (e) => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return; m.remove();
      try {
        if (a === 'open') nav('/b/' + b.id);
        if (a === 'dup') { const d = await api('POST', `/api/boards/${b.id}/duplicate`); toast('ボードを複製しました'); nav('/b/' + d.board.id); }
        if (a === 'export') window.location.href = `/api/boards/${b.id}/export`;
        if (a === 'rename') { const n = await promptDialog('ボード名を変更', 'ボード名', b.name); if (n) { await api('PATCH', `/api/boards/${b.id}`, { name: n }); refresh(); } }
        if (a === 'share') shareModal(b.id, () => refresh());
        if (a === 'delete') { if (await confirmDialog('ボードを削除しますか？', `「${b.name}」とその内容はすべて完全に削除されます。`)) { await api('DELETE', `/api/boards/${b.id}`); toast('ボードを削除しました'); refresh(); } }
        if (a === 'leave') { if (await confirmDialog('ボードから退出しますか？', `再度招待されるまで「${b.name}」にアクセスできなくなります。`, '退出')) { await api('POST', `/api/boards/${b.id}/leave`); refresh(); } }
      } catch (err) { toast(err.message, true); }
    };
  }
  function newBoardModal() {
    const { el, close } = modal(`<h2>新しいボード</h2>
      <label class="field"><span>名前</span><input id="name" placeholder="例: 第4四半期ブレスト" autofocus></label>
      <label class="field"><span>アクセスできる人</span>
        <div class="seg" id="vis"><button data-v="private" class="active">プライベート（招待制）</button><button data-v="team">チーム全員</button></div></label>
      <label class="field hidden" id="tp-wrap"><span>チームメンバーの権限</span><div class="seg" id="tp"><button data-v="edit" class="active">編集可</button><button data-v="view">閲覧のみ</button></div></label>
      <div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="ok">ボードを作成</button></div>`);
    let vis = 'private', tp = 'edit';
    el.querySelectorAll('#vis button').forEach((b) => (b.onclick = () => { vis = b.dataset.v; el.querySelectorAll('#vis button').forEach((x) => x.classList.toggle('active', x === b)); el.querySelector('#tp-wrap').classList.toggle('hidden', vis !== 'team'); }));
    el.querySelectorAll('#tp button').forEach((b) => (b.onclick = () => { tp = b.dataset.v; el.querySelectorAll('#tp button').forEach((x) => x.classList.toggle('active', x === b)); }));
    const ok = async () => { try { const d = await api('POST', '/api/boards', { name: el.querySelector('#name').value.trim() || '無題のボード', visibility: vis, team_permission: tp }); close(); nav('/b/' + d.board.id); } catch (e) { toast(e.message, true); } };
    el.querySelector('#ok').onclick = ok; el.querySelector('#name').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    el.querySelector('#name').focus();
  }
  function importBoard() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const d = await api('POST', '/api/boards/import', { name: j.name || f.name.replace(/\.json$/i, ''), items: j.items || [], description: j.description || '' }); toast('ボードをインポートしました'); nav('/b/' + d.board.id); } catch (e) { toast('インポートに失敗しました: ' + e.message, true); } };
    inp.click();
  }

  // ---------------------------------------------------------------- share modal
  async function shareModal(boardId, onChange) {
    let data;
    try { data = await api('GET', `/api/boards/${boardId}`); } catch (e) { toast(e.message, true); return; }
    const isOwner = data.permission === 'owner';
    const { el, close } = modal(`<h2>「${esc(data.board.name)}」を共有</h2>
      <div class="tabs"><button class="active" data-tab="members">メンバー</button><button data-tab="links">共有リンク</button><button data-tab="settings">アクセス</button></div>
      <div id="tab-members">
        <div class="row"><input id="inv-user" placeholder="ユーザーIDで招待…" list="userlist" autocomplete="off"><datalist id="userlist"></datalist><select id="inv-role" style="width:auto"><option value="editor">編集可</option><option value="viewer">閲覧のみ</option></select><button class="btn primary" id="inv">招待</button></div>
        <div class="err" id="inv-err"></div>
        <div id="members" style="margin-top:8px"></div>
      </div>
      <div id="tab-links" class="hidden">
        <p class="small muted">リンクを知っている人は誰でもボードを開けます。許可した場合はアカウントなし（ゲスト）でも開けます。リンクはいつでも無効化できます。</p>
        <div id="links"></div>
        ${isOwner ? `<div class="divider"></div><div class="row" style="flex-wrap:wrap"><select id="lnk-perm" style="width:auto"><option value="view">閲覧のみ</option><option value="edit">編集可</option></select><select id="lnk-exp" style="width:auto"><option value="">無期限</option><option value="1">1日で期限切れ</option><option value="7">7日で期限切れ</option><option value="30">30日で期限切れ</option></select><label class="switch on" id="lnk-guest"><i></i><span class="small">ゲストを許可（アカウント不要）</span></label><button class="btn primary sm" id="lnk-new">リンクを作成</button></div>` : ''}
      </div>
      <div id="tab-settings" class="hidden">
        <label class="field"><span>ボードの公開範囲</span><div class="seg" id="vis"><button data-v="private" class="${data.board.visibility === 'private' ? 'active' : ''}">プライベート（招待制）</button><button data-v="team" class="${data.board.visibility === 'team' ? 'active' : ''}">チーム全員</button></div></label>
        <label class="field ${data.board.visibility === 'team' ? '' : 'hidden'}" id="tp-wrap"><span>チームメンバーの権限</span><div class="seg" id="tp"><button data-v="edit" class="${data.board.team_permission === 'edit' ? 'active' : ''}">編集可</button><button data-v="view" class="${data.board.team_permission === 'view' ? 'active' : ''}">閲覧のみ</button></div></label>
        <p class="small muted">招待されたメンバーは、公開範囲に関係なく個別の役割が維持されます。</p>
        ${isOwner ? `<div class="divider"></div><div class="row between"><div><b>所有権の譲渡</b><div class="small muted">このボードを他のメンバーに譲ります。</div></div><button class="btn sm" id="transfer">譲渡…</button></div>` : ''}
      </div>
      <div class="actions"><button class="btn" data-close>完了</button></div>`, { wide: true });

    el.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { el.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); ['members', 'links', 'settings'].forEach((t) => el.querySelector('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab)); }));

    const drawMembers = (members) => {
      const me = S.user?.id;
      el.querySelector('#members').innerHTML = members.map((m) => `<div class="member-row">${avatar(m)}<div class="grow"><div>${esc(m.display_name)} ${m.id === me ? '<span class="small muted">（自分）</span>' : ''}</div><div class="small muted">${esc(m.username)}${m.status === 'pending' ? ' · <span class="pill amber">招待中</span>' : ''}</div></div>
        ${m.role === 'owner' ? '<span class="pill">オーナー</span>' : isOwner ? `<select data-role="${m.id}"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>編集可</option><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>閲覧のみ</option></select><button class="btn ghost sm danger" data-rm="${m.id}" title="削除">✕</button>` : `<span class="pill gray">${roleLabel(m.role)}</span>`}</div>`).join('');
      el.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { const d = await api('PATCH', `/api/boards/${boardId}/members/${s.dataset.role}`, { role: s.value }); drawMembers(d.members); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { try { const d = await api('DELETE', `/api/boards/${boardId}/members/${b.dataset.rm}`); drawMembers(d.members); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
    };
    drawMembers(data.members);
    const invInput = el.querySelector('#inv-user');
    invInput.oninput = async () => { const q = invInput.value.trim(); if (q.length < 1) return; try { const d = await api('GET', `/api/users?q=${encodeURIComponent(q)}`); el.querySelector('#userlist').innerHTML = d.users.map((u) => `<option value="${esc(u.username)}">${esc(u.display_name)}</option>`).join(''); } catch (_) {} };
    const invite = async () => { const username = invInput.value.trim(); if (!username) return; try { const d = await api('POST', `/api/boards/${boardId}/invite`, { username, role: el.querySelector('#inv-role').value }); drawMembers(d.members); invInput.value = ''; el.querySelector('#inv-err').textContent = ''; toast(`${username} さんに招待を送りました`); onChange && onChange(); } catch (e) { el.querySelector('#inv-err').textContent = e.message; } };
    el.querySelector('#inv').onclick = invite; invInput.onkeydown = (e) => { if (e.key === 'Enter') invite(); };

    const drawLinks = (links) => {
      const box = el.querySelector('#links');
      if (!links.length) { box.innerHTML = '<div class="empty" style="padding:16px">共有リンクはまだありません。</div>'; return; }
      box.innerHTML = links.map((l) => `<div class="link-box"><span class="pill ${l.permission === 'edit' ? '' : 'gray'}">${l.permission === 'edit' ? '編集可' : '閲覧のみ'}</span>${l.allow_guests ? '<span class="pill gray">ゲスト可</span>' : '<span class="pill gray">サインイン必須</span>'}${l.expired ? '<span class="pill amber">期限切れ</span>' : l.expires_at ? `<span class="pill gray">${new Date(l.expires_at * 1000).toLocaleDateString('ja-JP')} まで</span>` : ''}<code>${location.origin}/s/${l.token}</code><button class="btn sm" data-copy="${l.token}">コピー</button>${isOwner ? `<button class="btn ghost sm danger" data-del="${l.token}" title="無効化">✕</button>` : ''}</div>`).join('');
      box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(`${location.origin}/s/${b.dataset.copy}`); toast('リンクをコピーしました'); } catch (_) { prompt('このリンクをコピーしてください', `${location.origin}/s/${b.dataset.copy}`); } }));
      box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('リンクを無効化しますか？', 'このリンクを使っている人は直ちにアクセスできなくなります。', '無効化')) { const d = await api('DELETE', `/api/boards/${boardId}/links/${b.dataset.del}`); drawLinks(d.links); } }));
    };
    try { drawLinks((await api('GET', `/api/boards/${boardId}/links`)).links); } catch (_) { el.querySelector('#links').innerHTML = ''; }
    if (isOwner) {
      const g = el.querySelector('#lnk-guest'); g.onclick = () => g.classList.toggle('on');
      el.querySelector('#lnk-new').onclick = async () => { try { const exp = el.querySelector('#lnk-exp').value; const d = await api('POST', `/api/boards/${boardId}/links`, { permission: el.querySelector('#lnk-perm').value, allow_guests: g.classList.contains('on'), expires_days: exp ? +exp : null }); drawLinks(d.links); toast('共有リンクを作成しました'); } catch (e) { toast(e.message, true); } };
      el.querySelectorAll('#vis button').forEach((b) => (b.onclick = async () => { try { await api('PATCH', `/api/boards/${boardId}`, { visibility: b.dataset.v }); el.querySelectorAll('#vis button').forEach((x) => x.classList.toggle('active', x === b)); el.querySelector('#tp-wrap').classList.toggle('hidden', b.dataset.v !== 'team'); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelectorAll('#tp button').forEach((b) => (b.onclick = async () => { try { await api('PATCH', `/api/boards/${boardId}`, { team_permission: b.dataset.v }); el.querySelectorAll('#tp button').forEach((x) => x.classList.toggle('active', x === b)); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelector('#transfer').onclick = async () => {
        const members = (await api('GET', `/api/boards/${boardId}/members`)).members.filter((m) => m.role !== 'owner' && m.status === 'active');
        if (!members.length) { toast('先にメンバーを招待してから所有権を譲渡してください。', true); return; }
        const { el: t, close: c2 } = modal(`<h2>所有権の譲渡</h2><label class="field"><span>新しいオーナー</span><select id="to">${members.map((m) => `<option value="${m.id}">${esc(m.display_name)} (${esc(m.username)})</option>`).join('')}</select></label><p class="small muted">あなたは編集者としてボードに残ります。</p><div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="ok">譲渡</button></div>`);
        t.querySelector('#ok').onclick = async () => { try { await api('POST', `/api/boards/${boardId}/transfer`, { user_id: t.querySelector('#to').value }); c2(); close(); toast('所有権を譲渡しました'); onChange && onChange(); } catch (e) { toast(e.message, true); } };
      };
    } else { el.querySelectorAll('#vis button, #tp button').forEach((b) => (b.disabled = true)); }
  }

  // ---------------------------------------------------------------- board view
  async function renderBoard(boardId) {
    let data;
    try { data = await api('GET', `/api/boards/${boardId}`); }
    catch (e) {
      if (e.status === 401) { renderAuth(() => nav('/b/' + boardId)); return; }
      app.innerHTML = (S.user ? topbar() : '') + `<div class="dash"><div class="empty" style="margin-top:40px"><h2 style="font-size:16px;color:var(--ink);text-transform:none;letter-spacing:0">${e.status === 404 ? 'ボードが見つかりません' : 'このボードにアクセスできません'}</h2><p class="muted">${esc(e.message)}</p><a href="/" data-nav class="btn primary">ボード一覧へ戻る</a></div></div>`;
      if (S.user) wireTopbar();
      return;
    }
    app.innerHTML = '';
    const ed = window.BoardEditor(app, {
      boardId, initial: data, toast,
      onBack: () => nav(S.user ? '/' : '/'),
      onShare: () => { if (data.me.guest) { toast('共有設定を変更するにはサインインしてください', true); return; } shareModal(boardId, async () => { try { const d = await api('GET', `/api/boards/${boardId}`); ed.setMembers(d.members); } catch (_) {} }); },
      onRename: async (name) => { try { const d = await api('PATCH', `/api/boards/${boardId}`, { name }); ed.setBoard(d.board); } catch (e) { toast(e.message, true); ed.setBoard(data.board); } },
      onDuplicate: async () => { try { const d = await api('POST', `/api/boards/${boardId}/duplicate`); toast('ボードを複製しました'); nav('/b/' + d.board.id); } catch (e) { toast(e.message, true); } },
      onDelete: async () => { if (await confirmDialog('ボードを削除しますか？', 'このボードの内容はすべて完全に削除されます。')) { try { await api('DELETE', `/api/boards/${boardId}`); nav('/'); } catch (e) { toast(e.message, true); } } },
      onShortcuts: shortcutsModal,
      onSaveVersion: async () => { const label = await promptDialog('バージョンを保存', 'ラベル（任意）', '', '保存'); if (label === null) return; try { await api('POST', `/api/boards/${boardId}/snapshots`, { label }); toast('バージョンを保存しました'); } catch (e) { toast(e.message, true); } },
      onHistory: () => historyModal(boardId, data.permission),
      onKicked: () => { toast('このボードへのアクセス権がなくなりました', true); nav('/'); },
      onDeleted: () => { toast('このボードは削除されました', true); nav('/'); },
      onBoardUpdate: (b) => { data.board = b; },
    });
    S.editor = ed;
  }
  async function historyModal(boardId, perm) {
    const canEdit = perm === 'edit' || perm === 'owner';
    const { el, close } = modal(`<h2>バージョン履歴</h2><p class="small muted">作業中は数分ごとに自動でバージョンが保存され、手動でも保存できます。復元時は現在の状態もバージョンとして保存されるため、内容が失われることはありません。</p><div id="list"><p class="muted">読み込み中…</p></div><div class="actions">${canEdit ? '<button class="btn" id="save">現在の状態を保存</button>' : ''}<button class="btn primary" data-close>閉じる</button></div>`, { wide: true });
    const draw = async () => {
      let snaps; try { snaps = (await api('GET', `/api/boards/${boardId}/snapshots`)).snapshots; } catch (e) { toast(e.message, true); return; }
      el.querySelector('#list').innerHTML = snaps.length ? `<table class="tbl"><tr><th>日時</th><th>種類</th><th>保存者</th><th>件数</th><th></th></tr>${snaps.map((s) => `<tr><td>${new Date(s.created_at * 1000).toLocaleString('ja-JP')}<div class="small muted">${timeAgo(s.created_at)}</div></td><td>${s.kind === 'manual' ? `<span class="pill">${esc(s.label || '手動保存')}</span>` : '<span class="pill gray">自動</span>'}</td><td>${esc(s.author || (s.created_by && s.created_by.startsWith('guest_') ? 'ゲスト' : '—'))}</td><td>${s.item_count}</td><td style="text-align:right;white-space:nowrap"><button class="btn sm" data-dl="${s.id}">ダウンロード</button>${canEdit ? `<button class="btn sm primary" data-restore="${s.id}">復元</button>` : ''}${perm === 'owner' ? `<button class="btn ghost sm danger" data-del="${s.id}" title="バージョンを削除">✕</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">まだバージョンはありません。ボードを編集すると表示されます。</div>';
      el.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => { const d = await api('GET', `/api/boards/${boardId}/snapshots/${b.dataset.dl}`); const blob = new Blob([JSON.stringify({ format: 'whiteboard/v1', name: `version-${b.dataset.dl}`, items: d.snapshot.items }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `board-version-${new Date(d.snapshot.created_at * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`; a.click(); }));
      el.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('このバージョンを復元しますか？', '全員のボードがこのバージョンに置き換わります。現在の状態は先にバージョンとして保存されます。', '復元')) { try { await api('POST', `/api/boards/${boardId}/snapshots/${b.dataset.restore}/restore`); toast('バージョンを復元しました'); close(); } catch (e) { toast(e.message, true); } } }));
      el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/api/boards/${boardId}/snapshots/${b.dataset.del}`); draw(); }));
    };
    const sv = el.querySelector('#save'); if (sv) sv.onclick = async () => { const label = await promptDialog('バージョンを保存', 'ラベル（任意）', '', '保存'); if (label === null) return; await api('POST', `/api/boards/${boardId}/snapshots`, { label }); draw(); };
    draw();
  }
  function shortcutsModal() {
    const rows = [['V', '選択'], ['H', 'パン（Space長押し / 中ボタンでも可）'], ['N', '付箋'], ['T', 'テキスト'], ['S', '図形'], ['F', 'フレーム'], ['L / A', '線 / 矢印'], ['P', 'ペン'], ['キャンバスをダブルクリック', '新しい付箋'], ['アイテムをダブルクリック', 'テキストを編集'], ['Enter', '選択中のアイテムを編集'], ['Esc', '編集終了 / 選択解除'], ['Del', '削除'], ['Ctrl+Z / Shift+Ctrl+Z', '元に戻す / やり直す'], ['Ctrl+C / V / D', 'コピー / 貼り付け / 複製'], ['Ctrl+A', 'すべて選択'], ['[ / ]', '背面へ / 前面へ'], ['矢印キー', '微調整（Shiftで10px）'], ['スクロール', 'パン'], ['Ctrl+スクロール / ピンチ', 'ズーム'], ['Ctrl+0', 'ズームをリセット'], ['Shift+1', '全体を表示'], ['Shift+角をドラッグ', '自由なサイズ変更（付箋は比率維持）']];
    modal(`<h2>キーボードショートカット</h2><table class="tbl">${rows.map(([k, d]) => `<tr><td style="width:45%"><b>${esc(k)}</b></td><td>${esc(d)}</td></tr>`).join('')}</table><div class="actions"><button class="btn primary" data-close>閉じる</button></div>`);
  }

  // ---------------------------------------------------------------- share landing
  async function renderShareLanding(token) {
    let info;
    try { info = await api('GET', `/api/share/${token}`); }
    catch (e) { app.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><h2 style="font-size:18px">リンクを開けません</h2><p class="muted">${esc(e.message)}</p><a href="/" data-nav class="btn primary">ボード一覧へ</a></div></div>`; return; }
    if (info.signed_in) { try { const d = await api('POST', `/api/share/${token}/join`, {}); nav('/b/' + d.board_id); } catch (e) { toast(e.message, true); nav('/'); } return; }
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><span class="logo"></span>${esc(S.settings.org_name || 'ホワイトボード')}</div>
      <h2 style="font-size:20px;margin:18px 0 4px">${esc(info.board_name)}</h2>
      <p class="muted" style="margin:0 0 18px">${esc(info.owner_name)} さんがこのボードを共有しました · ${info.permission === 'edit' ? '編集できます' : '閲覧のみ'}</p>
      ${info.allow_guests ? `<label class="field"><span>あなたの名前（他の人に表示されます）</span><input id="gname" placeholder="例: 太郎" value="${esc(info.guest?.display_name || '')}" autofocus></label><button class="btn primary" id="guest" style="width:100%;justify-content:center;padding:10px">ゲストとして続ける</button><div class="err" id="err"></div><div class="divider"></div>` : '<p class="small muted">このリンクを開くにはアカウントが必要です。</p>'}
      <button class="btn" id="signin" style="width:100%;justify-content:center">アカウントでサインイン</button>
    </div></div>`;
    const g = app.querySelector('#guest');
    if (g) { const go = async () => { try { const d = await api('POST', `/api/share/${token}/join`, { guest_name: app.querySelector('#gname').value.trim() || 'ゲスト' }); await loadMe(); nav('/b/' + d.board_id); } catch (e) { app.querySelector('#err').textContent = e.message; } }; g.onclick = go; app.querySelector('#gname').onkeydown = (e) => { if (e.key === 'Enter') go(); }; }
    app.querySelector('#signin').onclick = () => renderAuth(() => renderShareLanding(token));
  }

  // ---------------------------------------------------------------- admin
  async function renderAdmin() {
    app.innerHTML = topbar() + `<div class="dash"><h1 style="font-size:22px">管理</h1>
      <div class="tabs" style="margin-top:16px"><button class="active" data-tab="users">メンバー</button><button data-tab="boards">すべてのボード</button><button data-tab="settings">設定</button></div>
      <div id="tab-users"><div class="row between" style="margin-bottom:12px"><span class="muted small" id="ucount"></span><button class="btn primary" id="adduser">+ メンバーを追加</button></div><div class="card" id="users"></div></div>
      <div id="tab-boards" class="hidden"><div class="card" id="boards"></div></div>
      <div id="tab-settings" class="hidden"><div class="card" style="padding:18px;max-width:520px">
        <div class="row between" style="margin-bottom:14px"><div><b>フルバックアップ</b><div class="small muted">すべてのボード・メンバー・アイテムを1つのJSONファイルに書き出します。</div></div><a class="btn" href="/api/admin/export">ダウンロード</a></div><div class="divider"></div>
        <label class="field"><span>組織名</span><div class="row"><input id="org"><button class="btn" id="saveorg">保存</button></div></label>
        <div class="divider"></div>
        <div><b>招待コード</b><div class="small muted" id="regcode" style="margin-top:4px"></div></div>
        <p class="small muted" style="margin-top:10px">招待コードはサーバーの環境変数 <code>REGISTRATION_CODE</code>（ローカルでは <code>.env</code> ファイル）で設定します。設定するとサインイン画面に「招待コード」欄が現れ、コードを知っている人だけが自分のアカウントを作成できます。未設定なら誰でも登録できます。変更後はサーバーの再起動が必要です。メンバータブから直接追加することもできます。</p>
      </div></div></div>`;
    wireTopbar();
    app.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { app.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); ['users', 'boards', 'settings'].forEach((t) => app.querySelector('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab)); }));

    const loadUsers = async () => {
      const d = await api('GET', '/api/admin/users');
      app.querySelector('#ucount').textContent = `メンバー ${d.users.length}人`;
      app.querySelector('#users').innerHTML = `<table class="tbl"><tr><th>メンバー</th><th>ID</th><th>役割</th><th>状態</th><th>ボード数</th><th>登録</th><th></th></tr>${d.users.map((u) => `<tr data-id="${u.id}">
        <td><div class="row">${avatar(u)}<span>${esc(u.display_name)}</span></div></td><td class="muted">${esc(u.username)}</td>
        <td><select data-role ${u.id === S.user.id ? 'disabled' : ''} style="width:auto;padding:4px 8px"><option value="member" ${u.role === 'member' ? 'selected' : ''}>メンバー</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>管理者</option></select></td>
        <td>${u.active ? '<span class="pill green">有効</span>' : '<span class="pill gray">無効</span>'}</td><td>${u.board_count}</td><td class="small muted">${timeAgo(u.created_at)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-pw>パスワード再設定</button>${u.id !== S.user.id ? `<button class="btn ghost sm" data-toggle>${u.active ? '無効化' : '再有効化'}</button><button class="btn ghost sm danger" data-del>削除</button>` : ''}</td></tr>`).join('')}</table>`;
      app.querySelectorAll('#users tr[data-id]').forEach((tr) => {
        const id = tr.dataset.id, u = d.users.find((x) => x.id === id);
        tr.querySelector('[data-role]').onchange = async (e) => { try { await api('PATCH', `/api/admin/users/${id}`, { role: e.target.value }); toast('役割を更新しました'); } catch (err) { toast(err.message, true); loadUsers(); } };
        tr.querySelector('[data-pw]').onclick = async () => { const p = await promptDialog(`${u.username} のパスワードを再設定`, '新しいパスワード（8文字以上）', '', '再設定'); if (p) { try { await api('PATCH', `/api/admin/users/${id}`, { password: p }); toast('パスワードを再設定しました。このユーザーのセッションはサインアウトされました'); } catch (err) { toast(err.message, true); } } };
        tr.querySelector('[data-toggle]')?.addEventListener('click', async () => { try { await api('PATCH', `/api/admin/users/${id}`, { active: !u.active }); loadUsers(); } catch (err) { toast(err.message, true); } });
        tr.querySelector('[data-del]')?.addEventListener('click', async () => { if (await confirmDialog(`${u.username} を削除しますか？`, 'このユーザーのボードはあなたに移管されます。この操作は取り消せません。')) { try { await api('DELETE', `/api/admin/users/${id}`); loadUsers(); } catch (err) { toast(err.message, true); } } });
      });
    };
    app.querySelector('#adduser').onclick = () => {
      const { el, close } = modal(`<h2>メンバーを追加</h2><label class="field"><span>ユーザーID（半角英数字）</span><input id="u" placeholder="例: t.suzuki" autofocus></label><label class="field"><span>表示名</span><input id="d"></label><label class="field"><span>仮パスワード（8文字以上）</span><input id="p" type="text" value="${Math.random().toString(36).slice(2, 12)}"></label><label class="field"><span>役割</span><select id="r"><option value="member">メンバー</option><option value="admin">管理者</option></select></label><div class="err" id="err"></div><div class="actions"><button class="btn" data-close>キャンセル</button><button class="btn primary" id="ok">追加</button></div>`);
      el.querySelector('#ok').onclick = async () => { try { await api('POST', '/api/admin/users', { username: el.querySelector('#u').value.trim(), display_name: el.querySelector('#d').value.trim(), password: el.querySelector('#p').value, role: el.querySelector('#r').value }); close(); toast('メンバーを追加しました'); loadUsers(); } catch (e) { el.querySelector('#err').textContent = e.message; } };
    };
    const loadBoards = async () => {
      const d = await api('GET', '/api/admin/boards');
      app.querySelector('#boards').innerHTML = d.boards.length ? `<table class="tbl"><tr><th>ボード</th><th>オーナー</th><th>公開範囲</th><th>件数</th><th>メンバー</th><th>更新</th><th></th></tr>${d.boards.map((b) => `<tr><td><a href="/b/${b.id}" data-nav>${esc(b.name)}</a></td><td>${esc(b.owner?.display_name || '—')}</td><td>${b.visibility === 'team' ? '<span class="pill">チーム</span>' : '<span class="pill gray">プライベート</span>'}</td><td>${b.item_count}</td><td>${b.member_count}</td><td class="small muted">${timeAgo(b.updated_at)}</td><td style="text-align:right"><button class="btn ghost sm danger" data-del="${b.id}" data-name="${esc(b.name)}">削除</button></td></tr>`).join('')}</table>` : '<div class="empty">ボードはまだありません。</div>';
      app.querySelectorAll('#boards [data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('ボードを削除しますか？', `「${b.dataset.name}」は完全に削除されます。`)) { await api('DELETE', `/api/boards/${b.dataset.del}`); loadBoards(); } }));
    };
    const loadSettings = async () => {
      const s = await api('GET', '/api/admin/settings');
      app.querySelector('#org').value = s.org_name;
      app.querySelector('#regcode').textContent = s.registration_code_required
        ? '設定済み — 登録には招待コードが必要です'
        : '未設定 — 誰でも自分のアカウントを作成できます';
      app.querySelector('#saveorg').onclick = async () => { try { const d = await api('PATCH', '/api/admin/settings', { org_name: app.querySelector('#org').value }); S.settings = d; toast('保存しました'); document.title = d.org_name; } catch (e) { toast(e.message, true); } };
    };
    try { await Promise.all([loadUsers(), loadBoards(), loadSettings()]); } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- boot
  loadMe().then(route).catch((e) => { app.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><h2>サーバーに接続できません</h2><p class="muted">${esc(e.message)}</p></div></div>`; });
})();
