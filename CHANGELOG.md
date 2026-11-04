# 变更记录

本项目**从未对外发布**，版本号仅用于标记本机迭代里程碑。
`4.0.0` / `4.0.1` 曾是我的内部里程碑编号（"第 4 代架构"），现已规范为 `0.x`：
`0.x` 表示尚未稳定——插件依赖逆向出来的私有协议，上游一变就可能失效。

---

## 0.11.1 — 2026-11-04

### 修复：图片输入不可用（`UNSUPPORTED_CONTENT`）

**现象**：选中支持视觉的 TeleAgent 模型时，只要消息带图片，本轮就失败：

```text
pi-ai image input requires the durable attachment service
code: UNSUPPORTED_CONTENT
```

**根因**：插件构造 `PiAiAdapter` 时只传了 `profiles / auth / resolveApiKey`，
没有像官方 `dsh-llm-pi-ai` / `dsh-llm-deepseek` 那样透传宿主的**持久附件服务**
（`resolveAttachments` / `resolveImageAccess`）。pi-ai 适配器在发请求前检查到
图片却没有该服务，就直接拒绝，上游根本收不到请求。

**修法**（`lib/attachments.js` / `lib/index.js`）

- 新增 `createAttachmentDeps(ctx, resolveImageAttachmentAccess)`：
  - `resolveAttachments: () => ctx.get('attachments')`
  - `resolveImageAccess`: 用 `ctx.get('fs')?.processPathFromHostPath` 映射宿主路径后交给
    `@deepseek-ai/dsh-llm` 的 `resolveImageAttachmentAccess`
- 构造 `PiAiAdapter` 时展开这两个依赖；没有附件服务的精简 profile 仍保持原行为（软探测）

**验证**：新增 4 项单测（服务透传、路径映射、缺失服务降级、ctx.get 抛错降级）；
`npm test` 231 全绿，`npm run verify` 6 套件全绿。

---

## 0.11.0 — 2026-11-02

### 开源发布

- 仓库公开：<https://github.com/anbulang/dsh-connect-teleagent>（MIT）
- **敏感信息清理**：不再提交上游网关 apiKey（改为环境变量 `TELEAGENT_API_KEY`
  或本地 `local.secrets.json`）；账号 ID、账号昵称、个人路径、余额样例等一并脱敏
- 移除仅用于个人发布/演示的资产：文章草稿与截图、设置卡片预览 HTML、
  客户端工具清单转储（`docs/official-tools.json`）等
- README 增加「上游 apiKey 配置」「免责声明」两节

---

## 0.10.7 — 2026-11-02

### 修复：DSH 退出留下孤儿内核，内核还会「无人值守」继续跑模型

日志实证（2026-11-01 22:56:57，DSH 退出瞬间）：插件 dispose 没被执行，
内核变成孤儿（ppid=1）；它把挂起的 MCP 工具调用判错后**继续自己调模型**、
还执行了内核内置 bash，22:57:45 才把上一轮跑完 —— 这是一段**没有界面的真实上游流量**。
更早的几次重启也留下了孤儿，本机累计 6 个（最早 10-28）。

**修法**（`lib/kernel.js` / `lib/index.js`）

1. `startKernel` 写 `kernel.pid`；`stop()` 核对 pid 后删除
2. 新增 `reapStaleKernels()`：启动内核前按「pidfile + 自家二进制且 ppid=1」扫描，
   `SIGTERM` → 等待 → `SIGKILL`，带日志；`boot()` 里先清理再拉起
3. 宿主退出兜底：注册 `process.on('exit')`；宿主自己没有信号处理器时，
   额外接 `SIGTERM` / `SIGINT` / `SIGHUP`（停内核后按标准码退出），
   `cleanup()` 里移除监听

**验证**

- 真机清理：一次清掉 6 个孤儿内核（2840/14699/26556/30437/35469/42077），只剩当前内核
- 新增单测：只清理 ppid=1 的自家内核，不误杀「有父进程」或「其它二进制」的进程，并清掉 pidfile
- `npm test` 227 全绿；`npm run verify` 6 套件全绿

**已知限制**：如果 DSH 被 `SIGKILL` 硬杀，宿主来不及跑任何处理器，仍可能留孤儿；
下一次启动会自动清理，但「退出到下次启动」之间内核仍可能继续跑完当前这一轮。

---

## 0.10.6 — 2026-11-01

### 修复：工具调用后整轮挂起 5 分钟，重试报 `session is busy`（会话卡死）

线上实测（Greeting 会话）：用户问「找下目录里与齐鲁农云相关的文件」，模型发起
`dsh_glob` / `dsh_grep` 后整轮**没有任何输出**；约 5 分钟后宿主超时重试，
内核日志出现 `prompt_async: session ...: session is busy`，会话彻底卡死。

**根因 1：等事件时不复查工具桥。**
内核在等 MCP 工具结果期间**不再发任何事件**。插件原来只在读到事件后才检查
`callWatcher`；而内核是「发出 tool part → 安全审查（实测 ~250ms）→ 才真正调用
MCP 工具」，插件很容易在审查窗口里已经阻塞在 `reader.read()` 上，永远等不到下一次事件。

**根因 2：失败/中止后没有把内核从"等工具结果"里救出来。**
宿主超时断开后，插件既没有 `cancelSuspended`，也没有 abort 内核会话；
内核那一轮永远停在等工具结果，会话永远 busy。

**修法**（`lib/kernel.js`）

- `consumeEvents` 边等事件边轮询：最多 150ms 复查一次 `callWatcher`
- 处理 `session.error` 事件：立刻收尾并抛出内核错误，不再干等 idle
- 本轮失败/被中止：`cancelSuspended` + 清空 pending + `POST /session/:id/abort`，
  并丢掉会话映射（下一轮按完整历史重建内核会话）
- 续跑守卫：`awaiting` 但没有新的 tool 结果（用户中断/宿主超时）→ 放弃旧会话重开，
  而不是再发一次空工具结果

**验证**

- 真内核实测 `POST /session/:id/abort` → `200 true`（幂等，空闲会话也可调用）
- 新增 4 项回归（无事件时轮询唤醒、`session.error` 收尾、续跑无结果时重开会话、
  流式失败时取消挂起并 abort）
- `npm test` 223 全绿；`npm run verify` 6 套件全绿

### 修复：思维链（reasoning）没有下发，聊天里看不到思考过程

**根因**：kernel 模式只处理 `part.type === 'text'`，把内核存下来的 `reasoning` part
直接丢掉了 —— DSH 收不到 `reasoning_content`，自然没有「思考过程」可渲染
（直连模式还能看到，属于 kernel 改造的回归）。

**修法**（`lib/kernel.js`）

- `consumeEvents` 把 `reasoning` part 按 part.id 累积全文转增量，通过 `onReasoningDelta` 暴露
- 流式：增量以 `delta.reasoning_content` 下发（pi-ai 的 openai-completions 会解析成 thinking 块）
- 非流式：assistant 消息带 `reasoning_content`
- 工具调用后的续跑同样透传思维链

**验证**：真内核 + 假上游（上游吐 `reasoning_content`）→ 两段思维链原样透传，
非流式 `reasoning_content` 完整；`npm test` 226 全绿（kernel 47 项），`npm run verify` 6 套件全绿。

> DSH 的「工作步骤展示」（简洁 / 标准 / 详细 / 完全展开）现在会同时作用于
> 工具步骤与思考过程；之前工具调用卡死、思维链缺失，所以怎么设置都看不到中间过程。

---

## 0.10.5 — 2026-10-28

### 修复：回复开头回显整段提示词（18 KB 系统提示词被当成助手输出）

线上表现：一句「hi」的回复以整段系统提示词开头 ——

```
You are an AI agent powered by DeepSeek Harness.
...
用户：hi
用户：Current runtime context...
Greeting你好！我是星辰超级智能体（TeleAgent）...
```

