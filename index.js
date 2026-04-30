const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
 
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const OPENAI_KEY = process.env.OPENAI_KEY;
 
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
        let isVoiceMessage = false;
 
        // Handle voice messages
        if (msg.voice || msg.audio) {
          isVoiceMessage = true;
          const fileId = (msg.voice || msg.audio).file_id;
          await sendTelegram('🎙️ Transcribing your voice message...');
          try {
            const fileUrl = await getTelegramFileUrl(fileId);
            if (!fileUrl) { await sendTelegram('❌ Could not download voice message. Try again.'); continue; }
            const filePath = await downloadFile(fileUrl);
            const transcribed = await transcribeVoice(filePath);
            fs.unlink(filePath, ()=>{});
            if (!transcribed) { await sendTelegram('❌ Could not transcribe. Please try again.'); continue; }
            console.log('Transcribed:', transcribed);
            await sendTelegram(`🎙️ I heard: "${transcribed}"`);
            const translated = await translateToEnglish(transcribed);
            console.log('Translated:', translated);
            msg.text = translated;
          } catch(e) {
            console.error('Voice error:', e.message);
            await sendTelegram('❌ Voice processing failed. Please try again.');
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
 
        // Check for "when" queries — find a specific task
        const whenQuery = effectiveLower.match(/\b(when (do i|should i|am i|is|are)|when'?s)\s+(my\s+)?(.*?)\??$/i)
          || effectiveLower.match(/^(when is|when do i have|when did i schedule|find)\s+(.*?)\??$/i);
 
        if (whenQuery) {
          const searchTerm = (whenQuery[4] || whenQuery[2] || '').replace(/\?/g,'').trim();
          if (searchTerm.length > 1) {
            const found = tasks.filter(t => t.title.toLowerCase().includes(searchTerm.toLowerCase()));
            if (found.length === 0) {
              await sendTelegram(`❌ No task found matching "${searchTerm}"`);
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
              await sendTelegram(msg.trim());
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
          await (isVoiceMessage ? sendVoiceReply(buildListMsgForDate(targetDate)) : sendTelegram(buildListMsgForDate(targetDate)));
        } else if (/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i.test(effectiveLower)) {
          const query = effectiveLower.replace(/^(done|complete|completed|finish|finished|mark|checked off|check off|i (did|finished|completed|done))\s+/i,'').replace(/\s+as\s+(done|complete|finished)\s*$/i,'').replace(/^(the\s+)/i,'').trim();
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
        } else if (/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i.test(effectiveLower)) {
          const rest = effectiveText.replace(/^(add|schedule|remind me to|remind me|set( up| a)?|create( a)?|new task|put( in)?|i need to|don'?t forget( to)?|note( to self)?|book( a)?|plan( a)?|make( a)?|set a reminder( to)?|add a|log)\s+/i, '').trim();
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
              await sendTelegram(`✅ Added: "${title}"\n📅 ${dayLabel}${time?'\n⏰ '+time:''}`);
            } else {
              await sendTelegram('Here\'s what I understand:\n\n📋 TO SEE TASKS:\nlist / tasks / today\n\n➕ TO ADD A TASK:\nadd / schedule / remind me to / book / plan / create / i need to / don\'t forget to / note to self / hey [task]\n\nExamples:\n• hey call Mike tomorrow 12pm\n• schedule dentist thursday 10am\n• remind me to pay bills friday\n• i need to go to the gym monday 7am\n\n✅ TO MARK DONE:\ndone / finished / i did [task name]');
            }
          } else {
            await sendTelegram('Here\'s what I understand:\n\n📋 TO SEE TASKS:\nlist / tasks / today\n\n➕ TO ADD A TASK:\nadd / schedule / remind me to / book / plan / create / i need to / don\'t forget to / note to self / hey [task]\n\nExamples:\n• hey call Mike tomorrow 12pm\n• schedule dentist thursday 10am\n• remind me to pay bills friday\n• i need to go to the gym monday 7am\n\n✅ TO MARK DONE:\ndone / finished / i did [task name]');
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
