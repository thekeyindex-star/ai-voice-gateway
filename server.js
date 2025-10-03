// server.js — Twilio <-> OpenAI Realtime voice bridge (full, debug logs, CSV + voicemail)
require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const path = require('path')

// ---------- Env ----------
const PORT  = process.env.PORT || 3000   // Render binds this
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

// ---------- CSV (persist to /data if available) ----------
const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd()
const CSV_PATH = path.join(DATA_DIR, 'leads.csv')

function ensureCsvWithHeader() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      'timestamp,name,phone,year,make,model,service,zip,raw_or_recording\n',
      'utf8'
    )
    console.log('[CSV] created', CSV_PATH)
  }
}

function csvEscape(v) {
  const s = (v ?? '').toString()
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function appendLeadRow(obj) {
  try {
    ensureCsvWithHeader()
    const row = [
      new Date().toISOString(),
      obj.name ?? '', obj.phone ?? '', obj.year ?? '', obj.make ?? '', obj.model ?? '', obj.service ?? '', obj.zip ?? '',
      obj.raw ?? obj.recordingUrl ?? ''
    ].map(csvEscape).join(',') + '\n'
    fs.appendFileSync(CSV_PATH, row)
    console.log('[CSV] wrote lead/voicemail row')
  } catch (e) {
    console.error('[CSV] write error', e)
  }
}

/** Parse "LEAD: Name=...; Phone=...; YMM=YYYY Make Model; Service=...; ZIP=..." */
function parseLeadLine(leadLine) {
  const raw = (leadLine || '').trim()
  const m = raw.match(/Name\s*=\s*([^;]+).*?Phone\s*=\s*([^;]+).*?YMM\s*=\s*([^;]+).*?Service\s*=\s*([^;]+).*?ZIP\s*=\s*([^;]+)/i)
  let name = '', phone = '', year = '', make = '', model = '', service = '', zip = ''
  if (m) {
    name = m[1].trim()
    phone = m[2].trim()
    const ymm = m[3].trim()
    service = m[4].trim()
    zip = m[5].trim()
    const ym = ymm.match(/(\d{4})\s+([A-Za-z0-9-]+)\s+(.*)/)
    if (ym) { year = ym[1]; make = ym[2]; model = ym[3] } else { model = ymm }
  }
  return { name, phone, year, make, model, service, zip, raw }
}

// ---------- App ----------
const app = express()
app.set('trust proxy', true)
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// tiny request log
app.use((req, _res, next) => { console.log(`[HTTP] ${req.method} ${req.url}`); next() })

// Health
app.get('/', (_req, res) => res.send('OK'))

// Helpful GET (so browser GET /voice doesn’t look broken)
app.get('/voice', (_req, res) => {
  res
    .status(200)
    .type('text/plain')
    .send('Twilio should POST to /voice. GET is only for sanity checks.')
})

// Dev helpers
app.get('/dev/lead', (_req, res) => {
  const sample = 'LEAD: Name=Test Caller; Phone=605-555-1212; YMM=2018 Honda Civic; Service=Lockout; ZIP=57106'
  appendLeadRow(parseLeadLine(sample))
  res.send('Sample lead appended to leads.csv')
})

// Voice webhook (Twilio -> here) — 24/7 assistant (no hours gating)
app.post('/voice', (req, res) => {
  console.log('[VOICE] hit /voice (24/7 mode)')
  res.type('text/xml').send(`
    <Response>
      <Say voice="alice">Connecting you to our assistant now.</Say>
      <Connect><Stream url="wss://${req.hostname}/media" /></Connect>
    </Response>
  `)
})

// Voicemail (Twilio posts form-encoded here after <Record>) — will be used only if you wire it in Twilio
app.post('/voicemail', (req, res) => {
  try {
    const from = req.body?.From || 'unknown'
    const rec  = req.body?.RecordingUrl || ''
    appendLeadRow({ name:'', phone: from, year:'', make:'', model:'', service:'voicemail', zip:'', recordingUrl: rec })
    console.log('[VOICEMAIL] saved', { from, rec })
  } catch (e) { console.error('[VOICEMAIL] save error', e) }

  res.type('text/xml').send('<Response><Say voice="alice">Thank you. Goodbye.</Say></Response>')
})

// Start HTTP
const server = app.listen(PORT, () => console.log(`[BOOT] HTTP up on :${PORT}`))

// ---------- WebSocket bridge (Twilio <-> OpenAI) ----------
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS, req) => {
  console.log('[WSS] Twilio connected to /media from', req.socket.remoteAddress)
  let streamSid = null
  let lastLeadLine = ''

  // Connect to OpenAI Realtime
  const oaUrl = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`
  console.log('[OA] connecting to', oaUrl)
  const openaiWS = new WebSocket(oaUrl, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  })

  openaiWS.on('open', () => {
    console.log('[OA] connected')
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        instructions:
          "You are Sofia, the Cars & Keys phone assistant. " +
          "Always collect: year/make/model, ZIP, and job type (lockout/duplicate/all keys lost/programming). " +
          "Keep responses concise. At the very end, output exactly one line beginning with 'LEAD:' " +
          "in the form: LEAD: Name=<name>; Phone=<digits>; YMM=<year make model>; Service=<service>; ZIP=<zip>"
      }
    }))
  })

  // From OpenAI -> to caller
  openaiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'response.output_audio.delta' && msg.audio?.data) {
        if (streamSid && twilioWS.readyState === WebSocket.OPEN) {
          twilioWS.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio.data } }))
        }
      }
      if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
        const lines = msg.delta.split(/\r?\n/)
        for (const line of lines) {
          const t = line.trim()
          if (t.toUpperCase().startsWith('LEAD:')) lastLeadLine = t
        }
      }
    } catch (e) { console.error('[OA] parse error', e) }
  })
  openaiWS.on('error', (e) => console.error('[OA] error', e))
  openaiWS.on('close', () => console.log('[OA] closed'))

  // From Twilio -> to OpenAI
  twilioWS.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid
      console.log('[WSS] stream start', streamSid)
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'response.create' }))
      }
    }

    if (msg.event === 'media' && msg.media?.payload) {
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: { data: msg.media.payload, format: { type: 'g711_ulaw', sample_rate: 8000 } }
        }))
      }
    }

    if (msg.event === 'stop') {
      console.log('[WSS] stream stop')
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        openaiWS.send(JSON.stringify({ type: 'response.create' }))
      }
      if (lastLeadLine) {
        appendLeadRow(parseLeadLine(lastLeadLine))
        lastLeadLine = ''
      }
    }
  })

  twilioWS.on('close', () => { console.log('[WSS] Twilio WS closed'); if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close() })
  twilioWS.on('error', (e) => console.error('[WSS] Twilio WS error', e))
})
