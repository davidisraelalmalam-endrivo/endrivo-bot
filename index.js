const express = require('express');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SHOPIFY_STORE = process.env.SHOPIFY_STORE;
const SHOPIFY_TOKEN = process.env.SHOPIFY_TOKEN;
const OWNER_PHONE = '972533940242';

const conversations = new Map();

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
      `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json?name=${orderNumber}&status=any`,
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
  const msg = `🔔 *התראה מהבוט*\n\nלקוחה: ${customerPhone}\nסיבה: ${reason}\nהודעה: "${messageText}"`;
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

  history.push({ role: 'user', content: text + orderContext });
  if (history.length > 10) history.splice(0, history.length - 10);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    system: SYSTEM_PROMPT,
    messages: history
  });

  const reply = response.content[0].text;
  history.push({ role: 'assistant', content: reply });

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
