// server.js — Fastify + Twilio <-> OpenAI Realtime (g711 μ-law, forced greeting)
require('dotenv').config();

const fastify = require('fastify')({ logger: false });
const formbody = require('@fastify/formbody');
const { WebSocketServer, WebSocket } = require('ws');

const PORT  = process.env.PORT || 3001;
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
const OA_KEY = process.env.OPENAI_API_KEY;
if (!OA_KEY) { console.error('❌ Missing OPENAI_API_KEY'); process.exit(1); }

fastify.register(formbody);
fastify.get('/', async () => 'OK');

// Twilio webhook – always return TwiML that starts a Stream
fastify.post('/voice', async (req, reply) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
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
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, () =>
  console.log(`[BOOT] Fastify up on :${PORT}`)
);

// WebSocket bridge
const wss = new WebSocketServer({ server: fastify.server, path: '/media' });

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected -> /media');
  let streamSid = null;

  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${OA_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  // ---------------- OpenAI side ----------------
  oaWS.on('open', () => {
    console.log('[OA] connected');
    // Configure the session first (formats + VAD)
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: { type: 'server', silence_duration_ms: 800 },
        // Keep short, task-focused instructions
        instructions:
          'You are Sofia from Cars & Keys. Greet the caller immediately. ' +
          'Speak clearly and briefly. Gather: name, callback number, year, make, model, service type, and ZIP. ' +
          'Confirm details back. If unsure, politely ask to repeat. End by saying you will text a confirmation.'
      }
    }));
  });

  oaWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Forward assistant audio to the caller
    if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string') {
      if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio } }));
      }
    }

    // Helpful logs while we’re stabilizing
    if (msg.type === 'response.completed') console.log('[OA] response completed');
    if (msg.type === 'error') console.error('[OA ERROR]', msg);
  });

  oaWS.on('close', () => console.log('[OA] closed'));
  oaWS.on('error', (e) => console.error('[OA] error', e));

  // ---------------- Twilio side ----------------
  let framesSinceCommit = 0;
  let hadAnyAppend = false;

  twilioWS.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.event === 'start') {
      streamSid = m.start?.streamSid;
      console.log('[WSS] stream start', streamSid);
      framesSinceCommit = 0; hadAnyAppend = false;

      // Force an immediate spoken greeting (even before caller speaks)
      if (oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({
          type: 'response.create',
          response: {
            instructions: 'Greet the caller now and begin collecting info.'
          }
        }));
      }
    }

    if (m.event === 'media' && m.media?.payload && oaWS.readyState === WebSocket.OPEN) {
      // Forward caller audio to OpenAI
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: m.media.payload }));
      hadAnyAppend = true;
      framesSinceCommit++;

      if (framesSinceCommit >= 5) {
        oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        framesSinceCommit = 0;
      }
    }

    if (m.event === 'stop') {
      console.log('[WSS] stream stop');
      if (oaWS.readyState === WebSocket.OPEN) {
        if (hadAnyAppend) oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        // Let assistant wrap up if it was mid-thought
        oaWS.send(JSON.stringify({ type: 'response.create' }));
      }
    }
  });

  twilioWS.on('close', () => { console.log('[WSS] Twilio WS closed'); try { oaWS.close(); } catch {} });
  twilioWS.on('error', (e) => console.error('[WSS] error', e));
});
