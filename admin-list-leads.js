// admin-list-leads.js
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const leads = await prisma.lead.findMany({
    orderBy: { id: 'desc' },
    take: 20,
    include: { business: true }
  })
  console.log("\n=== Recent Leads (top 20) ===")
  for (const L of leads) {
    console.log(`#${L.id} | ${L.business?.name || 'Unknown'} | ${L.timestamp.toISOString()}`)
    console.log(` type: ${L.type || 'lead'} | name: ${L.name || '-'} | phone: ${L.phone || '-'}`)
    console.log(` ymm: ${[L.year,L.make,L.model].filter(Boolean).join(' ')} | svc: ${L.service || '-'} | zip: ${L.zip || '-'}`)
    if (L.recordingUrl) console.log(` recording: ${L.recordingUrl}`)
    if (L.raw) console.log(` raw: ${L.raw}`)
    console.log('---')
  }
  await prisma.$disconnect()
}

main().catch(async (e)=>{ console.error(e); await prisma.$disconnect(); process.exit(1) })