模型真正的回答只有最后那句 `Greeting…`（上游 `completion_tokens` 仅 338），
说明前面那一大段**不是模型输出的**，是我们自己灌进去的。

**根因**：内核会把**本轮用户消息**也作为 `message.part.updated` 发回来
（`role: "user"`），而 `consumeEvents` 只看 `part.messageID`、不看角色，
把这条 part 当成助手 delta 转发给了 DSH。

同类问题还有 `/event` 是**全局**流：两个 session 同时跑（正文 + 标题生成）时，
两边事件会出现在同一条流里 —— 不按 `sessionID` 过滤就会串台。

**修法**（`lib/kernel.js` 的 `consumeEvents`）

1. `message.updated` 维护本会话 `messageID → role` 映射，只把 **assistant** 的 part 计入正文
2. `message.part.updated` 先按 `part.sessionID === sessionID` 过滤；角色未判明时暂存，
   等 `message.updated` 到了再决定补发还是丢弃（兼容续跑时 part 先到的情况）
3. 兜底：极端情况下（内核没发 `message.updated`）只补发**不是本轮提示词**的暂存文本

**验证**：本地拉起真内核 + 假上游（provider `baseURL` 指向 `127.0.0.1`，**零真实流量**）复现：

| 场景 | 修复前 | 修复后 |
|---|---|---|
| 普通一轮（流式） | `系统提示词 + 用户消息 + 回答` | `回答` |
| 非流式 | 同上 | `回答` |
| 两个会话并发 | 事件互相串台 | 各自只拿到自己的答案 |
| 工具调用后续跑 | — | `最终答案`（无回显） |

回归测试 +4（用户消息 part 不回显、SSE 不混入提示词、跨会话 part 被忽略、
part 先于 `message.updated` 时暂存补发）；并修正 `test-shim-shape.mjs` 里
迁移前遗留的绝对路径，`npm run verify` 因此重新可跑（6 套件全绿）。

**已知限制**：会话本身仍以「system + 对话折叠成一段用户文本」的方式送进内核
（内核 `prompt_async` 的 `system` 字段实测只接受字符串、且会追加到内核自带系统提示词后），
本轮只修回显，不改提示词编码方式。

---

## 0.10.4 — 2026-10-28

### 修复：`Cannot read properties of null (reading 'setTools')`（两个原因叠在一起）

> 版本说明：本节合并记录 0.10.3（判空）与 0.10.4（初始化顺序）两个修复；
> 0.10.4 是发布时的版本号。

线上表现：**每条消息都失败**，返回

```
502 {"message":"upstream: {\"error\":{\"message\":\"Cannot read properties of null (reading 'setTools')\"...}}"}
```

**根因**：判空写错。

```js
if (bridge !== undefined && ...)   // bridge 是 null 时仍然通过 → bridge.setTools 崩
```

工具桥创建失败时宿主会传 `null`（不是 `undefined`），这个判断挡不住。

**修法**

1. 判空改成 `if (bridge && ...)`
2. 工具桥相关操作整段加 `try/catch`：桥坏了**本轮降级为纯文本**，不让整条对话失败

**但还有第二个原因，才是真凶**：初始化顺序。

```js
kernelTransport = createKernelTransport({ ..., bridge: toolBridge })  // ← 此时 toolBridge 还是 null
toolBridge = await createMcpBridge(...)                               // ← 桥在这之后才创建
```

transport 拿到的是**创建瞬间的快照**，之后无论如何都拿不到桥 → 永远 null。
（日志里"工具桥已挂载"是成功的，所以只看启动日志会以为桥没问题。）

修法：改成 **getter 延迟取** —— `getBridge: () => toolBridge`，
transport 每次用桥时才去取当前值。

**测试**：新增 4 项回归——`bridge: null` 的非流式/流式、桥抛错降级、
以及"创建时桥不存在、稍后建好仍能被同一 transport 使用"。

---

## 0.10.2 — 2026-10-28

### kernel 模式工具调用：真机验证通过（五轮迭代）

用最新账号（`v1_public_2100000000000000000`，未封）跑通了完整闭环，**全程未修改 TeleAgent 系统提示词**。

**真机结果**

```
① 模型请求工具 → dsh_bash {"command":"echo hi"}  → 翻译成 OpenAI tool_call
② 回灌工具结果 "hi" → 内核续跑 → 最终回答：
   "已执行 echo hi，输出结果为：hi，命令执行成功（ok: true）。"
```

**过程中修的四个真问题**（都只能靠真机发现）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 第二轮 `session is busy` | 我们只断开了**自己**的事件流，内核那一轮还在跑 | 改为**挂起** MCP 调用，让内核阻塞等结果 |
| 2 | 续跑回复为空 | 内核不会再发 `message.updated`，我们拿不到 messageID | 从 `part.messageID` 反推 |
| 3 | 续跑仍为空（`completion_tokens=51`） | 最终答案在**新的** assistant 消息里，我们锁死了第一条 | 改为按 messageID 跟踪，取最后一条 |
| 4 | 重启后内核起不来 | 固定端口 47823 被上一条**孤儿内核**占着 | 改为自动选空闲端口（`pickFreePort`） |

第 4 条尤其值得记：DSH 硬重启不会执行 `apply()` 的清理，旧内核会带着端口变成孤儿。

**新增测试**：bridge 挂起/放行/取消（3 项）、多消息取最后一条（1 项）。
`npm run verify`：211 单测 + 6 套件全绿，且跑完无残留内核进程。

---

## 0.10.1 — 2026-10-28

### 修复：MCP 工具注册是异步的，第一轮可能拿不到工具

本地端到端校验发现：`POST /mcp` 返回 200 后，注册表**不会立刻**出现 `dsh_*`：

```
第 1 次查询：总数 31，我们的 0
第 2 次查询（+700ms）：总数 32，我们的 1  dsh_bash
```

而 `kernel.js` 挂载完就立刻发 prompt —— 第一轮模型很可能看不到任何工具
（工具定义了但还没生效）。这在真实使用里表现为"第一次调用工具失败，第二次才正常"。

**修复**

- `mcp-bridge` 新增 `waitForRegistration(kernel, {expected, timeoutMs})`：轮询注册表直到
  期望数量的 `dsh_*` 出现（默认最多等 4 秒）
- `kernel.js` 在 `mount()`（含强制重挂）之后先等注册完成，再发 prompt

### 新增：可重复的本地端到端校验

`test-kernel-mcp.mjs`（`npm run test:mcp`）—— **不起任何模型请求**：

```
✓ 内核拉起并 health 通过
✓ 本地 MCP 服务启动
✓ MCP 挂载到内核
✓ DSH 工具进入内核注册表（dsh_bash,dsh_read）
✓ 内核内置工具被关闭（31 个）
✓ tools/call 返回"已延迟"而不是执行结果
✓ 调用被记录 / 参数原样保留
✓ 可翻译成 OpenAI tool_calls
```

### 新增测试：tool_calls 翻译路径（原提交缺这块）

- 非流式：拦截到调用 → `finish_reason: "tool_calls"`、`content: null`、`tool_calls[0].id` 形如 `call_…`
- 流式：产出 `tool_calls` chunk、以 `finish_reason: "tool_calls"` 收尾、含 `[DONE]`
- 无工具请求：完全不碰桥，纯文本路径不受影响

---

## 0.10.1 — 2026-10-28

### 请求级比对：把 kernel 请求对齐到官方客户端

用户要求"充分比对真实请求和插件请求后再测试"。做法：把内核的 provider `baseURL`
指向**本地 mock 上游**，抓内核真正发出的请求体与请求头（零真实流量），逐项比对。

**比对发现的 3 处差异 → 已修**

