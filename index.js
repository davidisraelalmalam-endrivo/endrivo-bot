const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const OWNER_PHONE = '972533940242';
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'endrivo-admin';

async function refreshToken() {
  try {
    const response = await axios.get(
      `https://graph.facebook.com/oauth/access_token?grant_type=fb_exchange_token&client_id=${APP_ID}&client_secret=${APP_SECRET}&fb_exchange_token=${WHATSAPP_TOKEN}`
    );
    WHATSAPP_TOKEN = response.data.access_token;
    console.log('Token refreshed successfully');
  } catch (error) {
    console.error('Token refresh failed:', error.message);
  }
}

// Refresh token every 23 hours
setInterval(refreshToken, 23 * 60 * 60 * 1000);

// Keep-alive ping — מונע מ-Render לכבות את הבוט
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
setInterval(async () => {
  try {
    await axios.get(SELF_URL + '/');
    console.log('Keep-alive ping sent');
  } catch (e) {
    console.error('Keep-alive failed:', e.message);
  }
}, 14 * 60 * 1000); // כל 14 דקות

// --- זיכרון שיחות עם שמירה לדיסק ---
const CONVERSATIONS_FILE = path.join(__dirname, 'conversations.json');

function loadConversations() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONVERSATIONS_FILE, 'utf8'));
      return new Map(Object.entries(data));
    }
  } catch (e) {
    console.error('Failed to load conversations:', e.message);
  }
  return new Map();
}

function saveConversations() {
  try {
    const obj = Object.fromEntries(conversations);
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(obj), 'utf8');
  } catch (e) {
    console.error('Failed to save conversations:', e.message);
  }
}

const conversations = loadConversations();
console.log(`Loaded ${conversations.size} existing conversations from disk`);

const SYSTEM_PROMPT = `אתה נציגת שירות לקוחות של חברת Endrivo - חנות אונליין למוצרים לאימהות.
שמך הוא "מיה" ואת עונה בעברית בצורה חמה, אנושית ומקצועית.

מידע על החנות:
- זמן משלוח: בין 7 ל-14 ימי עסקים
- מדיניות החזרות: ניתן להחזיר או להחליף מוצר, הלקוחה יכולה לקרוא את מדיניות ההחזרות באתר שלנו
- אחריות: 14 יום על כל המוצרים
- אבטחת תשלום: החנות משתמשת בהצפנת SSL - התשלום מאובטח לחלוטין

כללים:
1. עני תמיד בעברית בלבד
2. היי חמה ואנושית - לא רובוטית
3. אם לקוחה שואלת על מצב הזמנה - בקשי ממנה את מספר ההזמנה שלה
4. אם לקוחה מבקשת החזרה/החלפה - אמרי לה שנציג יחזור אליה בהקדם
5. אם לקוחה שולחת תמונה - אמרי לה שנציג יחזור אליה בהקדם
6. אל תמציאי מידע שאין לך`;

