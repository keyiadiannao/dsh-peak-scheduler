/**
 * auto.mjs - OPT-IN automatic mode (default OFF).
 *
 * When config.enabled === true, this background process watches the current DSH
 * session and:
 *   - during PEAK hours: collects the user's messages into a pending queue
 *     (a copy — it NEVER blocks or alters the live conversation);
 *   - during OFF-PEAK hours: calls DeepSeek (now 2x cheaper) to condense the
 *     collected messages into a task summary, writes summary.json, clears queue.
 *
 * Urgent work is untouched by construction: this is a side observer, not an
 * interceptor.  It never delays or intercepts any user turn.
 *
 * Run: node auto.mjs config.json
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isPeak, beijingHour } from './scheduler.mjs'

const MAGIC = 0xFD2FB528

// ---- zstd frame decoding (ported from dsh-session-persistence-jsonl, MIT) ----
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== MAGIC) return frames
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset); offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictFlag = descriptor & 0x03
    const dictBytes = dictFlag === 3 ? 4 : dictFlag
    const csBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictBytes + csBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3); offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      offset += blockType === 0x01 ? 1 : blockSize
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}
function decodeSessionLog(filePath) {
  if (!fs.existsSync(filePath)) return []
  const buf = fs.readFileSync(filePath)
  let text = ''
  for (const f of scanZstdFrames(buf)) {
    try { text += zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8') } catch { /* torn frame */ }
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* partial */ }
  }
  return events
}
function discoverSessions(root) {
  const out = []
  if (!fs.existsSync(root)) return out
  for (const ws of fs.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const s of fs.readdirSync(path.join(root, ws.name), { withFileTypes: true })) {
      if (!s.isDirectory()) continue
      const log = path.join(root, ws.name, s.name, 'session.jsonl.zstd')
      if (fs.existsSync(log)) out.push({ name: s.name, log, mtime: fs.statSync(log).mtimeMs })
    }
  }
  return out
}
function pickActive(root, explicit = '') {
  if (explicit) return { name: path.basename(explicit), log: path.join(explicit, 'session.jsonl.zstd'), mtime: 0 }
  let best = null
  for (const s of discoverSessions(root)) {
    const ev = decodeSessionLog(s.log)
    let last = s.mtime
    for (const e of ev) if (typeof e.time === 'number' && e.time > last) last = e.time
    if (!best || last > best.time) best = { ...s, time: last }
  }
  return best
}
function userText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (c?.type === 'text' ? c.text : '')).join(' ')
  return ''
}

// ---- DeepSeek client (off-peak condense) ----
function readKey() {
  try {
    const m = fs.readFileSync(path.join(os.homedir(), '.dsh', '.credentials.yaml'), 'utf8').match(/DEEPSEEK_API_KEY:\s*(\S+)/)
    if (m) return m[1]
  } catch { /* ignore */ }
  return process.env.DEEPSEEK_API_KEY || ''
}
async function condense(messages) {
  const key = readKey()
  if (!key) return { error: 'no DeepSeek API key (set DEEPSEEK_API_KEY or ~/.dsh/.credentials.yaml)' }
  const prompt = [
    '你是任务整理助手。下面是用户在高峰时段提出的一组消息（可能是多条、也可能重复）。',
    '请把它们整理成一份简洁的中文任务清单：合并重复、按主题归类、每条一个可执行项。',
    '只输出 JSON: {"tasks": ["...", "..."], "summary": "一句话总结"}',
    '',
    '用户消息（按时间顺序）:',
    ...messages.map((m, i) => `${i + 1}. ${m}`),
  ].join('\n')
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      reasoning_effort: 'none',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!res.ok) return { error: `api:${res.status}` }
  const j = await res.json()
  const raw = j.choices?.[0]?.message?.content ?? '{}'
  try { return JSON.parse(String(raw).replace(/```json|```/g, '').trim()) } catch { return { raw } }
}

// ---- main loop ----
function loadConfig(cfgPath) {
  const raw = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  return {
    enabled: raw.enabled === true,
    pollMs: raw.pollMs ?? 30000,
    sessionsRoot: (raw.sessionsRoot ?? path.join(os.homedir(), '.dsh', 'sessions')).replace(/^~/, os.homedir()),
    sessionDir: raw.sessionDir ?? '',
    summaryFile: raw.summaryFile ?? 'summary.json',
  }
}

async function main() {
  const cfgPath = process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json')
  const cfg = loadConfig(cfgPath)
  if (!cfg.enabled) {
    console.log('[dsh-peak-scheduler/auto] disabled (config.enabled=false). Nothing to do. Set enabled:true to activate.')
    return
  }
  console.log('[dsh-peak-scheduler/auto] enabled. Watching session; peak hours → collect, off-peak → condense.')
  const pendingFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pending.jsonl')
  const seen = new Set() // dedupe by message text
  let lastFlush = 0

  const tick = async () => {
    const now = new Date()
    const peak = isPeak(now)
    const picked = pickActive(cfg.sessionsRoot, cfg.sessionDir)
    if (!picked) return
    const events = decodeSessionLog(picked.log)

    // collect user messages
    const msgs = []
    for (const e of events) {
      if (e.type === 'user/message') {
        const t = userText(e.data?.content).trim()
        if (t && !t.startsWith('<system-reminder>') && !seen.has(t)) { seen.add(t); msgs.push(t) }
      }
    }

    if (peak) {
      if (msgs.length) {
        const appended = msgs.map((t) => JSON.stringify({ t, at: now.toISOString() })).join('\n') + '\n'
        fs.appendFileSync(pendingFile, appended, 'utf8')
        console.log(`[auto] peak ${beijingHour(now).toFixed(1)}h: collected ${msgs.length} message(s)`)
      } else {
        // quiet
      }
    } else {
      // off-peak: condense pending
      if (fs.existsSync(pendingFile)) {
        const pending = fs.readFileSync(pendingFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        if (pending.length && now.getTime() - lastFlush > 60000) {
          console.log(`[auto] off-peak ${beijingHour(now).toFixed(1)}h: condensing ${pending.length} message(s) ...`)
          const result = await condense(pending.map((p) => p.t))
          if (result.error) { console.log(`[auto] condense failed: ${result.error}`); return }
          fs.writeFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), cfg.summaryFile), JSON.stringify({ ...result, condensedAt: now.toISOString(), nMessages: pending.length }, null, 2), 'utf8')
          fs.writeFileSync(pendingFile, '', 'utf8') // clear queue
          lastFlush = now.getTime()
          console.log(`[auto] wrote ${cfg.summaryFile} (${result.tasks?.length ?? 0} tasks)`)
        }
      }
    }
  }

  await tick()
  const timer = setInterval(tick, cfg.pollMs)
  // NOTE: do NOT unref — standalone watcher; the interval must keep the event
  // loop alive so the process stays running.
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
