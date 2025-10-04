// server.js — Twilio <-> OpenAI Realtime (24/7), hardened for primary-handler failures
require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

// ---------- OpenAI Realtime endpoint ----------
const OA_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`
const OA_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  'OpenAI-Beta': 'realtime=v1',
}

// ---------- App ----------
const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// tiny request log
app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next() })

app.get('/', (_req, res) => res.send('OK'))

// 24/7: always stream to assistant
app.post('/voice', (req, res) => {
  // Use the exact public host Twilio hit — most reliable on Render/Cloudflare/etc.
  const host = (req.headers['x-forwarded-host'] || req.get('host') || '').toString()
  const wsUrl = `wss://${host}/media`
  console.log('[VOICE] building <Stream> to', wsUrl)

  // Respond immediately with TwiML — long handlers cause fallback
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">Connecting you to our assistant now.</Say>
      <Connect><Stream url="${wsUrl}" /></Connect>
    </Response>
  `)
})

// ---------- Start HTTP ----------
const server = app.listen(PORT, () => {
  console.log(`[BOOT] HTTP up on :${PORT}`)
})

// ---------- WS bridge (Twilio <-> OpenAI) ----------
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected to /media')
  let streamSid = null

  // Connect to OpenAI Realtime
  const oa = new WebSocket(OA_URL, { headers: OA_HEADERS })

  // Commit cadence so OA speaks quickly
  let commitTimer = null
  let gotAudioSinceCommit = false
  const startCommit = () => {
    if (commitTimer) return
    commitTimer = setInterval(() => {
      if (oa.readyState === WebSocket.OPEN && gotAudioSinceCommit) {
        try {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          oa.send(JSON.stringify({ type: 'response.create' }))
        } catch (e) { console.error('[OA] commit error', e?.message || e) }
        gotAudioSinceCommit = false
      }
    }, 800)
  }
  const stopCommit = () => { if (commitTimer) clearInterval(commitTimer); commitTimer = null }

  oa.on('open', () => {
    console.log('[OA] connected')
    oa.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        instructions:
          "You are Sofia, the Cars & Keys phone assistant. Greet the caller warmly. " +
          "Collect their name, callback number (repeat it back), year/make/model, service needed, and ZIP. " +
          "Be brief, friendly, and confirm details."
      }
    }))
  })

  // OA -> caller (audio)
  oa.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf.toString()) } catch { return }
    if (msg.type === 'response.output_audio.delta') {
      const base64 = msg.delta || (msg.audio && msg.audio.data)
      if (base64 && streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: base64 } }))
      }
      return
    }
    if (msg.type === 'error' || msg.type === 'response.error') {
      console.error('[OA ERROR]', msg)
    }
    if (msg.type === 'response.completed') {
      console.log('[OA] response completed')
    }
  })
  oa.on('error', (e) => console.error('[OA<-] error', e?.message || e))
  oa.on('close', () => { console.log('[OA] closed'); stopCommit() })

  // Caller -> OA
  twilioWS.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid
      console.log('[WSS] stream start', streamSid)
      startCommit()
      if (oa.readyState === WebSocket.OPEN) {
        oa.send(JSON.stringify({ type: 'response.create' })) // greet immediately
      }
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      // IMPORTANT: pass base64 payload exactly as { audio: "<base64>" }
      if (oa.readyState === WebSocket.OPEN) {
        try {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: msg.media.payload }))
          gotAudioSinceCommit = true
        } catch (e) { console.error('[OA] append error', e?.message || e) }
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
      stopCommit()
      return
    }
  })

  twilioWS.on('close', () => { console.log('[WSS] Twilio WS closed'); stopCommit(); if (oa.readyState === WebSocket.OPEN) oa.close() })
  twilioWS.on('error', (e) => console.error('[WSS] error', e?.message || e))
})
