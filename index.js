const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;

let tasks = [];
let people = {}; // { "andreea": { birthday: "05-15" } }  MM-DD format
let pendingQueue = []; // queue of pending questions
function pendingQuestion() { return pendingQueue[0] || null; }
function setPending(q) { pendingQueue.push(q); }
function clearPending() { pendingQueue.shift(); }
function hasPending() { return pendingQueue.length > 0; }

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
    if (data && data.record) {
      if (Array.isArray(data.record.tasks)) { tasks = data.record.tasks; console.log(`Loaded ${tasks.length} tasks from DB`); }
      if (data.record.people) { people = data.record.people; console.log(`Loaded ${Object.keys(people).length} people from DB`); }
    }
  } catch(e) { console.error('Load DB error:', e.message); }
}

async function saveTasksToDB() {
  try {
    const body = JSON.stringify({ tasks, people });
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
    console.log(`Saved ${tasks.length} tasks + ${Object.keys(people).length} people to DB`);
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

// ── Voice transcription ───────────────────────────────────────
async function getTelegramFileUrl(fileId) {
  return new Promise(resolve => {
    https.get(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.ok) resolve(`https://api.telegram.org/file/bot${BOT_TOKEN}/${data.result.file_path}`);
          else resolve(null);
        } catch(e) { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join('/tmp', `voice_${Date.now()}.oga`);
    const file = fs.createWriteStream(tmpPath);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    }).on('error', reject);
  });
}

async function transcribeVoice(filePath) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), { filename: 'voice.oga', contentType: 'audio/ogg' });
    form.append('model', 'whisper-1');
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: { ...form.getHeaders(), 'Authorization': `Bearer ${OPENAI_KEY}` }
    };
    const req = https.request(options, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body).text || null); }
        catch(e) { resolve(null); }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

async function translateToEnglish(text) {
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are a translator. Translate the following text to English. If it is already in English, return it as-is. Only return the translated text, nothing else.' },
      { role: 'user', content: text }
    ],
    max_tokens: 200
  });
  return new Promise(resolve => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data).choices[0].message.content.trim()); }
        catch(e) { resolve(text); } // fallback to original
      });
    });
    req.on('error', () => resolve(text));
    req.write(body); req.end();
  });
}

async function speakReply(text) {
  // Strip emojis for cleaner speech
  const clean = text.replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '').replace(/[☐✅⏰❗⚠️📋➕✔️🎉🎙️❌📅]/g, '').trim();
  return new Promise(resolve => {
    const body = JSON.stringify({ model: 'tts-1', voice: 'alloy', input: clean.slice(0, 4096) });
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${OPENAI_KEY}`, 'Content-Length': Buffer.byteLength(body) }
    };
    const tmpPath = path.join('/tmp', `reply_${Date.now()}.mp3`);
    const file = fs.createWriteStream(tmpPath);
    const req = https.request(options, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(tmpPath); });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

async function sendVoiceReply(text) {
  try {
    const filePath = await speakReply(text);
    if (!filePath) { await sendTelegram(text); return; }
    await new Promise(resolve => {
      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('voice', fs.createReadStream(filePath), { filename: 'reply.mp3', contentType: 'audio/mpeg' });
      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendVoice`,
        method: 'POST',
        headers: form.getHeaders()
      };
      const req = https.request(options, res => {
        res.on('data', ()=>{});
        res.on('end', () => { fs.unlink(filePath, ()=>{}); resolve(); });
      });
      req.on('error', () => resolve());
      form.pipe(req);
    });
    // Also send text for reference
    await sendTelegram(text);
  } catch(e) {
    console.error('TTS error:', e.message);
    await sendTelegram(text);
  }
}

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

function buildListMsg() { return buildListMsgForDate(getEasternDate()); }

