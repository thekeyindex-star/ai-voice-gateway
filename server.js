// server.js — Twilio <-> OpenAI Realtime bridge (24/7, robust start, dual delta handlers, loud logs)
require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const PORT  = process.env.PORT || 3000
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next() })
app.get('/', (_req, res) => res.send('OK'))

// Always connect to stream (24/7)
app.post('/voice', (req, res) => {
  console.log('[VOICE] hit /voice (24/7 mode)')
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">Connecting you to our assistant now.</Say>
      <Connect><Stream url="wss://${req.hostname}/media" /></Connect>
    </Response>
  `)
})

const server = app.listen(PORT, () => console.log(`[BOOT] HTTP up on :${PORT}`))

// ----------------- WebSocket bridge -----------------
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('[WSS] Twilio connected to /media')

  let streamSid = null
  let openaiWS = null
  let oaOpen = false

  function toTwilio(base64ULaw) {
    if (!streamSid) return
    if (twilioWS.readyState !== WebSocket.OPEN) return
    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64ULaw }
    }))
  }

  // Connect to OpenAI
  openaiWS = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
  )

  // ---------- OpenAI handlers ----------
  openaiWS.on('open', () => {
    oaOpen = true
    console.log('[OA] connected')

    // 1) Update session formats + VAD
    const sessionUpdate = {
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        turn_detection: { type: 'server_vad' }
      }
    }
    openaiWS.send(JSON.stringify(sessionUpdate))
    console.log('[OA->] session.update sent')

    // 2) Force an immediate spoken greeting with explicit response payload
    const greet = {
      type: 'response.create',
      response: {
        instructions:
          "You are Sofia, the Cars & Keys phone assistant. " +
          "Greet the caller right away. Then, clearly and briefly collect their name, callback number, ZIP code, and the vehicle year, make, and model, plus the service needed.",
        modalities: ['audio'],
        audio: { voice: 'alloy' } // voice selection (if supported)
      }
    }
    openaiWS.send(JSON.stringify(greet))
    console.log('[OA->] response.create (greeting) sent')
  })

  openaiWS.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch (e) { console.error('[OA] parse error', e); return }

    // Log everything (throttle heavy ones below)
    if (msg.type !== 'response.audio.delta' && msg.type !== 'response.output_audio.delta') {
      console.log('[OA<-]', msg.type)
    }

    // Some stacks emit this:
    if (msg.type === 'response.audio.delta' && msg.delta) {
      // delta is base64 µ-law because of output_audio_format
      toTwilio(msg.delta)
      return
    }

    // Others emit this:
    if (msg.type === 'response.output_audio.delta' && msg.audio?.data) {
      toTwilio(msg.audio.data)
      return
    }

    // When a response finishes, OA will wait for next user turn;
    // our VAD + caller speech will trigger the next turn automatically.
    if (msg.type === 'response.completed') {
      console.log('[OA] response.completed')
    }

    // If OA reports an error, surface it
    if (msg.type === 'error' || msg.error) {
      console.error('[OA ERROR]', msg)
    }
  })

  openaiWS.on('error', (e) => console.error('[OA] error', e))
  openaiWS.on('close', () => console.log('[OA] closed'))

  // ---------- Twilio handlers ----------
  twilioWS.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid
      console.log('[WSS] stream start', streamSid)
      // If OA was slower and just opened now, send another response.create to be safe
      if (oaOpen && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio'], audio: { voice: 'alloy' } }
        }))
        console.log('[OA->] response.create (on start) sent')
      }
      return
    }

    if (msg.event === 'media' && msg.media?.payload) {
      // Caller -> OA
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: {
            data: msg.media.payload,
            format: { type: 'g711_ulaw', sample_rate: 8000 }
          }
        }))
      }
      return
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop')
      if (openaiWS && openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        openaiWS.send(JSON.stringify({
          type: 'response.create',
          response: { modalities: ['audio'], audio: { voice: 'alloy' } }
        }))
        console.log('[OA->] commit + response.create (on stop) sent')
      }
      return
    }
  })

  twilioWS.on('close', () => {
    console.log('[WSS] Twilio WS closed')
    if (openaiWS && openaiWS.readyState === WebSocket.OPEN) openaiWS.close()
  })

  twilioWS.on('error', (e) => console.error('[WSS] Twilio WS error', e))
})
