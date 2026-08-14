# dsh-peak-scheduler

[![CI](https://img.shields.io/github/actions/workflow/status/keyiadiannao/dsh-peak-scheduler/ci.yml?branch=master)](https://github.com/keyiadiannao/dsh-peak-scheduler/actions)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-blue)](https://modelcontextprotocol.io)

一个 **DeepSeek 峰谷计费的任务调度器**(MCP server)。它让 agent 把**非紧急**任务延迟到
空闲(便宜)时段执行,省约 **50%**,同时**绝不阻碍用户**。

> 背景:DeepSeek API 自 **2026-08-17 00:00(北京时间)** 起实行峰谷定价,高峰时段价格是
> 空闲时段的 **2 倍**。

## 官方峰谷时段(北京时间)

| 时段 | 时间 |
|---|---|
| **高峰** | 09:00–12:00、14:00–18:00 |
| **空闲** | 00:00–09:00、12:00–14:00、18:00–24:00 |

价格表(`get_prices` 工具可查,元/百万 tokens):

| 模型 | 档位 | 输出价格 |
|---|---|---|
| deepseek-v4-flash | 空闲 / 高峰 | 4.5 / 9.0 |
| deepseek-v4-pro | 空闲 / 高峰 | 13.5 / 27.0 |

## 设计原则:绝不阻碍用户

这是一个**顾问式延迟层**,不是拦截器:

- 用户/agent **主动**决定某个任务"可以延迟"才调用 `defer_task`;
- 紧急任务(`urgency >= 0.5`)或 deadline 早于下一个空闲时段的任务,**立即执行**;
- 它只提供"现在贵,建议推迟到 X 点(省 50%)"的建议 + 一个延迟队列,从不拦截任何输入。

## 显式开关(默认关)

整个功能默认**关闭**。`config.json` 的 `enabled` 控制:

```json
{ "enabled": false }
```

- `enabled: false`(默认)→ `defer_task` 返回"未启用,任务正常立即执行",功能等于不存在;
- `enabled: true` → 才进入峰谷判断。

## 自动模式(可选,旁路观察者)

`auto.mjs` 是**自动代理**形态:启用后,后台进程**旁路**观察会话,不拦截、不改变任何对话:

- **高峰时段**:把用户消息**攒**进 `pending.jsonl`(一份副本,对话照常);
- **空闲时段**:用 DeepSeek(此时 2 倍便宜)把攒的消息**整理**成任务清单,写 `summary.json`,清空队列。

### 一键开关(控制面板)

不用手动跑 `auto.mjs`,有一个带**开关按钮**的控制面板:

```bat
start-control.bat          # 或: node control.mjs config.json
```

打开 http://127.0.0.1:3280 ,一个大按钮:**自动模式 开/关**。点击即切换 `config.enabled`
并自动启动/停止 `auto.mjs` 后台进程,状态实时显示(当前峰/谷 + 队列 + 是否运行中)。

紧急任务天然不受影响——因为它是旁路观察者,从不延迟或拦截任何用户 turn。

## 工具

| 工具 | 作用 |
|---|---|
| `peak_status` | 当前是否高峰 + 下一个空闲时段何时开始 |
| `defer_task` | 延迟一个非紧急任务(task / deadline / urgency) |
| `list_queue` | 列出延迟队列 |
| `get_prices` | 峰谷价格表 |

## 运行(作为 MCP server)

零依赖,标准 MCP stdio 协议,任何 MCP 客户端可接:

```bash
node index.mjs
```

在 MCP 客户端配置里指向 `node index.mjs`(工作目录为本目录)。例如 Claude Desktop:

```json
{
  "mcpServers": {
    "dsh-peak-scheduler": {
      "command": "node",
      "args": ["D:/path/to/dsh-peak-scheduler/index.mjs"]
    }
  }
}
```

## 核心逻辑

```
scheduler.mjs
  isPeak(date)          → 北京时间 9-12 / 14-18 判峰谷
  nextOffPeakStart(date) → 下一个空闲时段起点(午休/傍晚/深夜/清晨)
  planTask({deadline, urgency}) → {defer, runAt, reason}
    紧急(urgency>=0.5)        → 立即
    空闲时段                  → 立即
    高峰 + deadline 早于空闲   → 立即
    否则                      → 延迟到下一个空闲时段
```

## 诚实局限

- **只覆盖"可延迟"任务**:它不能替你判断哪些任务紧急、哪些能等——这需要 agent/用户显式决策
  (通过 `urgency` 参数,或决定是否调用 `defer_task`);
- **时区硬编码北京时间**:峰谷以北京时间为准(DeepSeek 官方口径),不做本地时区换算;
- **自动模式是"旁路观察者"**:`auto.mjs` 高峰攒消息、空闲整理成清单,但它**不会真正替你执行**
  那些任务——产出的是一份建议清单,执行仍由 agent 决定;
- **调度↔经验库的整合未接**:设计上是"Scheduler 管 when/if,KB 管知识"(注入 `AdviceProvider`
  或事件总线),目前两者相互独立,没有组合闭环;
- **定价表是快照**:`get_prices` 的价格/时段硬编码自 2026-08-17 官方公告,官方调整需手动更新。

## 测试

`node test.mjs`(19 项断言,含时段边界、时区换算、deadline、队列)。

## License

MIT
