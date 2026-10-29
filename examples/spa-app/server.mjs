// A small single-page helpdesk app, used to test the plugin on what real apps do: client-side routing,
// data that loads after the page, a modal, a custom dropdown menu, toasts and a list long enough to scroll.
// No login and no dependencies: node server.mjs  (PORT defaults to 4400)
import fs from 'node:fs';
import http from 'node:http';

const PORT = Number(process.env.PORT || 4400);
const page = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const TITLES = [
  'Laptop won\'t connect to the office wifi', 'Need access to the finance shared drive', 'Monitor flickers after lunch',
  'Password reset for the CRM', 'Printer on the third floor is jammed', 'VPN drops every few minutes', 'Calendar invites arrive twice',
  'New starter needs an email account', 'Keyboard missing the letter E', 'Projector in room 4 has no signal',
  'Can\'t install the design app', 'Phone extension forwarding is wrong', 'Expense tool shows an error on submit',
  'Team chat notifications stopped', 'Request a standing desk', 'Spreadsheet macros are blocked', 'Mouse double-clicks on its own',
  'Shared mailbox is full', 'Webcam image is upside down', 'Need a licence for the PDF editor', 'Printer queue is stuck',
  'Badge doesn\'t open the side door', 'Slow file uploads from home', 'Old laptop needs wiping', 'Screen sharing shows a black screen',
  'Two-factor codes don\'t arrive', 'Desk phone has no dial tone', 'Request access to the analytics dashboard',
  'Headset microphone is too quiet', 'Browser keeps asking to sign in', 'Lost the charger for my laptop', 'Out-of-office reply won\'t turn off',
  'Meeting room screen won\'t wake', 'Need software for screen recording', 'Docking station only powers one monitor',
  'Request a second monitor', 'Email signature lost its logo', 'Wireless keyboard keeps disconnecting',
  'Request a loaner laptop for travel', 'Backup failed last night',
];
const PRIORITIES = ['Normal', 'High', 'Low', 'Normal', 'Normal'];
// Newest first, so the oldest tickets are at the bottom of a long list.
const seed = () => TITLES.map((title, i) => ({ id: i + 1, title, priority: PRIORITIES[i % PRIORITIES.length], status: i % 7 === 3 ? 'Solved' : 'Open' })).reverse();
let tickets = seed();

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
});

http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  // The tutorials plugin calls this before each tour (app.reset in tutorials/config.yaml).
  if (p === '/__reset' && req.method === 'POST') {
    tickets = seed();
    return json(res, 204);
  }
  if (p === '/api/tickets' && req.method === 'GET') {
    await later(300);
    return json(res, 200, tickets);
  }
  if (p === '/api/tickets' && req.method === 'POST') {
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    if (!title) return json(res, 400, { error: 'A ticket needs a title.' });
    await later(250);
    const ticket = { id: Math.max(...tickets.map((t) => t.id)) + 1, title, priority: ['Low', 'Normal', 'High'].includes(body.priority) ? body.priority : 'Normal', status: 'Open' };
    tickets.unshift(ticket);
    return json(res, 201, ticket);
  }
  const one = p.match(/^\/api\/tickets\/(\d+)(\/solve)?$/);
  if (one) {
    const ticket = tickets.find((t) => t.id === Number(one[1]));
    if (!ticket) return json(res, 404, { error: 'No such ticket.' });
    await later(200);
    if (one[2] && req.method === 'POST') ticket.status = 'Solved';
    return json(res, 200, ticket);
  }
  // Unfinished on purpose: the page thanks you, but nothing is kept.
  if (p === '/api/feedback' && req.method === 'POST') return json(res, 204);
  if (p.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(PORT, () => console.log(`Helpdesk sample app on http://localhost:${PORT}`));
