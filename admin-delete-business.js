// admin-delete-business.js -- delete a business by name (and its numbers & leads)
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const name = process.argv.slice(2).join(' ')
  if (!name) {
    console.error('Usage: node admin-delete-business.js "Business Name"')
    process.exit(1)
  }
  const biz = await prisma.business.findFirst({ where: { name }, include: { numbers: true, leads: true } })
  if (!biz) {
    console.error('No business found with that name.')
    process.exit(1)
  }
  console.log(`Deleting business "${biz.name}" (id ${biz.id}) with ${biz.numbers.length} numbers and ${biz.leads.length} leads...`)
  await prisma.lead.deleteMany({ where: { businessId: biz.id } })
  await prisma.phoneNumber.deleteMany({ where: { businessId: biz.id } })
  await prisma.business.delete({ where: { id: biz.id } })
  console.log('Deleted.')
  await prisma.$disconnect()
}
main().catch(async (e)=>{ console.error(e); await prisma.$disconnect(); process.exit(1) })
