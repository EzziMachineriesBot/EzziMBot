const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const { google } = require('googleapis');
const dotenv = require('dotenv');
dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID;
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
const SHEET_ID = process.env.SHEET_ID;
const SHEET_RANGE = process.env.SHEET_RANGE || 'Sheet1!A2:B';

async function checkTakeoverMode(phone) {
  const auth = new google.auth.JWT(
    CLIENT_EMAIL,
    null,
    PRIVATE_KEY,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']
  );
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: SHEET_RANGE,
  });

  const rows = response.data.values;
  if (rows && rows.length > 0) {
    for (const row of rows) {
      if (row[0] === phone) {
        return row[1].toLowerCase(); // should be "bot" or "manual"
      }
    }
  }
  return 'bot'; // default to bot if not found
}

app.get('/', (req, res) => {
  res.send('Ezzi WhatsApp Bot with Sheet Control is Live!');
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message && message.type === 'text') {
      const phone_number_id = changes.value.metadata.phone_number_id;
      const from = message.from;
      const text = message.text.body;

      const mode = await checkTakeoverMode(from);
      if (mode === 'manual') {
        console.log(`Manual takeover active for ${from}`);
        return res.sendStatus(200);
      }

      const sessionId = from;

      const jwtClient = new google.auth.JWT(
        CLIENT_EMAIL,
        null,
        PRIVATE_KEY,
        ['https://www.googleapis.com/auth/cloud-platform']
      );

      await jwtClient.authorize();

      const dialogflowUrl = `https://dialogflow.googleapis.com/v2/projects/${PROJECT_ID}/agent/sessions/${sessionId}:detectIntent`;

      try {
        const dfResponse = await axios.post(
          dialogflowUrl,
          {
            queryInput: {
              text: {
                text: text,
                languageCode: 'en-US',
              },
            },
          },
          {
            headers: {
              Authorization: `Bearer ${jwtClient.credentials.access_token}`,
            },
          }
        );

        const replyText = dfResponse.data.queryResult.fulfillmentText;

        await axios.post(
          `https://graph.facebook.com/v18.0/${phone_number_id}/messages`,
          {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: replyText },
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            },
          }
        );
      } catch (error) {
        console.error('Dialogflow/WhatsApp Error:', error?.response?.data || error.message);
      }
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});