| 维度 | 官方客户端 | 我们（修复前） | 修复 |
|---|---|---|---|
| `x-teleai-client-type` | `desktop` | **缺失** | 补 `OPENCODE_CLIENT=desktop` |
| 工具数量 | **21** | 27 | 补 `CLIENT_DISABLED_TOOLS`：客户端默认禁用表 + `read/write/edit/multiedit/glob/grep` |
| 请求体大小 | ~43–50KB | 58.6KB | 随工具数回落到 48.6KB |

`CLIENT_DISABLED_TOOLS` 里那 6 个文件类工具是**实测差集**（官方 21 个工具里没有它们）。

**对齐后的抓包结果**

```
tools 数量: 21  ← 与官方一致（含 bash/online_search/webfetch/memory_*/skill_*/task…）
persona 长度: 5029
请求体: 48,653 B
请求头: x-teleai-client-type=desktop、x-teleai-root-session-id、x-teleai-run-unit-type、x-superagent-*
```

**真实测试（最新账号，仅一次最小请求）**

```
账号 v1_public_2100000000000000000
HTTP 200 · 回复「收到」 · usage: 12186 prompt / 38 completion
```

即：kernel 传输在真实账号上**可用**，且请求形态已尽量贴近客户端。

---

## 0.10.0 — 2026-10-28

### 新增：kernel 模式下支持工具调用（MCP 桥）

用户要求**不要改 TeleAgent 的系统提示词**（改了会让请求特征变化，有封号风险）。
所以放弃"把工具目录塞进提示词"的方案，改走内核**原生 MCP** —— 客户端自己也在用 MCP，
这条路不改变请求身份。

#### 实测确认的内核契约（全部本地验证，未发模型请求）

| 事项 | 结论 |
|---|---|
| 运行时挂载 | `POST /mcp { name, config:{ type:'remote', url } }` → 200，内核随即 `initialize` + `tools/list` |
| 工具命名 | `<服务器名>_<工具名>`，如 `dsh` + `bash` → **`dsh_bash`** |
| 注册表查询 | `GET /experimental/tool/ids`、`GET /experimental/tool` |
| 动态更新 | `notifications/tools/list_changed` **不生效**（list 只调 1 次）；**重新 POST /mcp 会重新拉取**（list→2，注册表同步更新） |

#### 实现

- `lib/mcp-server.js`：最小 Streamable HTTP MCP 服务端（initialize / tools/list / tools/call / ping + SSE 通道）
- `lib/mcp-bridge.js`：把 DSH 的工具同步给内核；拦截 `tools/call`（**不执行**，记录后返回占位）、
  生成"关闭内核内置工具"的开关（实测关掉 31 个）、把调用翻译成 OpenAI `tool_calls`
- `lib/kernel.js`：每轮请求前同步工具集并（变化时）重新挂载；读到工具调用立刻中断本轮，
  流式返回 `finish_reason: "tool_calls"`；工具结果在下一轮以文本 part 回灌
- 内核重启后自动重挂 MCP

#### 验证（本地，无模型请求）

```
DSH 工具 5 个 → 内核注册表: ["dsh_bash","dsh_read","dsh_write","dsh_grep","dsh_webfetch"]
内置工具被关闭: 31 个
模拟内核调用 dsh_bash → 桥记录 {"tool":"bash","args":{"command":"ls"}}
```

#### 尚未验证（需要可用账号）

- 内核是否接受 `tools` 开关语义（关掉内置工具）
- 中断回合后内核会话继续对话的稳定性
- 模型是否真的按结构化形式调用 MCP 工具（而非回文本）

这三项都是"没有可用账号时无法验证"的部分，代码按文档写、有单测覆盖。

---

## 0.9.6 — 2026-10-28

### 修复：kernel 模式下插件"明显不对"

从内核日志看到的真实行为：

```
[perm] tool=memory_search   → 内核在查它自己的记忆
[perm] tool=memory_get      → 读 USER.md / MEMORY.md（文件不存在，报错）
[perm] tool=question        → 还会反问用户问题
tool_instruction_review × 4 → 每次工具调用又触发一轮额外的模型审查
```

也就是说：**我们发过去的是一段文本，回来的却是一个 agent 跑完一整轮的结果**。

**两条根因**

1. **工具没关干净**：早期只 deny 了 `bash/read/write/edit/glob/grep/todowrite/todoread/webfetch`，
   而内核还有 `memory_get`、`memory_search`、`question`、`skill`、`task`、`lsp`… 共 29 个。
   没 deny 的照常执行，于是对话里混进工具噪音，`question` 甚至会卡住等用户输入。
2. **结构性与 DSH 不兼容**：kernel 的 `prompt_async` 没有 `tools` 参数，
   我们也无法把 kernel 产生的 tool 事件转成 OpenAI 的 `tool_calls`。
   **DSH 自己的工具在 kernel 模式下根本不会被调用** —— 这是能力缺失，不是 bug。

**本次改动**

- `KERNEL_TOOLS` 扩到 29 个（含记忆、question、skill、task、lsp、imagegen 等），默认全部 deny
- `status.transport.warning` 明确写出：
  「kernel 模式不支持 DSH 工具调用；需要工具请把配置改成 transport: "direct"」
- 卡片「模型」栏与诊断栏都会显示这条限制

**这不能靠改代码变成"纯对话模型"**：kernel 是 agent 运行时，人格串、技能、记忆注入都在它内部。
所以 kernel 模式只适合"纯问答"，需要工具时应该用 `direct`。

---

## 0.9.5 — 2026-10-28

### 修复：删除账号报「目标账号没有可用的 token.json」

这个报错**来自 `switchAccount`，不是删除逻辑**。原因是**宿主还在跑旧代码**：

- DSH 进程 11:19 启动 → 加载的是当时的插件版本
- 删除功能 12:51 才写完 → 只在磁盘上，宿主没重新加载
- 旧路由没有 `action: 'delete'` 分支，于是把 POST 当成「切换账号」处理
- `switchAccount` 对一个 `no_token` 账号返回「目标账号没有可用的 token.json」

前端刷新能拿到新的删除按钮，宿主路由却还是旧的 —— 两者版本不一致时才出现这种"按钮在、功能不在"的状态。

**为什么不是重启就完事**：这类错会把用户引向错误方向（去登录一个本来就要删的账号）。
所以做了三处改进，让"宿主版本不一致"能被识别：

1. **能力集**：`/status` 新增 `capabilities`（如 `deleteAccount: true`）。
   客户端据此判断按钮是否真的可用；宿主不支持时按钮禁用并提示
   「当前宿主仍是旧版本：重启 DeepSeek Harness 后删除才可用」。
2. **未知 action 明确报错**：`POST /accounts` 收到不认识的 `action` 返回
   `400 未知操作：xxx`，而不是静默当成切换账号。
3. **错误翻译**：删除失败且原因里带 `token.json` 时，客户端直接提示
   「当前宿主仍在运行旧版本（插件已更新但 DSH 未重启）：请重启后重试」。

**测试**：路由新增「能力集存在」「未知 action 返回 400」两项断言。

> 用法提醒：改完插件**必须重启 DSH**，前端刷新只会重新加载客户端代码，不会重新加载宿主插件。

---

## 0.9.4 — 2026-10-28

### 修复：发消息报 `502 ECONNREFUSED`（插件根本没启动成功）

用户发消息报：

```
502 {"message":"上游连接中断（TypeError ← ECONNREFUSED）","code":"upstream_connection"}
```

看起来像网络问题，实际是**插件 boot 阶段就崩了**：

```
[boot 开始]
[boot 失败] Directory import '.../@earendil-works/pi-ai/api/openai-completions.lazy'
            is not supported resolving ES modules
            Did you mean to import ".../openai-completions.lazy/index.js"?
```

