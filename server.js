// server.js — Fastify + WS + health + stable batching
require('dotenv').config()
const Fastify = require('fastify')
const fastifyWebsocket = require('@fastify/websocket')
const { WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'
const OPENAI = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`

const app = Fastify({ logger: false })
app.register(fastifyWebsocket)

app.get('/', async () => 'OK')
app.get('/health', async () => ({ ok: true, ts: Date.now() }))

// Twilio webhook (24/7)
app.post('/voice', async (req, reply) => {
  const host = req.headers['x-forwarded-host'] || req.hostname
  const scheme = 'wss'
  reply
    .header('Content-Type', 'text/xml')
    .send(`
      <Response>
        <Say voice="alice">Connecting you to our assistant now.</Say>
        <Connect><Stream url="${scheme}://${host}/media" /></Connect>
      </Response>
    `)
})

// WS bridge
app.get('/media', { websocket: true }, (twilioWS /*, req*/) => {
  let streamSid = null
  let closed = false

  // Connect to OpenAI
  const oa = new WebSocket(OPENAI, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  })

  // Heartbeat keepalives
  const heartbeat = setInterval(() => {
    try { if (twilioWS.readyState === 1) twilioWS.ping() } catch {}
    try { if (oa.readyState === 1) oa.ping() } catch {}
  }, 15000)

  // Configure OA session (correct audio formats)
  oa.on('open', () => {
    oa.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          'You are Sofia from Cars & Keys. Be concise and friendly. ' +
          'Collect name, phone, year make model, service type, and ZIP; confirm back. ' +
          'If noisy, ask to repeat. End by saying you will text a confirmation.'
      }
    }))
  })

  // OA -> Twilio audio
  oa.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string' && streamSid) {
        if (twilioWS.readyState === 1) {
          twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio } }))
        }
      }
    } catch {}
  })

  // Twilio -> OA with timer batching (~100ms)
  let pendingAudio = false
  const commitTimer = setInterval(() => {
    if (oa.readyState === 1 && pendingAudio) {
      oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      oa.send(JSON.stringify({ type: 'response.create' }))
      pendingAudio = false
    }
  }, 100)

  twilioWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid
        if (oa.readyState === 1) oa.send(JSON.stringify({ type: 'response.create' })) // greeting
      }

      if (msg.event === 'media' && msg.media?.payload && oa.readyState === 1) {
        // Append base64 μ-law (string only)
        oa.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
        pendingAudio = true
      }

      if (msg.event === 'stop' && oa.readyState === 1) {
        if (pendingAudio) {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          pendingAudio = false
        }
        oa.send(JSON.stringify({ type: 'response.create' }))
      }
    } catch {}
  })

  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    clearInterval(commitTimer)
    try { if (twilioWS.readyState === 1) twilioWS.close() } catch {}
    try { if (oa.readyState === 1) oa.close() } catch {}
  }

  twilioWS.on('close', cleanup)
  twilioWS.on('error', cleanup)
  oa.on('close', cleanup)
  oa.on('error', cleanup)
})

// graceful shutdown
const closeSignals = ['SIGINT','SIGTERM']
closeSignals.forEach(sig => process.on(sig, async () => {
  try { await app.close() } finally { process.exit(0) }
}))

app.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`[BOOT] Fastify up on :${PORT}`))
  .catch((e) => { console.error(e); process.exit(1) })
