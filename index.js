const https = require('https');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// In-memory task store (updated via API from the app)
let tasks = [];
try { tasks = JSON.parse(process.env.TASKS || '[]'); } catch(e) {}

function sendTelegram(text) {
  const body = JSON.stringify({ chat_id: CHAT_ID, text });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  };
  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(null); } });
    });
    req.on('error', e => { console.error(e); resolve(null); });
    req.write(body);
    req.end();
  });
}

function getEasternDate() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function getTodayStr() {
  const d = getEasternDate();
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function isTaskToday(task) {
  const d = getEasternDate();
  const todayStr = getTodayStr();
  if (task.type === 'once' || task.type === 'timed') return task.date === todayStr;
  if (task.type === 'recurring') {
    if (task.recur === 'daily') return true;
    if (task.recur === 'weekly') return d.getDay() === task.weekDay;
    if (task.recur === 'monthly') return true;
    if (task.recur === 'dom') return d.getDate() === parseInt(task.domDay);
  }
  return false;
}

function buildMorningMsg() {
  const d = getEasternDate();
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const todayTasks = tasks.filter(isTaskToday);
  let msg = `Good morning! Your plan for ${days[d.getDay()]} ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' })}:\n\n`;
  if (todayTasks.length === 0) return msg + 'No tasks today. Enjoy your day!';
  const timed = todayTasks.filter(t => t.type === 'timed').sort((a, b) => a.time > b.time ? 1 : -1);
  const other = todayTasks.filter(t => t.type !== 'timed');
  if (timed.length > 0) { msg += 'Scheduled:\n'; timed.forEach(t => msg += `  ${t.time} — ${t.title}\n`); }
  if (other.length > 0) { msg += '\nTasks:\n'; other.forEach(t => msg += `  • ${t.title}\n`); }
  return msg + '\nHave a great day!';
}

function buildEveningMsg() {
  const undone = tasks.filter(isTaskToday);
  if (undone.length === 0) return 'Great job! All tasks completed today.';
  let msg = `Good evening! Here are your tasks for today:\n\n`;
  undone.forEach(t => msg += `  • ${t.title}\n`);
  return msg + '\nOpen your assistant to mark them done or move to tomorrow.';
}

// HTTP server handles both keep-alive and task sync API
const server = http.createServer((req, res) => {
  // CORS headers so the phone app can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200); res.end(); return;
  }

  // POST /sync — app sends its tasks here
  if (req.method === 'POST' && req.url === '/sync') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.tasks)) {
          tasks = data.tasks;
          console.log(`Tasks synced: ${tasks.length} tasks`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: tasks.length }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ ok: false }));
        }
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // GET /test — send a test Telegram message right now
  if (req.method === 'GET' && req.url === '/test') {
    sendTelegram('Test from your assistant server! Everything is working.').then(r => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r && r.ok }));
    });
    return;
  }

  // GET / — status page
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Assistant server running. Tasks loaded: ${tasks.length}`);
});

server.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
  startScheduler();
});

let lastMorning = null;
let lastEvening = null;
let sentReminders = {};

function startScheduler() {
  console.log('Scheduler started, checking every minute...');
  setInterval(checkSchedule, 60000);
}

async function checkSchedule() {
  const now = getEasternDate();
  const h = now.getHours();
  const m = now.getMinutes();
  const todayKey = getTodayStr();

  // Morning at 8:00am Eastern
  if (h === 8 && m === 0 && lastMorning !== todayKey) {
    lastMorning = todayKey;
    console.log('Sending morning digest...');
    await sendTelegram(buildMorningMsg());
  }

  // Evening at 10:00pm Eastern
  if (h === 22 && m === 0 && lastEvening !== todayKey) {
    lastEvening = todayKey;
    const todayTasks = tasks.filter(isTaskToday);
    if (todayTasks.length > 0) {
      console.log('Sending evening reminder...');
      await sendTelegram(buildEveningMsg());
    }
  }

  // 10-min reminders for timed tasks
  tasks.filter(t => t.type === 'timed').forEach(async task => {
    if (task.date !== todayKey) return;
    const [th, tm] = task.time.split(':').map(Number);
    const taskTime = new Date(now);
    taskTime.setHours(th, tm, 0, 0);
    const diff = taskTime - now;
    const reminderKey = `${todayKey}-${task.id}`;
    if (diff > 9 * 60000 && diff < 11 * 60000 && !sentReminders[reminderKey]) {
      sentReminders[reminderKey] = true;
      console.log(`Sending 10-min reminder for: ${task.title}`);
      await sendTelegram(`Reminder (10 min): ${task.title} at ${task.time}`);
    }
  });
}
