/**
 * index.mjs - MCP server exposing the peak/off-peak scheduler as tools.
 *
 * A minimal Model Context Protocol server over stdio (JSON-RPC 2.0, one message
 * per line).  Zero dependencies.  Any MCP client (DeepSeek Harness, Claude,
 * Cursor, etc.) can connect it.
 *
 * Tools:
 *   peak_status  - current price tier + when the next off-peak window starts
 *   defer_task   - enqueue a non-urgent task to run at the next off-peak window
 *   list_queue   - list deferred tasks
 *   get_prices   - DeepSeek V4 time-of-use price table
 *
 * This is advisory and NEVER blocks the user: urgent work (urgency >= 0.5 or a
 * deadline before the next off-peak) runs immediately.
 */
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPeak, nextOffPeakStart, untilOffPeak, currentTier, deferTask, listQueue, beijingHour } from './scheduler.mjs'

// ---- opt-in switch (default OFF) ----
function loadConfig() {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch { return {} }
}
const ENABLED = loadConfig().enabled === true

const PRICES = {
  'deepseek-v4-flash': { offPeak: { inHit: 0.05, inMiss: 1.5, out: 4.5 }, peak: { inHit: 0.10, inMiss: 3.0, out: 9.0 } },
  'deepseek-v4-pro': { offPeak: { inHit: 0.15, inMiss: 4.5, out: 13.5 }, peak: { inHit: 0.30, inMiss: 9.0, out: 27.0 } },
}

const TOOLS = [
  {
    name: 'peak_status',
    description: '当前是否处于 DeepSeek 高峰计费时段，以及下一个空闲时段何时开始（北京时间）。空闲时段价格是高峰的一半。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'defer_task',
    description: '把一个非紧急任务延迟到下一个空闲（便宜）时段执行。若任务紧急或 deadline 早于空闲时段，则建议立即执行（不延迟）。绝不阻碍用户。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '任务描述' },
        deadline: { type: 'string', description: '硬性截止时间（ISO 8601，可选）' },
        urgency: { type: 'number', description: '紧急度 0-1，>=0.5 视为紧急立即执行（默认 0）' },
      },
      required: ['task'],
    },
  },
  {
    name: 'list_queue',
    description: '列出已延迟、尚未到执行时间的任务队列。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_prices',
    description: '返回 DeepSeek V4 峰谷价格表（元/百万 tokens）。',
    inputSchema: { type: 'object', properties: {} },
  },
]

function toolResult(text) {
  return { content: [{ type: 'text', text }] }
}

async function callTool(name, args = {}) {
  const now = new Date()
  switch (name) {
    case 'peak_status': {
      const tier = currentTier(now)
      const next = nextOffPeakStart(now)
      const waitMs = untilOffPeak(now)
      return toolResult(JSON.stringify({
        tier, // 'peak' | 'off-peak'
        isPeak: isPeak(now),
        beijingHour: Number(beijingHour(now).toFixed(2)),
        nextOffPeakAt: next.toISOString(),
        untilOffPeakMs: waitMs,
        untilOffPeakHuman: waitMs === 0 ? '已处于空闲时段' : `${Math.round(waitMs / 60000)} 分钟`,
        note: '空闲时段价格 = 高峰的一半。高峰为北京时间 9:00-12:00、14:00-18:00。',
      }, null, 2))
    }
    case 'defer_task': {
      if (!ENABLED) {
        return toolResult(JSON.stringify({ enabled: false, defer: false, runNow: true, note: '峰谷调度未启用（config.json 的 enabled: false）。任务正常立即执行，不做任何延迟。' }, null, 2))
      }
      const deadline = args.deadline ? new Date(args.deadline).getTime() : null
      const urgency = Number.isFinite(args.urgency) ? args.urgency : 0
      const item = deferTask(args.task, { now, deadline, urgency })
      return toolResult(JSON.stringify({
        ...item,
        runAtISO: new Date(item.runAt).toISOString(),
        advice: item.deferred
          ? `已加入延迟队列，将在空闲时段 ${new Date(item.runAt).toLocaleTimeString('zh-CN')} 执行（省约 50%）`
          : `立即执行（原因：${item.reason}）`,
      }, null, 2))
    }
    case 'list_queue': {
      return toolResult(JSON.stringify({ count: listQueue().length, items: listQueue() }, null, 2))
    }
    case 'get_prices': {
      return toolResult(JSON.stringify({ unit: '元 / 百万 tokens', effective: '2026-08-17 00:00 北京时间', prices: PRICES }, null, 2))
    }
    default:
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  }
}

// ---- stdio JSON-RPC loop -----------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }

  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-peak-scheduler', version: '0.1.0' },
      },
    })
    return
  }
  if (msg.method === 'notifications/initialized') return // no response
  if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } })
    return
  }
  if (msg.method === 'tools/call') {
    try {
      const res = await callTool(msg.params?.name, msg.params?.arguments ?? {})
      send({ jsonrpc: '2.0', id: msg.id, result: res })
    } catch (err) {
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `error: ${err.message}` }], isError: true } })
    }
    return
  }
  if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
})

// keep stdin open; exit cleanly on EOF
rl.on('close', () => process.exit(0))
