// server.js — Fastify + Twilio <-> OpenAI Realtime bridge (g711 μ-law)
require('dotenv').config();

const fastify = require('fastify')({ logger: false });
const formbody = require('@fastify/formbody');
const { WebSocketServer, WebSocket } = require('ws');

const PORT  = process.env.PORT || 3001;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
const OA_KEY = process.env.OPENAI_API_KEY;

if (!OA_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

// Accept regular urlencoded bodies…
fastify.register(formbody);

// …and ALSO accept urlencoded bodies that include charset (what Twilio sends)
// Example: "application/x-www-form-urlencoded; charset=UTF-8"
fastify.addContentTypeParser(
  /^application\/x-www-form-urlencoded(?:;.*)?$/i,
  { parseAs: 'string' },
  (req, body, done) => {
    // We don't actually need the POST body for /voice, so just acknowledge it.
    done(null, {});
  }
);

// Simple health check
fastify.get('/', async () => 'OK');

// Twilio webhook -> return TwiML that starts Media Streams
fastify.post('/voice', async (request, reply) => {
  try {
    const host = request.headers['x-forwarded-host'] || request.headers.host;
    const wsUrl = `wss://${host}/media`;

    const twiml =
      `<Response>
        <Say voice="Polly.Salli">Connecting you to our assistant now.</Say>
        <Connect>
          <Stream url="${wsUrl}" />
        </Connect>
      </Response>`;

    reply.type('text/xml').send(twiml);
  } catch (err) {
    console.error('[ERROR /voice]', err);
    reply.code(500).type('text/plain').send('Internal Server Error');
  }
});

// Start HTTP
fastify.listen({ port: PORT, host: '0.0.0.0' }, () =>
  console.log(`[BOOT] Fastify up on :${PORT}`)
);

// WebSocket bridge: /media (Twilio) <-> OpenAI Realtime
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

  oaWS.on('open', () => {
    console.log('[OA] connected');
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          "You are Sofia from Cars & Keys. Be concise, helpful, and friendly. " +
          "Always collect name, phone, year/make/model, service type, and ZIP. " +
          "Confirm details and say you'll text a confirmation."
      }
    }));
  });

  oaWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      // OpenAI -> Twilio: audio chunks (base64 g711 μ-law)
      if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string') {
        if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: msg.audio }
          }));
        }
      }
    } catch (e) { console.error('[OA] parse error', e); }
  });

  oaWS.on('error', (e) => console.error('[OA] error', e));
  oaWS.on('close', () => console.log('[OA] closed'));

  // Twilio -> OpenAI
  let framesSinceCommit = 0;
  let hadAnyAppend = false;

  twilioWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid;
      console.log('[WSS] stream start', streamSid);
      framesSinceCommit = 0;
      hadAnyAppend = false;
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({ type: 'response.create' }));
      }
    }

    if (msg.event === 'media' && msg.media?.payload && oaWS.readyState === WebSocket.OPEN) {
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }));
      hadAnyAppend = true;
      framesSinceCommit += 1;

      if (framesSinceCommit >= 5) {
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type: 'response.create' }));
        framesSinceCommit = 0;
      }
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop');
      if (oaWS.readyState === WebSocket.OPEN) {
        if (hadAnyAppend) oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type: 'response.create' }));
      }
    }
  });

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed');
    try { if (oaWS.readyState === WebSocket.OPEN) oaWS.close(); } catch {}
  });

  twilioWS.on('error', (e) => console.error('[WSS] error', e));
});
