// Thử tải: tạo phòng bằng host thật, rồi chạy:  node tools/loadtest.js https://ten-app.onrender.com <PIN> 50
// Cần cài tạm: npm i socket.io-client --no-save
const { io } = require('socket.io-client');
const [url, pin, n = 50] = process.argv.slice(2);
let joined = 0, answers = 0, errs = 0;
for (let i = 0; i < n; i++) setTimeout(() => {
  const s = io(url, { transports: ['websocket'] });
  s.emit('player:join', { pin, name: 'bot' + i }, r => r.ok ? joined++ : (errs++, console.log('join lỗi:', r.err)));
  s.on('question', q => setTimeout(() => s.emit('player:answer', Math.floor(Math.random() * q.options.length), r => r && r.ok ? answers++ : errs++), 500 + Math.random() * 4000));
  s.on('end', () => s.close());
}, i * 50);
setInterval(() => console.log(`vào phòng ${joined}/${n} · đã trả lời ${answers} · lỗi ${errs}`), 3000);
