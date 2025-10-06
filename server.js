// server.js — Twilio <-> (Echo OR OpenAI) bridge
require('dotenv').config();
const fastify = require('fastify')({ logger: false });
const formbody = require('@fastify/formbody');
const { WebSocketServer, WebSocket } = require('ws');

const PORT   = process.env.PORT || 3001;
const MODEL  = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime';
const OA_KEY = process.env.OPENAI_API_KEY || '';
const ECHO   = process.env.DIAG_ECHO === '1';

fastify.register(formbody);
fastify.get('/', async () => 'OK');

fastify.post('/voice', async (req, reply) => {
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const wsUrl = `wss://${host}/media`;
  const twiml = `
    <Response>
      <Say voice="Polly.Salli">Connecting you to our assistant now.</Say>
      <Connect><Stream url="${wsUrl}"/></Connect>
    </Response>
  `.trim();
  reply.type('text/xml').send(twiml);
});

fastify.listen({ port: PORT, host: '0.0.0.0' }, () => {
  console.log(`[BOOT] Fastify on :${PORT}  ECHO=${ECHO ? 'ON' : 'OFF'}`);
});

const wss = new WebSocketServer({ server: fastify.server, path: '/media' });

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected -> /media');
  let streamSid = null;
  let framesIn = 0, oaOut = 0;

  if (ECHO) {
    // ---------- PURE ECHO (no OpenAI) ----------
    twilioWS.on('message', (raw) => {
      const msg = safeJSON(raw);
      if (!msg) return;
      if (msg.event === 'start') { streamSid = msg.start?.streamSid; framesIn = 0; }
      if (msg.event === 'media' && msg.media?.payload && streamSid) {
        framesIn++;
        // Immediately send caller audio back to caller
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: msg.media.payload }
        }));
      }
      if (msg.event === 'stop') {
        console.log(`[ECHO] stop  frames_in=${framesIn}`);
      }
    });
    twilioWS.on('close', () => console.log('[ECHO] Twilio WS closed'));
    twilioWS.on('error', (e) => console.error('[ECHO] WS error', e));
    return;
  }

  // ---------- OpenAI path ----------
  if (!OA_KEY) { console.error('❌ OPENAI_API_KEY missing'); twilioWS.close(); return; }

  const oaWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${OA_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  );

  oaWS.on('open', () => {
    console.log('[OA] connected');
    oaWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ["text","audio"],
        voice: "alloy",
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
        instructions:
          "You are Sofia from Cars & Keys. Be concise and friendly. " +
          "Collect: full name, callback number, year/make/model, service type, and ZIP. " +
          "Confirm details; then say you will text a confirmation."
      }
    }));
    oaWS.send(JSON.stringify({ type: 'response.create' }));
  });

  oaWS.on('message', (raw) => {
    const msg = safeJSON(raw);
    if (!msg) return;
    if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string' && streamSid) {
      oaOut++;
      twilioWS.send(JSON.stringify({ event:'media', streamSid, media:{ payload: msg.audio } }));
    }
  });
  oaWS.on('error', (e) => console.error('[OA] error', e));
  oaWS.on('close', () => console.log('[OA] closed'));

  // Commit only when we actually appended audio
  let appended = false;
  const commitTimer = setInterval(() => {
    if (appended && oaWS.readyState === WebSocket.OPEN) {
      oaWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      oaWS.send(JSON.stringify({ type: 'response.create' }));
      appended = false;
    }
  }, 120);

  twilioWS.on('message', (raw) => {
    const msg = safeJSON(raw);
    if (!msg) return;
    if (msg.event === 'start') { streamSid = msg.start?.streamSid; framesIn = 0; appended = false; }
    if (msg.event === 'media' && msg.media?.payload && oaWS.readyState === WebSocket.OPEN) {
      framesIn++; appended = true;
      oaWS.send(JSON.stringify({ type:'input_audio_buffer.append', audio: msg.media.payload }));
    }
    if (msg.event === 'stop') {
      console.log(`[WSS] stop frames_in=${framesIn} oa_audio_out=${oaOut}`);
      if (appended && oaWS.readyState === WebSocket.OPEN) {
        oaWS.send(JSON.stringify({ type:'input_audio_buffer.commit' }));
        oaWS.send(JSON.stringify({ type:'response.create' }));
        appended = false;
      }
    }
  });

  twilioWS.on('close', () => { clearInterval(commitTimer); try { if (oaWS.readyState===WebSocket.OPEN) oaWS.close(); } catch{}; });
  twilioWS.on('error', (e) => console.error('[WSS] error', e));
});

function safeJSON(buf) { try { return JSON.parse(buf.toString()); } catch { return null; } }