**根因**：DSH 在临时沙箱（`…/T/te-harness/`）里用**桩包**提供 pi-ai，
而桩包的 `api/openai-completions.lazy` 是个**目录**（只有 `index.js`，没有 exports 映射）。
Node 的 ESM 不支持目录导入 → `apply()` 抛错 → **shim 从未启动** →
宿主调用一个不存在的端口，于是 `ECONNREFUSED`。

**修复**

1. 新增 `lib/pi-ai-loader.js`：按「标准子路径 → `/index.js` → 主包上的同名导出」依次尝试，
   全部失败时报错里列出每个候选的真实原因（可诊断）
2. 内核**失联自愈**：请求遇到 `ECONNREFUSED` 时自动重启内核并重试一次
   （之前内核一旦挂掉，只能重启 DSH）
3. 内核**就绪等待**：transport 发请求前先等 `waitReady`，消除开机头几秒的假失败
4. `transport.chat/chatStream` 把 `prepare()`（建会话等）的异常也纳入错误映射，
   不再裸抛给 shim

**验证**（在**完全复刻沙箱布局**的桩环境里跑 `test-status-route.mjs`）：

```
boot 开始 → 运行时装依赖已加载 → kernel 已拉起 {"pid":81486}
✓ 已注册 7 条路由   ✓ GET status 返回 200
```

即：这条链路（DSH → 插件 → 内核）重新打通。**未对该账号发起任何模型请求**。

**测试**：新增 `test/loader.test.js` 6 项（候选顺序、目录导入回退、主包兜底、全失败诊断）
与 2 项自愈测试。

### 顺带修：`apply()` 不返回 disposer 导致内核泄漏

清理逻辑只注册在 `ctx.on('dispose')` 上。宿主/测试如果不触发那个事件，
插件拉起的 kernel 就变成孤儿进程（实测跑完测试留下过 2 个 pid）。

现在 `apply()` **同时返回 cleanup 函数**（幂等），并等内核真正退出（最多 3 秒）。
验证：`npm run verify` 跑完 `pgrep` 无残留内核。

---

## 0.9.3 — 2026-10-28

### 新增：账号池支持删除账号

卡片「账号」栏的本机账号列表里，每个非当前账号多了「删除」按钮（两步确认）。
命令行同样支持：

```bash
dsh-connect-teleagent accounts --delete=<scope> --dry-run          # 预演
dsh-connect-teleagent accounts --delete=<scope> --purge            # 删除（移入回收站）
```

**两种模式**

| 模式 | 行为 |
|---|---|
| `logout`（默认） | 只删 `<scope>/app-auth/token.json`，账号目录与个人数据全部保留；列表里变成 `no_token` |
| `purge` | 把 `users/<scope>` 与 `Partitions/owner%3A<scope>` **移动**到 `~/.dsh-teleagent-trash/<时间戳>-<scope>/`，账号从列表消失 |

`purge` 用**移动**而不是删除：技能、`USER.md`、记忆、日志原样留在回收站里，随时可以搬回来。

**三重保护**

1. **拒绝删除当前账号** —— 否则 `current-owner.json` 会指向不存在的账号，桌面端启动就坏
2. **桌面端运行中拒绝** —— 它持有 cookie 库，且退出时可能把凭据写回来
3. **`--dry-run` 一个文件都不动**，并列出将要删除的绝对路径

**界面**：删除按钮先变成「确认删除」，第二次点击才执行；
执行后提示「已删除（移入回收站，可恢复）」，并刷新列表。

**接口**：`POST /plugins/dsh-connect-teleagent/accounts`
`{ action: 'delete', scope, mode: 'purge'|'logout', dryRun? }`；
`GET` 的每个账号新增 `canDelete` 标记（当前账号与桌面端运行时为 false）。

**测试**：新增 6 项（摘登录态保留个人数据 / purge 移入回收站并可恢复 / 拒绝当前账号 /
拒绝运行中 / dry-run 不动文件 / 不存在的账号），路由测试 4 项，渲染测试补删除按钮断言。

---

## 0.9.2 — 2026-10-28

### 修复：插件配置页不再展示 README

用户反馈配置页被整篇 README 占满。上一版错误地**压缩了 README** —— README 应该保持原样，
要删的是**详情面板里的那份渲染**。

**宿主机制**（从 DSH 的 `plugin-manager` 文档学到）：

插件详情文档按顺序取，取到第一个存在的：

1. **locale 的 `meta.detail`** 指向的 Markdown 文件
2. 包内 `README.md`
3. （仅市场条目）仓库 README

我们原来没有 `meta.detail`，于是回退到了 README —— 这就是配置页里那坨内容的来源。

**做法**：让 `meta.detail` 指向一个**空文档**，宿主就没有内容可渲染
（面板对空 markdown 走 `:empty { display: none }` 折叠）：

```jsonc
// locale/zh.json、locale/en.json
{ "meta": { "title": "...", "description": "...", "detail": "locale/detail.md" } }
```

`locale/detail.md` 是 **0 字节**文件。

**改动**

- `locale/detail.md`（新增，0 字节）
- `locale/zh.json` / `locale/en.json`：新增 `meta.detail`
- `README.md`：**恢复原样**（259 行，上一版压到 58 行是错的）
- 删除上一版误加的 `docs/REFERENCE.md`
- 测试新增 2 项：`meta.detail` 契约（相对路径、`.md` 结尾、无 `..`/scheme、文件存在且为空）
  与「README 仍保留」

注意：这只影响插件的**详情面板**；`README.md` 本身完整保留。

## 0.9.0 — 2026-10-28

### 架构：改回 kernel 传输（直连保留为回退）

三个账号先后被封（`40109`）后，改为**驱动 TeleAgent 自己的内核**发请求：
内核解密登录态、自己加签、自己发请求，流量就是原生流量，不再需要复刻上游签名。

`transport: 'kernel'`（默认）/ `'direct'`（旧实现，保留用于回退与对比）。

**实现**（`lib/kernel.js`，与 `upstream.createUpstream()` **同形**，shim/卡片/积分/CLI 全部不用改）

| 环节 | 做法 |
|---|---|
| 拉起内核 | 无参数 spawn，env 走 **spawn env + stdin（4 字节长度 + JSON）** |
| 就绪探测 | `GET /global/health` |
| 建会话 | `POST /session` |
| 发消息 | `POST /session/:id/prompt_async` → 输出走 `GET /event` SSE |
| 流式 | `message.part.updated`（**累积全文**转增量）、`session.status idle` 收尾 |
| 多轮 | 每个 DSH 会话映射一个 kernel session，只发**新增**用户消息 |
| 图片 | data URL 落成临时文件 → kernel `file` part |
| 错误 | 挖 `{error|data}.{code|message}` 多种形状 + 文案兜底识别封禁/限流 |

### 排查出来的四个真问题

1. **漏传 `SERVER_PORT`** —— 内核起来了但不监听（`fetch failed` 的根因）
2. **`appPaths()` 字段是 `config` 不是 `conf`** —— 解构写错得到 `undefined`，
   JSON 序列化直接丢掉该键 → 内核报 `missing required path environment variables`
3. **provider 配置不能自己拼** —— 内核内置 NewApi 定义，缺 `options.baseURL` 会报
   `compat(NewApi): baseURL is required`；必须从桌面端 `defaultProvider` 结构照搬 options
4. **多轮会重发助手消息** —— 原先按"非 system 消息数"计数，把 kernel 自己上一轮的回复
   又发了一遍；改为只按**用户消息**计数，助手消息永不重发

### 实测

- 内核拉起 → `healthy:true, version 1.2.27`（本机验证）
- 一次最小对话：请求成功抵达上游，返回 `current user is banned`
  → **链路打通**（当前账号 acct-A 确已被封，与传输方式无关）
- `doctor` 新增「kernel 可执行文件」「kernel 启动与 health」两项，均通过

### 已知限制（kernel 模式）

