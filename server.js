// server.js — Fastify + Twilio <-> OpenAI Realtime (stable, μ-law, no VAD)
// ----------------------------------------------------------------------------
require('dotenv').config();

const fastify = require('fastify')({ logger: false });
const formbody = require('@fastify/formbody');
const { WebSocketServer, WebSocket } = require('ws');

const PORT   = process.env.PORT || 3001;
const MODEL  = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
const OA_KEY = process.env.OPENAI_API_KEY;

if (!OA_KEY) {
  console.error('❌ Missing OPENAI_API_KEY'); process.exit(1);
}

fastify.register(formbody);

// Health
fastify.get('/', async () => 'OK');

// ----------------------------------------------------------------------------
// Twilio webhook -> TwiML (always returns Stream to /media)
// ----------------------------------------------------------------------------
fastify.post('/voice', async (req, reply) => {
  try {
    const host  = req.headers['x-forwarded-host'] || req.headers.host;
    const wsUrl = `wss://${host}/media`;

    const twiml = `
      <Response>
        <Say voice="Polly.Salli">Connecting you to our assistant now.</Say>
        <Connect>
          <Stream url="${wsUrl}" />
        </Connect>
      </Response>
    `.trim();

    reply.type('text/xml').send(twiml);
  } catch (e) {
    console.error('[VOICE] error', e);
    reply.code(500).send('Internal Server Error');
  }
});

// Start HTTP
fastify.listen({ port: PORT, host: '0.0.0.0' }, () =>
  console.log(`[BOOT] Fastify up on :${PORT}`)
);

// ----------------------------------------------------------------------------
// WebSocket bridge: Twilio (/media) <-> OpenAI Realtime
// ----------------------------------------------------------------------------
const wss = new WebSocketServer({ server: fastify.server, path: '/media' });

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected -> /media');

  let streamSid = null;

  // Connect to OpenAI Realtime
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OA_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  // ----------------- OpenAI side -----------------
  oaWS.on('open', () => {
    console.log('[OA] connected');

    // IMPORTANT: formats are strings; keep config minimal & valid
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // Keep prompts simple; no tools; let model speak on first response
        instructions:
          "You are Sofia from Cars & Keys. Be concise, helpful, and friendly. " +
          "Always collect: name, phone number, year, make, model, service type, and ZIP. " +
          "Confirm details back and tell the caller you’ll text a confirmation."
      }
    }));
  });

  // Relay OpenAI audio back to the caller
  oaWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string') {
        if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: msg.audio } // base64 μ-law
          }));
        }
      }
    } catch (e) {
      console.error('[OA] parse error', e);
    }
  });

  oaWS.on('error', (e) => console.error('[OA] error', e));
  oaWS.on('close', () => console.log('[OA] closed'));

  // ----------------- Twilio side -----------------
  let framesSinceCommit = 0;
  let appendedSinceLast = false;
  let openaiReady = false;

  const safeCreateResponse = () => {
    // Don’t spam response.create while one is playing
    if (oaWS.readyState === WebSocket.OPEN) {
      oaWS.send(JSON.stringify({ type: 'response.create' }));
    }
  };

  twilioWS.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('[WSS] stream start', streamSid);
      framesSinceCommit = 0;
      appendedSinceLast = false;

      // Ask OA to speak a greeting right away
      safeCreateResponse();
      return;
    }

    if (msg.event === 'media' && msg.media?.payload) {
      // Forward caller audio to OpenAI (base64 μ-law string)
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
        appendedSinceLast = true;
        framesSinceCommit += 1;

        // Commit roughly every ~100ms (5 Twilio frames @ 20ms each)
        if (framesSinceCommit >= 5) {
          if (appendedSinceLast) {
            oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
            // Nudge OA to respond after each commit
            safeCreateResponse();
            appendedSinceLast = false;
          }
          framesSinceCommit = 0;
        }
      }
      return;
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop');
      if (oaWS.readyState === WebSocket.OPEN) {
        if (appendedSinceLast) {
          oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          appendedSinceLast = false;
        }
        // One last response if needed
        safeCreateResponse();
      }
      return;
    }
  });

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed');
    try { if (oaWS.readyState === WebSocket.OPEN) oaWS.close(); } catch {}
  });

  twilioWS.on('error', (e) => console.error('[WSS] error', e));
});