async function getOrderStatus(orderNumber) {
  try {
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/2025-04/orders.json?name=${orderNumber}&status=any`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json'
        }
      }
    );

    const orders = response.data.orders;
    if (!orders || orders.length === 0) return null;

    const order = orders[0];
    const fulfillmentStatus = order.fulfillment_status;

    let statusText = '';
    if (!fulfillmentStatus || fulfillmentStatus === 'unfulfilled') {
      statusText = 'ההזמנה שלך התקבלה ונמצאת בעיבוד';
    } else if (fulfillmentStatus === 'partial') {
      statusText = 'חלק מההזמנה שלך נשלח';
    } else if (fulfillmentStatus === 'fulfilled') {
      const tracking = order.fulfillments?.[0]?.tracking_number;
      statusText = `ההזמנה שלך נשלחה${tracking ? ` - מספר מעקב: ${tracking}` : ''}`;
    }

    return {
      status: statusText,
      createdAt: new Date(order.created_at).toLocaleDateString('he-IL')
    };
  } catch (error) {
    console.error('Shopify error:', error.message);
    return null;
  }
}

async function sendMessage(to, text) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

async function notifyOwner(customerPhone, reason, messageText) {
  const waLink = `https://wa.me/${customerPhone}`;
  const msg = `🔔 *התראה מהבוט*\n\nלקוחה: ${customerPhone}\n📞 לחזור אליה: ${waLink}\nסיבה: ${reason}\nהודעה: "${messageText}"`;
  await sendMessage(OWNER_PHONE, msg);
}

async function handleMessage(from, text, type) {
  if (type === 'image') {
    await notifyOwner(from, 'לקוחה שלחה תמונה', 'שלחה תמונה');
    await sendMessage(from, 'תודה שפנית אלינו 🙏 קיבלנו את התמונה, נציג יחזור אליך בהקדם!');
    return;
  }

  if (type !== 'text') return;

  const isReturn = /החזר|החלפ|החזרה|החלפה|להחזיר|להחליף/.test(text);
  const isBroken = /שבור|שבורה|פגום|פגומה|מקולקל|לא עובד|הגיע שבור/.test(text);

  if (isReturn) await notifyOwner(from, 'בקשת החזרה/החלפה', text);
  if (isBroken) await notifyOwner(from, 'מוצר שבור/פגום', text);

  if (!conversations.has(from)) conversations.set(from, []);
  const history = conversations.get(from);

  let orderContext = '';
  const orderMatch = text.match(/#?(\d{4,})/);
  if (orderMatch) {
    const orderData = await getOrderStatus(`#${orderMatch[1]}`);
    if (orderData) {
      orderContext = `\n[מידע מהמערכת: ${orderData.status}, הזמנה מתאריך ${orderData.createdAt}]`;
    } else {
      orderContext = '\n[מידע מהמערכת: לא נמצאה הזמנה עם המספר הזה]';
    }
  }

  history.push({ role: 'user', content: text + orderContext, ts: Date.now() });
  if (history.length > 10) history.splice(0, history.length - 10);

  // Anthropic API expects only role+content — strip timestamps before sending
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: history.map(({ role, content }) => ({ role, content }))
  });

  const reply = response.content[0].text;
  history.push({ role: 'assistant', content: reply, ts: Date.now() });
  saveConversations();

  await sendMessage(from, reply);
}

// Webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Receive messages
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message) return;

    const from = message.from;
    const type = message.type;
    const text = message.text?.body || '';

    await handleMessage(from, text, type);
  } catch (error) {
    console.error('Error:', error.message);
  }
});

app.get('/', (req, res) => res.send('Endrivo Bot is running!'));

// --- לוח ניטור ---
function checkAdminAuth(req, res) {
  if (req.query.token !== ADMIN_TOKEN) {
    res.status(401).send('❌ אין גישה — חסר token');
    return false;
  }
  return true;
}

app.get('/admin/data', (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const data = Object.fromEntries(conversations);
  res.json(data);
});

