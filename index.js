const https = require('https');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

let tasks = [];
try { tasks = JSON.parse(process.env.TASKS || '[]'); } catch(e) {}

// ── Telegram send ────────────────────────────────────────────
function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  return new Promise(resolve => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

// ── Date helpers ─────────────────────────────────────────────
function getEasternDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}
function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function getTodayStr() { return dateStr(getEasternDate()); }
function isLastDayOfMonth(d) { const n=new Date(d); n.setDate(n.getDate()+1); return n.getDate()===1; }

function isTaskOnDate(task, d) {
  const ds = dateStr(d);
  if (task.endDate && ds > task.endDate) return false;
  if (task.type === 'once') return task.date === ds;
  if (task.type === 'recurring') {
    const r = task.recur;
    if (r === 'daily') return true;
    if (r === 'weekday') { const wd = d.getDay(); return wd >= 1 && wd <= 5; }
    if (r === 'weekly') return d.getDay() === task.weekDay;
    if (r === 'biweekly') {
      if (d.getDay() !== task.weekDay) return false;
      const start = new Date(task.biweekStart + 'T00:00:00');
      return Math.round((d - start) / 86400000) % 14 === 0;
    }
    if (r === 'xdays') {
      const start = new Date(task.xdaysStart + 'T00:00:00');
      const diff = Math.round((d - start) / 86400000);
      return diff >= 0 && diff % parseInt(task.xdays) === 0;
    }
    if (r === 'dom') return d.getDate() === parseInt(task.domDay);
    if (r === 'lastdom') return isLastDayOfMonth(d);
  }
  return false;
}

function isDone(task, ds) { return !!(task.doneDate && task.doneDate[ds]); }
function getTasksForDate(d) { return tasks.filter(t => isTaskOnDate(t, d)); }

// ── Message builders ─────────────────────────────────────────
function buildMorningMsg() {
  const now = getEasternDate();
  const todayStr = getTodayStr();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateStr(yesterday);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  let msg = `Good morning! ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}:\n\n`;

  const yesterdayUndone = getTasksForDate(yesterday).filter(t => !isDone(t, yesterdayStr));
  if (yesterdayUndone.length > 0) {
    msg += '⚠️ Not done yesterday:\n';
    yesterdayUndone.forEach(t => msg += `  • ${t.title}\n`);
    msg += '\n';
  }

  const todayTasks = getTasksForDate(now);
  if (todayTasks.length === 0) { return msg + 'No tasks today. Enjoy your day!'; }

  const timed = todayTasks.filter(t => t.time).sort((a,b) => a.time > b.time ? 1 : -1);
  const other = todayTasks.filter(t => !t.time);
  if (timed.length > 0) { msg += "Scheduled:\n"; timed.forEach(t => msg += `  ${t.time} — ${t.title}${t.priority==='high'?' ❗':''}\n`); }
  if (other.length > 0) { msg += "\nTasks:\n"; other.forEach(t => msg += `  • ${t.title}${t.priority==='high'?' ❗':''}\n`); }
  return msg + '\nHave a great day!';
}

function buildEveningMsg() {
  const now = getEasternDate();
  const todayStr = getTodayStr();
  const undone = getTasksForDate(now).filter(t => !isDone(t, todayStr));
  if (undone.length === 0) return 'Great job! All tasks completed today. 🎉';
  let msg = `Good evening! ${undone.length} task${undone.length>1?'s':''} pending:\n\n`;
  undone.forEach(t => msg += `  • ${t.title}\n`);
  return msg + '\nOpen your assistant to mark done or move to tomorrow.';
}

function buildListMsg() {
  const now = getEasternDate();
  const todayStr = getTodayStr();
  const todayTasks = getTasksForDate(now);
  if (todayTasks.length === 0) return "No tasks today. Enjoy your day!";
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  let msg = `📋 ${days[now.getDay()]}'s tasks:\n\n`;
  const timed = todayTasks.filter(t => t.time).sort((a,b) => a.time > b.time ? 1 : -1);
  const other = todayTasks.filter(t => !t.time);
  if (timed.length > 0) { timed.forEach(t => msg += `  ${isDone(t,todayStr)?'✅':'⏰'} ${t.time} — ${t.title}\n`); }
  if (other.length > 0) { other.forEach(t => msg += `  ${isDone(t,todayStr)?'✅':'☐'} ${t.title}\n`); }
  return msg;
}

// ── Two-way Telegram: polling ─────────────────────────────────
let lastUpdateId = 0;