- 工具调用：内核的工具执行默认被**全部 deny**（避免它在自己的沙箱里替 DSH 动手）。
  DSH 的工具调用能力在 kernel 模式下受限，需要真实可用账号再验证 passthrough 是否可行。
- 端口固定为 `TELEAGENT_KERNEL_PORT`（默认 47823），不与桌面端共用数据目录
  （独立 `~/.dsh-teleagent-kernel/`）。

### 测试

新增 `test/kernel.test.js` 18 项（permission、信封加解密、会话映射、多轮计数、
SSE 映射、错误映射、图片落盘），全部不启动真内核、不发请求。

---

## 0.8.2 — 2026-10-27

### 修复：设置卡片整个消失（首帧崩溃）

用户反馈"插件的信息都看不到了"。后端完全正常（`/status` 200、7 条路由、provider 已注册），
问题在客户端：**`Card` 组件首次渲染时 `status` 还是 `null`（数据未返回），
而渲染里直接读了 `status.allowChatProbe`，于是一挂载就抛 TypeError。**

`TypeError: Cannot read properties of null (reading 'allowChatProbe')`

React 捕获后整块卡片就不渲染了 —— 表现就是"插件信息一片空白"。

- 修复：`status?.allowChatProbe`（可选链）
- 这个 bug 是 0.7.0 加「模型自检按钮」时引入的，`0.7.0`/`0.8.x` 一直在
- **为什么之前没测出来**：渲染测试只渲染了无状态的 `CardView`（用完整 props），
  从来没渲染过有状态的 `Card`，而 null 首帧只出现在 `Card` 里。

### 测试

新增「有状态卡片首帧」回归：渲染 `Card`（`status` 为 null）并断言不抛错。
同时导出 `Card` 供测试使用。

### 同日确认

`acct-A` 账号也被封（`40109`），即**第三个账号**。这与插件无关：
请求签名正确、`/status` 显示 `lastError.code = account_banned`、portal 仍可读（余额 5970.19）。
DSH 里看到的"API 密钥无效 / 本轮运行失败"就是这次 401 的直接表现。

---

## 0.8.1 — 2026-10-27

### 修复：积分余额不会自动刷新，必须手动点「刷新」

用户反馈：余额一直停在旧值，只有点「刷新」才变。

**根因**：0.5.2 引入的 `markStale()` 只是把缓存**标记**为过期，
但**没有任何读取路径去消费这个标记**：

```js
// 之前的 GET /welfare（不带 refresh）
return json(res, 200, welfare.snapshot())   // 纯读缓存，过期也不刷
```

于是只有两个地方会真正刷新：手动按钮（`action: 'refresh'`）和窗口聚焦（`?refresh=1`）。
对话结束后余额消耗了，标记是 stale 的，但没人管它。

**修复**：读取即刷新。

- `welfare.ensureFresh()`：缓存为空 / 被标记 stale / 超过 TTL 时，**在这次读取里**刷新
- `GET /welfare`（不带 refresh）改走 `ensureFresh()`
- 卡片停在「福利」栏时每 **5 秒**刷新一次（本机接口，便宜）
- 上游请求仍受 TTL 约束：`pointsTtlMs` 60 秒，所以胶囊 3 秒轮询**不会放大**上游流量

效果：**对话结束后 3 秒内余额自动更新**，无需手动刷新；
空闲时最多每分钟一次上游读取。

### 测试

新增 5 项回归测试（首次读取会拉、TTL 内不重复、`markStale` 后立刻刷新、
上游失败保留旧值、领取状态也按 TTL 刷新）+ 路由测试 1 项
（`GET /welfare` 必须走 ensureFresh）。
其中一条专门断言"stale 后返回的必须是新余额"，防止再退化成只读缓存。

---

## 0.8.0 — 2026-10-27

### 多账号：列举 / 逐账号积分 / 切换 / 逐账号领取

> **重要前提**：这一版是**盲写**的。两个旧账号都被封、当前账号也无法用于切换验证，
> 所以"切换成功后桌面端确实切过去了"这一点**未经真机验证**。
> 因此实现上把安全性放在了功能前面。

**新增 `lib/accounts.js`**

| 能力 | 说明 |
|---|---|
| `listAccounts()` | 枚举 `users/<scope>`，逐个解密各自 token.json 取账号名/有效期；单个失败不影响列表 |
| `fetchAccountPoints()` | 按账号读**自己分区**的 cookie，自己的余额 |
| `switchAccount()` | 改 `current-owner.json`（备份 + 原子写 + 失败回滚 + `generation` 递增） |
| `claimForAccount()` | 用该账号自己的 cookie 领取；已领则短路 |

**安全性约束（切换会改桌面端文件，所以尺寸很小、检查很多）**

1. 桌面端在运行时**拒绝**切换（它退出时会重写这个文件）
2. 目标账号没有 `token.json` 时拒绝
3. `--dry-run` 只报告，一个字节都不写
4. 写入用「临时文件 + rename」原子替换；失败自动回滚
5. `generation` 只增不减

**修掉的两个真 bug**

- `isAppRunning()` 返回的是 **PID 数组**：`[]` 是 truthy、`[pid]` 也不等于 `true`。
  早期用 `appRunning === true` 判断，导致"桌面端在运行"这条保护**完全失效**。
  新增 `isAppRunningNow()` 统一返回布尔，并在 `switchAccount` 里同时接受数组与布尔。
- `readPortalAuth(home, scope)` 在指定账号却读不到 cookie 时会**回落到主 cookie 库**，
  于是把当前账号的凭据当成别人的 —— 三个账号显示出两个相同的余额。
  现在只有"没指定账号"时才回落。

**接口与 CLI**

```
GET  /plugins/dsh-connect-teleagent/accounts[?points=1]
POST /plugins/dsh-connect-teleagent/accounts   { scope, dryRun }

dsh-connect-teleagent accounts [--json] [--no-points]
dsh-connect-teleagent accounts --to=<scope> [--dry-run]
dsh-connect-teleagent accounts --claim=<scope>
```

**界面**：账号栏新增「本机账号」列表 —— 每行显示账号名、剩余天数、**该账号自己的积分**、
当前标记与「切换」按钮；桌面端运行时按钮禁用并提示需先退出。

**真机看到的事实**：本机有三个账号目录，其中两个的 `token.json` 已被清除（未登录），
只有当前账号可读；三个账号的积分都能读（6096.43 / 16972.02 / 16972.02，后两个已失效的
显示为读取失败或旧值）—— 与"封号后 portal 仍可用"的结论一致。

**测试**：新增 `test/accounts.test.js` 17 项，覆盖切换的全部安全分支
（运行中拒绝、无 token 拒绝、dry-run 不写、原子写、备份、回滚、PID 数组回归）。
另新增路由测试 5 项。

---

## 0.7.0 — 2026-10-27

路线图 v0.7.0：福利与可观测性。其中「模型测试」按 0.6.1 的封号复盘**重新设计**了——
原计划是「点一下发一条真实请求」，这恰好是导致两次封号的形态。

### B. 福利活动徽标

- `portal.fetchDailyStatus` 现在带回 `data.activity`（活动名 / 结束文案 / 动作文案）
- 福利栏新增「福利活动」一行；结束日期在 **3 天内**时徽标变「即将结束」
- 积分胶囊的 tooltip 也会带上活动名

实测当前活动：`邀请共享积分礼 · 10/31 结束`。

### J. 错误分类扩展

| 响应 | 分类 | 给用户的动作 |
|---|---|---|
| `40104/40108/40109/40110` | 签名/凭据/封禁/停用 | 更新插件 / 重新登录 / 申诉 |
| `402`、`4029` | 积分不足 | 领取每日积分 |
| `429`、`4290` | 请求过于频繁 | 稍后再试 |
| `413` | 请求体过大 | 减少工具或附件（**明确不是账号问题**） |
| `404` | 接口变更 | 跑 doctor |
| `1210` | 内容类型不支持（如图片） | 换 chat-pro / chat-flash |
| `5xx` | 上游故障 | 稍后重试 |

