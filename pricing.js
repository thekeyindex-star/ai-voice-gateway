// pricing.js — simple pricing engine
const config = require('./pricing.json')

function isOpenAt(date) {
  const days = ['sun','mon','tue','wed','thu','fri','sat']
  const d = new Date(date)
  const day = days[d.getDay()]
  const ranges = config.hours[day] || []
  const hh = d.getHours().toString().padStart(2,'0')
  const mm = d.getMinutes().toString().padStart(2,'0')
  const now = `${hh}:${mm}`
  return ranges.some(r => {
    const [start,end] = r.split('-')
    return now >= start && now <= end
  })
}

function baseRange(service, afterHours) {
  const svc = config.services[service]
  if (!svc) return null
  const key = afterHours ? 'night' : 'day'
  return { min: svc[key][0], max: svc[key][1] }
}

function applyTravel(range, miles) {
  const extra = Math.max(0, miles - config.travel.includedMiles)
  const fee = extra * config.travel.perMileAfter
  return { min: range.min + fee, max: range.max + fee }
}

function applySurcharges(range, opts) {
  let { euro=false, laserCut=false } = opts
  let min = range.min, max = range.max
  if (laserCut) { min += config.services.laser_cut_surcharge; max += config.services.laser_cut_surcharge }
  if (euro)     { min += config.services.euro_surcharge;      max += config.services.euro_surcharge }
  return { min, max }
}

function applyAfterHours(range, afterHours) {
  if (!afterHours) return range
  return { min: range.min + config.afterHoursSurcharge, max: range.max + config.afterHoursSurcharge }
}

function quote({ service, miles=0, afterHours=false, euro=false, laserCut=false }) {
  let r = baseRange(service, afterHours)
  if (!r) return null
  r = applyTravel(r, miles)
  r = applySurcharges(r, { euro, laserCut })
  r = applyAfterHours(r, afterHours)
  return r
}

module.exports = { config, isOpenAt, quote }
