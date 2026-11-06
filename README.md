<p align="center">
  <a href="https://github.com/anbulang/dsh-connect-teleagent/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/anbulang/dsh-connect-teleagent?label=release&color=2ea44f"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent/blob/main/package.json"><img alt="version" src="https://img.shields.io/badge/version-0.11.4-blue"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-purple"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="platform" src="https://img.shields.io/badge/platform-macOS-lightgrey"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.1--rc.1%2B-orange"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="index" src="https://img.shields.io/badge/index-format--1-blueviolet"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="tests" src="https://img.shields.io/badge/tests-233%20passing-brightgreen"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent/stargazers"><img alt="stars" src="https://img.shields.io/github/stars/anbulang/dsh-connect-teleagent?style=social"></a>
</p>

<h1 align="center">dsh-connect-teleagent</h1>

<p align="center">
  把本机登录的 <b>TeleAgent</b>（天翼 AI 星辰超级智能体桌面端）模型接入 <b>DeepSeek Harness</b>。
  <br>
  <b>简体中文</b> · <a href="README_EN.md">English</a>
</p>

---

复用桌面端已有登录态，**不需要单独注册账号**；默认经由 TeleAgent 自己的 Go 内核发请求，
保留 DSH 的 role 结构、多轮历史、工具调用与流式体验。

## ✨ 特性

- **5 个官方模型**：智能 / 旗舰 / 极速 / 轻量 / 轻速（含图片输入与积分倍率展示）
- **原生内核流量**：默认走 TeleAgent 自己的内核（解密登录态、自己加签），不是伪造请求
- **真流式**：SSE 按字节转发，`reasoning_content` 思维链可在 DSH 里折叠查看
- **工具桥（MCP）**：DSH 的工具透传给模型，调用由 DSH 执行（有卡片、有权限）
- **图片输入**：`chat-pro` / `chat-flash` 支持，走本机持久附件服务
- **积分**：余额展示 + 每日自动领取（幂等），设置卡片与输入框胶囊
- **可订阅**：自带 format-1 插件索引，DSH「发现」页一键添加
- **防突发**：并发上限 + 认证失败熔断，避免误触上游风控

## 模型

| modelID | 名称 | 上下文 | 输出 | 图片 | 积分倍率 |
|---|---|---|---|---|---|
| `chat-pro` | 智能 | 400K | 65536 | ✅ | x0.6 |
| `chat-flagship` | 旗舰 | 400K | 65536 | ❌ | x1.0 |
| `chat-flash` | 极速 | 400K | 65536 | ✅ | x0.2 |
| `chat-lite` | 轻量 | 100K | 65536 | ❌ | x0.5 |
| `chat-nano` | 轻速 | 100K | 65536 | ❌ | x0.1 |

在 DSH 里显示为 `智能 · x0.6`，倍率来自 TeleAgent 自己的目录。

## 前置条件

1. macOS 已安装并**登录** TeleAgent 桌面版（`/Applications/TeleAgent.app`，桌面端只有 macOS）
2. DeepSeek Harness **0.2.1-rc.1+**（能打开「插件 → 发现」即可）
3. 按下面「上游 apiKey」在本机配置网关 apiKey

未登录时插件会提示「TeleAgent 尚未登录」；登录完成后**不需要重启 DSH**，凭据变更会自动生效。

## 安装

### 方式 A：DSH 插件索引（推荐）

1. 打开 **插件** → **实验性插件** 旁的 **更多** → 开启 **自定义插件市场**
2. 进入 **发现** → **添加索引源**，填写：

   ```text
   https://raw.githubusercontent.com/anbulang/dsh-connect-teleagent/main/market/index.json
   ```

3. 在市场下拉里选择 **dsh-connect-teleagent**，安装后重启 DSH

### 方式 B：包管理器直装

```bash
dsh plugin --profile web add github:anbulang/dsh-connect-teleagent
```

### 方式 C：Release 离线包

