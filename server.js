// server.js — Twilio <-> OpenAI Realtime voice bridge (24/7) with diagnostics
require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

/* -------------------- HTTP / Twilio webhook -------------------- */
const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next() })

app.get('/', (_req, res) => res.send('OK'))

// Pure Twilio TTS (sanity check that Twilio can play audio)
app.post('/voice-test', (req, res) => {
  console.log('[VOICE-TEST] hit /voice-test')
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">This is a Twilio test. If you hear this, Twilio playback works. Goodbye.</Say>
      <Hangup/>
    </Response>
  `)
})

// Always-open voice webhook (24/7 streaming to OpenAI)
app.post('/voice', (req, res) => {
  console.log('[VOICE] hit /voice (24/7 mode)')
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

/* -------------------- WebSocket bridge -------------------- */
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected to /media')
  let streamSid = null

  // Connect to OpenAI Realtime
  const openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    }
  )

  /* ---- OpenAI events ---- */
  openaiWS.on('open', () => {
    console.log('[OA] connected (session.update -> μ-law @ 8kHz)')
    // Formats must be strings for some server versions
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        instructions:
          "You are Sofia from Cars & Keys. Be concise, helpful, and friendly. " +
          "Always collect: name, callback phone, year make model, service type, and ZIP code. " +
          "Confirm details back. If line is noisy, ask to repeat."
      }
    }))

    // Proactively ask OA to greet
    openaiWS.send(JSON.stringify({ type: 'response.create' }))
  })

  openaiWS.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch (e) {
      console.error('[OA] parse error', e)
      return
    }

    // Log important events
    if (msg.type === 'error')        console.error('[OA ERROR]', msg)
    if (msg.type === 'response.refusal.delta') console.log('[OA refusal]', msg.delta)
    if (msg.type === 'response.output_text.delta') {
      // uncomment for verbose text deltas:
      // console.log('[OA text]', msg.delta)
    }

    // OA -> Twilio audio delta (handle both shapes)
    if (msg.type === 'response.output_audio.delta') {
      const base64 =
        (typeof msg.audio === 'string') ? msg.audio
        : (msg.audio && typeof msg.audio.data === 'string') ? msg.audio.data
        : null

      if (base64 && streamSid && twilioWS.readyState === WebSocket.OPEN) {
        twilioWS.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: base64 }
        }))
      }
    }
  })

  openaiWS.on('error', (e) => console.error('[OA] error', e))
  openaiWS.on('close', () => console.log('[OA] closed'))

  /* ---- Twilio media -> OpenAI ---- */
  // Commit after ~160ms (8 frames @ ~20ms/frame) to avoid "buffer too small".
  const FRAMES_PER_COMMIT = 8
  let framesSinceCommit = 0
  let appendedSinceCommit = false

  function commitIfReady() {
    if (openaiWS.readyState !== WebSocket.OPEN) return
    if (!appendedSinceCommit) return
    openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
    openaiWS.send(JSON.stringify({ type: 'response.create' }))
    framesSinceCommit = 0
    appendedSinceCommit = false
    // console.log('[OA] committed audio buffer')
  }

  twilioWS.on('message', (raw) => {
    let data
    try { data = JSON.parse(raw.toString()) } catch { return }

    if (data.event === 'start') {
      streamSid = data.start.streamSid
      console.log('[WSS] stream start', streamSid)
      framesSinceCommit = 0
      appendedSinceCommit = false
      // Also ensure we have a greeting even if no caller audio yet
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }

    if (data.event === 'media' && data.media?.payload) {
      if (openaiWS.readyState === WebSocket.OPEN) {
        // Append with **explicit format**; some OA builds require it this way.
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: {
            data: data.media.payload,   // base64 μ-law from Twilio
            format: 'g711_ulaw'
          }
        }))
        appendedSinceCommit = true
        framesSinceCommit += 1
        if (framesSinceCommit >= FRAMES_PER_COMMIT) commitIfReady()
      }
      return
    }

    if (data.event === 'stop') {
      console.log('[WSS] stream stop')
      commitIfReady()
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'response.create' }))
      }
      return
    }
  })

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed')
    try { if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close() } catch {}
  })
  twilioWS.on('error', (e) => console.error('[WSS] Twilio WS error', e))
})
