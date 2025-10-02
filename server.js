// server.js — Twilio <-> OpenAI Realtime bridge
// Features:
//  - Structured lead capture (CSV)
//  - Business-hours check (from pricing.json)
//  - Closed-hours voicemail (stores RecordingUrl in CSV)
//  - Dev endpoints: /dev/lead, /dev/open, /dev/quote
//  - WebSocket bridge for <Connect><Stream> to GPT Realtime
//
// Requirements:
//  - .env with OPENAI_API_KEY, PORT=3001 (optional), OPENAI_REALTIME_MODEL=gpt-4o-realtime
//  - pricing.json and pricing.js present (we already created those)

require('dotenv').config()
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')
const fs = require('fs')
const path = require('path')

// ===== Env / Ports / Model =====
const PORT  = process.env.PORT || 3001
const MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime'

// ===== Pricing engine (hours + quotes) =====
const { config: PRICING, quote, isOpenAt } = require('./pricing')

// ===== CSV helpers (structured leads) =====
const CSV_PATH = path.join(process.cwd(), 'leads.csv')

function ensureCsvWithHeader() {
  if (!fs.existsSync(CSV_PATH)) {
    fs.writeFileSync(
      CSV_PATH,
      'timestamp,name,phone,year,make,model,service,zip,raw\n',
      'utf8'
    )
  }
}

function csvEscape(v) {
  const s = (v ?? '').toString()
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/**
 * Parse a LEAD line like:
 * LEAD: Name=John; Phone=605-555-1212; YMM=2018 Honda Civic; Service=Lockout; ZIP=57106
 * Returns {name, phone, year, make, model, service, zip, raw}
 */
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

    // Try to split YMM into Year + Make + Model
    const ym = ymm.match(/(\d{4})\s+([A-Za-z0-9-]+)\s+(.*)/)
    if (ym) {
      year = ym[1].trim()
      make = ym[2].trim()
      model = ym[3].trim()
    } else {
      model = ymm // fallback: keep as single chunk
    }
  }
  return { name, phone, year, make, model, service, zip, raw }
}

function appendLeadRow(lead) {
  ensureCsvWithHeader()
  const row = [
    new Date().toISOString(),
    lead.name, lead.phone, lead.year, lead.make, lead.model, lead.service, lead.zip, lead.raw
  ].map(csvEscape).join(',') + '\n'
  fs.appendFileSync(CSV_PATH, row)
}

// ===== App =====
const app = express()

// Health check
app.get('/', (_req, res) => res.send('OK'))

// ----- Dev helper: write a sample structured LEAD row (no calls needed) -----
app.get('/dev/lead', (_req, res) => {
  const sample = 'LEAD: Name=Test Caller; Phone=605-555-1212; YMM=2018 Honda Civic; Service=Lockout; ZIP=57106'
  appendLeadRow(parseLeadLine(sample))
  res.send('Sample lead written to leads.csv with structured columns.')
})

// ----- Dev: Is business open right now? -----
app.get('/dev/open', (_req, res) => {
  res.json({ openNow: isOpenAt(new Date()), timezone: PRICING.timezone })
})

// ----- Dev: Price a scenario via query string -----
// Example: /dev/quote?service=lockout&miles=12&afterHours=true&euro=false&laserCut=true
app.get('/dev/quote', (req, res) => {
  const service    = (req.query.service || '').trim()
  const miles      = Number(req.query.miles || 0)
  const afterHours = String(req.query.afterHours || '').toLowerCase() === 'true'
  const euro       = String(req.query.euro || '').toLowerCase() === 'true'
  const laserCut   = String(req.query.laserCut || '').toLowerCase() === 'true'
  const q = quote({ service, miles, afterHours, euro, laserCut })
  if (!q) return res.status(400).json({ error: 'Unknown service', services: Object.keys(PRICING.services) })
  res.json({ service, miles, afterHours, euro, laserCut, range: q })
})

// ----- Voice webhook: route to Sofia when open; voicemail when closed -----
app.post('/voice', (req, res) => {
  const openNow = isOpenAt(new Date())

  if (!openNow) {
    // Closed hours → Voicemail path
    res.type('text/xml').send(`
      <Response>
        <Say voice="alice">
          Thank you for calling Cars and Keys. Our office is currently closed.
          Please leave your name, phone number, the year, make and model of your vehicle,
          and the service you need. We will get back to you as soon as possible during business hours.
          Goodbye.
        </Say>
        <Record maxLength="90" action="/voicemail" />
        <Hangup/>
      </Response>
    `)
  } else {
    // Open hours → Realtime assistant
    res.type('text/xml').send(`
      <Response>
        <Say voice="alice">Thanks for calling Cars and Keys. Connecting you to our assistant.</Say>
        <Connect><Stream url="wss://${req.hostname}/media" /></Connect>
      </Response>
    `)
  }
})

