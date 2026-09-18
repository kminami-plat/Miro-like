/* App shell: routing, auth, dashboard, sharing UI, admin panel. */
(function () {
  'use strict';
  const app = document.getElementById('app');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = (n) => (n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const avatar = (u, cls = '') => `<span class="avatar ${cls}" style="background:${esc(u.color || '#8b8d98')}" title="${esc(u.display_name)}">${esc(initials(u.display_name))}</span>`;
  const timeAgo = (t) => { if (!t) return ''; const d = (Date.now() / 1000 - t); if (d < 60) return 'just now'; if (d < 3600) return Math.floor(d / 60) + ' min ago'; if (d < 86400) return Math.floor(d / 3600) + ' h ago'; if (d < 86400 * 30) return Math.floor(d / 86400) + ' d ago'; return new Date(t * 1000).toLocaleDateString(); };

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
  function confirmDialog(title, text, okLabel = 'Delete') {
    return new Promise((res) => {
      const { el, close } = modal(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`);
      el.querySelector('#ok').onclick = () => { close(); res(true); };
      el.querySelector('[data-close]').addEventListener('click', () => res(false));
    });
  }
  function promptDialog(title, label, value = '', okLabel = 'Save') {
    return new Promise((res) => {
      const { el, close } = modal(`<h2>${esc(title)}</h2><label class="field"><span>${esc(label)}</span><input id="v" type="text" value="${esc(value)}"></label><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">${esc(okLabel)}</button></div>`);
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

  async function loadMe() { const d = await api('GET', '/api/auth/me'); S.user = d.user; S.guest = d.guest; S.settings = d.settings; document.title = S.settings.org_name || 'Whiteboard'; }

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
        <div class="brand"><span class="logo"></span>${esc(S.settings.org_name || 'Whiteboard')}</div>
        <p class="muted" style="margin:14px 0 20px">${mode === 'login' ? 'Sign in with your ID and password.' : 'Create your account.'}</p>
        <form id="f">
          <label class="field"><span>User ID</span><input name="username" autocomplete="username" required autofocus placeholder="e.g. k.minami"></label>
          ${mode === 'register' ? '<label class="field"><span>Display name</span><input name="display_name" placeholder="Shown to teammates"></label>' : ''}
          <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="4"></label>
          <button class="btn primary" style="width:100%;justify-content:center;padding:10px" type="submit">${mode === 'login' ? 'Sign in' : 'Create account'}</button>
          <div class="err" id="err"></div>
        </form>
        <div class="divider"></div>${mode === 'login'
          ? '<button type="button" class="btn" id="sw" style="width:100%;justify-content:center">Register a new account</button>'
          : '<div class="small muted" style="text-align:center">Already have an account? <a href="#" id="sw">Sign in</a></div>'}
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
      <a href="/" data-nav class="brand" style="color:inherit"><span class="logo"></span>${esc(S.settings.org_name || 'Whiteboard')}</a>
      <div class="grow"></div>${extra}
      ${u.role === 'admin' ? `<a href="/admin" data-nav class="btn ghost sm">Admin</a>` : ''}
      <button class="btn ghost sm" id="profile" title="Profile">${avatar(u)} <span>${esc(u.display_name)}</span></button>
      <button class="btn ghost sm" id="logout">Sign out</button>
    </div>`;
  }
  function wireTopbar() {
    app.querySelector('#logout').onclick = async () => { await api('POST', '/api/auth/logout'); S.user = null; S.guest = null; nav('/'); };
    app.querySelector('#profile').onclick = profileModal;
  }
  function profileModal() {
    const u = S.user;
    const colors = ['#F24E1E', '#FF7262', '#A259FF', '#1ABCFE', '#0ACF83', '#FFB800', '#E91E63', '#3F51B5', '#009688', '#795548', '#607D8B', '#8BC34A'];
    const { el, close } = modal(`<h2>Your profile</h2>
      <div class="row" style="margin-bottom:14px">${avatar(u, 'lg')}<div><div style="font-weight:650">${esc(u.display_name)}</div><div class="small muted">ID: ${esc(u.username)} · ${u.role}</div></div></div>
      <label class="field"><span>Display name</span><input id="dn" value="${esc(u.display_name)}"></label>
      <label class="field"><span>Avatar color</span><div class="row" style="flex-wrap:wrap;gap:6px">${colors.map((c) => `<button type="button" class="sw-c" data-c="${c}" style="width:26px;height:26px;border-radius:50%;background:${c};border:3px solid ${c === u.color ? '#1c1f2b' : 'transparent'}"></button>`).join('')}</div></label>
      <div class="divider"></div>
      <label class="field"><span>Current password (only to change password)</span><input id="cp" type="password" autocomplete="current-password"></label>
      <label class="field"><span>New password</span><input id="np" type="password" autocomplete="new-password" minlength="4"></label>
      <div class="err" id="err"></div>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="save">Save</button></div>`);
    let color = u.color;
    el.querySelectorAll('.sw-c').forEach((b) => (b.onclick = () => { color = b.dataset.c; el.querySelectorAll('.sw-c').forEach((x) => (x.style.borderColor = x.dataset.c === color ? '#1c1f2b' : 'transparent')); }));
    el.querySelector('#save').onclick = async () => {
      const body = { display_name: el.querySelector('#dn').value, color };
      const np = el.querySelector('#np').value; if (np) { body.new_password = np; body.current_password = el.querySelector('#cp').value; }
      try { const d = await api('PATCH', '/api/auth/me', body); S.user = d.user; close(); toast('Profile saved'); route(); } catch (e) { el.querySelector('#err').textContent = e.message; }
    };
  }

  // ---------------------------------------------------------------- dashboard
  async function renderDashboard() {
    app.innerHTML = topbar() + `<div class="dash"><div class="row between" style="flex-wrap:wrap;gap:12px"><h1 style="font-size:22px">Boards</h1><div class="row"><input type="search" id="q" placeholder="Search boards…" style="width:220px"><button class="btn" id="import">Import JSON</button><button class="btn primary" id="new">+ New board</button></div></div><div id="lists"><p class="muted" style="margin-top:30px">Loading…</p></div></div>`;
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
      if (data.invitations.length) html += `<h2>Invitations</h2><div class="card">${data.invitations.map((i) => `<div class="invite-row"><div class="grow"><b>${esc(i.inviter_name || 'Someone')}</b> invited you to <b>${esc(i.name)}</b> as ${i.role}</div><button class="btn sm" data-decline="${i.board_id}">Decline</button><button class="btn primary sm" data-accept="${i.board_id}">Accept</button></div>`).join('')}</div>`;
      if (favs.length) html += `<h2>Starred</h2><div class="board-grid">${favs.map(cardHtml).join('')}</div>`;
      html += `<h2>My boards <span class="pill gray">${data.owned.length}</span></h2><div class="board-grid">${!q ? '<button class="new-card" id="new2">+ New board</button>' : ''}${f(data.owned).map(cardHtml).join('')}</div>`;
      html += `<h2>Shared with me <span class="pill gray">${data.shared.length}</span></h2>${data.shared.length ? `<div class="board-grid">${f(data.shared).map(cardHtml).join('')}</div>` : '<div class="empty">Boards others invite you to will appear here.</div>'}`;
      html += `<h2>Team boards <span class="pill gray">${data.team.length}</span></h2>${data.team.length ? `<div class="board-grid">${f(data.team).map(cardHtml).join('')}</div>` : '<div class="empty">Boards set to "Everyone in the team" appear here.</div>'}`;
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
  function cardHtml(b) {
    const notes = ['#fff176', '#90caf9', '#f8bbd0', '#a5d6a7', '#ffab91'];
    const n = Math.min(5, Math.max(0, b.item_count));
    const thumbs = Array.from({ length: n }, (_, i) => `<span class="note" style="background:${notes[i % notes.length]};left:${18 + i * 34}px;top:${28 + (i % 2) * 22}px;transform:rotate(${(i % 3) * 3 - 3}deg)"></span>`).join('');
    const vis = b.visibility === 'team' ? `<span class="pill">Team · ${b.team_permission === 'edit' ? 'can edit' : 'view only'}</span>` : '<span class="pill gray">Private</span>';
    const mine = S.user && b.owner_id === S.user.id;
    return `<div class="card board-card" data-id="${b.id}">
      <div class="thumb">${thumbs}${b.online ? `<span class="pill green online">● ${b.online} online</span>` : ''}<button class="fav ${b.favorite ? 'on' : ''}" title="Star">★</button></div>
      <div class="meta"><div class="name">${esc(b.name)}</div>
        <div class="row between"><div class="small muted">${mine ? 'You' : esc(b.owner?.display_name || '')} · ${b.item_count} items · ${timeAgo(b.updated_at)}</div><button class="btn ghost icon sm card-menu" title="More">⋯</button></div>
        <div style="margin-top:8px">${vis}${b.my_role ? ` <span class="pill gray">${b.my_role}</span>` : ''}</div></div></div>`;
  }
  function boardCardMenu(b, anchor, refresh) {
    document.querySelectorAll('.menu').forEach((m) => m.remove());
    const r = anchor.getBoundingClientRect();
    const m = document.createElement('div'); m.className = 'menu'; m.style.cssText = `position:fixed;left:${Math.min(r.left, window.innerWidth - 220)}px;top:${r.bottom + 4}px`;
    const mine = b.owner_id === S.user.id || S.user.role === 'admin';
    m.innerHTML = `<button data-a="open">Open</button><button data-a="dup">Duplicate</button><button data-a="export">Export JSON</button>${mine ? '<div class="sep"></div><button data-a="rename">Rename</button><button data-a="share">Sharing…</button><button data-a="delete" class="danger">Delete board</button>' : '<div class="sep"></div><button data-a="leave" class="danger">Leave board</button>'}`;
    document.body.append(m);
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    m.onclick = async (e) => {
      const a = e.target.closest('button')?.dataset.a; if (!a) return; m.remove();
      try {
        if (a === 'open') nav('/b/' + b.id);
        if (a === 'dup') { const d = await api('POST', `/api/boards/${b.id}/duplicate`); toast('Board duplicated'); nav('/b/' + d.board.id); }
        if (a === 'export') window.location.href = `/api/boards/${b.id}/export`;
        if (a === 'rename') { const n = await promptDialog('Rename board', 'Board name', b.name); if (n) { await api('PATCH', `/api/boards/${b.id}`, { name: n }); refresh(); } }
        if (a === 'share') shareModal(b.id, () => refresh());
        if (a === 'delete') { if (await confirmDialog('Delete board?', `"${b.name}" and everything on it will be permanently deleted.`)) { await api('DELETE', `/api/boards/${b.id}`); toast('Board deleted'); refresh(); } }
        if (a === 'leave') { if (await confirmDialog('Leave board?', `You will lose access to "${b.name}" unless invited again.`, 'Leave')) { await api('POST', `/api/boards/${b.id}/leave`); refresh(); } }
      } catch (err) { toast(err.message, true); }
    };
  }
  function newBoardModal() {
    const { el, close } = modal(`<h2>New board</h2>
      <label class="field"><span>Name</span><input id="name" placeholder="e.g. Q4 brainstorm" autofocus></label>
      <label class="field"><span>Who can access</span>
        <div class="seg" id="vis"><button data-v="private" class="active">Private (invite only)</button><button data-v="team">Everyone in the team</button></div></label>
      <label class="field hidden" id="tp-wrap"><span>Team members can</span><div class="seg" id="tp"><button data-v="edit" class="active">Edit</button><button data-v="view">View only</button></div></label>
      <div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Create board</button></div>`);
    let vis = 'private', tp = 'edit';
    el.querySelectorAll('#vis button').forEach((b) => (b.onclick = () => { vis = b.dataset.v; el.querySelectorAll('#vis button').forEach((x) => x.classList.toggle('active', x === b)); el.querySelector('#tp-wrap').classList.toggle('hidden', vis !== 'team'); }));
    el.querySelectorAll('#tp button').forEach((b) => (b.onclick = () => { tp = b.dataset.v; el.querySelectorAll('#tp button').forEach((x) => x.classList.toggle('active', x === b)); }));
    const ok = async () => { try { const d = await api('POST', '/api/boards', { name: el.querySelector('#name').value.trim() || 'Untitled board', visibility: vis, team_permission: tp }); close(); nav('/b/' + d.board.id); } catch (e) { toast(e.message, true); } };
    el.querySelector('#ok').onclick = ok; el.querySelector('#name').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    el.querySelector('#name').focus();
  }
  function importBoard() {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = async () => { const f = inp.files[0]; if (!f) return; try { const j = JSON.parse(await f.text()); const d = await api('POST', '/api/boards/import', { name: j.name || f.name.replace(/\.json$/i, ''), items: j.items || [], description: j.description || '' }); toast('Board imported'); nav('/b/' + d.board.id); } catch (e) { toast('Import failed: ' + e.message, true); } };
    inp.click();
  }

  // ---------------------------------------------------------------- share modal
  async function shareModal(boardId, onChange) {
    let data;
    try { data = await api('GET', `/api/boards/${boardId}`); } catch (e) { toast(e.message, true); return; }
    const isOwner = data.permission === 'owner';
    const { el, close } = modal(`<h2>Share “${esc(data.board.name)}”</h2>
      <div class="tabs"><button class="active" data-tab="members">Members</button><button data-tab="links">Share links</button><button data-tab="settings">Access</button></div>
      <div id="tab-members">
        <div class="row"><input id="inv-user" placeholder="Invite by user ID…" list="userlist" autocomplete="off"><datalist id="userlist"></datalist><select id="inv-role" style="width:auto"><option value="editor">Can edit</option><option value="viewer">Can view</option></select><button class="btn primary" id="inv">Invite</button></div>
        <div class="err" id="inv-err"></div>
        <div id="members" style="margin-top:8px"></div>
      </div>
      <div id="tab-links" class="hidden">
        <p class="small muted">Anyone with a link can open the board — even without an account (as a guest) if allowed. Links can be revoked at any time.</p>
        <div id="links"></div>
        ${isOwner ? `<div class="divider"></div><div class="row" style="flex-wrap:wrap"><select id="lnk-perm" style="width:auto"><option value="view">Can view</option><option value="edit">Can edit</option></select><select id="lnk-exp" style="width:auto"><option value="">Never expires</option><option value="1">Expires in 1 day</option><option value="7">Expires in 7 days</option><option value="30">Expires in 30 days</option></select><label class="switch on" id="lnk-guest"><i></i><span class="small">Allow guests (no account)</span></label><button class="btn primary sm" id="lnk-new">Create link</button></div>` : ''}
      </div>
      <div id="tab-settings" class="hidden">
        <label class="field"><span>Board visibility</span><div class="seg" id="vis"><button data-v="private" class="${data.board.visibility === 'private' ? 'active' : ''}">Private (invite only)</button><button data-v="team" class="${data.board.visibility === 'team' ? 'active' : ''}">Everyone in the team</button></div></label>
        <label class="field ${data.board.visibility === 'team' ? '' : 'hidden'}" id="tp-wrap"><span>Team members can</span><div class="seg" id="tp"><button data-v="edit" class="${data.board.team_permission === 'edit' ? 'active' : ''}">Edit</button><button data-v="view" class="${data.board.team_permission === 'view' ? 'active' : ''}">View only</button></div></label>
        <p class="small muted">Invited members keep their individual roles regardless of visibility.</p>
        ${isOwner ? `<div class="divider"></div><div class="row between"><div><b>Transfer ownership</b><div class="small muted">Give this board to another member.</div></div><button class="btn sm" id="transfer">Transfer…</button></div>` : ''}
      </div>
      <div class="actions"><button class="btn" data-close>Done</button></div>`, { wide: true });

    el.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { el.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); ['members', 'links', 'settings'].forEach((t) => el.querySelector('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab)); }));

    const drawMembers = (members) => {
      const me = S.user?.id;
      el.querySelector('#members').innerHTML = members.map((m) => `<div class="member-row">${avatar(m)}<div class="grow"><div>${esc(m.display_name)} ${m.id === me ? '<span class="small muted">(you)</span>' : ''}</div><div class="small muted">${esc(m.username)}${m.status === 'pending' ? ' · <span class="pill amber">invitation pending</span>' : ''}</div></div>
        ${m.role === 'owner' ? '<span class="pill">Owner</span>' : isOwner ? `<select data-role="${m.id}"><option value="editor" ${m.role === 'editor' ? 'selected' : ''}>Can edit</option><option value="viewer" ${m.role === 'viewer' ? 'selected' : ''}>Can view</option></select><button class="btn ghost sm danger" data-rm="${m.id}" title="Remove">✕</button>` : `<span class="pill gray">${m.role}</span>`}</div>`).join('');
      el.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { const d = await api('PATCH', `/api/boards/${boardId}/members/${s.dataset.role}`, { role: s.value }); drawMembers(d.members); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => { try { const d = await api('DELETE', `/api/boards/${boardId}/members/${b.dataset.rm}`); drawMembers(d.members); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
    };
    drawMembers(data.members);
    const invInput = el.querySelector('#inv-user');
    invInput.oninput = async () => { const q = invInput.value.trim(); if (q.length < 1) return; try { const d = await api('GET', `/api/users?q=${encodeURIComponent(q)}`); el.querySelector('#userlist').innerHTML = d.users.map((u) => `<option value="${esc(u.username)}">${esc(u.display_name)}</option>`).join(''); } catch (_) {} };
    const invite = async () => { const username = invInput.value.trim(); if (!username) return; try { const d = await api('POST', `/api/boards/${boardId}/invite`, { username, role: el.querySelector('#inv-role').value }); drawMembers(d.members); invInput.value = ''; el.querySelector('#inv-err').textContent = ''; toast(`Invitation sent to ${username}`); onChange && onChange(); } catch (e) { el.querySelector('#inv-err').textContent = e.message; } };
    el.querySelector('#inv').onclick = invite; invInput.onkeydown = (e) => { if (e.key === 'Enter') invite(); };

    const drawLinks = (links) => {
      const box = el.querySelector('#links');
      if (!links.length) { box.innerHTML = '<div class="empty" style="padding:16px">No share links yet.</div>'; return; }
      box.innerHTML = links.map((l) => `<div class="link-box"><span class="pill ${l.permission === 'edit' ? '' : 'gray'}">${l.permission === 'edit' ? 'Can edit' : 'Can view'}</span>${l.allow_guests ? '<span class="pill gray">guests ok</span>' : '<span class="pill gray">sign-in required</span>'}${l.expired ? '<span class="pill amber">expired</span>' : l.expires_at ? `<span class="pill gray">expires ${new Date(l.expires_at * 1000).toLocaleDateString()}</span>` : ''}<code>${location.origin}/s/${l.token}</code><button class="btn sm" data-copy="${l.token}">Copy</button>${isOwner ? `<button class="btn ghost sm danger" data-del="${l.token}" title="Revoke">✕</button>` : ''}</div>`).join('');
      box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = async () => { try { await navigator.clipboard.writeText(`${location.origin}/s/${b.dataset.copy}`); toast('Link copied'); } catch (_) { prompt('Copy this link', `${location.origin}/s/${b.dataset.copy}`); } }));
      box.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('Revoke link?', 'Anyone using this link will lose access immediately.', 'Revoke')) { const d = await api('DELETE', `/api/boards/${boardId}/links/${b.dataset.del}`); drawLinks(d.links); } }));
    };
    try { drawLinks((await api('GET', `/api/boards/${boardId}/links`)).links); } catch (_) { el.querySelector('#links').innerHTML = ''; }
    if (isOwner) {
      const g = el.querySelector('#lnk-guest'); g.onclick = () => g.classList.toggle('on');
      el.querySelector('#lnk-new').onclick = async () => { try { const exp = el.querySelector('#lnk-exp').value; const d = await api('POST', `/api/boards/${boardId}/links`, { permission: el.querySelector('#lnk-perm').value, allow_guests: g.classList.contains('on'), expires_days: exp ? +exp : null }); drawLinks(d.links); toast('Share link created'); } catch (e) { toast(e.message, true); } };
      el.querySelectorAll('#vis button').forEach((b) => (b.onclick = async () => { try { await api('PATCH', `/api/boards/${boardId}`, { visibility: b.dataset.v }); el.querySelectorAll('#vis button').forEach((x) => x.classList.toggle('active', x === b)); el.querySelector('#tp-wrap').classList.toggle('hidden', b.dataset.v !== 'team'); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelectorAll('#tp button').forEach((b) => (b.onclick = async () => { try { await api('PATCH', `/api/boards/${boardId}`, { team_permission: b.dataset.v }); el.querySelectorAll('#tp button').forEach((x) => x.classList.toggle('active', x === b)); onChange && onChange(); } catch (e) { toast(e.message, true); } }));
      el.querySelector('#transfer').onclick = async () => {
        const members = (await api('GET', `/api/boards/${boardId}/members`)).members.filter((m) => m.role !== 'owner' && m.status === 'active');
        if (!members.length) { toast('Invite someone first, then transfer ownership.', true); return; }
        const { el: t, close: c2 } = modal(`<h2>Transfer ownership</h2><label class="field"><span>New owner</span><select id="to">${members.map((m) => `<option value="${m.id}">${esc(m.display_name)} (${esc(m.username)})</option>`).join('')}</select></label><p class="small muted">You will remain on the board as an editor.</p><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Transfer</button></div>`);
        t.querySelector('#ok').onclick = async () => { try { await api('POST', `/api/boards/${boardId}/transfer`, { user_id: t.querySelector('#to').value }); c2(); close(); toast('Ownership transferred'); onChange && onChange(); } catch (e) { toast(e.message, true); } };
      };
    } else { el.querySelectorAll('#vis button, #tp button').forEach((b) => (b.disabled = true)); }
  }

  // ---------------------------------------------------------------- board view
  async function renderBoard(boardId) {
    let data;
    try { data = await api('GET', `/api/boards/${boardId}`); }
    catch (e) {
      if (e.status === 401) { renderAuth(() => nav('/b/' + boardId)); return; }
      app.innerHTML = (S.user ? topbar() : '') + `<div class="dash"><div class="empty" style="margin-top:40px"><h2 style="font-size:16px;color:var(--ink);text-transform:none;letter-spacing:0">${e.status === 404 ? 'Board not found' : 'No access to this board'}</h2><p class="muted">${esc(e.message)}</p><a href="/" data-nav class="btn primary">Back to boards</a></div></div>`;
      if (S.user) wireTopbar();
      return;
    }
    app.innerHTML = '';
    const ed = window.BoardEditor(app, {
      boardId, initial: data, toast,
      onBack: () => nav(S.user ? '/' : '/'),
      onShare: () => { if (data.me.guest) { toast('Sign in to manage sharing', true); return; } shareModal(boardId, async () => { try { const d = await api('GET', `/api/boards/${boardId}`); ed.setMembers(d.members); } catch (_) {} }); },
      onRename: async (name) => { try { const d = await api('PATCH', `/api/boards/${boardId}`, { name }); ed.setBoard(d.board); } catch (e) { toast(e.message, true); ed.setBoard(data.board); } },
      onDuplicate: async () => { try { const d = await api('POST', `/api/boards/${boardId}/duplicate`); toast('Board duplicated'); nav('/b/' + d.board.id); } catch (e) { toast(e.message, true); } },
      onDelete: async () => { if (await confirmDialog('Delete board?', 'Everything on this board will be permanently deleted.')) { try { await api('DELETE', `/api/boards/${boardId}`); nav('/'); } catch (e) { toast(e.message, true); } } },
      onShortcuts: shortcutsModal,
      onSaveVersion: async () => { const label = await promptDialog('Save version', 'Label (optional)', '', 'Save'); if (label === null) return; try { await api('POST', `/api/boards/${boardId}/snapshots`, { label }); toast('Version saved'); } catch (e) { toast(e.message, true); } },
      onHistory: () => historyModal(boardId, data.permission),
      onKicked: () => { toast('You no longer have access to this board', true); nav('/'); },
      onDeleted: () => { toast('This board was deleted', true); nav('/'); },
      onBoardUpdate: (b) => { data.board = b; },
    });
    S.editor = ed;
  }
  async function historyModal(boardId, perm) {
    const canEdit = perm === 'edit' || perm === 'owner';
    const { el, close } = modal(`<h2>Version history</h2><p class="small muted">A version is saved automatically every few minutes while people work, plus whenever someone saves one manually. Restoring keeps the current state as a version too, so nothing is lost.</p><div id="list"><p class="muted">Loading…</p></div><div class="actions">${canEdit ? '<button class="btn" id="save">Save current version</button>' : ''}<button class="btn primary" data-close>Close</button></div>`, { wide: true });
    const draw = async () => {
      let snaps; try { snaps = (await api('GET', `/api/boards/${boardId}/snapshots`)).snapshots; } catch (e) { toast(e.message, true); return; }
      el.querySelector('#list').innerHTML = snaps.length ? `<table class="tbl"><tr><th>When</th><th>Type</th><th>By</th><th>Items</th><th></th></tr>${snaps.map((s) => `<tr><td>${new Date(s.created_at * 1000).toLocaleString()}<div class="small muted">${timeAgo(s.created_at)}</div></td><td>${s.kind === 'manual' ? `<span class="pill">${esc(s.label || 'Saved')}</span>` : '<span class="pill gray">auto</span>'}</td><td>${esc(s.author || (s.created_by && s.created_by.startsWith('guest_') ? 'Guest' : '—'))}</td><td>${s.item_count}</td><td style="text-align:right;white-space:nowrap"><button class="btn sm" data-dl="${s.id}">Download</button>${canEdit ? `<button class="btn sm primary" data-restore="${s.id}">Restore</button>` : ''}${perm === 'owner' ? `<button class="btn ghost sm danger" data-del="${s.id}" title="Delete version">✕</button>` : ''}</td></tr>`).join('')}</table>` : '<div class="empty">No versions yet. They appear as soon as the board is edited.</div>';
      el.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = async () => { const d = await api('GET', `/api/boards/${boardId}/snapshots/${b.dataset.dl}`); const blob = new Blob([JSON.stringify({ format: 'whiteboard/v1', name: `version-${b.dataset.dl}`, items: d.snapshot.items }, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `board-version-${new Date(d.snapshot.created_at * 1000).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.json`; a.click(); }));
      el.querySelectorAll('[data-restore]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('Restore this version?', 'The board will be replaced with this version for everyone. The current state is saved as a version first.', 'Restore')) { try { await api('POST', `/api/boards/${boardId}/snapshots/${b.dataset.restore}/restore`); toast('Version restored'); close(); } catch (e) { toast(e.message, true); } } }));
      el.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => { await api('DELETE', `/api/boards/${boardId}/snapshots/${b.dataset.del}`); draw(); }));
    };
    const sv = el.querySelector('#save'); if (sv) sv.onclick = async () => { const label = await promptDialog('Save version', 'Label (optional)', '', 'Save'); if (label === null) return; await api('POST', `/api/boards/${boardId}/snapshots`, { label }); draw(); };
    draw();
  }
  function shortcutsModal() {
    const rows = [['V', 'Select'], ['H', 'Pan (or hold Space / middle mouse)'], ['N', 'Sticky note'], ['T', 'Text'], ['S', 'Shape'], ['F', 'Frame'], ['L / A', 'Line / Arrow'], ['P', 'Pen'], ['Double-click canvas', 'New sticky note'], ['Double-click item', 'Edit text'], ['Enter', 'Edit selected'], ['Esc', 'Finish editing / deselect'], ['Del', 'Delete'], ['Ctrl+Z / Shift+Ctrl+Z', 'Undo / Redo'], ['Ctrl+C / V / D', 'Copy / Paste / Duplicate'], ['Ctrl+A', 'Select all'], ['[ / ]', 'Send back / bring front'], ['Arrows', 'Nudge (Shift = 10px)'], ['Scroll', 'Pan'], ['Ctrl+Scroll / pinch', 'Zoom'], ['Ctrl+0', 'Reset zoom'], ['Shift+1', 'Fit to content'], ['Shift+drag corner', 'Free resize (stickies keep ratio)']];
    modal(`<h2>Keyboard shortcuts</h2><table class="tbl">${rows.map(([k, d]) => `<tr><td style="width:45%"><b>${esc(k)}</b></td><td>${esc(d)}</td></tr>`).join('')}</table><div class="actions"><button class="btn primary" data-close>Close</button></div>`);
  }

  // ---------------------------------------------------------------- share landing
  async function renderShareLanding(token) {
    let info;
    try { info = await api('GET', `/api/share/${token}`); }
    catch (e) { app.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><h2 style="font-size:18px">Link unavailable</h2><p class="muted">${esc(e.message)}</p><a href="/" data-nav class="btn primary">Go to boards</a></div></div>`; return; }
    if (info.signed_in) { try { const d = await api('POST', `/api/share/${token}/join`, {}); nav('/b/' + d.board_id); } catch (e) { toast(e.message, true); nav('/'); } return; }
    app.innerHTML = `<div class="auth-wrap"><div class="card auth-card">
      <div class="brand"><span class="logo"></span>${esc(S.settings.org_name || 'Whiteboard')}</div>
      <h2 style="font-size:20px;margin:18px 0 4px">${esc(info.board_name)}</h2>
      <p class="muted" style="margin:0 0 18px">${esc(info.owner_name)} shared this board with you · ${info.permission === 'edit' ? 'you can edit' : 'view only'}</p>
      ${info.allow_guests ? `<label class="field"><span>Your name (shown to others)</span><input id="gname" placeholder="e.g. Taro" value="${esc(info.guest?.display_name || '')}" autofocus></label><button class="btn primary" id="guest" style="width:100%;justify-content:center;padding:10px">Continue as guest</button><div class="err" id="err"></div><div class="divider"></div>` : '<p class="small muted">This link requires an account.</p>'}
      <button class="btn" id="signin" style="width:100%;justify-content:center">Sign in with your account</button>
    </div></div>`;
    const g = app.querySelector('#guest');
    if (g) { const go = async () => { try { const d = await api('POST', `/api/share/${token}/join`, { guest_name: app.querySelector('#gname').value.trim() || 'Guest' }); await loadMe(); nav('/b/' + d.board_id); } catch (e) { app.querySelector('#err').textContent = e.message; } }; g.onclick = go; app.querySelector('#gname').onkeydown = (e) => { if (e.key === 'Enter') go(); }; }
    app.querySelector('#signin').onclick = () => renderAuth(() => renderShareLanding(token));
  }

  // ---------------------------------------------------------------- admin
  async function renderAdmin() {
    app.innerHTML = topbar() + `<div class="dash"><h1 style="font-size:22px">Administration</h1>
      <div class="tabs" style="margin-top:16px"><button class="active" data-tab="users">Members</button><button data-tab="boards">All boards</button><button data-tab="settings">Settings</button></div>
      <div id="tab-users"><div class="row between" style="margin-bottom:12px"><span class="muted small" id="ucount"></span><button class="btn primary" id="adduser">+ Add member</button></div><div class="card" id="users"></div></div>
      <div id="tab-boards" class="hidden"><div class="card" id="boards"></div></div>
      <div id="tab-settings" class="hidden"><div class="card" style="padding:18px;max-width:520px">
        <div class="row between" style="margin-bottom:14px"><div><b>Full backup</b><div class="small muted">Every board, member list and item as one JSON file.</div></div><a class="btn" href="/api/admin/export">Download</a></div><div class="divider"></div>
        <label class="field"><span>Organization name</span><div class="row"><input id="org"><button class="btn" id="saveorg">Save</button></div></label>
        <p class="small muted">Anyone can create their own account from the sign-in page. You can also add members yourself under Members.</p>
      </div></div></div>`;
    wireTopbar();
    app.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { app.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b)); ['users', 'boards', 'settings'].forEach((t) => app.querySelector('#tab-' + t).classList.toggle('hidden', t !== b.dataset.tab)); }));

    const loadUsers = async () => {
      const d = await api('GET', '/api/admin/users');
      app.querySelector('#ucount').textContent = `${d.users.length} member${d.users.length === 1 ? '' : 's'}`;
      app.querySelector('#users').innerHTML = `<table class="tbl"><tr><th>Member</th><th>ID</th><th>Role</th><th>Status</th><th>Boards</th><th>Joined</th><th></th></tr>${d.users.map((u) => `<tr data-id="${u.id}">
        <td><div class="row">${avatar(u)}<span>${esc(u.display_name)}</span></div></td><td class="muted">${esc(u.username)}</td>
        <td><select data-role ${u.id === S.user.id ? 'disabled' : ''} style="width:auto;padding:4px 8px"><option value="member" ${u.role === 'member' ? 'selected' : ''}>Member</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option></select></td>
        <td>${u.active ? '<span class="pill green">Active</span>' : '<span class="pill gray">Deactivated</span>'}</td><td>${u.board_count}</td><td class="small muted">${timeAgo(u.created_at)}</td>
        <td style="text-align:right;white-space:nowrap"><button class="btn ghost sm" data-pw>Reset password</button>${u.id !== S.user.id ? `<button class="btn ghost sm" data-toggle>${u.active ? 'Deactivate' : 'Reactivate'}</button><button class="btn ghost sm danger" data-del>Delete</button>` : ''}</td></tr>`).join('')}</table>`;
      app.querySelectorAll('#users tr[data-id]').forEach((tr) => {
        const id = tr.dataset.id, u = d.users.find((x) => x.id === id);
        tr.querySelector('[data-role]').onchange = async (e) => { try { await api('PATCH', `/api/admin/users/${id}`, { role: e.target.value }); toast('Role updated'); } catch (err) { toast(err.message, true); loadUsers(); } };
        tr.querySelector('[data-pw]').onclick = async () => { const p = await promptDialog(`Reset password for ${u.username}`, 'New password (min 4 chars)', '', 'Reset'); if (p) { try { await api('PATCH', `/api/admin/users/${id}`, { password: p }); toast('Password reset; their sessions were signed out'); } catch (err) { toast(err.message, true); } } };
        tr.querySelector('[data-toggle]')?.addEventListener('click', async () => { try { await api('PATCH', `/api/admin/users/${id}`, { active: !u.active }); loadUsers(); } catch (err) { toast(err.message, true); } });
        tr.querySelector('[data-del]')?.addEventListener('click', async () => { if (await confirmDialog(`Delete ${u.username}?`, 'Their boards will be transferred to you. This cannot be undone.')) { try { await api('DELETE', `/api/admin/users/${id}`); loadUsers(); } catch (err) { toast(err.message, true); } } });
      });
    };
    app.querySelector('#adduser').onclick = () => {
      const { el, close } = modal(`<h2>Add member</h2><label class="field"><span>User ID</span><input id="u" placeholder="e.g. t.suzuki" autofocus></label><label class="field"><span>Display name</span><input id="d"></label><label class="field"><span>Temporary password</span><input id="p" type="text" value="${Math.random().toString(36).slice(2, 10)}"></label><label class="field"><span>Role</span><select id="r"><option value="member">Member</option><option value="admin">Admin</option></select></label><div class="err" id="err"></div><div class="actions"><button class="btn" data-close>Cancel</button><button class="btn primary" id="ok">Add</button></div>`);
      el.querySelector('#ok').onclick = async () => { try { await api('POST', '/api/admin/users', { username: el.querySelector('#u').value.trim(), display_name: el.querySelector('#d').value.trim(), password: el.querySelector('#p').value, role: el.querySelector('#r').value }); close(); toast('Member added'); loadUsers(); } catch (e) { el.querySelector('#err').textContent = e.message; } };
    };
    const loadBoards = async () => {
      const d = await api('GET', '/api/admin/boards');
      app.querySelector('#boards').innerHTML = d.boards.length ? `<table class="tbl"><tr><th>Board</th><th>Owner</th><th>Visibility</th><th>Items</th><th>Members</th><th>Updated</th><th></th></tr>${d.boards.map((b) => `<tr><td><a href="/b/${b.id}" data-nav>${esc(b.name)}</a></td><td>${esc(b.owner?.display_name || '—')}</td><td>${b.visibility === 'team' ? '<span class="pill">Team</span>' : '<span class="pill gray">Private</span>'}</td><td>${b.item_count}</td><td>${b.member_count}</td><td class="small muted">${timeAgo(b.updated_at)}</td><td style="text-align:right"><button class="btn ghost sm danger" data-del="${b.id}" data-name="${esc(b.name)}">Delete</button></td></tr>`).join('')}</table>` : '<div class="empty">No boards yet.</div>';
      app.querySelectorAll('#boards [data-del]').forEach((b) => (b.onclick = async () => { if (await confirmDialog('Delete board?', `"${b.dataset.name}" will be permanently deleted.`)) { await api('DELETE', `/api/boards/${b.dataset.del}`); loadBoards(); } }));
    };
    const loadSettings = async () => {
      const s = await api('GET', '/api/admin/settings');
      app.querySelector('#org').value = s.org_name;
      app.querySelector('#saveorg').onclick = async () => { const d = await api('PATCH', '/api/admin/settings', { org_name: app.querySelector('#org').value }); S.settings = d; toast('Saved'); document.title = d.org_name; };
    };
    try { await Promise.all([loadUsers(), loadBoards(), loadSettings()]); } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------------- boot
  loadMe().then(route).catch((e) => { app.innerHTML = `<div class="auth-wrap"><div class="card auth-card"><h2>Cannot reach server</h2><p class="muted">${esc(e.message)}</p></div></div>`; });
})();
