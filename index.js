const https = require('https');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

let tasks = [];
try { tasks = JSON.parse(process.env.TASKS || '[]'); } catch(e) {}

const JSONBIN_ID = process.env.JSONBIN_ID;
const JSONBIN_KEY = process.env.JSONBIN_KEY;

async function loadTasksFromDB() {
  try {
    const data = await new Promise(resolve => {
      const options = {
        hostname: 'api.jsonbin.io',
        path: `/v3/b/${JSONBIN_ID}/latest`,
        headers: { 'X-Master-Key': JSONBIN_KEY }
      };
      https.get(options, res => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
      }).on('error', () => resolve(null));
    });
    if (data && data.record && Array.isArray(data.record.tasks)) {
      tasks = data.record.tasks;
      console.log(`Loaded ${tasks.length} tasks from DB`);
    }
  } catch(e) { console.error('Load DB error:', e.message); }
}

async function saveTasksToDB() {
  try {
    const body = JSON.stringify({ tasks });
    await new Promise(resolve => {
      const options = {
        hostname: 'api.jsonbin.io',
        path: `/v3/b/${JSONBIN_ID}`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': JSONBIN_KEY,
          'Content-Length': Buffer.byteLength(body)
        }
      };
      const req = https.request(options, res => {
        res.on('data', ()=>{});
        res.on('end', resolve);
      });
      req.on('error', resolve);
      req.write(body); req.end();
    });
    console.log(`Saved ${tasks.length} tasks to DB`);
  } catch(e) { console.error('Save DB error:', e.message); }
}
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
async function startPolling() {
  console.log('Starting Telegram polling...');
  let offset = 0;
  while (true) {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=20`;
      const data = await new Promise((resolve) => {
        const req = https.get(url, res => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.setTimeout(25000, () => { req.destroy(); resolve(null); });
      });

      if (!data || !data.ok || !data.result) {
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || String(msg.chat.id) !== String(CHAT_ID)) continue;

        const text = (msg.text || '').trim();
        const lower = text.toLowerCase();
        console.log('Incoming:', lower);

        if (/^(list|tasks|today|what('?s| is) (on my list|on the list|today|my tasks)|show( me)? (my )?(tasks|list|today)|what do i have|what('?s| is) up today|my day|agenda)(\?)?$/i.test(lower)) {
          await sendTelegram(buildListMsg());
        } else if (/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i.test(lower)) {
          const query = lower.replace(/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i,'').replace(/\s+as\s+(done|complete|finished)\s*$/i,'').replace(/^(the\s+)/i,'').trim();
          const todayStr = getTodayStr();
          const task = tasks.find(t => t.title.toLowerCase().includes(query));
          if (task) {
            if (!task.doneDate) task.doneDate = {};
            task.doneDate[todayStr] = true;
            await saveTasksToDB();
            await sendTelegram(`✅ Marked done: ${task.title}`);
          } else {
            await sendTelegram(`❌ Task not found: "${query}"`);
          }
        } else if (/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i.test(lower)) {
          const rest = text.replace(/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i, '').trim();
          if (!rest) { await sendTelegram('❌ Please include a task name.\nExample: add wash the car saturday 12pm'); continue; }

          let date = getTodayStr();
          let title = rest;
          let time = null;

          // Strip filler words that confuse parsing
          // e.g. "on friday", "on saturday at", "for tomorrow"
          let cleaned = title
            .replace(/\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/gi, '$1')
            .replace(/\bfor\s+(today|tomorrow)\b/gi, '$1')
            .replace(/\bthis\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '$1')
            .replace(/\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '$1');

          // Parse date
          const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          const dayMatch = cleaned.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);

          if (/\btomorrow\b/i.test(cleaned)) {
            const tom = getEasternDate(); tom.setDate(tom.getDate()+1);
            date = dateStr(tom);
            cleaned = cleaned.replace(/\btomorrow\b/i, '').trim();
          } else if (/\btoday\b/i.test(cleaned)) {
            cleaned = cleaned.replace(/\btoday\b/i, '').trim();
          } else if (dayMatch) {
            const targetDay = dayNames.indexOf(dayMatch[1].toLowerCase());
            const now = getEasternDate();
            let daysAhead = targetDay - now.getDay();
            if (daysAhead <= 0) daysAhead += 7;
            const target = new Date(now);
            target.setDate(now.getDate() + daysAhead);
            date = dateStr(target);
            cleaned = cleaned.replace(dayMatch[0], '').trim();
          }

          // Parse time — handle many formats:
          // "at 3pm", "at 3:30pm", "3pm", "15:00", "3 pm", "at 3", "@3pm"
          const timePatterns = [
            /\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i,
            /\bat\s+(\d{1,2})\s*(am|pm)\b/i,
            /\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i,
            /\b(\d{1,2})\s*(am|pm)\b/i,
            /\bat\s+(\d{1,2}):(\d{2})\b/,
            /\b(\d{2}):(\d{2})\b/
          ];

          for (const pattern of timePatterns) {
            const m = cleaned.match(pattern);
            if (m) {
              let h, min, ampm;
              if (pattern.source.includes('am|pm')) {
                // has am/pm
                if (m.length === 4) { h = parseInt(m[1]); min = parseInt(m[2]); ampm = m[3]; }
                else { h = parseInt(m[1]); min = 0; ampm = m[2]; }
                if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
                if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
              } else {
                h = parseInt(m[1]); min = parseInt(m[2] || '0');
              }
              time = `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
              cleaned = cleaned.replace(m[0], '').replace(/\bat\b/gi, '').trim();
              break;
            }
          }

          // Clean up leftover punctuation/spaces
          title = cleaned.replace(/\s+/g, ' ').replace(/^[,.\s]+|[,.\s]+$/g, '').trim();

          // Validate title
          if (!title || title.length < 2) {
            await sendTelegram('❌ Could not parse task name. Try:\nadd wash the car friday 12pm');
            continue;
          }

          try {
            const newTask = { id: Date.now().toString(), title, type: 'once', date, time, priority: 'medium' };
            tasks.push(newTask);
            await saveTasksToDB();
            const dayLabel = date === getTodayStr() ? 'today' : new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
            await sendTelegram(`✅ Added: "${title}"\n📅 ${dayLabel}${time ? '\n⏰ ' + time : ''}`);
          } catch(e) {
            await sendTelegram('❌ Something went wrong saving the task. Please try again.');
          }
        } else {
          await sendTelegram('Here\'s what I understand:\n\n📋 TO SEE TASKS:\nlist / tasks / today / what\'s today / show my tasks\n\n➕ TO ADD A TASK:\nadd / schedule / remind me to / book / plan / create / i need to / don\'t forget to / note to self / set a reminder to\n\nExamples:\n• schedule call with Mike tomorrow 12pm\n• remind me to pay bills friday\n• i need to go to the gym monday 7am\n• don\'t forget to call mom today\n• book dentist thursday 10am\n\n✅ TO MARK DONE:\ndone / complete / finished / i did / i finished / check off [task name]');
        }
      }
    } catch(e) {
      console.error('Poll error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
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
          await saveTasksToDB();
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
    if (req.method === 'GET' && req.url === '/tasks') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, tasks }));
      return;
    }
    if (req.method === 'GET' && req.url === '/ping') { res.writeHead(200); res.end('pong'); return; }
    res.writeHead(200); res.end(`Assistant running. Tasks: ${tasks.length}`);
  });
});

const PORT = parseInt(process.env.PORT) || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log('Server running on port', PORT);
  await loadTasksFromDB();
  startScheduler();
  startKeepAlive();
  startPolling();
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
    http.get(`http://localhost:${PORT}/ping`, ()=>{}).on('error',()=>{});
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
