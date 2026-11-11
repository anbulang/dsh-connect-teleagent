<p align="center">
  <a href="https://github.com/anbulang/dsh-connect-teleagent/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/anbulang/dsh-connect-teleagent?label=release&color=2ea44f"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent/blob/main/package.json"><img alt="version" src="https://img.shields.io/badge/version-0.14.0-blue"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-purple"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.1--rc.1%2B-orange"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="index" src="https://img.shields.io/badge/index-format--1-blueviolet"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="tests" src="https://img.shields.io/badge/tests-402%20passing-brightgreen"></a>
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
- **多账号**：本机账号列表 + 「添加账号」入口；登录另一个账号时**自动保留原账号登录态**，可随时切换
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

1. 在 macOS 或 Windows 安装 **TeleAgent 2.7.1 或更高版本**，至少启动一次并登录。
2. DeepSeek Harness **0.2.1-rc.1+**（能打开「插件 → 发现」即可）
3. 按下面「上游 apiKey」在本机配置网关 apiKey

`dsh-connect-teleagent doctor --json` 和插件诊断栏会显示实际安装版本。版本过低或无法读取时，模型接入会暂停。

Windows 需用登录 TeleAgent 的同一个 Windows 用户运行 DSH。安装在自定义目录时，可在启动 DSH 前设置
`$env:TELEAGENT_APP_PATH = 'D:\Apps\TeleAgent\TeleAgent.exe'`。独立运行 CLI 需要 Node.js 22.19+（22.x）或 24+。

Windows 上 TeleAgent 运行时会锁定积分 Cookie 数据库。首次登录后打开一次积分福利页，再完全退出 TeleAgent，即可让插件读取积分凭据。

未登录时插件会提示「TeleAgent 尚未登录」；登录完成后**不需要重启 DSH**，凭据变更会自动生效。

## 安装

### 方式 A：DSH 插件索引（推荐）

1. 打开 **插件** → **实验性插件** 旁的 **更多** → 开启 **自定义插件市场**
2. 进入 **发现** → **添加索引源**，填写：

   ```text
   https://raw.githubusercontent.com/anbulang/dsh-connect-teleagent/main/market/index.json
   ```

3. 在市场下拉里选择 **TeleAgent 模型**（包名 `@anbulang/dsh-connect-teleagent`），安装后重启 DSH

### 方式 B：包管理器直装

```bash
dsh plugin --profile web add github:anbulang/dsh-connect-teleagent
```

### 方式 C：Release 离线包