### I. 只读 DSH 工具 `teleagent_points`

让模型自己能回答"我还有多少积分、今天领了没"：

- **只读** portal：不消耗积分、不触发领取、**不发任何模型请求**
- 无 `tools` 服务时安全降级（返回空 disposer，不影响插件装载）
- 输出为结构化 JSON + 一段人类可读文本

### E. 模型自检 —— 改为默认禁用

- 新增 `POST /plugins/dsh-connect-teleagent/probe`：**默认 403**，`code: probe_disabled`，
  并在错误里说明原因与开启方式（配置 `ui.allowChatProbe: true`）
- 开启后按钮才出现在模型行，点击会发一条 `max_tokens:1` 的真实请求，
  按钮 title 明确写「会消耗积分并产生真实流量」
- 设计取舍：**便利性让位于账号安全**（见 `../../AGENTS.md`）

### 测试

142 项单测（+11）；路由测试新增 probe 门禁两条（默认拒绝 / 开启后可用）。

---

## 0.6.2 — 2026-10-27

### 把"别再探测"变成硬约束

用户明确要求记住：**两个账号都已因探测被封**。仅仅"记住"不够，因此落到三处：

1. **工作区长期记忆** `../../AGENTS.md`（工作区根目录）：每次会话自动加载，
   记录两个账号的封禁事实、可疑行为清单、禁止事项与替代做法。
2. **代码硬门禁** `probeUpstream()`：默认**拒绝**发聊天请求，
   返回 `{ ok:false, skipped:true, reason }` 且**不产生任何 HTTP 请求**；
   必须显式 `{ allow: true }` 或环境变量 `TELEAGENT_ALLOW_CHAT_PROBE=1` 才放行。
3. **测试**：两条单测锁住"默认必须跳过"，防止以后被人顺手改掉。

配套调整（上一版已做，此处一并记录）：

- 启动自检 / `doctor` / `bin status` 默认走 portal（只读、免费），不发聊天请求
- `GUARD.maxPerMinute = 20`：分钟级限速，避免请求突发
- 引导日志改为追加 + 轮转，不再每次启动清空（保住"被封前发生了什么"的证据）

---

## 0.6.1 — 2026-10-27

### 背景：第二个账号在约 1 小时 45 分后被封

现象与上一次一致：聊天网关 `40109 current user is banned`，
**但积分接口仍然正常**（余额可读、领取可用）——说明是模型调用通道被限制，不是账号注销。

排查后确定的**自身原因**（这一轮必须承认）：

1. 我为了验证视觉能力与体积上限，在该账号上跑了**合成探测**：
   - 5 个模型 × 图片 data URL（约 13 次）
   - 50/150/300/600 KB 填充体各一次（`max_tokens: 8`）
   - 10/100/265 个**合成工具**（`tool_0` … `tool_264`）各一次
   这些形态在风控眼里就是自动化探测：超大 body、无实际语义、工具名规律、短时间换模型。
2. 插件自身还存在两个"放大"因素：
   - 每次启动都发一次真实聊天请求做自检
   - 只有并发上限，没有**速率**上限（短时间可打出一串请求）

### 修复（收敛自身流量）

| 项 | 之前 | 现在 |
|---|---|---|
| 启动自检 | 发一次真实聊天请求（`max_tokens:1`） | 默认**只读 portal**（免费、无模型流量）；`probeOnBoot: true` 才发聊天请求 |
| `doctor` 自检 | 默认发聊天请求 | 默认跳过，`--probe` 才发；新增「积分接口」只读检查 |
| `bin status` | 默认探聊天通道 | 默认不探，`--probe` 才探 |
| 请求速率 | 无限制（仅并发 2） | **每分钟上限 20**（可配置），超限自动等待 |

### 诊断能力

- **引导日志不再每次启动清空**：改为追加 + `===== 新的启动 =====` 分隔线，
  超过 512 KB 时保留尾部一半。上一轮就是因为清空而丢失了"被封前发生了什么"的证据。

---

## 0.6.0 — 2026-10-27

路线图 v0.6.0 的五项全部完成（都是零上游依赖、可自动验证的改动）。

### G. 整体关闭 provider

- `store` 新增 `providerDisabled`：为 true 时 `buildModels()` 返回空数组，
  模型选择器里彻底看不到 TeleAgent（account/勾选状态全部保留）
- 卡片「账号」栏顶部新增总开关；停用时头部状态显示「已停用」，模型列表置灰并提示
- 复用 `POST /models` 路由：带 `providerDisabled` 字段即切换开关

### C. 卡片分栏（账号 / 模型 / 福利 / 诊断）

- 四个 tab；非活动栏用 `hidden` 隐藏 —— 切栏不重新取数、也没有额外请求
- 「诊断」栏是只读事实表：插件版本、上游网关、供应商状态、账号、有效期、
  模型数与启用数、上游连通性、熔断计数、积分缓存年龄、最近上游错误原文
- 模型栏显示「共 N 个，启用 M 个」与图片能力说明

### K. 包元数据

- 补 `displayName` / `author` / `icon` / `repository` / `homepage` / `bugs`
- 新增 `test/metadata.test.js`（7 项）：必需字段、locale 与包名一致、
  semver 且为 0.x、exports 覆盖、icon 为 128×128 PNG、files 清单、bin 存在

### D. CLI 子命令

`lib/bin.js` 提供三个命令（替代原来只能跑 doctor）：

| 命令 | 作用 |
|---|---|
| `status [--json] [--no-probe]` | 账号 / 积分 / 今日领取 / 上游连通 / 供应商状态（只读） |
| `doctor [--json]` | 完整自检（转发现有的 doctor.js） |
| `logout [--all] [--json]` | 清除登录态（只删凭据，保留技能与记忆） |

两个实现细节：用 `process.exitCode` 而不是 `process.exit()`（后者会截断管道里的 stdout）；
`--help` 优先于默认子命令。

### F. 凭据探测详情

- `credential.js` 新增 `probeDetails()`：逐账号列出 `app-auth` / `token.json` 的真实状态
  （没有目录 / 没有 token / encryptedToken 为空 / 无法解析 / 正常），外加钥匙串可读性
- 能区分「凭据在但钥匙串读不到」与「本机没有任何账号」——这两种的处置完全不同
- 卡片在**未登录时**才展示可折叠详情；已登录时不探测（避免每 15 秒读一次钥匙串）

### 领取策略优化

| 场景 | 之前 | 现在 |
|---|---|---|
| 当天已领 | 启动后仍请求 `checkDayTask` | **不发任何请求**（本地记录即足够） |
| 未领 | 固定 6 小时一次 | 每小时检查一次 |
| 已领 | 固定 6 小时一次 | 8 小时一次 |
| 连续失败 | 无退避 | 指数退避，上限 8 小时 |
| 领取前查状态 | 强制刷新（重复请求） | 复用 15 秒缓存 |

轮询从固定 `setInterval` 改为递归 `setTimeout`，每轮结束后按最新状态决定下次间隔。

### 测试

`npm test` 125 项、`test-cli.mjs` 6 项；`verify` 一条命令覆盖 6 个套件。

---

## 0.5.3 — 2026-10-27

### 修复：一次真实使用中的上游连接中断

用户在用 `chat-flagship` 跑长任务时报错：

```
Error: Auto review of tool "bash" failed; its body was not executed:
       auto-review: reviewer ended with error TRANSPORT: Stream ended without finish_reason
本轮运行失败 502: {"message":"shim: upstream stream failed: fetch failed", ...}
```

