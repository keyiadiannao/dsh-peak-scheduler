/**
 * control.mjs - a tiny control panel with an ON/OFF button for the automatic
 * peak/off-peak mode (auto.mjs).
 *
 *   GET  /            -> control page (button + live status)
 *   GET  /api/status  -> { enabled, tier, autoRunning, queueCount, nextOffPeak }
 *   POST /api/toggle  -> flip config.enabled, start/stop the auto.mjs child
 *
 * This is the "one-click switch" for auto mode: no manual process juggling.
 * Run: node control.mjs config.json   (default port 3280)
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isPeak, nextOffPeakStart, listQueue } from './scheduler.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CFG = path.join(HERE, 'config.json')

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')) } catch { return { enabled: false } }
}
function writeConfig(cfg) { fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2) + '\n', 'utf8') }

let autoChild = null
let autoRunning = false

function startAuto() {
  if (autoRunning) return
  try {
    const node = process.execPath
    autoChild = spawn(node, [path.join(HERE, 'auto.mjs'), CFG], { stdio: 'ignore', detached: false })
    autoRunning = true
    autoChild.on('exit', () => { autoRunning = false; autoChild = null })
  } catch { autoRunning = false }
}
function stopAuto() {
  if (autoChild) { try { autoChild.kill() } catch { /* ignore */ } }
  autoRunning = false
  autoChild = null
}
// sync child state to config on startup
if (readConfig().enabled) startAuto()

function toggle() {
  const cfg = readConfig()
  cfg.enabled = !cfg.enabled
  writeConfig(cfg)
  if (cfg.enabled) startAuto()
  else stopAuto()
  return cfg.enabled
}

function status() {
  const cfg = readConfig()
  return {
    enabled: cfg.enabled,
    tier: isPeak() ? 'peak' : 'off-peak',
    autoRunning,
    queueCount: listQueue().length,
    nextOffPeakAt: nextOffPeakStart().toISOString(),
  }
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>峰谷调度 · 控制面板</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background:#0b1020; color:#e8ecf4; font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
  .wrap { width:100%; max-width:480px; text-align:center; }
  h1 { font-size:16px; color:#7aa2ff; margin-bottom:6px; }
  .sub { color:#7b8499; font-size:12px; margin-bottom:24px; }
  .status { background:#141a2e; border:1px solid #232c47; border-radius:12px; padding:16px; margin-bottom:16px; font-size:13px; color:#aab3c9; }
  .status b { color:#e8ecf4; }
  .btn { display:inline-block; width:100%; padding:18px; border:none; border-radius:12px; font-size:20px; font-weight:700; cursor:pointer; color:#0b0d10; transition:transform .1s; }
  .btn:active { transform:scale(.97); }
  .btn.on { background:#22c55e; }
  .btn.off { background:#4b5563; }
  .note { color:#7b8499; font-size:12px; margin-top:14px; line-height:1.6; }
</style></head><body>
<div class="wrap">
  <h1>峰谷调度 · 自动模式</h1>
  <div class="sub">DeepSeek 峰谷计费 · 空闲时段便宜 50%</div>
  <div class="status" id="status">加载中…</div>
  <button class="btn off" id="btn" onclick="toggle()">—</button>
  <div class="note">开启后：高峰时段自动攒用户消息，空闲时段用 DeepSeek(2x 便宜)整理成任务清单。<br>绝不拦截用户对话，紧急任务不受影响。</div>
</div>
<script>
const $ = (id) => document.getElementById(id)
async function refresh() {
  const s = await (await fetch('/api/status')).json()
  $('status').innerHTML = '当前：<b>' + (s.tier === 'peak' ? '高峰' : '空闲') + '</b> · 队列 <b>' + s.queueCount + '</b> 项 · 自动模式 ' + (s.autoRunning ? '<b style="color:#22c55e">运行中</b>' : '<b>已停止</b>') + (s.tier === 'peak' ? '<br>下一个空闲：' + new Date(s.nextOffPeakAt).toLocaleTimeString('zh-CN') : '')
  const on = s.enabled
  $('btn').textContent = on ? '自动模式：开（点击关闭）' : '自动模式：关（点击开启）'
  $('btn').className = 'btn ' + (on ? 'on' : 'off')
}
async function toggle() {
  await fetch('/api/toggle', { method: 'POST' })
  refresh()
}
refresh()
setInterval(refresh, 3000)
</script>
</body></html>`

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0]
  if (url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(status()))
    return
  }
  if (url === '/api/toggle' && req.method === 'POST') {
    const now = toggle()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ enabled: now }))
    return
  }
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(HTML)
    return
  }
  res.writeHead(404); res.end('not found')
})

const port = 3280
server.listen(port, '127.0.0.1', () => {
  console.log(`[dsh-peak-scheduler/control] http://127.0.0.1:${port}  (auto mode ON/OFF switch)`)
})
process.on('SIGINT', () => { stopAuto(); process.exit(0) })
