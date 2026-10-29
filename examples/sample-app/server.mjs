// A tiny project-management app with a login, used to try the plugin end to end.
// No dependencies: node server.mjs  (PORT defaults to 4321)
// Sign in with demo@example.com / demo1234
import http from 'node:http';

const PORT = Number(process.env.PORT || 4321);
const USER = { email: 'demo@example.com', password: 'demo1234', name: 'Dana Demo' };
// Everything lives in memory. Restarting the server, or POST /__reset, puts back this seed data.
const todo = (...texts) => texts.map((text) => ({ text, done: false }));
const seed = () => ({
  projects: [
    { id: 1, name: 'Website relaunch', owner: 'Dana Demo', tasks: todo('Write homepage copy', 'Pick hero image', 'QA on mobile') },
    { id: 2, name: 'Q3 marketing plan', owner: 'Sam Lee', tasks: todo('Budget draft', 'Channel mix') },
    { id: 3, name: 'Customer onboarding', owner: 'Priya Shah', tasks: todo('Welcome email', 'Setup checklist') },
  ],
  members: [
    { name: 'Dana Demo', email: 'demo@example.com', role: 'Owner' },
    { name: 'Sam Lee', email: 'sam@example.com', role: 'Admin' },
    { name: 'Priya Shah', email: 'priya@example.com', role: 'Member' },
  ],
  invites: [],
});
let { projects, members, invites } = seed();

const css = `
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:#1f2430;background:#f6f7fb}
a{color:#3b5bdb;text-decoration:none}.shell{display:flex;min-height:100vh}
aside{width:220px;background:#1f2430;color:#cfd3dc;padding:20px}aside h2{color:#fff;font-size:17px;margin:0 0 20px}
aside nav a{display:block;color:#cfd3dc;padding:8px 10px;border-radius:6px}aside nav a.on,aside nav a:hover{background:#2e3446;color:#fff}
main{flex:1;padding:28px 36px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}
h1{font-size:24px;margin:0}.card{background:#fff;border:1px solid #e3e6ee;border-radius:10px;padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.stat{font-size:28px;font-weight:600}
.btn{display:inline-block;background:#3b5bdb;color:#fff;border:0;border-radius:7px;padding:9px 16px;font:inherit;cursor:pointer}
.btn.secondary{background:#fff;color:#1f2430;border:1px solid #cfd3dc}table{width:100%;border-collapse:collapse}
td,th{text-align:left;padding:10px;border-bottom:1px solid #eef0f5}label{display:block;margin:12px 0 4px;font-weight:500}
input,select,textarea{width:100%;max-width:420px;padding:9px;border:1px solid #cfd3dc;border-radius:7px;font:inherit}
.login{max-width:380px;margin:12vh auto}.muted{color:#6b7385}input[type=checkbox]{width:auto;margin-right:8px}
.done{color:#6b7385;text-decoration:line-through}`;

function layout(title, active, body, user = true) {
  const link = (href, label) => `<a href="${href}" class="${active === href ? 'on' : ''}">${label}</a>`;
  const nav = user ? `<aside><h2>Acme Projects</h2><nav aria-label="Main">${link('/dashboard', 'Dashboard')}${link('/projects', 'Projects')}${link('/reports', 'Reports')}${link('/settings', 'Settings')}${link('/logout', 'Log out')}</nav></aside>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} · Acme Projects</title><style>${css}</style></head><body><div class="shell">${nav}<main>${body}</main></div></body></html>`;
}

