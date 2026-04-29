const https = require('https');
const http = require('http');
 
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
 
let tasks = [];
let doneData = {}; // { "YYYY-MM-DD": { taskId: true } }
 
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
 
function dateStr(d) {
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}
 
function getTodayStr() { return dateStr(getEasternDate()); }
 
function isTaskOnDate(task, d) {
  const ds = dateStr(d);
  if (task.type === 'once') return task.date === ds;
  if (task.type === 'recurring') {
    if (task.recur === 'daily') return true;
    if (task.recur === 'weekly') return d.getDay() === task.weekDay;
    if (task.recur === 'dom') return d.getDate() === parseInt(task.domDay);
    if (task.recur === 'biweekly') {
      if (d.getDay() !== task.weekDay) return false;
      const start = new Date(task.biweekStart + 'T00:00:00');
      const diffDays = Math.round((d - start) / (1000*60*60*24));
      return diffDays >= 0 && diffDays % 14 === 0;
    }
  }
  return false;
}
 
function isDone(taskId, dateString) {
  // Check server doneData first, then task's own doneDate field
  if (doneData[dateString] && doneData[dateString][taskId]) return true;
  const task = tasks.find(t => t.id === taskId);
  if (task && task.doneDate && task.doneDate[dateString]) return true;
  return false;
}
 
function getTasksForDate(d) { return tasks.filter(t => isTaskOnDate(t, d)); }
 
function buildMorningMsg() {
  const now = getEasternDate();
  const todayStr = getTodayStr();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = dateStr(yesterday);
 
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
 
  let msg = `Good morning! ${days[now.getDay()]}, ${months[now.getMonth()]} ${now.getDate()}:\n\n`;
 
  // Yesterday's unfinished tasks
  const yesterdayTasks = getTasksForDate(yesterday).filter(t => !isDone(t.id, yesterdayStr));
  if (yesterdayTasks.length > 0) {
    msg += '⚠️ Not done yesterday:\n';
    yesterdayTasks.forEach(t => msg += `  • ${t.title}\n`);
    msg += '\n';
  }
 
  // Today's tasks
  const todayTasks = getTasksForDate(now);
  if (todayTasks.length === 0) {
    msg += 'No tasks today. Enjoy your day!';
    return msg;
  }
 
  const timed = todayTasks.filter(t => t.time).sort((a, b) => a.time > b.time ? 1 : -1);
  const other = todayTasks.filter(t => !t.time);
 
  if (timed.length > 0) { msg += "Today's scheduled:\n"; timed.forEach(t => msg += `  ${t.time} — ${t.title}\n`); }
  if (other.length > 0) { msg += "\nToday's tasks:\n"; other.forEach(t => msg += `  • ${t.title}\n`); }
 
  return msg + '\nHave a great day!';
}
 
function buildEveningMsg() {
  const now = getEasternDate();
  const todayStr = getTodayStr();
  const undone = getTasksForDate(now).filter(t => !isDone(t.id, todayStr));
  if (undone.length === 0) return 'Great job! All tasks completed today. 🎉';
  let msg = `Good evening! ${undone.length} task${undone.length > 1 ? 's' : ''} still pending:\n\n`;
  undone.forEach(t => msg += `  • ${t.title}\n`);
  return msg + '\nOpen your assistant to mark done or move to tomorrow.';
}
 
// HTTP server
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
 
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
 
    // POST /sync — sync tasks + done status from app
    if (req.method === 'POST' && req.url === '/sync') {
      try {
        const data = JSON.parse(body);
        if (Array.isArray(data.tasks)) {
          tasks = data.tasks;
          // Extract doneDate from tasks into doneData
          tasks.forEach(t => {
            if (t.doneDate) {
              Object.keys(t.doneDate).forEach(dateKey => {
                if (!doneData[dateKey]) doneData[dateKey] = {};
                if (t.doneDate[dateKey]) doneData[dateKey][t.id] = true;
              });
            }
          });
          console.log(`Synced: ${tasks.length} tasks`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, count: tasks.length }));
        } else {
          res.writeHead(400); res.end(JSON.stringify({ ok: false }));
        }
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ ok: false, error: e.message }));
      }
      return;
    }
 
    // GET /test
    if (req.method === 'GET' && req.url === '/test') {
      const r = await sendTelegram('Test from your assistant server! Everything is working. ✅');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: r && r.ok }));
      return;
    }
 
    // GET /ping — keep-alive endpoint
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200); res.end('pong');
      return;
    }
 
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Assistant running. Tasks: ${tasks.length}`);
  });
});
 
server.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
  startScheduler();
  startKeepAlive();
});
 
let lastMorning = null;
let lastEvening = null;
let sentReminders = {};
 
function startScheduler() {
  console.log('Scheduler started...');
  setInterval(checkSchedule, 60000);
  checkSchedule();
}
 
// Keep-alive: ping self every 10 min to prevent spin-down
function startKeepAlive() {
  setInterval(() => {
    const port = process.env.PORT || 3000;
    http.get(`http://localhost:${port}/ping`, (res) => {
      console.log('Keep-alive ping sent');
    }).on('error', () => {});
  }, 10 * 60 * 1000);
}
 
async function checkSchedule() {
  const now = getEasternDate();
  const h = now.getHours();
  const m = now.getMinutes();
  const todayKey = getTodayStr();
 
  // Morning at 8:00am
  if (h === 8 && m === 0 && lastMorning !== todayKey) {
    lastMorning = todayKey;
    console.log('Sending morning digest...');
    await sendTelegram(buildMorningMsg());
  }
 
  // Evening at 10:00pm
  if (h === 22 && m === 0 && lastEvening !== todayKey) {
    lastEvening = todayKey;
    const msg = buildEveningMsg();
    console.log('Sending evening reminder...');
    await sendTelegram(msg);
  }
 
  // 10-min reminders
  const todayTasks = getTasksForDate(now);
  todayTasks.filter(t => t.time).forEach(async task => {
    const [th, tm] = task.time.split(':').map(Number);
    const taskTime = new Date(now);
    taskTime.setHours(th, tm, 0, 0);
    const diff = taskTime - now;
    const reminderKey = `${todayKey}-${task.id}`;
    if (diff > 9 * 60000 && diff < 11 * 60000 && !sentReminders[reminderKey]) {
      sentReminders[reminderKey] = true;
      console.log(`10-min reminder: ${task.title}`);
      await sendTelegram(`⏰ In 10 minutes: ${task.title} at ${task.time}`);
    }
  });
}
 