从 [Releases](https://github.com/anbulang/dsh-connect-teleagent/releases/latest) 下载
`dsh-connect-teleagent-<version>.tgz`，解压到 `~/.dsh/plugins/dsh-connect-teleagent/`，
或用仓库里的安装脚本：

```bash
bash scripts/install.sh      # 复制到 ~/.dsh/plugins 并写入 profile
bash scripts/uninstall.sh    # 卸载
```

安装后**完全退出并重启 DeepSeek Harness**；「设置 → 模型」里即可看到 TeleAgent 的 5 个模型。

### 上游 apiKey

插件请求上游时需要一个网关 apiKey（TeleAgent 桌面端内置常量）。**仓库不提交真实值**，
在本机二选一配置：

1. 环境变量：`export TELEAGENT_API_KEY=sk-...`
2. 仓库根目录 `local.secrets.json`（已 gitignore）：

   ```json
   { "apiKey": "sk-..." }
   ```

都没有时，插件会在日志/卡片里提示「未配置上游 apiKey」。

## 使用

- **模型开关**：设置卡片里取消勾选即从选择器移除，重启后保留
- **积分**：卡片显示余额与今日领取状态；可关自动领取
- **换账号**：TeleAgent 桌面端重新登录后，插件按 `token.json` 指纹自动重建客户端（无需重启 DSH）
- **清除登录态**：卡片两步确认，只删 `token.json`，保留技能/记忆/个人数据

## 工作原理

默认 **kernel 模式**：插件驱动 TeleAgent 自己的 Go 内核发请求，内核负责解密登录态与签名，
请求形态是客户端原生流量；`direct` 模式（旧实现）会由插件自己复刻签名直连上游，作为回退保留。

```text
DSH (pi-ai) ──OpenAI──► loopback shim (127.0.0.1:随机端口)
                              │  透明转发（不改写 messages / tools）
                              ▼
                  TeleAgent kernel (Go, 本机 ~/.dsh-teleagent-kernel)
                              │  解密登录态 + 原生签名
                              ▼
                  TeleAgent 上游 /superCowork/sapi/api/v1
```

| 文件 | 职责 |
|---|---|
| `lib/kernel.js` | 拉起内核、会话/SSE/多轮/图片/工具挂起续跑 |
| `lib/shim.js` | 本地 OpenAI 兼容端点，纯代理（角色/工具/流式全部透传） |
| `lib/mcp-bridge.js` | 把 DSH 工具挂进内核 MCP，工具调用仍由 DSH 执行 |
| `lib/index.js` | 装配 pi-ai provider，注册 `teleagent` 路由 |
| `lib/upstream.js` | `direct` 回退模式的签名实现（见 [docs/DESIGN.md](docs/DESIGN.md)） |

内核独立运行在 `~/.dsh-teleagent-kernel/`，不碰桌面端数据目录。

## 配置

设置保存在 `$DSH_HOME/teleagent-plugin.json`（默认 `~/.dsh/teleagent-plugin.json`），
并可通过 DSH 设置卡片编辑：

```jsonc
{
  "transport": "kernel",          // kernel（默认）或 direct
  "kernelAllowedTools": [],       // 允许内核额外执行的工具（默认空）
  "denyBuiltinTools": true,       // 默认禁止内核自带工具，只走 DSH 的 MCP 工具
  "kernelReadyTimeoutMs": 60000,
  "enabledModelIds": [],          // 空数组 = 全部启用
  "guard": { "maxConcurrent": 2, "failureThreshold": 3, "cooldownMs": 600000 }
}
```

环境变量：`TELEAGENT_KERNEL_PORT`（内核端口，默认 47823）、`TELEAGENT_API_KEY`（上游 apiKey）。

## 积分

| 项 | 说明 |
|---|---|
| 余额 | 设置卡片与输入框胶囊，来自 `/meter/super-agent/user/portal/points/detail` |
| 每日领取 | 默认自动领取，每天一次；卡片可手动领取 |
| 幂等 | 上游 `claimed_today` + 本地 `lastClaimDate` 双重判断 |
| 失败影响 | 仅卡片提示，不影响模型可用 |

## 费用与积分（重要）

- 上游按 **tokens × 模型积分倍率** 计费：输入 tokens（**含工具 schema 与完整历史上下文**）+ 输出 tokens
- DSH 长会话 + 大量插件工具时，单步输入可达 **10 万–36 万 tokens**（实测 11-05/11-06 两天约 10.09M 输入 tokens）
- 每个工具调用还会触发内核的 `security/instruction/review` 审核请求（内核行为，每输入/输出各一次）
- 省钱建议：
  - 长任务用 `chat-flash`（x0.2）或 `chat-pro`（x0.6），`chat-flagship`（x1.0）留给短问答
  - 勤开新会话、及时压缩上下文；在 DSH 里禁用不用的插件以减少 `tools` 数量
  - 每天记得领 100 积分（卡片可查余额；额度不足时上游返回 402/5005，插件会直接报 `insufficient quota` 而不是反复重试）

## 防护

| 机制 | 默认 | 说明 |
|---|---|---|
| 并发上限 | 2 | 避免 DSH 并行调用造成突发 |
| 熔断阈值 | 连续 3 次 401/403 | 达到即暂停 10 分钟，期间快速失败 |
| 半开探测 | 1 个 | 冷却后先放一个请求试探 |

## 诊断与测试

```bash
node lib/doctor.js          # 环境/登录态/签名/模型目录自检（--json 可机器读）
npm test                    # 233 个单元测试（不启动真内核）
npm run verify              # 单测 + CLI + 状态路由 + shim 形态 + 路由 + 卡片渲染（6 套件）
```

`npm test` 覆盖：模型清单、签名算法、生命周期、凭据/账号/积分、内核传输（事件过滤、
工具挂起、会话恢复、孤儿内核清理、思维链）、图片附件与请求预算。

## 已知限制

- **仅 macOS**：TeleAgent 桌面端只提供 macOS 版
- **图片输入**：只有 `chat-pro` / `chat-flash` 支持；`chat-lite` 会胡编，`chat-nano` / `chat-flagship` 明确拒绝
- **依赖逆向**：上游协议/内核升级可能需要适配（`node lib/doctor.js` 会先暴露签名问题）
- **模型行为**：部分模型会把过程叙述直接写进正文（不是插件的渲染问题）
- **与官方客户端可识别**：system 提示词、工具集合、TLS 指纹、请求节奏都与官方客户端不同，
  本插件不伪装官方客户端（见下节）

## 与官方客户端的可识别差异

本插件**不伪装成官方客户端**，请求在若干维度上与官方客户端可区分，这是明确的取舍：

| 维度 | 官方客户端 | 本插件 |
|---|---|---|
| `messages[0]` | 固定人格串 | DSH 自己的 system 提示词 |
| 工具集合 | 客户端内置工具 | DSH 的 MCP 工具（`dsh_*`） |
| TLS 指纹 | Electron/Chromium | Node undici（shim 与内核之间为回环） |
| 请求节奏 | 人工交互 | 可能突发/并发，已加并发与熔断限制 |

不建议伪造官方人格或客户端身份：既会污染模型行为，也无助于账号申诉。

## 账号异常与清除登录态

卡片会区分「未登录」与「账号异常（凭据失效/被封）」，提供「去登录」与「清除登录态」。
清除只删 `<scope>/app-auth/token.json`，保留 `skills/`、`USER.md`、日志等个人数据；
执行前会先退出 TeleAgent 桌面端，避免凭据被重写。对应接口：
`POST /plugins/dsh-connect-teleagent/logout`（仅 loopback）。

## 免责声明

本项目是对本机已安装客户端行为的**互操作研究**，用于把已有账号接入自己的工具链。
请遵守 TeleAgent / DeepSeek Harness 的使用条款与当地法律，风险自负。
仓库不包含任何真实账号凭据、cookie 或上游密钥。

## License

[MIT](LICENSE)