// ----- Voicemail handler: Twilio POSTs recording metadata here -----
app.post('/voicemail', express.urlencoded({ extended: false }), (req, res) => {
  try {
    const ts = new Date().toISOString()
    const from = req.body.From || 'unknown'
    const recording = req.body.RecordingUrl || ''
    // Store as a CSV row (type=voicemail placed into 'service' column for easy filtering)
    const row = [
      ts, '', from, '', '', '', 'voicemail', '', recording
    ].map(csvEscape).join(',') + '\n'

    ensureCsvWithHeader()
    fs.appendFileSync(CSV_PATH, row)
    console.log('Voicemail saved:', { from, recording })
  } catch (e) {
    console.error('Voicemail save error:', e)
  }
  res.type('text/xml').send('<Response><Say voice="alice">Thank you. Goodbye.</Say></Response>')
})

// Start HTTP
const server = app.listen(PORT, () => {
  console.log(`HTTP up on :${PORT}`)
})

// ===== WebSocket bridge for Twilio <Connect><Stream> =====
const wss = new WebSocketServer({ server, path: '/media' })

wss.on('connection', (twilioWS) => {
  console.log('Twilio connected.')
  let streamSid = null
  let lastLeadLine = '' // keep latest "LEAD:" line from model text

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

  // Send μ-law audio back to Twilio
  function toTwilio(base64ULaw) {
    if (!streamSid || twilioWS.readyState !== WebSocket.OPEN) return
    twilioWS.send(JSON.stringify({
      event: 'media',
      streamSid,
      media: { payload: base64ULaw }
    }))
  }

  openaiWS.on('open', () => {
    console.log('OpenAI connected.')
    const instructions =
      "You are Sofia, the trusted phone assistant for Cars & Keys. " +
      "When asked about pricing, give a safe range based on business hours vs after-hours, travel distance beyond included miles, and any surcharges (laser-cut or European). " +
      "Be clear that quotes are ranges until VIN/immobilizer check. " +
      "Always collect: (1) year, make, model; (2) service (lockout/duplicate/transponder/all keys lost/programming); " +
      "(3) ZIP/location; (4) best callback number. Confirm by repeating the number. " +
      "At the END, output ONE line starting with EXACTLY 'LEAD:' in this format: " +
      "'LEAD: Name=<name>; Phone=<digits or formatted>; YMM=<year make model>; Service=<lockout/duplicate/transponder/all keys lost/programming>; ZIP=<zip or area>'. " +
      "Do not add any other text on that final line."

    // Match PSTN audio so no transcoding is required
    openaiWS.send(JSON.stringify({
      type: 'session.update',
      session: {
        input_audio_format:  { type: 'g711_ulaw', sample_rate: 8000 },
        output_audio_format: { type: 'g711_ulaw', sample_rate: 8000 },
        instructions
      }
    }))
  })

  // Audio/text events from OpenAI -> caller / capture LEAD line
  openaiWS.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString())

      // Audio to caller
      if (msg.type === 'response.output_audio.delta' && msg.audio?.data) {
        toTwilio(msg.audio.data)
      }

      // Capture the latest LEAD: line from text stream
      if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
        const lines = msg.delta.split(/\r?\n/)
        for (const line of lines) {
          const t = line.trim()
          if (t.toUpperCase().startsWith('LEAD:')) lastLeadLine = t
        }
      }
    } catch (e) {
      console.error('OpenAI msg parse error', e)
    }
  })

  openaiWS.on('close', () => console.log('OpenAI closed'))
  openaiWS.on('error', (e) => console.error('OpenAI error', e))

  // Caller audio from Twilio -> OpenAI input buffer
  twilioWS.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())

    if (msg.event === 'start') {
      streamSid = msg.start.streamSid
      console.log('Twilio stream started:', streamSid)
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'response.create' })) // greet immediately
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
      if (openaiWS.readyState === WebSocket.OPEN) {
        openaiWS.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
        openaiWS.send(JSON.stringify({ type: 'response.create' }))
      }
    }
  })

  // When the call ends, persist the LEAD line (structured) to leads.csv
  function writeLeadIfPresent() {
    const parsed = parseLeadLine(lastLeadLine || 'LEAD:')
    appendLeadRow(parsed)
    console.log('Lead saved:', parsed)
  }

  twilioWS.on('close', () => {
    console.log('Twilio closed')
    if (openaiWS.readyState === WebSocket.OPEN) openaiWS.close()
    writeLeadIfPresent()
  })
  twilioWS.on('error', (e) => console.error('Twilio WS error', e))
})
