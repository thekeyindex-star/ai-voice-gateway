// admin-add-business.js — create or update a Business + link a Twilio number
// Usage:
//   node admin-add-business.js --name "Cars & Keys Sioux Falls" --e164 +16056100158 --tz America/Chicago
//
// Optional flags for simple defaults (you can edit later via dashboard):
//   --afterHours 40 --included 10 --perMile 2.0
//
// If the business exists, it will update its name/timezone/profile. If the number exists, it will relink.

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

function arg(name, def=null) {
  const i = process.argv.indexOf(name)
  if (i === -1) return def
  return process.argv[i+1]
}

async function main() {
  const name   = arg('--name')
  const e164   = arg('--e164')
  const tz     = arg('--tz', 'America/Chicago')
  const ah     = Number(arg('--afterHours', 40))
  const incl   = Number(arg('--included', 10))
  const pm     = Number(arg('--perMile', 2.0))

  if (!name || !e164) {
    console.error('Missing required flags. Example:')
    console.error('node admin-add-business.js --name "My Shop" --e164 +14155551212 --tz America/Chicago')
    process.exit(1)
  }

  const defaultProfile = {
    hours: {
      mon: ['08:00-22:00'], tue: ['08:00-22:00'], wed: ['08:00-22:00'],
      thu: ['08:00-22:00'], fri: ['08:00-22:00'], sat: ['09:00-20:00'], sun: ['10:00-18:00']
    },
    pricing: {
      afterHoursSurcharge: ah,
      travel: { includedMiles: incl, perMileAfter: pm, oneWay: true },
      services: {
        lockout:               { day: [79,119],  night: [119,159] },
        duplicate_basic:       { day: [59,89],   night: [89,119] },
        duplicate_transponder: { day: [129,179], night: [169,219] },
        all_keys_lost:         { day: [199,349], night: [249,399] },
        fob_programming:       { day: [99,149],  night: [139,189] },
        laser_cut_surcharge: 60,
        euro_surcharge: 80
      }
    },
    scripts: {
      greeting:  'Thanks for calling {{businessName}}. Connecting you to our assistant.',
      voicemail: 'Thank you for calling {{businessName}}. We are currently closed. Please leave your name, phone number, the year, make and model of your vehicle, and the service you need. We will get back to you as soon as possible during business hours. Goodbye.'
    },
    faq: [
      { q: 'Do you cut laser keys?', a: 'Yes. Laser-cut surcharge applies.' },
      { q: 'Do you program European vehicles?', a: 'Yes. European immobilizer surcharge may apply.' }
    ]
  }

  // Create or update business
  let biz = await prisma.business.findFirst({ where: { name } })
  if (biz) {
    biz = await prisma.business.update({
      where: { id: biz.id },
      data: { name, timezone: tz, profile: defaultProfile }
    })
    console.log('Updated business:', biz.name)
  } else {
    biz = await prisma.business.create({
      data: { name, timezone: tz, profile: defaultProfile }
    })
    console.log('Created business:', biz.name)
  }

  // Link phone number
  const existing = await prisma.phoneNumber.findUnique({ where: { e164 } })
  if (existing) {
    await prisma.phoneNumber.update({ where: { e164 }, data: { businessId: biz.id } })
    console.log('Re-linked number to this business:', e164)
  } else {
    await prisma.phoneNumber.create({ data: { e164, businessId: biz.id } })
    console.log('Linked new number to this business:', e164)
  }

  console.log('\nWebhook method (recommended): set Twilio "A call comes in" to POST:')
  console.log('   https://YOUR-DOMAIN/voice')
  console.log('\nTwiML Bin (alternative):')
  console.log(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thanks for calling ${name}. Connecting you to our assistant.</Say>
  <Connect>
    <Stream url="wss://YOUR-DOMAIN/media" />
  </Connect>
</Response>`)

  await prisma.$disconnect()
}

main().catch(async (e)=>{ console.error(e); await prisma.$disconnect(); process.exit(1) })