**两个错误其实是同一件事的两端**：上游连接在流式中途被切断（`fetch failed`），
我们的 shim 只回了一个笼统的 502；DSH 的自动审批（auto-review）那一轮因此看到
"流结束但没有 finish_reason"，于是判定这次工具调用失败、请求体没有执行。

**排查过程**

| 假设 | 验证 | 结论 |
|---|---|---|
| 请求体过大（265 个工具） | 53KB / 150KB / 300KB / 600KB 逐级压测 | 全部 200，**不是体积问题** |
| 模型能力问题 | 同一模型小请求正常 | 不是 |
| 瞬时连接中断 | 我们**没有记录** fetch 失败原因 | 是盲区，必须先补诊断 |

顺带发现：上游延迟偏高（小请求 7–12 秒），这类环境里瞬时断连的概率更高。

**修复**

1. **展开 fetch 错误原因**（`describeFetchError`）：`fetch failed` 只是外壳，
   真因在 `cause` 里（`ECONNRESET` / `ETIMEDOUT` / `UND_ERR_SOCKET`…）。现在会完整记录。
2. **连接类失败自动重试一次**（`isRetryableConnectionError`）：仅限
   `ECONNRESET / ECONNREFUSED / ETIMEDOUT / EPIPE / ENOTFOUND / EAI_AGAIN / UND_ERR_SOCKET`
   且**尚未收到任何字节**的情况；证书错误等不重试。
3. **补齐 `finish_reason`**：上游流结束却没有 finish_reason 时，补发一个
   `{"choices":[{"delta":{},"finish_reason":"stop"}]}`，并确保 `[DONE]` 存在。
   这样 DSH 不会再报 "Stream ended without finish_reason"。
4. **错误文案可执行**：502 从 `shim: upstream stream failed: fetch failed` 改为
   `上游连接中断（TypeError ← ECONNRESET）。请重试。`，`code: upstream_connection`。
5. **记录请求体字节数**：`shim 受理请求` 日志新增 `bytes` 字段。

**测试**：新增 7 项（重试成功、重试仍失败的错误码与原因、缺 finish_reason 补发、
缺 [DONE] 补发）。

---

## 0.5.2 — 2026-10-27

### 积分胶囊：按当前模型显示 + 近实时刷新

**1. 只在选中 TeleAgent 模型时显示**

宿主向槽位注入 `useProjection`，读 `modelSelection` 投影：
`(next ?? lastUsed).provider`。只有等于 `teleagent` 才渲染胶囊；
其他 provider（deepseek / workbuddy / codebuddy…）时**返回 null，组件不挂载**，
连轮询都不会启动。做法与 `dsh-connect-workbuddy` 的 `ComposerCreditsGate` 一致。

宿主不提供 `useProjection`（旧版本）时无法判断，退化为"显示"——宁可多显示，也不把功能藏掉。

**2. 刷新策略：本机轮询快、上游请求省**

| 层 | 频率 | 说明 |
|---|---|---|
| 胶囊 → 本机 `/welfare` | 每 **3 秒** | 本机 HTTP，代价可忽略 |
| 宿主 → portal `points/detail` | TTL **15 秒** + stale 标记 | 真正去上游的次数 |
| 对话结束 | 一次 | shim 完成请求后回调 `welfare.markStale()`，把缓存标记为过期 |
| 窗口聚焦 / 页面可见 | 一次 | 强制刷新（`?refresh=1`） |
| 领取成功 | 一次 | 直接取新值并渲染 |

效果：**聊完一轮最多 3 秒后余额就更新**，而空闲时不会持续打上游。

**3. 实现**

- `lib/shim.js`：新增 `onTurnComplete` 回调（流式与非流式两条路径都触发）
- `lib/welfare.js`：`markStale()` + 快照里暴露 `pointsStale`
- `lib/client.js`：`PointsCapsuleGate`（provider 门控）+ 3 秒轮询 + 焦点/可见性刷新
- `lib/index.js`：把 shim 的完成回调接到 `welfare.markStale()`

**测试**：新增 7 项（门控：选中 teleagent 渲染 / 三个其他 provider 不渲染 / 无投影退化；
刷新：stale 触发重新拉取、snapshot 不触发网络、未登录不抛错、TTL 内不放大请求）。

---

## 0.5.1 — 2026-10-27

### 纠正：图片输入**是支持的**（此前结论错误）

排期里曾把「图片输入」标为 ❌ 不可行，依据是客户端模型目录声明 `Input.Image:false`。
用户指出客户端实际能识图后重新实测，**声明是错的，以实测为准**。

用同一张「蓝色三角形 + 文字 42」的图片逐个验证（OpenAI 风格
`{type:'image_url', image_url:{url:'data:image/png;base64,…'}}` 内容块）：

| 模型 | 结果 | 证据 |
|---|---|---|
| `chat-pro` | ✅ 支持 | 正确读出色/形/文字 |
| `chat-flash` | ✅ 支持 | 正确读出色/形/文字 |
| `chat-lite` | ❌ 不支持 | HTTP 200 但内容与图片无关（胡编），不算支持 |
| `chat-nano` | ❌ 不支持 | HTTP 400 `telechat-29b is not a multimodal model` |
| `chat-flagship` | ❌ 不支持 | HTTP 400 `code 1210`（不接受 image 内容块） |

另外两点经验：`chat-pro` 在 `max_tokens` 过小时会因 reasoning 吃满而返回空内容，
看起来像"不支持"，实际是 token 不足；判断能力时要给足 `max_tokens`。

### 实现

- `lib/models.js`：每个模型加 `vision` 布尔（实测值），导出 `VISION_MODEL_IDS`
- `lib/index.js`：按实测向 DSH 声明 `input: ['text','image']` ——
  pi-ai 只有在 `model.input.includes('image')` 时才会把图片块发给上游
- `lib/status.js` / `lib/client.js`：模型行显示「图片」徽标
- shim 无需改动：`messages` 本来就原样透传，图片内容块天然保留

### 测试

- 单测：`VISION_MODEL_IDS` 只含 chat-pro/chat-flash；每个模型必须有显式 `vision` 布尔
- shim 形态：图片内容块与文本块并存且原样透传
- 渲染：视觉模型显示「图片」徽标

---

## 0.5.0 — 2026-10-27

### 新增：积分余额与每日自动领取

> 此前我在排期里写过「TeleAgent 没有签到/积分体系」，**这个结论是错的**，本版本已纠正。
> 误判原因是当时只在 kernel 二进制与客户端主进程里搜索，而积分功能在**渲染层的 portal 应用**里。

**发现过程（全部静态分析 + 一次只读验证）**

| 线索 | 位置 |
|---|---|
| 界面文案 | `app.asar` 内的 i18n：`积分福利社`、`每日可领 {{points}} 积分`、`claimedToday:"今日已领"` |
| API 前缀 | portal SPA bundle：`_4 = VITE_API_PREFIX \|\| '/meter/super-agent/user/portal'` |
| 鉴权方式 | portal 请求封装：`X-Token: <operationToken>` + `userId` 头（不签名） |
| 凭据来源 | `Partitions/owner%3A<scope>/Cookies`（Chromium cookie 库，实测**明文**存在 `value` 列） |
| 接口 | `/points/detail`、`/companyStore/v2/checkDayTask`、`/companyStore/checkTask?type=daily_login`、`/companyStore/userCenter` |

**实测结果**：余额 `5967.79`，当日可领 `100` 积分为 `claimed_today:false`；
执行领取后余额变为 `1234.56`（+100），`total_claim_days:2`。

**新增模块**

- `lib/portal.js`：读分区 cookie、调 portal 接口（`fetchPoints` / `fetchDailyStatus` / `claimDaily` / `fetchUserCenter`）
- `lib/welfare.js`：余额缓存（60 秒 TTL）+ 每日自动领取状态机（默认每 6 小时检查一次）

**幂等保证**（领取是写操作，重复就是 bug）

