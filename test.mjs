/**
 * test.mjs - unit tests for the scheduler core + MCP round-trip.
 * Run: node test.mjs
 */
import { isPeak, beijingHour, nextOffPeakStart, untilOffPeak, planTask, deferTask, dueItems, currentTier } from './scheduler.mjs'

let pass = 0, fail = 0
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}`) }
}

function at(utcIso) {
  // build a Date from a UTC instant string
  return new Date(utcIso)
}

console.log('--- 时段判断（北京时间 = UTC+8）---')
// UTC 01:00 = 北京 09:00 (peak 开始)
ok(isPeak(at('2026-08-17T01:00:00Z')) === true, 'UTC 01:00 (北京 09:00) 是高峰')
// UTC 02:00 = 北京 10:00 (peak)
ok(isPeak(at('2026-08-17T02:00:00Z')) === true, 'UTC 02:00 (北京 10:00) 是高峰')
// UTC 04:00 = 北京 12:00 (peak 结束 → off-peak)
ok(isPeak(at('2026-08-17T04:00:00Z')) === false, 'UTC 04:00 (北京 12:00) 是空闲(午休)')
// UTC 05:00 = 北京 13:00 (off-peak 午休)
ok(isPeak(at('2026-08-17T05:00:00Z')) === false, 'UTC 05:00 (北京 13:00) 是空闲')
// UTC 06:00 = 北京 14:00 (peak 开始)
ok(isPeak(at('2026-08-17T06:00:00Z')) === true, 'UTC 06:00 (北京 14:00) 是高峰')
// UTC 10:00 = 北京 18:00 (peak 结束)
ok(isPeak(at('2026-08-17T10:00:00Z')) === false, 'UTC 10:00 (北京 18:00) 是空闲')
// UTC 15:00 = 北京 23:00 (off-peak 深夜)
ok(isPeak(at('2026-08-17T15:00:00Z')) === false, 'UTC 15:00 (北京 23:00) 是空闲')

console.log('--- 北京时间换算 ---')
ok(Math.abs(beijingHour(at('2026-08-17T02:30:00Z')) - 10.5) < 0.01, 'beijingHour(UTC 02:30) = 10.5')

console.log('--- 延迟规划 ---')
// 高峰 10:00 北京 → 下一个空闲是 12:00 午休（2 小时后）
const peakNow = at('2026-08-17T02:00:00Z') // 北京 10:00
ok(isPeak(peakNow), '前置: 北京 10:00 是高峰')
const plan = planTask({ now: peakNow, urgency: 0 })
ok(plan.defer === true, '高峰 + 非紧急 → 延迟')
ok(Math.abs(beijingHour(plan.runAt) - 12) < 0.01, `延迟到北京 12:00 午休（实际北京 ${beijingHour(plan.runAt).toFixed(1)}:00）`)

// 紧急任务不延迟
const urgent = planTask({ now: peakNow, urgency: 0.8 })
ok(urgent.defer === false, '紧急任务不延迟')

// deadline 早于空闲 → 立即执行
const tight = planTask({ now: peakNow, deadline: peakNow.getTime() + 60 * 60 * 1000, urgency: 0 }) // 1 小时后 deadline
ok(tight.defer === false && tight.reason === 'deadline-before-offpeak', 'deadline 早于空闲 → 立即执行')

// 空闲时段不延迟
const offPeakNow = at('2026-08-17T05:00:00Z') // 北京 13:00
const offPlan = planTask({ now: offPeakNow, urgency: 0 })
ok(offPlan.defer === false && offPlan.reason === 'off-peak-now', '空闲时段 → 立即执行')

console.log('--- 队列 ---')
const q1 = deferTask('整理历史会话', { now: peakNow, urgency: 0 })
ok(q1.deferred === true, '入队任务标记为 deferred')
ok(dueItems(peakNow).length === 0, '未到执行时间时队列为空(due=0)')
ok(dueItems(new Date(q1.runAt + 1)).length === 1, '到执行时间后 due=1')

console.log('--- 价格档位 ---')
ok(currentTier(peakNow) === 'peak', '高峰档位 = peak')
ok(currentTier(offPeakNow) === 'off-peak', '空闲档位 = off-peak')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
