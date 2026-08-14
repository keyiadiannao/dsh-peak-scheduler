/**
 * scheduler.mjs - core peak/off-peak scheduling logic for DeepSeek time-of-use
 * pricing.  Pure functions + a tiny in-memory/persistent defer queue.  No
 * network, no LLM — this is the "when is it cheaper / when should I run this"
 * brain, exposed to an agent as MCP tools.
 *
 * Official schedule (effective 2026-08-17 00:00 Beijing time):
 *   peak    : 09:00–12:00, 14:00–18:00   (Beijing, UTC+8)
 *   off-peak: 00:00–09:00, 12:00–14:00, 18:00–24:00
 *   price   : peak = 2 × off-peak
 *
 * Design principle: this NEVER blocks the user.  It is an advisory deferral
 * layer — the agent (or user) opts in per task.  Urgent work runs immediately.
 */

/** Hour (fractional) in Beijing time (UTC+8). */
export function beijingHour(date = new Date()) {
  const h = date.getUTCHours() + 8
  const m = date.getUTCMinutes() / 60
  return (h % 24) + m
}

/** Is `date` inside a peak window? */
export function isPeak(date = new Date()) {
  const h = beijingHour(date)
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/**
 * Off-peak window boundaries as [startHour, endHour) in Beijing time.
 * Windows: 00-09, 12-14, 18-24.
 */
export const OFF_PEAK_WINDOWS = [
  [0, 9], [12, 14], [18, 24],
]

/** The next off-peak start time (as a Date) strictly after `date`. */
export function nextOffPeakStart(date = new Date()) {
  const h = beijingHour(date)
  const candidates = []
  for (const [s] of OFF_PEAK_WINDOWS) {
    let deltaH = s - h
    if (deltaH <= 0) deltaH += 24
    candidates.push(new Date(date.getTime() + deltaH * 3600 * 1000))
  }
  candidates.sort((a, b) => a.getTime() - b.getTime())
  return candidates[0]
}

/** How many ms until the next off-peak window starts (0 if already off-peak). */
export function untilOffPeak(date = new Date()) {
  if (!isPeak(date)) return 0
  return Math.max(0, nextOffPeakStart(date).getTime() - date.getTime())
}

/**
 * Decide whether a task should be deferred, and if so, when to run it.
 *
 * @param {object} opts
 *   - {Date}    now       current time
 *   - {Date|number|null} deadline  hard deadline (ms epoch or Date); optional
 *   - {number}  urgency   0..1, higher = more urgent (0 = fully deferrable)
 * @returns {object} {defer: boolean, reason: string, runAt: Date|null}
 */
export function planTask({ now = new Date(), deadline = null, urgency = 0 } = {}) {
  const dl = deadline ? new Date(deadline).getTime() : null
  if (urgency >= 0.5) {
    return { defer: false, reason: 'urgent', runAt: now }
  }
  if (!isPeak(now)) {
    return { defer: false, reason: 'off-peak-now', runAt: now }
  }
  const next = nextOffPeakStart(now).getTime()
  if (dl != null && next > dl) {
    return { defer: false, reason: 'deadline-before-offpeak', runAt: now }
  }
  return { defer: true, reason: 'defer-to-offpeak', runAt: new Date(next) }
}

/** Human-readable current price tier for a model's output token price. */
export function currentTier(now = new Date()) {
  return isPeak(now) ? 'peak' : 'off-peak'
}

// ---- tiny defer queue -------------------------------------------------------

const QUEUE = []
let seq = 0

/**
 * Enqueue a deferrable task.
 * @returns {object} the queued item {id, task, runAt, deadline, createdAt}
 */
export function deferTask(task, { now = new Date(), deadline = null, urgency = 0 } = {}) {
  const plan = planTask({ now, deadline, urgency })
  const item = {
    id: ++seq,
    task: String(task || '').slice(0, 500),
    runAt: plan.runAt ? plan.runAt.getTime() : now.getTime(),
    deadline: deadline ? new Date(deadline).getTime() : null,
    createdAt: now.getTime(),
    deferred: plan.defer,
    reason: plan.reason,
  }
  QUEUE.push(item)
  return item
}

/** Items whose scheduled time has arrived (and not yet flushed). */
export function dueItems(now = new Date()) {
  return QUEUE.filter((i) => i.runAt <= now.getTime())
}

/** All queued items (newest first). */
export function listQueue() {
  return [...QUEUE].reverse()
}