app.get('/admin', (req, res) => {
  if (!checkAdminAuth(req, res)) return;
  const token = req.query.token;
  res.send(`<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Endrivo Bot — לוח ניטור</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f2f5; direction: rtl; }
    header { background: #075E54; color: white; padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 20px; font-weight: 600; }
    .stats { display: flex; gap: 32px; padding: 16px 24px; background: white; border-bottom: 1px solid #e0e0e0; }
    .stat-num { font-size: 28px; font-weight: bold; color: #075E54; }
    .stat-label { font-size: 12px; color: #888; margin-top: 2px; }
    .conversations { padding: 16px; max-width: 860px; margin: 0 auto; }
    .conv-item { background: white; border-radius: 12px; margin-bottom: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .conv-header { padding: 14px 18px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .conv-header:hover { background: #f9f9f9; }
    .conv-phone { font-weight: 600; font-size: 15px; }
    .conv-preview { font-size: 13px; color: #666; margin-top: 3px; max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .conv-right { text-align: left; }
    .badge { background: #25D366; color: white; border-radius: 10px; padding: 2px 9px; font-size: 12px; font-weight: 500; }
    .conv-time { font-size: 12px; color: #aaa; margin-top: 5px; }
    .conv-messages { display: none; padding: 12px 18px 18px; border-top: 1px solid #f2f2f2; max-height: 480px; overflow-y: auto; }
    .conv-messages.open { display: block; }
    .msg { margin: 7px 0; display: flex; }
    .msg.user { justify-content: flex-end; }
    .msg.assistant { justify-content: flex-start; }
    .msg-wrap { max-width: 72%; }
    .msg-bubble { padding: 9px 13px; border-radius: 12px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
    .msg.user .msg-bubble { background: #DCF8C6; border-radius: 12px 12px 0 12px; }
    .msg.assistant .msg-bubble { background: #f0f0f0; border-radius: 12px 12px 12px 0; }
    .msg-time { font-size: 11px; color: #bbb; margin-top: 2px; text-align: left; }
    .refresh-btn { background: rgba(255,255,255,0.15); color: white; border: 1px solid rgba(255,255,255,0.4); padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 14px; }
    .refresh-btn:hover { background: rgba(255,255,255,0.25); }
    .empty { text-align: center; padding: 60px; color: #aaa; font-size: 16px; }
  </style>
</head>
<body>
  <header>
    <h1>🤖 Endrivo Bot — לוח ניטור</h1>
    <button class="refresh-btn" onclick="loadData()">🔄 רענן</button>
  </header>
  <div class="stats">
    <div><div class="stat-num" id="total">—</div><div class="stat-label">שיחות</div></div>
    <div><div class="stat-num" id="msgs">—</div><div class="stat-label">הודעות</div></div>
    <div><div class="stat-num" id="lastUpdate">—</div><div class="stat-label">עדכון אחרון</div></div>
  </div>
  <div class="conversations" id="convList"><div class="empty">טוען...</div></div>

  <script>
    const TOKEN = '${token}';

    function fmt(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
      const date = d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
      return isToday ? time : date + ' ' + time;
    }

    async function loadData() {
      const res = await fetch('/admin/data?token=' + TOKEN);
      if (!res.ok) { document.getElementById('convList').innerHTML = '<div class="empty">❌ שגיאת גישה</div>'; return; }
      const data = await res.json();

      const phones = Object.keys(data);
      document.getElementById('total').textContent = phones.length;
      const totalMsgs = phones.reduce((s, p) => s + data[p].length, 0);
      document.getElementById('msgs').textContent = totalMsgs;
      document.getElementById('lastUpdate').textContent = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

      const list = document.getElementById('convList');
      if (!phones.length) { list.innerHTML = '<div class="empty">אין שיחות עדיין 📭</div>'; return; }

      phones.sort((a, b) => (data[b].at(-1)?.ts || 0) - (data[a].at(-1)?.ts || 0));

      list.innerHTML = phones.map(phone => {
        const h = data[phone];
        const last = h.at(-1);
        const preview = last?.content?.replace(/\\n/g, ' ').substring(0, 65) + (last?.content?.length > 65 ? '…' : '') || '';

        const msgs = h.map(m => \`
          <div class="msg \${m.role}">
            <div class="msg-wrap">
              <div class="msg-bubble">\${m.content.replace(/</g,'&lt;')}</div>
              \${m.ts ? '<div class="msg-time">' + fmt(m.ts) + '</div>' : ''}
            </div>
          </div>\`).join('');

        return \`<div class="conv-item">
          <div class="conv-header" onclick="toggle('\${phone}')">
            <div>
              <div class="conv-phone">+\${phone}</div>
              <div class="conv-preview">\${preview}</div>
            </div>
            <div class="conv-right">
              <span class="badge">\${h.length} הודעות</span>
              <div class="conv-time">\${fmt(last?.ts)}</div>
            </div>
          </div>
          <div class="conv-messages" id="c-\${phone}">\${msgs}</div>
        </div>\`;
      }).join('');
    }

    function toggle(phone) {
      const el = document.getElementById('c-' + phone);
      el.classList.toggle('open');
      if (el.classList.contains('open')) el.scrollTop = el.scrollHeight;
    }

    loadData();
    setInterval(loadData, 30000);
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