async function pollTelegram() {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId+1}&timeout=30`;
    const data = await new Promise(resolve => {
      https.get(url, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!data || !data.ok) return;

    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || String(msg.chat.id) !== String(CHAT_ID)) continue;

      const text = (msg.text || '').trim().toLowerCase();
      console.log('Incoming:', text);

      // list
      if (text === 'list') {
        await sendTelegram(buildListMsg());
        continue;
      }

      // done [task name]
      if (text.startsWith('done ')) {
        const query = text.slice(5).trim();
        const todayStr = getTodayStr();
        const task = tasks.find(t => t.title.toLowerCase().includes(query));
        if (task) {
          if (!task.doneDate) task.doneDate = {};
          task.doneDate[todayStr] = true;
          await sendTelegram(`✅ Marked done: ${task.title}`);
        } else {
          await sendTelegram(`❌ Task not found: "${query}"`);
        }
        continue;
      }

      // add [task] today/tomorrow [time]
      if (text.startsWith('add ')) {
        const rest = msg.text.slice(4).trim();
        let date = getTodayStr();
        let title = rest;
        let time = null;

        if (/tomorrow/i.test(rest)) {
          const tom = getEasternDate(); tom.setDate(tom.getDate()+1);
          date = dateStr(tom);
          title = rest.replace(/tomorrow/i, '').trim();
        } else if (/today/i.test(rest)) {
          title = rest.replace(/today/i, '').trim();
        }

        // extract time like 3pm, 4:30pm, 14:00
        const timeMatch = title.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
        if (timeMatch) {
          let h = parseInt(timeMatch[1]);
          const m = parseInt(timeMatch[2] || '0');
          const ampm = timeMatch[3].toLowerCase();
          if (ampm === 'pm' && h !== 12) h += 12;
          if (ampm === 'am' && h === 12) h = 0;
          time = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
          title = title.replace(timeMatch[0], '').trim();
        }

        const newTask = { id: Date.now().toString(), title, type: 'once', date, time, priority: 'medium' };
        tasks.push(newTask);
        await sendTelegram(`✅ Added: ${title}${time ? ' at ' + time : ''} on ${date}`);
        continue;
      }

      // unknown
      await sendTelegram('Commands:\n• list\n• done [task name]\n• add [task] today/tomorrow [3pm]');
    }
  } catch(e) {
    console.error('Poll error:', e.message);
  }
  // poll again immediately
  setTimeout(pollTelegram, 1000);
}

// ── HTTP server ───────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    if (req.method === 'POST' && req.url === '/sync') {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.tasks)) {
          tasks = data.tasks;
          console.log(`Synced: ${tasks.length} tasks`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: tasks.length }));
        } else { res.writeHead(400); res.end('{}'); }
      } catch(e) { res.writeHead(400); res.end('{}'); }
      return;
    }
    if (req.method === 'GET' && req.url === '/test') {
      const r = await sendTelegram('Test from your assistant server! Everything is working. ✅');
      res.writeHead(200); res.end(JSON.stringify({ ok: r && r.ok })); return;
    }
    if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200); res.end('pong'); return; }
    res.writeHead(200); res.end(`Assistant running. Tasks: ${tasks.length}`);
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
  startScheduler();
  startKeepAlive();
  pollTelegram(); // start two-way polling
});

// ── Scheduler ────────────────────────────────────────────────
let lastMorning = null, lastEvening = null, sentReminders = {};

function startScheduler() {
  console.log('Scheduler started...');
  setInterval(checkSchedule, 60000);
  checkSchedule();
}

function startKeepAlive() {
  setInterval(() => {
    http.get(`http://localhost:${process.env.PORT||3000}/ping`, ()=>{}).on('error',()=>{});
  }, 10 * 60 * 1000);
}

async function checkSchedule() {
  const now = getEasternDate();
  const h = now.getHours(), m = now.getMinutes();
  const todayKey = getTodayStr();

  if (h === 8 && m === 0 && lastMorning !== todayKey) {
    lastMorning = todayKey;
    console.log('Sending morning digest...');
    await sendTelegram(buildMorningMsg());
  }
  if (h === 22 && m === 0 && lastEvening !== todayKey) {
    lastEvening = todayKey;
    console.log('Sending evening reminder...');
    await sendTelegram(buildEveningMsg());
  }
  getTasksForDate(now).filter(t => t.time).forEach(async task => {
    const [th, tm] = task.time.split(':').map(Number);
    const ev = new Date(now); ev.setHours(th, tm, 0, 0);
    const diff = ev - now;
    const key = `${todayKey}-${task.id}`;
    if (diff > 9*60000 && diff < 11*60000 && !sentReminders[key]) {
      sentReminders[key] = true;
      await sendTelegram(`⏰ In 10 minutes: ${task.title} at ${task.time}`);
    }
  });
}
