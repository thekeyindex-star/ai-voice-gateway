// admin-list-businesses.js
require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const businesses = await prisma.business.findMany({
    include: { numbers: true }
  })
  console.log("\n=== Businesses in DB ===")
  for (const b of businesses) {
    console.log(`ID: ${b.id}`)
    console.log(`Name: ${b.name}`)
    console.log(`Timezone: ${b.timezone}`)
    console.log(`Phone Numbers: ${b.numbers.map(n => n.e164).join(", ") || "(none)"}`)
    console.log("---------------")
  }
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