function send(res, code, html, headers = {}) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(html);
}
function redirect(res, to, headers = {}) {
  res.writeHead(302, { location: to, ...headers });
  res.end();
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
  });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const loggedIn = (req) => /(?:^|;\s*)session=demo/.test(req.headers.cookie || '');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/login' && req.method === 'POST') {
    const form = await readBody(req);
    if (form.email === USER.email && form.password === USER.password) return redirect(res, '/dashboard', { 'set-cookie': 'session=demo; Path=/; HttpOnly' });
    return send(res, 401, layout('Sign in', '', loginForm('That email and password don’t match.'), false));
  }
  if (p === '/login') return send(res, 200, layout('Sign in', '', loginForm(), false));
  if (p === '/logout') return redirect(res, '/login', { 'set-cookie': 'session=; Path=/; Max-Age=0' });
  // The tutorials plugin calls this before each tour (app.reset in tutorials/config.yaml). A real app would guard it.
  if (p === '/__reset' && req.method === 'POST') {
    ({ projects, members, invites } = seed());
    res.writeHead(204);
    return res.end();
  }
  if (!loggedIn(req)) return redirect(res, '/login');

  if (p === '/' || p === '/dashboard') {
    return send(res, 200, layout('Dashboard', '/dashboard', `
      <header><h1>Good morning, Dana</h1><a class="btn" href="/projects/new">New project</a></header>
      <div class="grid">
        <div class="card"><div class="muted">Open projects</div><div class="stat">${projects.length}</div></div>
        <div class="card"><div class="muted">Tasks due this week</div><div class="stat">7</div></div>
        <div class="card"><div class="muted">Team members</div><div class="stat">${members.length}</div></div>
      </div>
      <div class="card"><h2>Recent projects</h2><table>${projects.map((pr) => `<tr><td><a href="/projects/${pr.id}">${esc(pr.name)}</a></td><td class="muted">${esc(pr.owner)}</td></tr>`).join('')}</table></div>`));
  }
  if (p === '/projects' && req.method === 'POST') {
    const form = await readBody(req);
    const name = (form.name || '').trim();
    if (!name) return redirect(res, '/projects/new');
    const id = Math.max(0, ...projects.map((x) => x.id)) + 1;
    projects.push({ id, name, description: (form.description || '').trim(), owner: form.owner || USER.name, tasks: [] });
    return redirect(res, `/projects/${id}`);
  }
  if (p === '/projects') {
    return send(res, 200, layout('Projects', '/projects', `
      <header><h1>Projects</h1><a class="btn" href="/projects/new">New project</a></header>
      <div class="card"><label for="q">Search projects</label><input id="q" placeholder="Search by name"></div>
      <div class="card"><table><tr><th>Name</th><th>Owner</th><th>Tasks</th></tr>${projects.map((pr) => `<tr><td><a href="/projects/${pr.id}">${esc(pr.name)}</a></td><td>${esc(pr.owner)}</td><td>${pr.tasks.length}</td></tr>`).join('')}</table></div>`));
  }
  if (p === '/projects/new') {
    return send(res, 200, layout('New project', '/projects', `
      <header><h1>New project</h1></header>
      <form class="card" method="post" action="/projects"><label for="name">Project name</label><input id="name" name="name" required>
      <label for="desc">Description</label><textarea id="desc" name="description" rows="3"></textarea>
      <label for="owner">Owner</label><select id="owner" name="owner">${members.map((m) => `<option>${m.name}</option>`).join('')}</select>
      <p><button class="btn" type="submit">Create project</button> <a class="btn secondary" href="/projects">Cancel</a></p></form>`));
  }
  const tm = p.match(/^\/projects\/(\d+)\/tasks\/(\d+)$/);
  if (tm && req.method === 'POST') {
    const form = await readBody(req);
    const task = projects.find((x) => x.id === Number(tm[1]))?.tasks[Number(tm[2])];
    if (!task) return send(res, 404, layout('Not found', '', '<h1>Task not found</h1>'));
    task.done = form.done === 'on';
    res.writeHead(204);
    return res.end();
  }
  const m = p.match(/^\/projects\/(\d+)$/);
  if (m) {
    const pr = projects.find((x) => x.id === Number(m[1]));
    if (!pr) return send(res, 404, layout('Not found', '', '<h1>Project not found</h1>'));
    if (req.method === 'POST') {
      const text = ((await readBody(req)).task || '').trim();
      if (text) pr.tasks.push({ text, done: false });
      return redirect(res, p);
    }
    // Ticking a task saves in the background, so the page doesn't reload mid-recording.
    const tick = `fetch(this.dataset.url,{method:'POST',body:this.checked?'done=on':''});this.nextElementSibling.classList.toggle('done',this.checked)`;
    return send(res, 200, layout(esc(pr.name), '/projects', `
      <header><h1>${esc(pr.name)}</h1><button class="btn secondary" type="button">Share</button></header>
      ${pr.description ? `<p class="muted">${esc(pr.description)}</p>` : ''}
      <div class="card"><h2>Tasks</h2>${pr.tasks.length ? '' : '<p class="muted">No tasks yet.</p>'}<table>${pr.tasks.map((t, i) => `<tr><td><input type="checkbox" aria-label="Mark ${esc(t.text)} done" data-url="/projects/${pr.id}/tasks/${i}"${t.done ? ' checked' : ''} onchange="${tick}"> <span class="${t.done ? 'done' : ''}">${esc(t.text)}</span></td></tr>`).join('')}</table>
      <form method="post"><label for="task">New task</label><input id="task" name="task" placeholder="What needs doing?" required><p><button class="btn" type="submit">Add task</button></p></form></div>`));
  }
  if (p === '/reports') {
    return send(res, 200, layout('Reports', '/reports', `
      <header><h1>Reports</h1><a class="btn secondary" href="/reports/export.csv">Export CSV</a></header>
      <div class="card"><label for="range">Date range</label><select id="range"><option>Last 7 days</option><option>Last 30 days</option><option>This quarter</option></select>
      <p class="muted">Tasks completed: 23 · Average time to close: 2.4 days</p></div>`));
  }
  if (p === '/reports/export.csv') {
    res.writeHead(200, { 'content-type': 'text/csv' });
    return res.end('project,tasks\n' + projects.map((x) => `"${x.name.replace(/"/g, '""')}",${x.tasks.length}`).join('\n'));
  }
  if (p === '/settings') {
    return send(res, 200, layout('Settings', '/settings', `
      <header><h1>Settings</h1></header>
      <div class="card"><h2><a href="/settings/members">Members</a></h2><p class="muted">Invite people and change roles.</p></div>
      <div class="card"><h2><a href="/settings/billing">Billing</a></h2><p class="muted">Plan and invoices.</p></div>`));
  }
  if (p === '/settings/members' && req.method === 'POST') {
    const form = await readBody(req);
    const email = (form.email || '').trim().toLowerCase();
    if (!email) return redirect(res, '/settings/members');
    const known = members.some((x) => x.email === email) || invites.some((x) => x.email === email);
    if (!known) invites.push({ email, role: form.role === 'Admin' ? 'Admin' : 'Member' });
    return redirect(res, `/settings/members?${known ? 'exists' : 'invited'}=${encodeURIComponent(email)}`);
  }
  if (p === '/settings/members') {
    const q = url.searchParams;
    const notice = q.has('invited') ? `Invite sent to ${esc(q.get('invited'))}.` : q.has('exists') ? `${esc(q.get('exists'))} is already on the team or invited.` : '';
    return send(res, 200, layout('Members', '/settings', `
      <header><h1>Members</h1></header>
      ${notice ? `<p class="card" role="status">${notice}</p>` : ''}
      <div class="card"><table><tr><th>Name</th><th>Email</th><th>Role</th></tr>${members.map((x) => `<tr><td>${x.name}</td><td>${x.email}</td><td>${x.role}</td></tr>`).join('')}${invites.map((x) => `<tr><td class="muted">Invite pending</td><td>${esc(x.email)}</td><td>${x.role}</td></tr>`).join('')}</table></div>
      <form class="card" method="post"><h2>Invite a teammate</h2><label for="email">Email address</label><input id="email" name="email" type="email" required>
      <label for="role">Role</label><select id="role" name="role"><option>Member</option><option>Admin</option></select>
      <p><button class="btn" type="submit">Send invite</button></p></form>`));
  }
  if (p === '/settings/billing') {
    return send(res, 200, layout('Billing', '/settings', `
      <header><h1>Billing</h1><button class="btn secondary" type="button">Change plan</button></header>
      <div class="card"><p>Team plan · 3 seats · renews Dec 1</p><table><tr><th>Invoice</th><th>Amount</th></tr><tr><td>Oct 2026</td><td>$36.00</td></tr><tr><td>Sep 2026</td><td>$36.00</td></tr></table></div>`));
  }
  send(res, 404, layout('Not found', '', '<h1>Page not found</h1>'));
});

function loginForm(error = '') {
  return `<form class="card login" method="post" action="/login"><h1>Sign in to Acme</h1>${error ? `<p role="alert" style="color:#c92a2a">${error}</p>` : ''}
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username">
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
    <p><button class="btn" type="submit">Sign in</button></p><p class="muted">Demo: demo@example.com / demo1234</p></form>`;
}

server.listen(PORT, () => console.log(`Acme Projects sample app on http://localhost:${PORT}`));
