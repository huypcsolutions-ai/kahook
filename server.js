const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), server = http.createServer(app), io = new Server(server);
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Supabase (tuỳ chọn). Không có biến môi trường -> lưu tạm trong RAM.
let sb = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  sb = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const mem = [{ id: 'demo', title: 'Quiz mẫu', questions: [
  { q: 'Thủ đô của Việt Nam?', options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'TP.HCM'], correct: 0, time: 15 },
  { q: '2 + 2 × 3 = ?', options: ['12', '8', '10', '6'], correct: 1, time: 15 },
  { q: 'Ngôn ngữ chạy trên trình duyệt?', options: ['Python', 'Java', 'JavaScript', 'C'], correct: 2, time: 15 }
] }];

function valid(qs) {
  return Array.isArray(qs) && qs.length > 0 && qs.length <= 100 && qs.every(x =>
    x && typeof x.q === 'string' && Array.isArray(x.options) && x.options.length >= 2 && x.options.length <= 4 &&
    Number.isInteger(x.correct) && x.correct >= 0 && x.correct < x.options.length);
}
app.get('/api/quizzes', async (_, res) => {
  if (!sb) return res.json(mem.map(({ id, title }) => ({ id, title })));
  const { data } = await sb.from('quizzes').select('id,title').order('created_at', { ascending: false }).limit(50);
  res.json(data || []);
});
app.post('/api/quizzes', async (req, res) => {
  const { title, questions } = req.body || {};
  if (!title || !valid(questions)) return res.status(400).json({ err: 'Dữ liệu quiz không hợp lệ' });
  if (!sb) { const id = String(Date.now()); mem.push({ id, title, questions }); return res.json({ id }); }
  const { data, error } = await sb.from('quizzes').insert({ title, questions }).select('id').single();
  if (error) return res.status(500).json({ err: error.message });
  res.json({ id: data.id });
});
async function getQuiz(id) {
  if (!sb) return mem.find(x => x.id === id);
  const { data } = await sb.from('quizzes').select('*').eq('id', id).single();
  return data;
}

const games = {};
const top = (g, n) => Object.values(g.players).sort((a, b) => b.score - a.score).slice(0, n).map(p => ({ name: p.name, score: p.score }));
const names = g => Object.values(g.players).map(p => p.name);

function reveal(pin) {
  const g = games[pin]; if (!g || g.state !== 'question') return;
  clearTimeout(g.timer); g.state = 'reveal';
  const q = g.quiz.questions[g.qi], limit = (q.time || 20) * 1000;
  const counts = q.options.map(() => 0);
  const ranked = Object.entries(g.players);
  ranked.forEach(([, p]) => {
    p.gained = 0;
    if (p.ans) {
      counts[p.ans.idx]++;
      if (p.ans.idx === q.correct) { p.gained = Math.round(1000 * (1 - Math.min(p.ans.ms / limit, 1) / 2)); p.score += p.gained; }
    }
  });
  ranked.sort((a, b) => b[1].score - a[1].score).forEach(([id, p], i) =>
    io.to(id).emit('result', { correct: p.ans ? p.ans.idx === q.correct : false, answered: !!p.ans, gained: p.gained, score: p.score, rank: i + 1 }));
  io.to(g.host).emit('reveal', { correct: q.correct, counts, top: top(g, 5), last: g.qi === g.quiz.questions.length - 1 });
}

io.on('connection', s => {
  s.on('host:create', async (id, cb) => {
    const quiz = await getQuiz(id); if (!quiz) return cb({ err: 'Không tìm thấy quiz' });
    let pin; do pin = String(Math.floor(100000 + Math.random() * 900000)); while (games[pin]);
    games[pin] = { host: s.id, quiz, players: {}, state: 'lobby', qi: -1 };
    s.join(pin); s.data.pin = pin; cb({ pin });
  });
  s.on('player:join', ({ pin, name } = {}, cb) => {
    const g = games[pin]; name = String(name || '').trim().slice(0, 20);
    if (!g) return cb({ err: 'PIN không đúng' });
    if (g.state !== 'lobby') return cb({ err: 'Game đã bắt đầu' });
    if (!name) return cb({ err: 'Hãy nhập tên' });
    if (names(g).some(n => n.toLowerCase() === name.toLowerCase())) return cb({ err: 'Tên đã được dùng' });
    g.players[s.id] = { name, score: 0 }; s.join(pin); s.data.pin = pin;
    io.to(g.host).emit('lobby', names(g)); cb({ ok: 1 });
  });
  s.on('host:next', () => {
    const pin = s.data.pin, g = games[pin]; if (!g || g.host !== s.id || g.state === 'question') return;
    g.qi++;
    if (g.qi >= g.quiz.questions.length) { g.state = 'end'; return io.to(pin).emit('end', top(g, 10)); }
    const q = g.quiz.questions[g.qi];
    g.state = 'question'; g.t0 = Date.now();
    Object.values(g.players).forEach(p => p.ans = null);
    io.to(pin).emit('question', { i: g.qi + 1, total: g.quiz.questions.length, q: q.q, options: q.options, time: q.time || 20 });
    g.timer = setTimeout(() => reveal(pin), (q.time || 20) * 1000);
  });
  s.on('player:answer', idx => {
    const g = games[s.data.pin], p = g && g.players[s.id];
    if (!p || g.state !== 'question' || p.ans || !Number.isInteger(idx)) return;
    p.ans = { idx, ms: Date.now() - g.t0 };
    const all = Object.values(g.players), done = all.filter(x => x.ans).length;
    io.to(g.host).emit('answered', { done, total: all.length });
    if (done === all.length) reveal(s.data.pin);
  });
  s.on('disconnect', () => {
    const pin = s.data.pin, g = games[pin]; if (!g) return;
    if (g.host === s.id) { clearTimeout(g.timer); io.to(pin).emit('closed'); delete games[pin]; }
    else if (g.state === 'lobby') { delete g.players[s.id]; io.to(g.host).emit('lobby', names(g)); }
  });
});
server.listen(process.env.PORT || 3000, () => console.log('Running'));