function buildListMsgForDate(d) {
  const todayStr = getTodayStr();
  const ds = dateStr(d);
  const dayTasks = getTasksForDate(d);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let label = ds === todayStr ? 'Today' : `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
  if (!dayTasks.length) return `📋 ${label}:\n\nNo tasks. Enjoy your day!`;
  let msg = `📋 ${label}:\n\n`;
  const timed = dayTasks.filter(t => t.time).sort((a,b) => a.time > b.time ? 1 : -1);
  const other = dayTasks.filter(t => !t.time);
  if (timed.length) { timed.forEach(t => msg += `  ${isDone(t,ds)?'✅':'⏰'} ${t.time} — ${t.title}${t.priority==='high'?' ❗':''}\n`); }
  if (other.length) { if (timed.length) msg += '\n'; other.forEach(t => msg += `  ${isDone(t,ds)?'✅':'☐'} ${t.title}${t.priority==='high'?' ❗':''}\n`); }
  return msg;
}

// Smart reply — voice if input was voice, text otherwise
let lastBotReply = { text: '', timestamp: 0 };

async function reply(text, voice) {
  lastBotReply = { text, timestamp: Date.now() };
  if (voice) {
    await sendVoiceReply(text);
  } else {
    await sendTelegram(text);
  }
}
// Holiday lookup table
function getHoliday(name, year) {
  const n = name.toLowerCase().replace(/[\s'\-]/g,'');
  const fixed = {
    newyears:`${year}-01-01`,newyearsday:`${year}-01-01`,
    valentinesday:`${year}-02-14`,valentines:`${year}-02-14`,
    stpatricksday:`${year}-03-17`,stpatricks:`${year}-03-17`,
    halloween:`${year}-10-31`,
    christmas:`${year}-12-25`,christmasday:`${year}-12-25`,
    christmaseve:`${year}-12-24`,
    newyearseve:`${year}-12-31`,
    independenceday:`${year}-07-04`,july4th:`${year}-07-04`,fourthofjuly:`${year}-07-04`,
    veteransday:`${year}-11-11`,cincodemayo:`${year}-05-05`,
  };
  if (fixed[n]) return fixed[n];
  // nth weekday helpers
  const nth = (y,mo,wd,n) => { const d=new Date(y,mo,1);let c=0;while(d.getMonth()===mo){if(d.getDay()===wd){c++;if(c===n)return dateStr(d);}d.setDate(d.getDate()+1);}return null; };
  const last = (y,mo,wd) => { const d=new Date(y,mo+1,0);while(d.getDay()!==wd)d.setDate(d.getDate()-1);return dateStr(d); };
  // Easter (Anonymous Gregorian)
  const easter = (y) => { const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),dy=((h+l-7*m+114)%31)+1;return new Date(y,mo-1,dy); };
  const computed = {
    mlkday:()=>nth(year,0,1,3), martinlutherking:()=>nth(year,0,1,3),
    presidentsday:()=>nth(year,1,1,3),
    mothersday:()=>nth(year,4,0,2),
    fathersday:()=>nth(year,5,0,3),
    memorialday:()=>last(year,4,1),
    laborday:()=>nth(year,8,1,1),
    columbusday:()=>nth(year,9,1,2),
    thanksgiving:()=>nth(year,10,4,4),thanksgivingday:()=>nth(year,10,4,4),
    blackfriday:()=>{ const t=nth(year,10,4,4);if(!t)return null;const d=new Date(t+'T12:00');d.setDate(d.getDate()+1);return dateStr(d); },
    easter:()=>dateStr(easter(year)),
    goodfriday:()=>{ const d=easter(year);d.setDate(d.getDate()-2);return dateStr(d); },
  };
  if (computed[n]) return computed[n]();
  return null;
}

// Parse natural language date from text, returns { date, cleaned }
function parseNaturalDate(text) {
  let cleaned = text;
  let date = getTodayStr();
  let found = false;
  const now = getEasternDate();
  const yr = now.getFullYear();
  const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const monthShort = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  const allMonths = [...monthNames,...monthShort].join('|');

  function parseMonthDay(monthStr, dayNum, yearStr) {
    let mIdx = monthNames.indexOf(monthStr.toLowerCase());
    if (mIdx === -1) mIdx = monthShort.indexOf(monthStr.toLowerCase());
    const day = parseInt(dayNum);
    let year = yearStr ? parseInt(yearStr) : yr;
    const candidate = new Date(year, mIdx, day);
    if (candidate < now && !yearStr) year++;
    return new Date(year, mIdx, day);
  }

  const holidayNames = 'christmas|christmas eve|christmas day|mothers day|fathers day|thanksgiving|halloween|new years|new years eve|new years day|valentines day|valentines|memorial day|labor day|independence day|july 4th|fourth of july|easter|good friday|black friday|columbus day|veterans day|cinco de mayo|st patricks day|mlk day|martin luther king|presidents day';
  const relHoliday = new RegExp(`(?:(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)\\s+days?\\s+|(the\\s+day\\s+))\\s*(before|after|prior to|ahead of)\\s+(${holidayNames})`, 'i');
  const wordNums = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};

  let m;
  if ((m = cleaned.match(relHoliday))) {
    const numStr = m[1] || '1';
    const days = wordNums[numStr.toLowerCase()] !== undefined ? wordNums[numStr.toLowerCase()] : (parseInt(numStr)||1);
    const isBefore = /before|prior|ahead/.test(m[3].toLowerCase());
    const holidayKey = m[4].trim();
    let hDate = getHoliday(holidayKey, yr);
    if (hDate && new Date(hDate+'T12:00') < now) hDate = getHoliday(holidayKey, yr+1);
    if (hDate) {
      const target = new Date(hDate+'T12:00');
      target.setDate(target.getDate() + (isBefore ? -days : days));
      date = dateStr(target);
      cleaned = cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();
      found = true;
    }
    // if hDate is null: holiday name matched but unknown → found stays false
  } else {
    const relMD = new RegExp(`(\\d+)\\s+days?\\s+(before|after|prior to|from)\\s+(?:the\\s+)?(${allMonths})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?`, 'i');
    const relDM = new RegExp(`(\\d+)\\s+days?\\s+(before|after|prior to|from)\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${allMonths})(?:\\s+(\\d{4}))?`, 'i');
    const relSimple = /(\d+)\s+days?\s+(before|after|prior to|from)\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
    const monthDayPattern = new RegExp(`\\b(${allMonths})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?\\b`, 'i');
    const dayMonthPattern = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${allMonths})(?:\\s+(\\d{4}))?\\b`, 'i');

    if ((m = cleaned.match(relMD))) {
      const offset=parseInt(m[1]);const dir=/before|prior/i.test(m[2])?-1:1;
      const anchor=parseMonthDay(m[3],m[4],m[5]);anchor.setDate(anchor.getDate()+dir*offset);
      date=dateStr(anchor);cleaned=cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();found=true;
    } else if ((m = cleaned.match(relDM))) {
      const offset=parseInt(m[1]);const dir=/before|prior/i.test(m[2])?-1:1;
      const anchor=parseMonthDay(m[4],m[3],m[5]);anchor.setDate(anchor.getDate()+dir*offset);
      date=dateStr(anchor);cleaned=cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();found=true;
    } else if ((m = cleaned.match(relSimple))) {
      const offset=parseInt(m[1]);const dir=/before|prior/i.test(m[2])?-1:1;
      let anchor=getEasternDate();const ref=m[3].toLowerCase();
      if(ref==='tomorrow')anchor.setDate(anchor.getDate()+1);
      else if(dayNames.includes(ref)){let da=dayNames.indexOf(ref)-anchor.getDay();if(da<=0)da+=7;anchor.setDate(anchor.getDate()+da);}
      anchor.setDate(anchor.getDate()+dir*offset);
      date=dateStr(anchor);cleaned=cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();found=true;
    } else if ((m = cleaned.match(monthDayPattern))) {
      const anchor=parseMonthDay(m[1],m[2],m[3]);date=dateStr(anchor);
      cleaned=cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();found=true;
    } else if ((m = cleaned.match(dayMonthPattern))) {
      const anchor=parseMonthDay(m[2],m[1],m[3]);date=dateStr(anchor);
      cleaned=cleaned.replace(m[0],'').replace(/\bon\b/gi,'').trim();found=true;
    } else if (/\btomorrow\b/i.test(cleaned)) {
      const t=getEasternDate();t.setDate(t.getDate()+1);date=dateStr(t);
      cleaned=cleaned.replace(/\btomorrow\b/i,'').trim();found=true;
    } else if (/\btoday\b|\btonight\b/i.test(cleaned)) {
      cleaned=cleaned.replace(/\btoday\b|\btonight\b/gi,'').trim();found=true;
    } else if (/\bnext week\b/i.test(cleaned)) {
      const t=getEasternDate();t.setDate(t.getDate()+7);date=dateStr(t);
      cleaned=cleaned.replace(/\bnext week\b/i,'').trim();found=true;
    } else {
      const dm=cleaned.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if(dm){
        const td=dayNames.indexOf(dm[1].toLowerCase());
        let da=td-now.getDay();if(da<=0)da+=7;
        const t=new Date(now);t.setDate(now.getDate()+da);
        date=dateStr(t);cleaned=cleaned.replace(dm[0],'').trim();found=true;
      }
    }
  }
  return { date, cleaned, found };
}
// Schedule a birthday reminder task
function scheduleBirthdayReminder(name, mmdd, reminderDays, reminderTitle) {
  const now = getEasternDate();
  const todayStr = dateStr(now);
  const yr = now.getFullYear();
  const [mm, dd] = mmdd.split('-').map(Number);

  // Find next upcoming birthday - compare as date strings to avoid timezone issues
  let bdayYear = yr;
  const bdayThisYear = `${yr}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  if (bdayThisYear <= todayStr) bdayYear = yr + 1;

  const bday = new Date(bdayYear, mm-1, dd, 12, 0, 0); // noon to avoid timezone edge cases

  // Calculate reminder date
  const reminderDate = new Date(bday);
  reminderDate.setDate(reminderDate.getDate() - reminderDays);

  // If reminder date is also in the past, move birthday to next year
  const reminderStr = dateStr(reminderDate);
  if (reminderStr <= todayStr) {
    bday.setFullYear(bdayYear + 1);
    reminderDate.setFullYear(bdayYear + 1);
  }

  const taskTitle = reminderTitle || `Buy gift for ${name}'s birthday`;
  const dateKey = dateStr(reminderDate);

  // Remove old reminder for same person if exists
  const existing = tasks.findIndex(t => t._birthdayFor === name.toLowerCase() && t._birthdayReminder);
  if (existing > -1) tasks.splice(existing, 1);

  const newTask = {
    id: Date.now().toString(),
    title: taskTitle,
    type: 'once',
    date: dateKey,
    time: null,
    priority: 'medium',
    _birthdayFor: name.toLowerCase(),
    _birthdayReminder: true
  };
  tasks.push(newTask);
  return { task: newTask, birthdayDate: dateStr(bday) };
}

