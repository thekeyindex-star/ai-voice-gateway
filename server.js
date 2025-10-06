// server.js — Fastify + Twilio <-> OpenAI Realtime (with Echo mode)
// ------------------------------------------------------------------
require('dotenv').config();

const fastify = require('fastify')({ logger: false });
const formbody = require('@fastify/formbody');
const { WebSocketServer, WebSocket } = require('ws');

// ------------------------------------------------------------------
// Config
// ------------------------------------------------------------------
const PORT   = process.env.PORT || 3001;
const MODEL  = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
const OA_KEY = process.env.OPENAI_API_KEY;
const DIAG_ECHO = String(process.env.DIAG_ECHO || '0') === '1'; // 1 => loopback test

if (!OA_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

fastify.register(formbody);
fastify.get('/', async () => 'OK');

// ------------------------------------------------------------------
// Twilio webhook -> starts Media Stream
// ------------------------------------------------------------------
fastify.post('/voice', async (request, reply) => {
  const host = request.headers['x-forwarded-host'] || request.headers.host;
  const wsUrl = `wss://${host}/media`;

  // keep the “connecting” line; it’s fine for both echo and OA modes
  const twiml = `
    <Response>
      <Say voice="Polly.Salli">Connecting you to our assistant now.</Say>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>
  `.trim();

  reply.type('text/xml').send(twiml);
});

// ------------------------------------------------------------------
// Start HTTP
// ------------------------------------------------------------------
fastify.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log(`[BOOT] Fastify up on :${PORT}`);
});

// ------------------------------------------------------------------
// WebSocket bridge: /media (Twilio) <-> (Echo | OpenAI Realtime)
// ------------------------------------------------------------------
const wss = new WebSocketServer({ server: fastify.server, path: '/media' });

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected -> /media');

  let streamSid = null;

  // ---------------------------
  // ECHO MODE (no OpenAI at all)
  // ---------------------------
  if (DIAG_ECHO) {
    console.log('[ECHO] Echo mode ENABLED (DIAG_ECHO=1)');
    twilioWS.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.event === 'start') {
        streamSid = msg.start?.streamSid;
        console.log('[ECHO] stream start', streamSid);
      }

      if (msg.event === 'media' && msg.media?.payload && streamSid) {
        // loop media right back to the caller
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.media.payload }
        }));
      }

      if (msg.event === 'stop') {
        console.log('[ECHO] stream stop');
      }
    });

    twilioWS.on('close', () => console.log('[ECHO] Twilio WS closed'));
    twilioWS.on('error', (e) => console.error('[ECHO] Twilio WS error', e));
    return; // IMPORTANT: do not connect to OpenAI when echoing
  }

  // ---------------------------
  // OPENAI REALTIME MODE
  // ---------------------------
  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OA_KEY}`,
        'OpenAI-Beta': 'realtime=v1',
      },
    }
  );

  // track if we already asked OA to speak to avoid “active response” error
  let haveActiveResponse = false;

  oaWS.on('open', () => {
    console.log('[OA] connected');

    // Session config — g711 μ-law both directions
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        // (omit turn_detection or use 'server_vad'/'semantic_vad' if you want)
        instructions:
          "You are Sofia from Cars & Keys. Be concise, helpful, and friendly. " +
          "Always collect: name, phone number, year make model, service type, and ZIP. " +
          "Confirm details back, then say you’ll text a confirmation."
      }
    }));
  });

  oaWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    // OA -> Twilio: speak μ-law audio back
    if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string') {
      if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.audio }
        }));
      }
    }

    // When OA finishes a response, allow a new one
    if (msg.type === 'response.completed' || msg.type === 'response.cancelled') {
      haveActiveResponse = false;
    }

    // Log errors clearly
    if (msg.type === 'error') {
      console.error('[OA ERROR]', JSON.stringify(msg, null, 2));
      // if this was “already has active response”, just mark inactive later
    }
  });

  oaWS.on('error', (e) => console.error('[OA] error', e));
  oaWS.on('close', () => console.log('[OA] closed'));

  // Batch & commit every ~5 frames (~100ms)
  let framesSinceCommit = 0;
  let hadAnyAppend = false;

  twilioWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('[WSS] stream start', streamSid);
      framesSinceCommit = 0;
      hadAnyAppend = false;

      // Ask OA to greet immediately
      if (oaWS.readyState === WebSocket.OPEN && !haveActiveResponse) {
        oaWS.send(JSON.stringify({ type: 'response.create' }));
        haveActiveResponse = true;
      }
    }

    if (msg.event === 'media' && msg.media?.payload) {
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: msg.media.payload
        }));
        hadAnyAppend = true;
        framesSinceCommit += 1;

        if (framesSinceCommit >= 5) {
          oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          if (!haveActiveResponse) {
            oaWS.send(JSON.stringify({ type: 'response.create' }));
            haveActiveResponse = true;
          }
          framesSinceCommit = 0;
        }
      }
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop');
      if (oaWS.readyState === WebSocket.OPEN) {
        if (hadAnyAppend) {
          oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          hadAnyAppend = false;
        }
        if (!haveActiveResponse) {
          oaWS.send(JSON.stringify({ type: 'response.create' }));
          haveActiveResponse = true;
        }
      }
    }
  });

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed');
    try { if (oaWS.readyState === WebSocket.OPEN) oaWS.close(); } catch {}
  });
  twilioWS.on('error', (e) => console.error('[WSS] error', e));
});
