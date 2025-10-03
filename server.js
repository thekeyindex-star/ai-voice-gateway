// server.js — COMPLETE debug bridge for Twilio <-> OpenAI Realtime
// Goal: fix call hang-ups by adding Stream status logs + robust WS handling.

require('dotenv').config();
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT  = process.env.PORT || 3001;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
if (!process.env.OPENAI_API_KEY) {
  console.warn('[BOOT] Missing OPENAI_API_KEY in environment');
}

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded
app.use(express.json());

// ---------- Health ----------
app.get('/', (_req, res) => res.send('OK'));

// ---------- Voice webhook (DEBUG: always go realtime) ----------
app.post('/voice', (req, res) => {
  // If you want to flip to voicemail temporarily, set ?mode=vm on the Twilio URL.
  if (String(req.query.mode || '').toLowerCase() === 'vm') {
    return res.type('text/xml').send(`
      <Response>
        <Say voice="alice">
          Thank you for calling Cars and Keys. We are currently unavailable.
          Please leave your name, number, year make model, and service needed.
        </Say>
        <Record maxLength="90" /><Hangup/>
      </Response>`);
  }

  const twiml = `
    <Response>
      <Say voice="alice">Thanks for calling Cars and Keys. Connecting you to our assistant.</Say>
      <Connect>
        <Stream
          url="wss://${req.hostname}/media"
          statusCallback="/stream-status"
          statusCallbackEvent="start connected error disconnected end"
        />
      </Connect>
    </Response>
  `;
  res.type('text/xml').send(twiml);
});

// ---------- Stream lifecycle logs ----------
app.post('/stream-status', (req, res) => {
  try {
    // Twilio posts many fields like EventType, StreamSid, Start, etc.
    console.log('[STATUS]', req.body);
  } catch (e) {
    console.error('[STATUS] parse error', e);
  }
  res.sendStatus(200);
});

// ---------- Start HTTP ----------
const server = app.listen(PORT, () => {
  console.log(`[BOOT] HTTP up on :${PORT}`);
});

// ---------- WebSocket bridge (Twilio <-> OpenAI) ----------
const wss = new WebSocketServer({ server, path: '/media' });

wss.on('connection', (twilioWS, req) => {
  console.log('[WSS] Twilio connected from', req.socket?.remoteAddress);
  let streamSid = null;
  let frames = 0;
  let closed = false;

  // Connect to OpenAI Realtime
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  );

  // Keepalives help avoid idle timeouts on some hosts
  const pingInterval = setInterval(() => {
    try {
      if (twilioWS.readyState === WebSocket.OPEN) twilioWS.ping();
      if (openaiWS.readyState === WebSocket.OPEN) openaiWS.ping();
    } catch {}
  }, 15000);

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(pingInterval);
    try { if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close(); } catch {}
    try { if (twilioWS.readyState === WebSocket.OPEN) twilioWS.close(); } catch {}
    console.log('[WSS] cleaned up');
  }

  function sendToTwilio(base64uLaw) {
    if (!streamSid || twilioWS.readyState !== WebSocket.OPEN) return;
    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64uLaw }
    }));
  }

  // ----- OpenAI handlers -----
  openaiWS.on('open', () => {
    console.log('[OA] connected');
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        // Match PSTN so we do zero transcoding:
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        instructions:
          "You are Sofia, the trusted phone assistant for Cars & Keys. " +
          "Always collect: (1) year, make, model; (2) job type (lockout, duplicate, all keys lost, programming); " +
          "(3) ZIP/location; (4) best callback number (confirm by repeating). " +
          "Give price ranges only; mention after-hours and travel may change pricing. Keep sentences short."
      }
    }));
  });

  openaiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'response.output_audio.delta' && msg.audio?.data) {
        // Send µ-law audio chunk back to caller
        sendToTwilio(msg.audio.data);
      }
      if (msg.type === 'error') {
        console.error('[OA] error payload:', msg);
      }
    } catch (e) {
      console.error('[OA] message parse error', e);
    }
  });

  openaiWS.on('close', () => console.log('[OA] socket closed'));
  openaiWS.on('error', (e) => console.error('[OA] socket error', e));

  // ----- Twilio handlers -----
  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        console.log('[WSS] start streamSid', streamSid);
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({ type: 'response.create' })); // greet immediately
        }
      }

      if (msg.event === 'media' && msg.media?.payload) {
        frames++;
        if (frames % 100 === 0) console.log('[WSS] media frames', frames);
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: { data: msg.media.payload, format: { type: 'g711_ulaw', sample_rate: 8000 } }
          }));
        }
      }

      if (msg.event === 'stop') {
        console.log('[WSS] stop streamSid', streamSid);
        if (openaiWS.readyState === WebSocket.OPEN) {
          openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          openaiWS.send(JSON.stringify({ type: 'response.create' }));
        }
      }
    } catch (e) {
      console.error('[WSS] Twilio msg parse error', e);
    }
  });

  twilioWS.on('close', () => { console.log('[WSS] Twilio socket closed'); cleanup(); });
  twilioWS.on('error', (e) => { console.error('[WSS] Twilio socket error', e); cleanup(); });

  // Safety: if OpenAI dies, end Twilio side too
  openaiWS.on('close', cleanup);
  openaiWS.on('error', cleanup);
});