// Detect "X days before [name]'s birthday" pattern
// ── GENERAL EVENT REMINDER PARSER ──
// Handles: "X days before/after/on [event]", "the day of [event]", "when [person] arrives/lands/gets back"
function parseEventReminder(text) {
  const wordNums = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,fifteen:15,twenty:20};

  // Extract offset and direction first
  let days = 0;
  let direction = 0; // -1 = before, 0 = on, 1 = after
  let eventPhrase = null;
  let taskPart = text;

  // Patterns:
  // "X days before [event]"
  // "X days after [event]"
  // "the day before/after [event]"
  // "on the day of [event]" / "on [event]"
  // "when [person] [verb]s" → event = "[person] [verb]s"

  const beforePat = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+days?\s+before\s+(.+?)(?:\s*$)/i;
  const afterPat  = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)\s+days?\s+after\s+(.+?)(?:\s*$)/i;
  const dayBefore = /\bthe\s+day\s+before\s+(.+?)(?:\s*$)/i;
  const dayAfter  = /\bthe\s+day\s+after\s+(.+?)(?:\s*$)/i;
  const onEvent   = /\b(?:on\s+(?:the\s+day\s+of\s+)?|for\s+)(.+?)(?:'s\s+\w+|\s*$)/i;
  const whenPat   = /\bwhen\s+(.+?)(?:\s+(?:arrives?|lands?|gets?\s+back|comes?\s+back|returns?|is\s+back|gets?\s+here|shows?\s+up|starts?|begins?|happens?|is\s+done|finishes?|ends?))(?:\s*$)/i;
  const atEvent   = /\bat\s+(?:the\s+)?(.+?)(?:\s*$)/i;

  let m;

  if ((m = text.match(beforePat))) {
    const numStr = m[1].toLowerCase();
    days = wordNums[numStr] ?? parseInt(numStr) ?? 1;
    direction = -1;
    eventPhrase = m[2].trim();
  } else if ((m = text.match(afterPat))) {
    const numStr = m[1].toLowerCase();
    days = wordNums[numStr] ?? parseInt(numStr) ?? 1;
    direction = 1;
    eventPhrase = m[2].trim();
  } else if ((m = text.match(dayBefore))) {
    days = 1; direction = -1;
    eventPhrase = m[1].trim();
  } else if ((m = text.match(dayAfter))) {
    days = 1; direction = 1;
    eventPhrase = m[1].trim();
  } else if ((m = text.match(whenPat))) {
    days = 0; direction = 1; // "when X arrives" → schedule for that day
    eventPhrase = m[1].trim() + (text.match(/arrives?|lands?|gets?\s+back|comes?\s+back|returns?|is\s+back|gets?\s+here|shows?\s+up|starts?|begins?|happens?|finishes?|ends?/i)||[''])[0];
    eventPhrase = eventPhrase.trim();
  } else {
    return null; // no event pattern found
  }

  if (!eventPhrase) return null;

  // Clean up event phrase — remove trailing punctuation
  eventPhrase = eventPhrase.replace(/[.,!?]+$/, '').trim();

  // Extract task title = everything before the timing clause
  // Remove the timing clause from original text to get the task
  taskPart = text
    .replace(/remind me to\s*/i, '')
    .replace(/remind me\s*/i, '')
    .replace(new RegExp(escapeReg(m[0]), 'i'), '')
    .replace(/\s+/g, ' ').trim()
    .replace(/^[,.\s]+|[,.\s]+$/g, '').trim();

  return { eventPhrase, days, direction, taskPart };
}

