// server.js — Twilio <-> OpenAI Realtime 24/7 bridge
// Fixes: correct audio shape + periodic commits + robust output handler

require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

const OA_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`
const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'realtime=v1'
}

const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

app.get('/', (_req, res) => res.send('OK'))

// Always stream 24/7 so testing is simple
app.post('/voice', (req, res) => {
  console.log('[HTTP] POST /voice')
  const wsUrl = `wss://${req.hostname}/media`
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">Connecting you to our assistant now.</Say>
      <Connect><Stream url="${wsUrl}" /></Connect>
    </Response>
  `)
})

// Start HTTP
const server = app.listen(PORT, () => {
  console.log(`[BOOT] HTTP up on :${PORT}`)
})

// WebSocket bridge
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected to /media')
  let streamSid = null

  // Connect to OpenAI Realtime
  const oa = new WebSocket(OA_URL, { headers: OA_HEADERS })

  // Periodic commit so OA can generate audio frequently
  let commitTimer = null
  let receivedAudioSinceLastCommit = false
  function startCommitTimer() {
    if (commitTimer) return
    commitTimer = setInterval(() => {
      if (oa.readyState === WebSocket.OPEN && receivedAudioSinceLastCommit) {
        try {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          oa.send(JSON.stringify({ type: 'response.create' }))
        } catch (e) { console.error('[OA] commit error', e) }
        receivedAudioSinceLastCommit = false
      }
    }, 800) // ~0.8s cadence works well for phone
  }
  function stopCommitTimer() {
    if (commitTimer) { clearInterval(commitTimer); commitTimer = null }
  }

  oa.on('open', () => {
    console.log('[OA] connected')
    // Configure ulaw both ways; add brief system instructions
    oa.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        instructions:
          "You are Sofia, the Cars & Keys phone assistant. " +
          "Greet the caller. Collect their name, callback number, year/make/model, " +
          "service needed, and ZIP code. Speak concisely and be friendly."
      }
    }))
  })

  // OA -> Twilio: play back audio chunks
  oa.on('message', (buf) => {
    let msg
    try { msg = JSON.parse(buf.toString()) } catch { return }

    // Realtime may send either .delta or .audio.data for audio chunks
    if (msg.type === 'response.output_audio.delta') {
      const base64 = msg.delta || (msg.audio && msg.audio.data)
      if (base64 && streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64 }
        }))
      }
      return
    }

    if (msg.type === 'error' || msg.type === 'response.error') {
      console.error('[OA ERROR]', msg)
      return
    }

    // Optional: log response boundary for debugging
    if (msg.type === 'response.completed') {
      console.log('[OA] response completed')
    }
  })

  oa.on('error', (e) => console.error('[OA<-] error', e?.message || e))
  oa.on('close', () => { console.log('[OA] closed'); stopCommitTimer() })

  // Twilio -> OA: append caller audio
  twilioWS.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid
      console.log('[WSS] stream start', streamSid)
      // Kick off commit cadence
      startCommitTimer()
      // Also prompt an initial greeting
      if (oa.readyState === WebSocket.OPEN) {
        oa.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      // CRUCIAL: The payload must be passed as { audio: "<base64>" }
      if (oa.readyState === WebSocket.OPEN) {
        try {
          oa.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload         // <-- correct shape
          }))
          receivedAudioSinceLastCommit = true
        } catch (e) {
          console.error('[OA] append error', e?.message || e)
        }
      }
      return
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop')
      if (oa.readyState === WebSocket.OPEN) {
        try {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          oa.send(JSON.stringify({ type: 'response.create' }))
        } catch (e) { console.error('[OA] final commit error', e) }
      }
      stopCommitTimer()
      return
    }
  })

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed')
    stopCommitTimer()
    if (oa.readyState === WebSocket.OPEN) oa.close()
  })
  twilioWS.on('error', (e) => console.error('[WSS] error', e?.message || e))
})
