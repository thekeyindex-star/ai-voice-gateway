// server.js — Twilio <-> OpenAI Realtime (with ECHO diagnostic + verbose logs)
require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'
const DIAG_ECHO = String(process.env.DIAG_ECHO || '0') === '1' // echo incoming audio back to caller

const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next() })
app.get('/', (_req, res) => res.send('OK'))

// Always connect 24/7
app.post('/voice', (req, res) => {
  console.log('[VOICE] hit /voice (24/7)')
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">Connecting you to our assistant now.</Say>
      <Connect>
        <Stream url="wss://${req.hostname}/media" />
      </Connect>
    </Response>
  `)
})

const server = app.listen(PORT, () => console.log(`[BOOT] HTTP up on :${PORT}`))
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('────────────────────────────────────────────────────────')
  console.log('[WSS] Twilio connected /media')

  let streamSid = null
  let framesIn = 0
  let commits = 0
  let oaAudioOut = 0
  let framesSinceCommit = 0
  let appendedSinceCommit = false
  let oaBusy = false

  // Connect OA
  const oa = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  )

  const safeCreateResponse = (why) => {
    if (oa.readyState !== WebSocket.OPEN) return
    if (oaBusy) return
    oaBusy = true
    console.log(`[OA] response.create (${why})`)
    oa.send(JSON.stringify({ type: 'response.create' }))
  }

  oa.on('open', () => {
    console.log('[OA] connected')
    oa.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          "You are Sofia from Cars & Keys. Be concise and friendly. " +
          "Collect caller name, callback phone, year make model, requested service, and ZIP. " +
          "Confirm details and say you'll text a confirmation."
      }
    }))
  })

  oa.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'response.created')  { oaBusy = true }
    if (msg.type === 'response.completed' || msg.type === 'response.stopped' || msg.type === 'response.error') {
      oaBusy = false
    }

    if (msg.type === 'response.output_audio.delta' && typeof msg.audio === 'string') {
      oaAudioOut += 1
      if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio } }))
      }
    }

    if (msg.type === 'error') {
      console.log('[OA ERROR]', JSON.stringify(msg, null, 2))
    }
  })

  oa.on('error', (e) => console.error('[OA] error', e))
  oa.on('close', () => console.log('[OA] closed'))

  twilioWS.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'start') {
      streamSid = msg.start?.streamSid
      framesIn = commits = oaAudioOut = framesSinceCommit = 0
      appendedSinceCommit = false
      oaBusy = false
      console.log(`[WSS] stream start ${streamSid}  (ECHO=${DIAG_ECHO ? 'ON' : 'OFF'})`)
      safeCreateResponse('greeting') // Let Sofia speak right away
      return
    }

    if (msg.event === 'media') {
      const b64 = msg.media?.payload
      framesIn += 1

      // DIAGNOSTIC echo: send caller audio straight back to caller
      if (DIAG_ECHO && streamSid && twilioWS.readyState === WebSocket.OPEN && typeof b64 === 'string' && b64.length) {
        twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }))
      }

      // OA path
      if (oa.readyState === WebSocket.OPEN && typeof b64 === 'string' && b64.length) {
        oa.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: b64 }))
        appendedSinceCommit = true
        framesSinceCommit += 1
        if (framesSinceCommit >= 5) {          // ~100ms at 8k μ-law
          commits += 1
          framesSinceCommit = 0
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          safeCreateResponse('after-commit')
        }
      }
      return
    }

    if (msg.event === 'stop') {
      console.log(`[WSS] stream stop  frames_in=${framesIn} commits=${commits} oa_audio_out=${oaAudioOut}`)
      if (oa.readyState === WebSocket.OPEN) {
        if (appendedSinceCommit) {
          oa.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
          appendedSinceCommit = false
        }
        safeCreateResponse('on-stop')
      }
      return
    }
  })

  twilioWS.on('close', () => {
    console.log(`[WSS] Twilio WS closed  frames_in=${framesIn} commits=${commits} oa_audio_out=${oaAudioOut}`)
    try { if (oa.readyState === WebSocket.OPEN) oa.close() } catch {}
    console.log('────────────────────────────────────────────────────────')
  })
  twilioWS.on('error', (e) => console.error('[WSS] Twilio WS error', e))
})