function escapeReg(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Legacy wrapper for birthday-specific calls
function parseBirthdayReminder(text) {
  // Birthday patterns - extract name and treat birthday as the event
  const wordNums = {one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
  const beforeM = text.match(/(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+days?\s+before|the\s+day\s+before)\s+([\w]+)(?:'s|s')?\s+birthday/i);
  if (beforeM) {
    const numStr = beforeM[1] || '1';
    const days = wordNums[numStr?.toLowerCase()] ?? (parseInt(numStr)||1);
    return { name: resolvePersonName(beforeM[2], text), days, isBirthday: true };
  }
  const onM = text.match(/(?:on|for)\s+([\w]+(?:'s|s')?|his|her|my\s+\w+(?:'s)?)\s+birthday/i);
  if (onM) {
    const rawName = onM[1].replace(/'s$/i,'').replace(/s'$/i,'').trim();
    return { name: resolvePersonName(rawName, text), days: 0, isBirthday: true };
  }
  const simpleM = text.match(/([\w]+)(?:'s|s')\s+birthday/i);
  if (simpleM) {
    return { name: resolvePersonName(simpleM[1], text), days: 0, isBirthday: true };
  }
  return null;
}

function resolvePersonName(raw, fullText) {
  const r = raw.toLowerCase().trim();
  // If pronoun, extract the actual person from the full text
  if (/^(my|his|her|their|its)$/.test(r) || r === '') {
    // First look for a proper name (capitalized word that's not a command word)
    const nameMatch = fullText.match(/\b(?:call|text|visit|see|meet|remind|contact)\s+([A-Z][a-z]+)\b/);
    if (nameMatch) return nameMatch[1];
    // Look for relation words anywhere in the text
    const relationMatch = fullText.match(/\b(mom|mother|mama|mum|dad|father|papa|pop|brother|sister|wife|husband|girlfriend|boyfriend|partner|son|daughter|grandma|grandmother|grandpa|grandfather|aunt|uncle|cousin|friend|boss|colleague)\b/i);
    if (relationMatch) return resolvePersonName(relationMatch[1], fullText);
    // Look for "my X"
    const myMatch = fullText.match(/\bmy\s+([\w]+)/i);
    if (myMatch) return resolvePersonName(myMatch[1], fullText);
    return 'them';
  }
  if (/^(mom|mother|mama|mum)$/i.test(r)) return 'Mom';
  if (/^(dad|father|papa|pop)$/i.test(r)) return 'Dad';
  if (/^(brother)$/i.test(r)) return 'Brother';
  if (/^(sister)$/i.test(r)) return 'Sister';
  if (/^(wife)$/i.test(r)) return 'Wife';
  if (/^(husband)$/i.test(r)) return 'Husband';
  if (/^(son)$/i.test(r)) return 'Son';
  if (/^(daughter)$/i.test(r)) return 'Daughter';
  if (/^(grandma|grandmother)$/i.test(r)) return 'Grandma';
  if (/^(grandpa|grandfather)$/i.test(r)) return 'Grandpa';
  return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
}


// Extract clean task title from a "remind me to X [timing]" command
function extractTaskTitle(text, name) {
  let t = text
    .replace(/^(remind me to|remind me|please remind me to|can you remind me to)\s*/i, '')
    .trim();
  // Remove all timing/birthday/event clauses from the END of the string
  t = t
    .replace(/\s+\d+\s+days?\s+(before|after)\s+.*$/i, '')
    .replace(/\s+the\s+day\s+(before|after)\s+.*$/i, '')
    .replace(/\s+on\s+(his|her|their|my|our)\s+birthday.*$/i, '')
    .replace(/\s+on\s+\w+['']?s?\s+birthday.*$/i, '')
    .replace(/\s+for\s+\w+['']?s?\s+birthday.*$/i, '')
    .replace(/\s+at\s+(his|her|their|my)\s+birthday.*$/i, '')
    .replace(/\s+when\s+.*$/i, '')
    .replace(/\s+before\s+.*$/i, '')
    .replace(/\s+after\s+.*$/i, '')
    .replace(/[.\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  // If stripping left nothing meaningful, build a default
  if (!t || t.length < 2) t = name ? `Call ${name}` : 'Reminder';
  // Replace generic pronouns with actual name
  if (name && name !== 'them') {
    t = t.replace(/\b(him|her|them|my mom|my dad|my brother|my sister)\b/gi, name);
  }
  return t;
}

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
        let isVoiceMessage = false;

        // Handle voice messages
        if (msg.voice || msg.audio) {
          isVoiceMessage = true;
          const fileId = (msg.voice || msg.audio).file_id;
          try {
            const fileUrl = await getTelegramFileUrl(fileId);
            if (!fileUrl) { await reply('❌ Could not download voice message. Try again.', false); continue; }
            const filePath = await downloadFile(fileUrl);
            const transcribed = await transcribeVoice(filePath);
            fs.unlink(filePath, ()=>{});
            if (!transcribed) { await reply('❌ Could not transcribe. Please try again.', false); continue; }
            console.log('Transcribed:', transcribed);
            const translated = await translateToEnglish(transcribed);
            console.log('Translated:', translated);
            msg.text = translated;
          } catch(e) {
            console.error('Voice error:', e.message);
            await reply('❌ Voice processing failed. Please try again.', false);
            continue;
          }
        }

        // Re-read text (may have been set by voice transcription)
        const rawText = (msg.text || '').trim();
        // Translate to English if needed (works for typed Romanian/Spanish too)
        const finalText = rawText ? await translateToEnglish(rawText) : '';
        const finalLower = finalText.toLowerCase();

        // Strip "hey" prefix and reprocess naturally
        const cleanText = finalText.replace(/^hey[,!]?\s*/i, '').trim();
        const cleanLower = cleanText.toLowerCase();
        const effectiveText = cleanText;
        const effectiveLower = cleanLower;

        // ── PENDING QUESTION HANDLER ──
        if (pendingQuestion() && pendingQuestion().type === 'event') {
          const { date: eventDate, found } = parseNaturalDate(finalText.trim());
          if (found) {
            const { eventPhrase, days, direction, taskTitle } = pendingQuestion();
            people[eventPhrase.toLowerCase()] = { eventDate };
            const anchor = new Date(eventDate+'T12:00');
            anchor.setDate(anchor.getDate() + direction * days);
            const newTask = {id:Date.now().toString(),title:taskTitle,type:'once',date:dateStr(anchor),time:null,priority:'medium'};
            tasks.push(newTask); await saveTasksToDB();
            clearPending();
            const dirLabel = direction===-1?(days===1?'the day before':days+' days before'):direction===1?(days===1?'the day after':days+' days after'):'on';
            const rDay = anchor.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
            let msg = `✅ "${taskTitle}"\n📅 ${rDay}`;
            if (hasPending()) {
              const next = pendingQuestion();
              msg += `\nWhen is ${next.eventPhrase||next.name}?`;
            }
            await reply(msg, isVoiceMessage);
          } else {
            await reply(`I didn't catch that. Try "May 15" or "next Friday".`, isVoiceMessage);
          }
          continue;
        }

        if (pendingQuestion() && pendingQuestion().type === 'birthday') {
          const answer = finalText.trim();
          // Try to parse a date from the answer (e.g. "May 15", "15th of May", "05/15")
          let mmdd = null;
          const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
          const monthShort = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
          const allMonths = [...monthNames,...monthShort].join('|');
          let m2;
          const mdP = new RegExp(`\\b(${allMonths})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i');
          const dmP = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${allMonths})\\b`, 'i');
          const slashP = /\b(\d{1,2})[\/\-](\d{1,2})\b/;
          if ((m2 = answer.match(mdP))) {
            let mIdx = monthNames.indexOf(m2[1].toLowerCase()); if(mIdx===-1) mIdx=monthShort.indexOf(m2[1].toLowerCase());
            mmdd = `${String(mIdx+1).padStart(2,'0')}-${String(parseInt(m2[2])).padStart(2,'0')}`;
          } else if ((m2 = answer.match(dmP))) {
            let mIdx = monthNames.indexOf(m2[2].toLowerCase()); if(mIdx===-1) mIdx=monthShort.indexOf(m2[2].toLowerCase());
            mmdd = `${String(mIdx+1).padStart(2,'0')}-${String(parseInt(m2[1])).padStart(2,'0')}`;
          } else if ((m2 = answer.match(slashP))) {
            mmdd = `${String(parseInt(m2[1])).padStart(2,'0')}-${String(parseInt(m2[2])).padStart(2,'0')}`;
          }
          if (mmdd) {
            const { name, days: rDays, reminderTitle } = pendingQuestion;
            people[name.toLowerCase()] = { name, birthday: mmdd };
            const { task, birthdayDate } = scheduleBirthdayReminder(name, mmdd, rDays, reminderTitle);
            await saveTasksToDB();
            clearPending();
            const bday = new Date(birthdayDate+'T12:00').toLocaleDateString('en-US',{month:'long',day:'numeric'});
            const rDay = new Date(task.date+'T12:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
            let bdayMsg = `🎂 Got it! ${name}'s birthday is ${bday}.\n✅ Reminder set: "${task.title}"\n📅 ${rDay}`;
            if (hasPending()) {
              const next = pendingQuestion();
              bdayMsg += `\nWhen is ${next.eventPhrase||next.name}?`;
            }
            await reply(bdayMsg, isVoiceMessage);
          } else {
            await reply(`I didn't catch that date. Try "May 15" or "15th of May".`, isVoiceMessage);
          }
          continue;
        }

        // ── BIRTHDAY REMINDER DETECTION ──
        // "remind me to buy flowers one day before Andreea's birthday"
        const bdayReminder = parseBirthdayReminder(effectiveText);
        if (bdayReminder) {
          const { name, days: rDays } = bdayReminder;
          const nameKey = name.toLowerCase();
          const reminderTitle = extractTaskTitle(effectiveText, name);
          if (people[nameKey] && people[nameKey].birthday) {
            const { task, birthdayDate } = scheduleBirthdayReminder(name, people[nameKey].birthday, rDays, reminderTitle);
            await saveTasksToDB();
            const bday = new Date(birthdayDate+'T12:00').toLocaleDateString('en-US',{month:'long',day:'numeric'});
            const rDay = new Date(task.date+'T12:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
            await reply(`✅ Reminder set: "${task.title}"\n📅 ${rDay}\n🎂 ${name}'s birthday: ${bday}`, isVoiceMessage);
          } else {
            setPending({ type: 'birthday', name, days: rDays, reminderTitle });
            await reply(`When is ${name}'s birthday?`, isVoiceMessage);
          }
          continue;
        }

        // Check for "when" queries — find a specific task
        const whenQuery = effectiveLower.match(/\b(when (do i|should i|am i|is|are)|when'?s)\s+(my\s+)?(.*?)\??$/i)
          || effectiveLower.match(/^(when is|when do i have|when did i schedule|find)\s+(.*?)\??$/i);

        if (whenQuery) {
          const searchTerm = (whenQuery[4] || whenQuery[2] || '').replace(/\?/g,'').trim();
          if (searchTerm.length > 1) {
            const found = tasks.filter(t => t.title.toLowerCase().includes(searchTerm.toLowerCase()));
            if (found.length === 0) {
              await reply(`❌ No task found matching "${searchTerm}"`);
            } else {
              const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              let msg = `🔍 Found ${found.length} task${found.length>1?'s':''} matching "${searchTerm}":\n\n`;
              found.forEach(t => {
                if (t.type === 'once' || t.type === 'timed') {
                  const d = new Date(t.date + 'T12:00:00');
                  const label = `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}`;
                  msg += `📅 ${t.title}${t.time ? ' at ' + t.time : ''}\n   ${label}\n\n`;
                } else {
                  const recLabels = {daily:'Every day',weekday:'Every weekday',weekly:`Every ${days[t.weekDay||1]}`,biweekly:`Every 2 weeks on ${days[t.weekDay||1]}`,dom:`Every ${t.domDay}${['th','st','nd','rd'][Math.min(t.domDay%10,3)] || 'th'} of month`,lastdom:'Last day of month',xdays:`Every ${t.xdays} days`};
                  msg += `🔄 ${t.title}\n   ${recLabels[t.recur] || 'Recurring'}\n\n`;
                }
              });
              await reply(msg.trim(), isVoiceMessage);
            }
            continue;
          }
        }

        // Check for schedule/list queries for specific days
        const scheduleQuery = effectiveLower.match(/\b(what'?s?|show me|get|give me|tell me|what do i have|what (do i need to|should i|have i got|is on my)|do i have anything|remind me what)\s*(my\s*)?(schedule|tasks|list|agenda|plan|day|calendar|on|to do|todo|due)?\s*(for\s*)?(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week)(\?)?/i)
          || effectiveLower.match(/\bwhat (do i have|is (on|scheduled|planned)|should i do|are my tasks|tasks (do i have|are there))\b/i)
          || effectiveLower.match(/^(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)('?s)?\s*(schedule|tasks|list|agenda|plan)?(\?)?$/i)
          || effectiveLower.match(/^(list|tasks|agenda|schedule|what do i have|what'?s up|my day)(\?)?$/i)
          || effectiveLower.match(/what (do i|have i) (have|got|need) (to do|scheduled|planned|coming up)(\s*(today|tomorrow|this week|on \w+))?(\?)?/i);

        if (scheduleQuery) {
          const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          const msg2 = effectiveLower;
          let targetDate = getEasternDate();
          if (/tomorrow/i.test(msg2)) { targetDate.setDate(targetDate.getDate()+1); }
          else {
            const dayMatch = msg2.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
            if (dayMatch) {
              const td = dayNames.indexOf(dayMatch[1].toLowerCase());
              const now = getEasternDate();
              let da = td - now.getDay();
              if (da < 0) da += 7;
              if (da === 0) da = 0; // today if same day
              targetDate = new Date(now); targetDate.setDate(now.getDate()+da);
            }
          }
          await reply(buildListMsgForDate(targetDate), isVoiceMessage);
        } else if (/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i.test(effectiveLower)) {
          const query = effectiveLower.replace(/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i,'').replace(/\s+as\s+(done|complete|finished)\s*$/i,'').replace(/^(the\s+)/i,'').trim();
          const todayStr = getTodayStr();
          const task = tasks.find(t => t.title.toLowerCase().includes(query));
          if (task) {
            if (!task.doneDate) task.doneDate = {};
            task.doneDate[todayStr] = true;
            await saveTasksToDB();
            await reply(`✅ Marked done: ${task.title}`, isVoiceMessage);
          } else {
            await reply(`❌ Task not found: "${query}"`, isVoiceMessage);
          }
        } else if (/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i.test(effectiveLower)) {
          const rest = effectiveText.replace(/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i, '').trim();
          if (!rest) { await reply('❌ Please include a task name.\nExample: add wash the car saturday 12pm'); continue; }

          let title = rest;
          let time = null;
          let cleaned = rest.replace(/\bon\s+/gi,' ').trim();
          const { date, cleaned: cleaned2, found: dateFound } = parseNaturalDate(cleaned);
          cleaned = cleaned2;

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
            await reply('❌ Could not parse task name. Try:\nadd wash the car friday 12pm');
            continue;
          }

          // No date found — ask instead of defaulting to today
          if (!dateFound) {
            setPending({ type: 'date', title, time });
            await reply(`📅 What date is "${title}" for?\nReply with something like "May 15" or "next Friday".`, isVoiceMessage);
            continue;
          }

          try {
            const newTask = { id: Date.now().toString(), title, type: 'once', date, time, priority: 'medium' };
            tasks.push(newTask);
            await saveTasksToDB();
            const dayLabel = date === getTodayStr() ? 'today' : new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
            await reply(`✅ Added: "${title}"\n📅 ${dayLabel}${time ? '\n⏰ ' + time : ''}`, isVoiceMessage);
          } catch(e) {
            await reply('❌ Something went wrong saving the task. Please try again.');
          }
        } else {
          // Smart fallback: if message has date/time clue, try to schedule it anyway
          const hasDateClue = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tonight)\b/i.test(effectiveLower);
          const hasTimeClue = /\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(effectiveLower);
          const looksLikeQuestion = /\b(what|when|where|who|how|do i|have i|should i|is there|are there|can i)\b/i.test(effectiveLower) || effectiveLower.endsWith('?');
          if ((hasDateClue || hasTimeClue) && !looksLikeQuestion) {
            let date = getTodayStr();
            let title = effectiveText;
            let time = null;
            const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
            let cleaned = title.replace(/\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)\b/gi,'$1').replace(/\bfor\s+(today|tomorrow)\b/gi,'$1').replace(/\b(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi,'$2');
            const dayMatch = cleaned.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
            if (/\btomorrow\b/i.test(cleaned)){const tom=getEasternDate();tom.setDate(tom.getDate()+1);date=dateStr(tom);cleaned=cleaned.replace(/\btomorrow\b/i,'').trim();}
            else if (/\btoday\b|\btonight\b/i.test(cleaned)){cleaned=cleaned.replace(/\btoday\b|\btonight\b/gi,'').trim();}
            else if (dayMatch){const td=dayNames.indexOf(dayMatch[1].toLowerCase());const now=getEasternDate();let da=td-now.getDay();if(da<=0)da+=7;const t=new Date(now);t.setDate(now.getDate()+da);date=dateStr(t);cleaned=cleaned.replace(dayMatch[0],'').trim();}
            const timePatterns=[/\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i,/\bat\s+(\d{1,2})\s*(am|pm)\b/i,/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i,/\b(\d{1,2})\s*(am|pm)\b/i];
            for(const p of timePatterns){const m=cleaned.match(p);if(m){let h=parseInt(m[1]),min=parseInt(m[2]||'0'),ap=(m[3]||m[2]||'').toLowerCase();if(ap==='pm'&&h!==12)h+=12;if(ap==='am'&&h===12)h=0;time=`${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;cleaned=cleaned.replace(m[0],'').replace(/\bat\b/gi,'').trim();break;}}
            title=cleaned.replace(/\s+/g,' ').replace(/^[,.\s]+|[,.\s]+$/g,'').trim();
            if(title&&title.length>=2){
              const newTask={id:Date.now().toString(),title,type:'once',date,time,priority:'medium'};
              tasks.push(newTask);await saveTasksToDB();
              const dayLabel=date===getTodayStr()?'today':new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});
              await reply(`✅ Added: "${title}"\n📅 ${dayLabel}${time?'\n⏰ '+time:''}`, isVoiceMessage);
            } else {
              await reply("Here's what I understand:\n\n📋 TO SEE TASKS:\nlist / tasks / today\n\n➕ TO ADD A TASK:\nadd / schedule / remind me to / book / plan / create / i need to / don't forget to / note to self / hey [task]\n\nExamples:\n• hey call Mike tomorrow 12pm\n• schedule dentist thursday 10am\n• remind me to pay bills friday\n• i need to go to the gym monday 7am\n\n✅ TO MARK DONE:\ndone / finished / i did [task name]", isVoiceMessage);
            }
          } else {
            await reply("Here's what I understand:\n\n📋 TO SEE TASKS:\nlist / tasks / today\n\n➕ TO ADD A TASK:\nadd / schedule / remind me to / book / plan / create / i need to / don't forget to / note to self / hey [task]\n\nExamples:\n• hey call Mike tomorrow 12pm\n• schedule dentist thursday 10am\n• remind me to pay bills friday\n• i need to go to the gym monday 7am\n\n✅ TO MARK DONE:\ndone / finished / i did [task name]", isVoiceMessage);
          }
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Audio-Ext');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const bodyBuf = Buffer.concat(chunks);
    const body = bodyBuf.toString('utf8');
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
    if (req.method === 'POST' && req.url === '/ai') {
      try {
        const data = JSON.parse(body);
        const messages = data.messages || [];
        const context = data.context || '';
        const apiKey = process.env.OPENAI_KEY;
        console.log('AI endpoint hit, apiKey present:', !!apiKey);
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            max_tokens: 500,
            messages: [
              { role: 'system', content: `You are a friendly personal assistant in a task app. ${context} Be concise, warm and helpful.` },
              ...messages.map(m => ({ role: m.role, content: m.content }))
            ]
          })
        });
        const d = await response.json();
        const reply = d.choices?.[0]?.message?.content || "I couldn't process that.";
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply }));
      } catch(e) {
        console.error('AI error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reply: "Sorry, couldn't connect. Try again!" }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/voice') {
      try {
        // Receive raw audio body
        const chunks = [];
        // body already collected above, but for binary we need raw
        // We'll use a different approach - re-read from buffer
        const ext = req.headers['x-audio-ext'] || 'webm';
        const tmpPath = path.join('/tmp', `voice_${Date.now()}.${ext}`);
        fs.writeFileSync(tmpPath, bodyBuf);

        // Transcribe
        const transcribed = await transcribeVoice(tmpPath);
        fs.unlink(tmpPath, () => {});

        if (!transcribed) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reply: '❌ Could not transcribe. Try again.' }));
          return;
        }

        console.log('App voice transcribed:', transcribed);
        const translated = await translateToEnglish(transcribed);
        console.log('App voice translated:', translated);

        // Process command same as Telegram (reuse logic via fake msg object)
        const fakeText = translated.trim();
        const effectiveLower = fakeText.toLowerCase().replace(/^hey[,!]?\s*/i, '');
        const effectiveText = fakeText.replace(/^hey[,!]?\s*/i, '').trim();

        let replyText = '';
        const setReply = (t) => { replyText = t; lastBotReply = { text: t, timestamp: Date.now() }; };

        // ── FORGET PERSON (update birthday/event) ──
        // "forget mom's birthday" / "update mom's birthday" / "change mom's birthday"
        const forgetM = effectiveLower.match(/^(forget|delete|remove|update|change|reset)\s+([\w\s]+?)(?:'?s?)?\s+birthday/i);
        if (forgetM) {
          const rawName = forgetM[2].trim();
          const name = resolvePersonName(rawName, effectiveText);
          const key = name.toLowerCase();
          if (people[key]) { delete people[key]; await saveTasksToDB(); }
          setPending({ type: 'birthday', name, days: 0, reminderTitle: `${name}'s birthday` });
          setReply(`When is ${name}'s birthday?`);
          await sendTelegram(`🎙️ "${transcribed}"\n\n${replyText}`);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,reply:replyText,transcript:transcribed}));
          return;
        }

        // ── GENERAL EVENT REMINDER ──
        const eventReminder = parseEventReminder(effectiveText);
        if (eventReminder) {
          const { eventPhrase, days, direction, taskPart } = eventReminder;
          const eventKey = eventPhrase.toLowerCase();
          const dirLabel = direction===-1?(days===1?'the day before':days+' days before'):direction===1?(days===1?'the day after':days+' days after'):'on the day of';
          const taskTitle = taskPart || `Reminder ${dirLabel} ${eventPhrase}`;
          if (people[eventKey] && people[eventKey].eventDate) {
            const { date: eDate } = parseNaturalDate(people[eventKey].eventDate);
            const anchor = new Date(eDate+'T12:00');
            anchor.setDate(anchor.getDate() + direction * days);
            const now = getEasternDate();
            if (anchor < now) {
              setPending({ type:'event', eventPhrase, days, direction, taskTitle });
              await reply(`When is ${eventPhrase}?`, isVoiceMessage);
            } else {
              const newTask = {id:Date.now().toString(),title:taskTitle,type:'once',date:dateStr(anchor),time:null,priority:'medium'};
              tasks.push(newTask); await saveTasksToDB();
              const rDay = anchor.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
              await reply(`✅ "${taskTitle}"\n📅 ${rDay}`, isVoiceMessage);
            }
          } else {
            setPending({ type:'event', eventPhrase, days, direction, taskTitle });
            await reply(`When is ${eventPhrase}?`, isVoiceMessage);
          }
          await sendTelegram(`🎙️ "${transcribed}"\n\n${replyText}`);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,reply:replyText,transcript:transcribed}));
          return;
        }

        // ── FORGET PERSON ──
        const forgetV = effectiveLower.match(/^(forget|delete|remove|update|change|reset)\s+([\w\s]+?)(?:'?s?)?\s+birthday/i);
        if (forgetV) {
          const name = resolvePersonName(forgetV[2].trim(), effectiveText);
          const key = name.toLowerCase();
          if (people[key]) { delete people[key]; await saveTasksToDB(); }
          setPending({ type: 'birthday', name, days: 0, reminderTitle: `${name}'s birthday` });
          setReply(`When is ${name}'s birthday?`);
          await sendTelegram(`🎙️ "${transcribed}"\n\n${replyText}`);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,reply:replyText,transcript:transcribed}));
          return;
        }
        const bdayReminder = parseBirthdayReminder(effectiveText);
        if (bdayReminder) {
          const { name, days: rDays } = bdayReminder;
          const nameKey = name.toLowerCase();
          const reminderTitle = extractTaskTitle(effectiveText, name);
          if (people[nameKey] && people[nameKey].birthday) {
            const { task, birthdayDate } = scheduleBirthdayReminder(name, people[nameKey].birthday, rDays, reminderTitle);
            await saveTasksToDB();
            const bday = new Date(birthdayDate+'T12:00').toLocaleDateString('en-US',{month:'long',day:'numeric'});
            const rDay = new Date(task.date+'T12:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
            setReply(`✅ Reminder: "${task.title}"\n📅 ${rDay}\n🎂 ${name}'s birthday: ${bday}`);
          } else {
            setPending({ type: 'birthday', name, days: rDays, reminderTitle });
            setReply(`When is ${name}'s birthday?`);
          }
          await sendTelegram(`🎙️ "${transcribed}"\n\n${replyText}`);
          res.writeHead(200,{'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true,reply:replyText,transcript:transcribed}));
          return;
        }

        // Schedule/list query
        const scheduleQuery = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(tasks?|schedule|list|agenda|plan)\b|\b(tasks?|schedule|list|agenda|what do i have)\b/i.test(effectiveLower)
          || /^(today|tomorrow|list|tasks|schedule)[\?]?$/i.test(effectiveLower.trim());

        if (scheduleQuery) {
          const dayNames = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
          let targetDate = getEasternDate();
          if (/tomorrow/i.test(effectiveLower)) targetDate.setDate(targetDate.getDate()+1);
          else {
            const dm = effectiveLower.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
            if (dm) { const td=dayNames.indexOf(dm[1].toLowerCase());const now=getEasternDate();let da=td-now.getDay();if(da<0)da+=7;targetDate=new Date(now);targetDate.setDate(now.getDate()+da); }
          }
          setReply(buildListMsgForDate(targetDate));
        } else if (/^(done|complete|finish|finished|i did|i finished|i completed|mark)\s+/i.test(effectiveLower)) {
          const query = effectiveLower.replace(/^(done|complete|finish|finished|i did|i finished|i completed|mark)\s+/i,'').replace(/\s+as\s+(done|complete)$/i,'').trim();
          const task = tasks.find(t => t.title.toLowerCase().includes(query));
          if (task) { if(!task.doneDate)task.doneDate={};task.doneDate[getTodayStr()]=true;await saveTasksToDB();setReply(`✅ Marked done: ${task.title}`); }
          else setReply(`❌ Task not found: "${query}"`);
        } else if (/^(add|schedule|remind me to|remind me|create|i need to|book|plan|don'?t forget|note to self)\s+/i.test(effectiveLower) || /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b/i.test(effectiveLower)) {
          let title = effectiveText;
          let time = null;
          let cleaned = title.replace(/^(add|schedule|remind me to|remind me|create|i need to|book|plan|don'?t forget to?|note to self)\s+/i,'').replace(/\bon\s+/gi,' ').trim();
          const { date, cleaned: cleaned2, found: dateFound } = parseNaturalDate(cleaned);
          cleaned = cleaned2;
          const timePatterns=[/\bat\s+(\d{1,2}):(\d{2})\s*(am|pm)\b/i,/\bat\s+(\d{1,2})\s*(am|pm)\b/i,/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i,/\b(\d{1,2})\s*(am|pm)\b/i];
          for(const p of timePatterns){const m=cleaned.match(p);if(m){let h=parseInt(m[1]),mn=parseInt(m[2]||'0'),ap=(m[3]||m[2]||'').toLowerCase();if(ap==='pm'&&h!==12)h+=12;if(ap==='am'&&h===12)h=0;time=`${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}`;cleaned=cleaned.replace(m[0],'').replace(/\bat\b/gi,'').trim();break;}}
          title=cleaned.replace(/\s+/g,' ').replace(/^[,.\s]+|[,.\s]+$/g,'').trim();
          if(!dateFound && title && title.length>=2){
            // No date found — ask
            setPending({type:'date',title,time,originalText:transcribed});
            setReply(`📅 What date is "${title}" for?\nReply with a date like "May 15" or "next Friday".`);
          } else if(title&&title.length>=2){const newTask={id:Date.now().toString(),title,type:'once',date,time,priority:'medium'};tasks.push(newTask);await saveTasksToDB();const dayLabel=date===getTodayStr()?'today':new Date(date+'T12:00:00').toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'});setReply(`✅ Added: "${title}"\n📅 ${dayLabel}${time?'\n⏰ '+time:''}`);}
          else setReply(`I heard: "${transcribed}"\nTry: "add call Mike tomorrow 3pm"`);
        } else {
          setReply(`I heard: "${transcribed}"\n\nTry saying:\n• "What's on my schedule today?"\n• "Add call Mike tomorrow 3pm"\n• "Done gym"`);
        }

        // Also send to Telegram so it shows up there
        await sendTelegram(`🎙️ "${transcribed}"\n\n${replyText}`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply: replyText, transcript: transcribed }));
      } catch(e) {
        console.error('Voice endpoint error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reply: '❌ Voice processing failed. Try again.' }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/birthday') {
      try {
        const data = JSON.parse(body);
        const { name, mmdd, eventDate, eventPhrase } = data;

        // Generic event (non-birthday)
        if (eventPhrase && eventDate) {
          const eventKey = eventPhrase.toLowerCase();
          people[eventKey] = { eventDate };
          const pq = pendingQuestion && pendingQuestion().type === 'event' ? pendingQuestion : null;
          clearPending();
          let replyText = `📅 Got it! "${eventPhrase}" is on ${eventDate}.`;
          if (pq) {
            const { date: eDate } = parseNaturalDate(eventDate);
            const anchor = new Date(eDate+'T12:00');
            anchor.setDate(anchor.getDate() + pq.direction * pq.days);
            const newTask = {id:Date.now().toString(),title:pq.taskTitle,type:'once',date:dateStr(anchor),time:null,priority:'medium'};
            tasks.push(newTask); await saveTasksToDB();
            const rDay = anchor.toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
            replyText = `✅ "${pq.taskTitle}"\n📅 ${rDay}`;
          }
          lastBotReply = { text: replyText, timestamp: Date.now() };
          await sendTelegram(replyText);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reply: replyText }));
          return;
        }

        // Birthday
        if (!name || !mmdd) { res.writeHead(400); res.end('{}'); return; }
        people[name.toLowerCase()] = { name, birthday: mmdd };
        const pq = pendingQuestion && pendingQuestion().type === 'birthday' && pendingQuestion().name.toLowerCase() === name.toLowerCase() ? pendingQuestion : null;
        const rDays = pq ? pq.days : 1;
        const reminderTitle = pq ? pq.reminderTitle : `${name}'s birthday reminder`;
        clearPending();
        const { task, birthdayDate } = scheduleBirthdayReminder(name, mmdd, rDays, reminderTitle);
        await saveTasksToDB();
        const bday = new Date(birthdayDate+'T12:00').toLocaleDateString('en-US',{month:'long',day:'numeric'});
        const rDay = new Date(task.date+'T12:00').toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric'});
        const reply = `🎂 Got it! ${name}'s birthday is ${bday}.\n✅ Reminder set: "${task.title}"\n📅 ${rDay}`;
        lastBotReply = { text: reply, timestamp: Date.now() };
        await sendTelegram(reply);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, reply }));
      } catch(e) {
        console.error('Event/birthday error:', e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reply: '❌ Could not save.' }));
      }
      return;
    }
    if (req.method === 'POST' && req.url === '/clearPerson') {
      try {
        const data = JSON.parse(body);
        const key = (data.name || '').toLowerCase();
        if (key && people[key]) {
          delete people[key];
          await saveTasksToDB();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, reply: `Cleared ${data.name}` }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, reply: 'Not found' }));
        }
      } catch(e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
      return;
    }
    if (req.method === 'GET' && req.url === '/people') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, people }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/lastReply')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...lastBotReply }));
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
