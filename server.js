const express = require('express'), http = require('http'), path = require('path'), fs = require('fs');
const { Server } = require('socket.io');
const app = express(), server = http.createServer(app), io = new Server(server);
const PASS = process.env.HOST_PASS || 'hch';
app.use(express.json({ limit: '1mb' }));
const root = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
app.use(express.static(root));
app.get('/', (_, res) => res.sendFile(path.join(root, 'index.html')));

let sb = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const mem = [{ id: 'demo', title: 'Quiz mẫu', questions: [
  { q: 'Thủ đô của Việt Nam?', options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'], correct: 0, time: 15 },
  { q: '2 + 2 × 3 = ?', options: ['12', '8', '10', '6'], correct: 1, time: 15 },
  { q: 'Ngôn ngữ chạy trên trình duyệt?', options: ['Python', 'Java', 'JavaScript', 'C'], correct: 2, time: 15 }] }];

const auth = (req, res, next) => req.get('x-pass') === PASS ? next() : res.status(401).json({ err: 'Sai mật khẩu' });
const valid = qs => Array.isArray(qs) && qs.length > 0 && qs.length <= 200 && qs.every(x =>
  x && typeof x.q === 'string' && Array.isArray(x.options) && x.options.length >= 2 && x.options.length <= 4 &&
  Number.isInteger(x.correct) && x.correct >= 0 && x.correct < x.options.length);

app.get('/api/quizzes', auth, async (_, res) => {
  if (!sb) return res.json(mem.map(({ id, title }) => ({ id, title })));
  const { data } = await sb.from('quizzes').select('id,title').order('created_at', { ascending: false }).limit(100);
  res.json(data || []);
});
app.post('/api/quizzes', auth, async (req, res) => {
  const { title, questions } = req.body || {};
  if (!title || !valid(questions)) return res.status(400).json({ err: 'Dữ liệu quiz không hợp lệ' });
  if (!sb) { const id = String(Date.now()); mem.push({ id, title, questions }); return res.json({ id }); }
  const { data, error } = await sb.from('quizzes').insert({ title, questions }).select('id').single();
  if (error) return res.status(500).json({ err: error.message });
  res.json({ id: data.id });
});
// Proxy Google Sheet công khai -> CSV (tránh lỗi CORS)
app.get('/api/sheet', auth, async (req, res) => {
  const url = String(req.query.url || ''), m = /\/d\/([\w-]+)/.exec(url), gid = /[#&?]gid=(\d+)/.exec(url);
  if (!m) return res.status(400).json({ err: 'Link Google Sheet không hợp lệ' });
  try {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv` + (gid ? `&gid=${gid[1]}` : ''));
    const t = await r.text();
    if (!r.ok || t.trim().startsWith('<')) throw 0;
    res.type('text/csv').send(t);
  } catch { res.status(400).json({ err: 'Không đọc được sheet. Hãy chia sẻ: "Bất kỳ ai có đường liên kết" (Người xem)' }); }
});
async function getQuiz(id) {
  if (!sb) return mem.find(x => x.id === id);
  const { data } = await sb.from('quizzes').select('*').eq('id', id).single();
  return data;
}

const games = {};
const clamp = (v, a, b, d) => { v = Number(v); return Number.isFinite(v) ? Math.min(Math.max(v, a), b) : d; };
const shuf = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const plist = g => Object.values(g.players);
const top = (g, n) => plist(g).sort((a, b) => b.score - a.score).slice(0, n).map(p => ({ name: p.name, score: p.score }));
const lobby = g => plist(g).map(p => ({ key: p.key, name: p.name, online: p.online }));
const qFor = (g, p, time) => {
  const q = g.questions[g.qi], perm = p ? p.perm : q.options.map((_, i) => i);
  return { i: g.qi + 1, total: g.questions.length, q: q.q, options: perm.map(i => q.options[i]), time };
};
const progress = g => { const on = plist(g).filter(p => p.online); io.to(g.host).emit('answered', { done: on.filter(p => p.ans).length, total: on.length }); };
const checkDone = pin => { const g = games[pin]; if (!g || g.state !== 'question') return; progress(g);
  const on = plist(g).filter(p => p.online); if (on.length && on.every(p => p.ans)) reveal(pin); };

function advance(pin) {
  const g = games[pin]; if (!g || g.state === 'question' || g.state === 'end') return;
  clearTimeout(g.autoTimer); g.qi++;
  if (g.qi >= g.questions.length) {
    g.state = 'end'; g.finalTop = top(g, 10);
    plist(g).forEach(p => io.to(p.sid).emit('end', { top: g.finalTop }));
    const full = plist(g).sort((a, b) => b.score - a.score).map(p => ({ name: p.name, score: p.score, correct: p.correct, log: p.log }));
    return io.to(g.host).emit('end', { top: g.finalTop, full, qs: g.questions.map(q => q.q) });
  }
  const q = g.questions[g.qi], n = q.options.length, t = q.time || 20;
  g.state = 'question'; g.t0 = Date.now();
  plist(g).forEach(p => { p.ans = null; const idx = [...Array(n).keys()]; p.perm = g.shuffleA ? shuf(idx) : idx; });
  io.to(g.host).emit('question', qFor(g, null, t));
  plist(g).forEach(p => io.to(p.sid).emit('question', qFor(g, p, t)));
  g.timer = setTimeout(() => reveal(pin), t * 1000);
}
function reveal(pin) {
  const g = games[pin]; if (!g || g.state !== 'question') return;
  clearTimeout(g.timer); g.state = 'reveal'; g.revealAt = Date.now();
  const q = g.questions[g.qi], limit = (q.time || 20) * 1000, counts = q.options.map(() => 0), list = plist(g);
  list.forEach(p => {
    p.gained = 0;
    if (p.ans) {
      counts[p.ans.idx]++;
      if (p.ans.idx === q.correct) { p.gained = Math.round(1000 * (1 - Math.min(p.ans.ms / limit, 1) / 2)); p.score += p.gained; p.correct++; }
    }
    p.log.push(p.gained);
  });
  const t5 = top(g, 5);
  list.sort((a, b) => b.score - a.score).forEach((p, i) => {
    p.lastResult = { name: p.name, answered: !!p.ans, correct: !!p.ans && p.ans.idx === q.correct, correctText: q.options[q.correct],
      gained: p.gained, score: p.score, rank: i + 1, total: list.length, top: t5 };
    io.to(p.sid).emit('result', p.lastResult);
  });
  io.to(g.host).emit('reveal', { correct: q.correct, counts, top: t5, last: g.qi === g.questions.length - 1, auto: g.auto, min: g.min, wait: g.wait });
  if (g.auto) g.autoTimer = setTimeout(() => advance(pin), g.wait * 1000);
}
// Gửi lại trạng thái hiện tại cho người chơi vừa vào lại
function sync(g, p, s) {
  if (g.state === 'question') {
    const q = g.questions[g.qi], rem = Math.max(1, Math.ceil(((q.time || 20) * 1000 - (Date.now() - g.t0)) / 1000));
    s.emit('question', qFor(g, p, rem)); if (p.ans) s.emit('sent');
  } else if (g.state === 'reveal' && p.lastResult) s.emit('result', p.lastResult);
  else if (g.state === 'end') s.emit('end', { top: g.finalTop });
}

io.on('connection', s => {
  s.on('host:create', async (o = {}, cb) => {
    if (o.pass !== PASS) return cb({ err: 'Sai mật khẩu' });
    const quiz = await getQuiz(o.id); if (!quiz) return cb({ err: 'Không tìm thấy quiz' });
    let pin; do pin = String(Math.floor(100000 + Math.random() * 900000)); while (games[pin]);
    const min = clamp(o.min, 0, 60, 5), wait = Math.max(min, clamp(o.wait, 0, 120, 10));
    const questions = o.shuffleQ ? shuf([...quiz.questions]) : quiz.questions;
    games[pin] = { host: s.id, quiz, questions, players: {}, state: 'lobby', qi: -1, auto: !!o.auto, min, wait, shuffleA: !!o.shuffleA };
    s.join(pin); s.data.pin = pin; cb({ pin });
  });
  // Vào mới hoặc vào lại (cùng tên: giữ nguyên điểm)
  s.on('player:join', ({ pin, name, token } = {}, cb) => {
    const g = games[pin]; name = String(name || '').trim().slice(0, 20);
    if (!g) return cb({ err: 'PIN không đúng' });
    if (!name) return cb({ err: 'Hãy nhập tên' });
    const key = name.toLowerCase(); let p = g.players[key];
    if (p) {
      if (p.online && p.sid !== s.id && p.token !== token) return cb({ err: 'Tên đã được dùng' });
      p.sid = s.id; p.online = true;
    } else {
      if (g.state !== 'lobby') return cb({ err: 'Game đã bắt đầu' });
      p = g.players[key] = { key, name, score: 0, correct: 0, log: [], token: Math.random().toString(36).slice(2), sid: s.id, online: true };
    }
    s.join(pin); s.data.pin = pin; s.data.key = key;
    io.to(g.host).emit('lobby', lobby(g));
    cb({ ok: 1, token: p.token, name: p.name, state: g.state });
    if (g.state !== 'lobby') { sync(g, p, s); progress(g); }
  });
  s.on('host:kick', key => {
    const g = games[s.data.pin]; if (!g || g.host !== s.id || g.state !== 'lobby') return;
    const p = g.players[key]; if (!p) return;
    delete g.players[key];
    const sock = io.sockets.sockets.get(p.sid);
    if (sock) { sock.emit('kicked'); sock.leave(s.data.pin); sock.data.pin = null; }
    io.to(g.host).emit('lobby', lobby(g));
  });
  s.on('host:next', () => {
    const g = games[s.data.pin]; if (!g || g.host !== s.id) return;
    if (g.state === 'reveal' && Date.now() - g.revealAt < g.min * 1000) return;
    advance(s.data.pin);
  });
  s.on('player:answer', idx => {
    const g = games[s.data.pin], p = g && g.players[s.data.key];
    if (!p || p.sid !== s.id || g.state !== 'question' || p.ans || !Number.isInteger(idx)) return;
    const orig = p.perm && p.perm[idx]; if (orig === undefined) return;
    p.ans = { idx: orig, ms: Date.now() - g.t0 };
    checkDone(s.data.pin);
  });
  s.on('disconnect', () => {
    const pin = s.data.pin, g = games[pin]; if (!g) return;
    if (g.host === s.id) { clearTimeout(g.timer); clearTimeout(g.autoTimer); io.to(pin).emit('closed'); delete games[pin]; return; }
    const p = g.players[s.data.key];
    if (p && p.sid === s.id) {
      p.online = false;
      if (g.state === 'lobby') io.to(g.host).emit('lobby', lobby(g)); else checkDone(pin);
    }
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Running'));