从 [Releases](https://github.com/anbulang/dsh-connect-teleagent/releases/latest) 下载
`anbulang-dsh-connect-teleagent-<version>.tgz`（包里只有插件本体，**不含** `scripts/`），解压到
`~/.dsh/plugins/dsh-connect-teleagent/`；macOS 也可以用仓库里的安装脚本：

```bash
mkdir -p ~/.dsh/plugins/dsh-connect-teleagent
tar -xzf anbulang-dsh-connect-teleagent-<version>.tgz --strip-components=1 \
  -C ~/.dsh/plugins/dsh-connect-teleagent      # 去掉 tar 包顶层的 package/ 前缀
```

**但解压只是第一步**：DSH 不会自动发现这个目录，还要在 profile 里做**两处注册**
（仓库里的 `scripts/install.sh` 做的正是这两件事 —— 从 git 检出运行时可以直接
`bash scripts/install.sh`，它会连复制带注册一起做）。手工做的话，编辑
`~/.dsh/profiles/desktop/package.json`（profile 名不是 `desktop` 时换成你的）：

```jsonc
{
  "dependencies": {
    "@anbulang/dsh-connect-teleagent": "file:/Users/<你>/.dsh/plugins/dsh-connect-teleagent"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ……原有的 bundle 保持不动……
        "@anbulang/dsh-connect-teleagent"          // ← 追加到列表末尾
      ]
    }
  }
}
```

1. **`dependencies`**：`file:` 指向插件目录的**绝对路径**（用 `~` 也可以，DSH 会展开）。
2. **`dsh.profile.bundles`**：把**包名**追加进这个有序列表 —— 只有列表里的 bundle 才会被加载；
   插件自带的 `cordis.patch.yml` 会经 bundle 机制自动生效，**不需要**再在 profile 的
   `cordis.patch.yml` 里手写一条 `- id: dsh-connect-teleagent`。

> 两个名字不要混：**插件身份**是 `@anbulang/dsh-connect-teleagent`（依赖键与 bundle 名）；
> **Loader 条目 id** 仍是 `dsh-connect-teleagent`，它决定设置命名空间（`include:dsh-connect-teleagent`）。
> 0.14.0 只改了前者，所以升级后原有设置仍然有效。

改完 `package.json` 后，在该 profile 目录里装一次依赖（Plugins 页在后台做的也是这件事）：

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

> `desktop` 是 DSH 保留给桌面端的 profile，`dsh plugin --profile desktop ...` 会被拒绝，
> 所以这里直接用 pnpm。

最后**完全退出并重启 DeepSeek Harness**；「设置 → 模型」里即可看到 TeleAgent 的 5 个模型。

漏掉任一步的后果不一样，别只看"插件目录在不在"：

| 漏掉 | 现象 |
|---|---|
| `dependencies` | 启动时 stderr 打印 `skipping profile bundle "@anbulang/dsh-connect-teleagent": … cannot resolve profile bundle …`，插件不加载（DSH 仍能启动，所以很容易被忽略） |
| `dsh.profile.bundles` | 包装上了但从不激活 —— 模型列表里同样没有 TeleAgent |

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

配置入口有两个（同一个配置，两处都能改，改完下一轮请求生效）：
- **设置 → TeleAgent**：DSH 原生设置页里的精简表单（停用开关 / 模型勾选 / 工具白名单 / 积分自动领取）
- **设置 → 插件 → TeleAgent**：富卡片，除同样四项外还带账号、登录、积分余额、诊断等运维信息

- **模型开关**：取消勾选即从选择器移除，重启后保留
- **积分**：卡片显示余额与今日领取状态；可关自动领取
- **添加账号（多账号）**：卡片「账号 → 本机账号 → 添加账号」→ 在 TeleAgent 里退出旧账号、
  用另一个账号登录。插件会**先备份**旧账号登录态，检测到新账号后**原样写回**，
  两个账号都出现在列表里、随时可切换（见下节「多账号」）
- **换账号**：在「本机账号」列表点「切换」（只改 owner 文件，桌面端需完全退出）；
  切换后自动重建客户端，下一次请求用新账号
- **清除登录态**：卡片两步确认，只删 `token.json`，保留技能/记忆/个人数据

## 多账号

TeleAgent 桌面端同一时刻只有一个「当前账号」（`current-owner.json`），但数据目录按账号隔离
（`users/<scope>/`，任务记录 / 技能 / 记忆各一份）。本插件在桌面上加了**多账号使用**：

1. **添加账号**：卡片「账号 → 本机账号 → 添加账号」，或命令行：

   ```bash
   dsh-connect-teleagent accounts --add
   ```

   流程：备份当前账号 `token.json` → 唤起 TeleAgent → 你在应用里「设置 → 账号 → 退出登录」→
   用**另一个账号**登录 → 插件检测到新账号、把原账号凭据**原样写回** → 两个账号都能用。

2. **账号列表**：显示每个账号的昵称、有效期、**各自**的积分；「切换」写入
   `current-owner.json`（原子替换 + 备份回滚，只改 owner 指针，不动任何 token）。

3. **逐账号领取**：每个账号用自己的分区 cookie 领取每日积分，互不影响。

### 为什么需要「备份 → 写回」

逆向桌面端主进程可以确认：应用内「退出登录」会执行 `setToken("")` → 删除当前 owner 的
`app-auth/token.json`。所以换号登录会**顺手删掉原账号凭据**——不备份的话，插件里的多账号
永远退化成单账号（另一个账号变成 `no_token`，切过去也用不了）。

插件因此在 DSH home 下用原子写保存一份**原字节**备份（`teleagent-login-backup.json`）：

- 登录新账号后，只有原账号 token 文件**不存在**时才写回；文件已存在（同一账号重新登录）则
  **绝不覆盖**新凭据
- 超时 / 取消 / 流程中途崩溃，都会恢复原账号登录态（DSH 启动时也会先尝试恢复上次残留的备份）
- 全程不修改 `current-owner.json`、不生成任何新凭据

### 限制

- 登录窗是 TeleAgent 主进程 IPC 独占的，外部进程无法直接打开，所以「退出登录 → 登录新账号」
  这一步需要你在应用里操作；插件负责唤起、检测、备份与写回
- 切换账号写 owner 文件会被桌面端覆盖，因此**桌面端运行中拒绝切换**（先完全退出 TeleAgent）

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
| `lib/accounts.js` | 本机账号枚举 / 逐账号积分 / 切换 / 删除 |
| `lib/add-account.js` | 多账号登录入口：备份 token → 等换号登录 → 写回原账号凭据 |

内核独立运行在 `~/.dsh-teleagent-kernel/`，不碰桌面端数据目录。

## 配置

配置分**两类**，存放位置不同，不要混在一起（写错地方不会报错，只是不生效）：

| 类别 | 存放位置 | 由谁读写 | 包含字段 |
|---|---|---|---|
| **可配置设置** | **DSH 原生设置**（落到 profile 的 `cordis.patch.yml` 里本插件条目的 `config:`） | 宿主 settings 服务；「设置 → TeleAgent」表单与状态卡片都可写 | `providerDisabled`、`enabledModelIds`、`toolsAllowlist`、`autoClaimDaily` |
| **运行时配置** | profile 的 `cordis.patch.yml` 里本插件条目的 `config:`（手写层） | 宿主在 `apply(ctx, config)` 时传入 | `transport`、`guard`、`kernelAllowedTools`、`denyBuiltinTools`、`kernelReadyTimeoutMs`、`toolBridge`、`baseUrl`/`timeoutMs`、`probeOnBoot`/`probeTimeoutMs`、`ui.allowChatProbe` |

### 可配置设置（DSH 原生设置）

自 0.13.0 起，这四项统一存进 **DSH 自己的设置文档**，而不再由插件自己维护一个 JSON 文件。
好处是它们和其它插件设置放在一起，能在「设置」页里用原生表单改，改完**下一轮请求立即生效**（不需要重启）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `providerDisabled` | `false` | `true` = 整体停用，模型选择器里彻底消失 |
| `enabledModelIds` | `[]` | 空数组 = 全部启用 |
| `toolsAllowlist` | `[]` | `[]`/`null` = 全发；数组 = 只发匹配项（支持 `foo*`） |
| `autoClaimDaily` | `true` | 积分每日自动领取 |

**旧配置会自动迁移**：升级后首次启动时，若 settings 里还没有值，插件会把旧的
`~/.dsh/teleagent-plugin.json` 里的这四项搬进 settings，并在旧文件里打一个
`migratedToSettings: true` 标记。**旧文件不会被删除**（留着可回滚），但之后不再作为主存储写入 ——
只有宿主没有 settings 服务时它才继续当兜底存储。

> 优先级：**settings > 旧 JSON > 显式 config**。`toolsAllowlist` 尤其如此：
> 卡片/表单能改它，所以用户保存的值必须真正生效。


### 运行时配置（profile 的 `cordis.patch.yml`）

**改传输方式、内核参数、防护阈值只能走这里** —— 插件只在 `apply()` 时从 `config` 读这些值，
写进「设置」表单或旧 `teleagent-plugin.json` 都不会生效。编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- id: dsh-connect-teleagent
  name: '@anbulang/dsh-connect-teleagent'
  config:
    transport: kernel              # kernel（默认）或 direct
    kernelAllowedTools: []         # 允许内核额外执行的工具（默认空）
    denyBuiltinTools: true         # 默认禁止内核自带工具，只走 DSH 的 MCP 工具
    kernelReadyTimeoutMs: 60000
    toolBridge: true               # false = 完全不启用 DSH 工具桥
    guard: { maxConcurrent: 2, failureThreshold: 3, cooldownMs: 600000 }
```

改完需**重启 DeepSeek Harness**：上表这些 `config` 值只在 `apply()` 启动时读一次。
（`toolsAllowlist`、`enabledModelIds`、`providerDisabled`、`autoClaimDaily` 是例外 ——
它们来自上面那张表里的可配置设置，每轮请求热读取。）

环境变量（不分来源，启动时读取）：`TELEAGENT_KERNEL_PORT`（内核端口，默认 47823）、
`TELEAGENT_API_KEY`（上游 apiKey）。

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

### 省 token：工具白名单

DSH 会把**所有插件**的工具都塞进每次请求（实测 255 个，schema 约 875 KB ≈ 22 万 tokens），
而且每一步都会重发。

**设置 → TeleAgent** 里的「工具白名单」编辑框可以直接改（每行一个，
支持 `foo*` 通配，保存后下一轮生效）；也可以直接写 DSH 设置文档
（`~/.dsh/profiles/desktop/cordis.patch.yml` 里本插件条目的 `config.toolsAllowlist`）：

```jsonc
{
  "toolsAllowlist": [
    "bash", "read", "write", "edit", "glob", "grep",
    "web_*", "job_*", "task", "skill*", "ask_user_question", "todo_write",
    "mcp__rea__*"
  ]
}
```

- 不配置 / `null` / `[]` / `["*"]` = 全发（旧行为）
- 精确名字或后缀通配；配置写错导致一个都没匹配时会**回退全发**并记日志
- 设置卡片会显示「上次请求 约 N tokens · 工具 x/y」；工具超过 60 个时提示配置

## 防护

| 机制 | 默认 | 说明 |
|---|---|---|
| 并发上限 | 2 | 避免 DSH 并行调用造成突发 |
| 熔断阈值 | 连续 3 次 401/403 | 达到即暂停 10 分钟，期间快速失败 |
| 半开探测 | 1 个 | 冷却后先放一个请求试探 |

## 诊断与测试

```bash
node lib/doctor.js          # 环境/登录态/签名/模型目录自检（--json 可机器读）
npm test                    # 全部单元测试（不启动真内核）
npm run verify              # 单测 + CLI + 状态路由 + shim 形态 + 路由 + 卡片渲染（6 套件）
```

`npm test` 覆盖：模型清单、签名算法、生命周期、凭据/账号/积分、多账号登录（备份/写回/
超时取消/崩溃恢复）、内核传输（事件过滤、工具挂起、会话恢复、孤儿内核清理、思维链）、
图片附件与请求预算。

## 已知限制

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
