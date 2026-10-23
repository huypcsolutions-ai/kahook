// Thử tải + kiểm tra logic.  Cách dùng:
//   1) Host tạo phòng thật (lấy PIN). 2) npm i socket.io-client --no-save
//   3) node tools/loadtest.js https://ten-app.onrender.com <PIN> 50
//   4) Khi thấy "đã vào N/N" thì host bấm Bắt đầu. Cuối cùng in báo cáo; thoát mã 1 nếu có vi phạm.
// ~15% bot "chập chờn": rớt mạng trước hoặc sau khi trả lời rồi vào lại bằng token; mọi bot đôi khi gửi đáp án 2 lần.
const { io } = require('socket.io-client');
const [url, pin, N = 30] = process.argv.slice(2), n = +N;
const joinMs = [], ackMs = [], bad = [], warn = []; let ended = 0, joined = 0, dups = 0, rejoinOk = 0;
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function bot(i) {
  const name = 'bot' + i, flaky = i % 7 === 0, st = { score: 0, token: '', answered: false, results: 0, qi: 0, total: 0, done: false };
  let s;
  const connect = first => {
    const t0 = Date.now(); s = io(url, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => s.emit('player:join', { pin, name, token: st.token }, r => {
      if (!r.ok) return bad.push(`${name}: vào phòng lỗi — ${r.err}`);
      st.token = r.token; if (first) { joined++; joinMs.push(Date.now() - t0); } else rejoinOk++;
    }));
    s.on('sent', () => { st.answered = true; });
    s.on('question', q => { st.q = q; st.qi = q.i; st.total = q.total; if (!st.answered || st.ansQ !== q.i) { st.answered = false; plan(q); } });
    s.on('result', r => {
      st.results++;
      if (r.gained < 0 || r.gained > 1000) bad.push(`${name}: điểm cộng bất thường ${r.gained}`);
      if (r.score !== st.score + r.gained) bad.push(`${name}: tổng điểm lệch (${r.score} ≠ ${st.score}+${r.gained}) — nghi tính điểm 2 lần`);
      if (r.rank < 1 || r.rank > r.total) bad.push(`${name}: hạng ${r.rank}/${r.total} sai`);
      if (r.top.some((x, j) => j && x.score > r.top[j - 1].score)) bad.push(`${name}: top không giảm dần`);
      st.score = r.score;
    });
    s.on('end', e => {
      if (st.done) return; st.done = true; ended++;
      if (e.top.some((x, j) => j && x.score > e.top[j - 1].score)) bad.push(`${name}: bảng cuối không giảm dần`);
      const me = e.top.find(x => x.name === name); if (me && me.score !== st.score) bad.push(`${name}: điểm cuối lệch (${me.score} ≠ ${st.score})`);
      if (st.results !== st.total) warn.push(`${name}: nhận ${st.results}/${st.total} kết quả`);
      s.close();
    });
  };
  const send = q => new Promise(res => {
    const t = Date.now(), qi = q.i;
    s.emit('player:answer', Math.floor(Math.random() * q.options.length), r => {
      if (r && r.ok) { ackMs.push(Date.now() - t); st.answered = true; st.ansQ = qi; if (r.dup) dups++; }
      else if (!(r && /Hết giờ/.test(r.err || ''))) warn.push(`${name}: câu ${qi} gửi lỗi — ${r && r.err}`);
      res(r);
    });
  });
  async function plan(q) {
    await sleep(300 + Math.random() * Math.min(q.time * 700, 5000));
    if (st.qi !== q.i || st.answered) return;
    if (flaky && Math.random() < .5) {            // rớt mạng TRƯỚC khi trả lời
      s.close(); await sleep(1500); connect(false); await sleep(1500);
      if (st.qi === q.i && !st.answered) await send(st.q);
    } else {
      await send(q);
      if (flaky) { s.close(); await sleep(1500); connect(false); }   // rớt SAU khi trả lời: phải nhận 'sent', không được trả lời lại
      else if (Math.random() < .2) { const r = await send(q); if (!(r && r.dup)) bad.push(`${name}: gửi lần 2 không bị chặn`); }
    }
  }
  setTimeout(() => connect(true), i * 40);
}
for (let i = 0; i < n; i++) bot(i);

const tick = setInterval(() => console.log(`vào phòng ${joined}/${n} · trả lời ${ackMs.length} · vào lại ${rejoinOk} · kết thúc ${ended}/${n} · vi phạm ${bad.length}`), 4000);
const finish = () => {
  clearInterval(tick);
  console.log(`\n=== BÁO CÁO (${n} bot) ===\nvào phòng: p50 ${pct(joinMs, .5)}ms · p95 ${pct(joinMs, .95)}ms\nxác nhận đáp án: p50 ${pct(ackMs, .5)}ms · p95 ${pct(ackMs, .95)}ms · max ${pct(ackMs, 1)}ms\nvào lại thành công: ${rejoinOk} · gửi lặp bị chặn đúng: ${dups}\nvi phạm logic: ${bad.length} · cảnh báo: ${warn.length}`);
  [...new Set(bad)].slice(0, 10).forEach(x => console.log('  ✗', x)); [...new Set(warn)].slice(0, 5).forEach(x => console.log('  !', x));
  process.exit(bad.length ? 1 : 0);
};
const w = setInterval(() => { if (ended >= n) { clearInterval(w); setTimeout(finish, 1000); } }, 1000);
setTimeout(finish, 30 * 60e3);
