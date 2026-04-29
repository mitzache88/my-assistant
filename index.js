const https = require('https');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

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
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', e => { console.error(e); resolve(null); });
    req.write(body);
    req.end();
  });
}

// Get current time in Eastern
function getEasternTime() {
  const now = new Date();
  const eastern = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return eastern;
}

function getTodayLabel() {
  const d = getEasternTime();
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function getDayOfMonth() {
  return getEasternTime().getDate();
}

function getDayOfWeek() {
  return getEasternTime().getDay(); // 0=Sun, 1=Mon...
}

// Load tasks from environment
function getTasks() {
  try {
    return JSON.parse(process.env.TASKS || '[]');
  } catch(e) {
    return [];
  }
}

function isTaskToday(task) {
  const d = getEasternTime();
  const todayStr = d.toISOString().split('T')[0];
  // Use Eastern date
  const easternDateStr = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD
  if (task.type === 'once' || task.type === 'timed') return task.date === easternDateStr;
  if (task.type === 'recurring') {
    if (task.recur === 'daily') return true;
    if (task.recur === 'weekly') return getDayOfWeek() === task.weekDay;
    if (task.recur === 'monthly') return true;
    if (task.recur === 'dom') return getDayOfMonth() === parseInt(task.domDay);
  }
  return false;
}

function buildMorningMsg(tasks) {
  const todayTasks = tasks.filter(isTaskToday);
  let msg = `Good morning! Your plan for ${getTodayLabel()}:\n\n`;
  if (todayTasks.length === 0) return msg + 'No tasks today. Enjoy your day!';
  const timed = todayTasks.filter(t => t.type === 'timed').sort((a, b) => a.time > b.time ? 1 : -1);
  const other = todayTasks.filter(t => t.type !== 'timed');
  if (timed.length > 0) { msg += 'Scheduled:\n'; timed.forEach(t => msg += `  ${t.time} — ${t.title}\n`); }
  if (other.length > 0) { msg += '\nTasks:\n'; other.forEach(t => msg += `  • ${t.title}\n`); }
  return msg + '\nHave a great day!';
}

// Simple HTTP server so Render keeps it alive
const http = require('http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Assistant server is running!');
});
server.listen(process.env.PORT || 3000, () => {
  console.log('Server running');
  startScheduler();
});

function startScheduler() {
  console.log('Scheduler started, checking every minute...');
  setInterval(checkSchedule, 60000);
  checkSchedule(); // run immediately on start
}

let lastMorning = null;
let lastEvening = null;
let sentReminders = {};

async function checkSchedule() {
  const now = getEasternTime();
  const h = now.getHours();
  const m = now.getMinutes();
  const todayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tasks = getTasks();

  // Morning at 8:00am
  if (h === 8 && m === 0 && lastMorning !== todayKey) {
    lastMorning = todayKey;
    const msg = buildMorningMsg(tasks);
    console.log('Sending morning digest...');
    await sendTelegram(msg);
  }

  // Evening at 10:00pm
  if (h === 22 && m === 0 && lastEvening !== todayKey) {
    lastEvening = todayKey;
    const todayTasks = tasks.filter(isTaskToday);
    if (todayTasks.length > 0) {
      let msg = `Good evening! Here are your tasks for today:\n\n`;
      todayTasks.forEach(t => msg += `  • ${t.title}\n`);
      msg += '\nOpen your assistant to mark them done or move to tomorrow.';
      console.log('Sending evening reminder...');
      await sendTelegram(msg);
    }
  }

  // 10-min reminders for timed tasks
  tasks.filter(t => t.type === 'timed').forEach(async task => {
    const easternDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (task.date !== easternDateStr) return;
    const [th, tm] = task.time.split(':').map(Number);
    const taskTime = new Date(now);
    taskTime.setHours(th, tm, 0, 0);
    const diff = taskTime - now;
    const reminderKey = `${todayKey}-${task.id}`;
    // Fire when between 9-11 minutes away
    if (diff > 9 * 60000 && diff < 11 * 60000 && !sentReminders[reminderKey]) {
      sentReminders[reminderKey] = true;
      console.log(`Sending 10-min reminder for: ${task.title}`);
      await sendTelegram(`Reminder (10 min): ${task.title} at ${task.time}`);
    }
  });
}