1. 先看上游 `claimed_today`，已领直接返回
2. 再看本地 `lastClaimDate`（本地日期键），当天不再尝试
3. 领取后再查一次确认，避免"接口 200 但没发积分"

**界面**

- 输入框左下角积分胶囊（`conversation.input.left`，与 workbuddy 同一挂载点）：
  已领完显示余额，可领时高亮「+100 可领」并可直接点击领取，无数据时不占位
- 设置卡片新增「积分福利」区块：余额 + 最近到期、每日领取状态与按钮、自动领取开关

**新增接口**

- `GET  /plugins/dsh-connect-teleagent/welfare`（`?refresh=1` 强制刷新）
- `POST /plugins/dsh-connect-teleagent/welfare`，`action: claim | refresh | auto`

**测试**：新增 13 项单元测试（日期判定、领取幂等、失败不阻塞、开关持久化、快照鲁棒性）
+ 渲染测试新增 3 项（可领场景、读取失败场景、胶囊首帧不占位）。

---

## 0.4.1 — 2026-10-27

### 设置卡片视觉改版
- 展示层抽成纯组件 `CardView`，逻辑组件 `Card` 只负责取数与交互
- 全部改用 `--dsw-alias-*` 设计令牌，每个都带深色回退值，明暗主题均不失真
- 卡片容器使用 `bg-layer-2` + `border-l1` + `radius-lg`，与宿主面板同层级
- 状态改为实心药丸（成功/警告/错误），模型开关改为自绘 `Switch`（带过渡）
- 「账号 / 连接 / 模型」三节结构，1px 分隔线；按钮与开关补齐 hover / disabled 态
- 新增 `Notice` 组件展示原因与处置建议（替代原来挤在标题旁的小字）
- 修正两处自相矛盾的文案：
  - 「账号」标题已是账号名时，说明里不再重复账号名
  - 被封禁时不再写"签名有效"却标"异常"，改为"签名有效，但账号被封禁"

### 可离线预览 / 渲染回归
- `npm run preview` → `docs/card-preview.html`，明暗双主题并排渲染 4 种状态
- `test-ui-render.mjs`：8 个场景（载入中/失败/正常/未登录/被封/熔断/确认态/坏数据）
  \+ 3 项样式断言（使用了设计令牌、带深色回退、控件是真 `<button>`）

### 命名与版本
- 插件显示名统一为包名 **`dsh-connect-teleagent`**（`locale/*.json` 的 `meta.title`），
  与 `dsh-connect-workbuddy` 的约定一致；卡片内部标题仍为产品名 `TeleAgent`
- `version` 由 `4.0.1` 规范为 `0.4.1`

---

## 0.4.0 — 2026-10-26

> 本版本代号曾记为 `4.0.0`（内部里程碑"第 4 代架构"）。

### 架构：去掉 kernel，直连上游
经 REA + `debug/gosym` + lldb 逆向出上游签名算法后，模型调用不再经过 TeleAgent 的 agent runtime：

- 新增 `lib/upstream.js`：凭据读取 + 两步 HMAC 签名 + 直连客户端
- 新增 `lib/models.js`：模型清单与路径解析
- **删除** `lib/kernel.js`（约 300 行）与 `lib/session.js`（约 220 行）
- `lib/shim.js` 简化为**纯代理**：不改写 `messages`/`tools`，流式按字节转发

修复了 kernel 架构下无法解决的三个缺陷：

| 缺陷 | kernel 架构 | 直连后 |
|---|---|---|
| 用户消息被折叠 | 拼成"用户：…/助手：…"一段文本 | `role` 原样透传 |
| 多轮历史 | 依赖 kernel session，重启即丢 | 调用方携带完整历史 |
| 工具调用链 | 被 kernel 自己执行后截断 | `tools`/`tool_calls` 完整往返 |

### 与官方客户端的请求对齐（`llm_tap` 抓包逐项比对）
- 补齐 `X-Session-Id` / `X-Message-Id` / `X-Teleai-Root-Session-Id` / `Cache-Control` / `Connection`
- 补齐 body 的 `stream_options: {include_usage: true}`
- 发现官方客户端**从不发送** `stream: false` → 改为始终向上游发流式，非流式在本地用
  `aggregateSse` 聚合成标准 JSON（含跨块 `tool_calls` 参数拼接）

### 上游错误分类（`lib/health.js`）
- `40104` 签名失效 / `40108` token 无效 / **`40109` 账号封禁** / 未知 401 分别给出原因与建议
- 不再把"账号封禁"笼统显示成"API 密钥无效"
- 启动自检：boot 后后台发一个 `max_tokens:1` 探针，账号级问题立刻显示在卡片上

### 防护（`lib/guard.js`）
- 并发上限 2：避免 DSH 并行调用造成突发
- 熔断：连续 3 次 401/403 暂停 10 分钟，期间请求快速失败（503 + `Retry-After`）
- 半开探测：冷却后只放行一个请求试探，成功闭合、失败重开
- 换账号时自动复位

### 账号管理（`lib/account.js`）
- 新增 `POST /plugins/dsh-connect-teleagent/logout`，**只删除 `token.json`**，
  保留 `skills/`、`USER.md`、日志等全部个人数据
- 默认只清"当前"账号，批量清除必须显式传 `all: true`
- 多账号目录并存时优先 `current-owner.json`，否则选 `token.json` 最新的那个
- 凭据指纹（scope + mtime + size）变化时自动重建客户端 → 换账号无需重启 DSH

### 可观测性
- 新增 `$DSH_HOME/teleagent-boot.log`：记录每个装配阶段、路由注册形状、失败堆栈
- `doctor` 检查项改为：应用安装 / 数据目录 / 登录态 / 钥匙串 / 设备标识 /
  **签名自检** / 模型目录 / 工具调用

### 修复
- **状态路由 404**：根因是 `ctx.get('webServer')` 在 `boot()` 阶段存在竞态（服务尚未就绪）。
  改为在 `apply()` 中 `ctx.inject(['webServer'], cb)`，与 workbuddy 的写法一致
  （其注释即写明 "startup order cannot make this registration disappear"）。
  回归测试 `test-status-route.mjs`：桩掉 pi-ai 后真实加载 `lib/index.js`，
  mock「`ctx.get` 拿不到、只有 `ctx.inject` 能给到服务」的场景，断言 3 条路由注册成功

---

## 0.3.x — 2026-10-25（已废弃）

kernel 架构阶段：自有 kernel 进程 + loopback shim。

已具备：真流式（消费 kernel `/event` SSE）、多轮会话、`doctor` 诊断命令、
登录闭环（唤起应用→轮询凭据→自动退出）、单元测试 54 项 + 路由测试 12 项 + 端到端 11 项。

**废弃原因**：kernel 是完整 agent runtime，人格 prompt 与工具执行全部硬编码，
`# Security` 段明确禁止外部覆盖，导致 role 结构、多轮历史与工具链三者无法兼顾。

---

## 已知限制（长期）

| 限制 | 说明 |
|---|---|
| 图片输入不可用 | 上游 `chat-pro`/`chat-flash` 的能力声明为 `Attachment:false, Input.Image:false`，实测多种图片 part 格式均不被识别 |
| 无签到/积分接口 | 客户端明文 JS 与 kernel 二进制内均无相关代码；模型目录只有 `creditMultiplier`（倍率），没有余额接口 |
| 签名算法依赖逆向 | 上游协议变更即失效；`doctor` 的签名自检会先发现 |
| 账号级封禁无法绕过 | 收到 `40109` 时所有模型均被拒，只能申诉或换账号 |
| 与官方客户端存在可识别差异 | `messages[0]` 无人格串、TLS/JA3 指纹不同（Node undici vs Go）、`tools` 内容不同。详见 README「与官方客户端的可识别差异」 |
