# dsh-connect-teleagent

把本机登录的 **[TeleAgent](https://www.teleai.com.cn)**（天翼 AI 星辰超级智能体桌面版）的模型接入 **DeepSeek Harness** 模型选择器。

复用桌面端已有登录态；上游网关的 apiKey 需按下面「上游 apiKey」一节在本机配置。

插件**直连 TeleAgent 上游**（标准 OpenAI 兼容接口），不经过 TeleAgent 的 agent 运行时。
因此 `messages` 的 role 结构、多轮历史、`tools`/`tool_calls` 全部原样保留，由 DSH 掌控。

## 模型

| modelID | 名称 | 上下文 | 输出 | 积分倍率 |
|---|---|---|---|---|
| `chat-pro` | 智能 | 400K | 65536 | x0.6 |
| `chat-flagship` | 旗舰 | 400K | 65536 | x1.0 |
| `chat-flash` | 极速 | 400K | 65536 | x0.2 |
| `chat-lite` | 轻量 | 100K | 65536 | x0.5 |
| `chat-nano` | 轻速 | 100K | 65536 | x0.1 |

在 DSH 里显示为 `智能 · x0.6` 这样，倍率来自 TeleAgent 自己的目录。

## 前置条件

1. macOS 已安装并**登录** TeleAgent 桌面版（`/Applications/TeleAgent.app`）
2. DSH 版本与 `dsh-connect-workbuddy` 相同代际（peer 依赖满足）

未登录时插件会在日志里报「TeleAgent 尚未登录」，卡片上会给出「去登录」按钮。
登录完成后**不需要重启 DSH**：插件会自动重建上游客户端。

## 安装

```bash
bash scripts/install.sh
```

然后**完全退出并重启 DeepSeek Harness**。重启后在「设置 → 模型」里应能看到 TeleAgent 的 5 个模型。

### 上游 apiKey

插件请求上游时需要一个网关 apiKey（TeleAgent 桌面端内置的常量）。**仓库不提交真实值**，
按以下任一方式在本机配置：

1. 环境变量：`export TELEAGENT_API_KEY=sk-...`
2. 仓库根目录 `local.secrets.json`（已 gitignore）：

   ```json
   { "apiKey": "sk-..." }
   ```

两者都没有时，插件会在日志/卡片里提示「未配置上游 apiKey」。

卸载：

```bash
bash scripts/uninstall.sh
```

## 工作原理

```
DSH (pi-ai) ──OpenAI──► loopback shim (127.0.0.1:随机端口)
                              │  透明转发（不改写 messages / tools）
                              ▼
                    TeleAgent 上游 /superCowork/sapi/api/v1
                              ▲
                        请求签名（本地计算）
                              │
              token.json（safeStorage） + device-meta.json
```

三个组件：

| 文件 | 职责 |
|---|---|
| `lib/upstream.js` | 读凭据、计算签名、直连上游 |
| `lib/shim.js` | 本地 OpenAI 兼容端点，**纯代理**（role/工具/流式全部透传） |
| `lib/index.js` | 装配 pi-ai provider 并注册 `teleagent` 路由 |

### 上游签名（逆向所得）

上游要求每个请求带一组 `X-Superagent-*` 头，签名是**两步 HMAC-SHA256**：

**第 1 步**（绑定 installId，得到中间密钥 k1）：

```
key = JWT 第三段                     # token.split(".")[2]
msg = "superagent-auth-v1/{token}/{installId}/{ts}/{nonce}"
k1  = hex(HMAC-SHA256(key, msg))
```

**第 2 步**（请求签名）：

```
key = k1                             # 作为 64 字符十六进制文本
msg = "superagent-auth-v1\n{METHOD}\n{pathname}\n{ts}\n{nonce}\n{appVersion}\n{sha256hex(body)}"
sig = hex(HMAC-SHA256(key, msg))
```

要点：

- `pathname` 必须包含 `/superCowork/sapi` 前缀（错则 `40104 invalid signature`）
- `Authorization: Bearer <内置 apiKey>`，**用户 token 走 `X-Token` 头**
- 每次请求都要新的 `ts`（Unix 秒）+ `nonce`（UUID）
- body 哈希必须对**实际发出的字节**计算

完整逆向过程见 [`docs/ROADMAP.md`](docs/ROADMAP.md) P8。

### 凭据

| 数据 | 位置 | 处理 |
|---|---|---|
| 用户 token | `~/.local/share/TeleAgent/users/<scope>/app-auth/token.json` | safeStorage 加密，用钥匙串 `TeleAgent Safe Storage` 解密（AES-128-CBC，PBKDF2-SHA1 1003 轮） |
| 设备标识 | `~/.local/share/TeleAgent/app-auth/device-meta.json` | 直接读取 `deviceId` / `installId` |
| 网关 apiKey | 桌面端内置常量 | 仅随请求头发送 |

token 只存在于插件进程内存与上游请求中，**从不写入 DSH 配置、日志或状态接口**。

## 能力矩阵（均已实测）

| 能力 | 说明 |
|---|---|
| **真流式** | 上游 SSE 字节级转发，`[DONE]` 正常结束 |
| **多轮会话** | 调用方携带完整历史，插件不保存任何会话状态 |
| **role 透传** | `system` / `user` / `assistant` / `tool` 原样上送 |
| **工具执行** | `tools` / `tool_calls` 原样透传，由 DSH 执行（无双层执行） |
| **模型开关** | 卡片里取消勾选即从选择器移除，设置在重启后保留 |

## 传输方式

| 模式 | 说明 |
|---|---|
| **kernel（默认）** | 驱动 TeleAgent 自己的 Go 内核发请求：内核解密登录态、自己加签。流量是原生流量 |
| `direct` | 插件自己复刻签名直连上游（旧实现，保留作回退） |

```jsonc
{ "transport": "kernel" }   // 默认；改 "direct" 可回退
```

配置项：`kernelAllowedTools`（默认空 = 内核不执行任何工具）、
`kernelReadyTimeoutMs`（默认 60000）、环境变量 `TELEAGENT_KERNEL_PORT`（默认 47823）。

kernel 模式的内核独立运行在 `~/.dsh-teleagent-kernel/`，不碰桌面端数据目录。

## 积分

| 项 | 说明 |
|---|---|
| **余额** | 设置卡片与输入框胶囊显示，来自 `/meter/super-agent/user/portal/points/detail` |
| **每日领取** | 默认开启自动领取，每天一次；也可在卡片里手动点「领取」 |
| **幂等** | 上游 `claimed_today` + 本地 `lastClaimDate` 双重判断，同一天绝不重复领取 |
| **鉴权** | portal 服务用 cookie + `X-Token`，与聊天网关的签名机制不同（详见 `lib/portal.js` 注释） |
| **失败影响** | 仅卡片提示，不影响模型可用 |

关闭自动领取：卡片里把「自动领取」开关关掉，或写配置：

```jsonc
{ "welfare": { "autoClaimDaily": false } }
```

## 防护

| 机制 | 默认 | 说明 |
|---|---|---|
| 并发上限 | 2 | 避免 DSH 并行调用造成突发 |
| 熔断阈值 | 连续 3 次 401/403 | 达到即暂停 10 分钟，期间请求快速失败 |
| 半开探测 | 1 个 | 冷却后先放一个请求试探 |

可在插件配置里覆盖：

```jsonc
{ "guard": { "maxConcurrent": 2, "failureThreshold": 3, "cooldownMs": 600000 } }
```

## 配置

设置保存在 `$DSH_HOME/teleagent-plugin.json`（默认 `~/.dsh/teleagent-plugin.json`）：

```jsonc
{
  "enabledModelIds": ["chat-pro", "chat-flash"]   // 空数组 = 全部启用
}
```

## 测试

```bash
npm test              # 49 个单元测试（含签名算法确定性/敏感性）
node test-routes.mjs  # 12 项 HTTP 路由测试
node test-e2e.mjs     # 11 项端到端（真实调用上游，消耗少量额度）
```

单元测试覆盖：模型清单、状态文档、签名算法（确定性、body/nonce/ts/path 敏感性）、
凭据诊断、设置持久化、生命周期。

## 诊断

```bash
node lib/doctor.js          # 人类可读
node lib/doctor.js --json   # 机器可读
```

检查项：应用安装、数据目录、登录态、钥匙串、设备标识、**签名自检**、模型目录、工具调用。

其中「签名自检」会真实发一个 `max_tokens: 1` 的请求验证整条链路——
如果 TeleAgent 升级导致签名算法变更，会明确报出来，而不是让用户面对一堆 401。

## 变更记录

逐版变更见 [CHANGELOG.md](CHANGELOG.md)。版本为 `0.x`：尚未稳定，依赖逆向出来的私有协议。

## 已知限制

- **图片输入：仅部分模型支持**（v0.5.1 实测，已接入）。
  `chat-pro` / `chat-flash` 可用 OpenAI 风格
  `{type:'image_url', image_url:{url:'data:image/png;base64,…'}}` 内容块识图；
  `chat-lite` 会返回与图片无关的内容（胡编，不算支持），
  `chat-nano`/`chat-flagship` 明确拒绝。客户端目录里的 `Input.Image:false` 声明与实测不符，以实测为准。
- **没有签到/积分体系**：客户端 4MB 明文 JS 与 kernel 二进制里均无相关代码，
  模型目录只有 `creditMultiplier`（倍率），没有余额接口。
- **签名算法依赖逆向**：TeleAgent 若变更协议，需更新 `lib/upstream.js`（doctor 会先发现）。
- `chat-flash` 等模型会把思考过程直接写进正文（`reasoning: 0`），是模型行为，不是插件问题。

## 与官方客户端的可识别差异（重要）

本插件**不伪装成官方客户端**，因此请求在某些维度上与官方客户端可区分。
这不是缺陷，是一个明确的取舍：

| 维度 | 官方客户端 | 本插件 | 说明 |
|---|---|---|---|
| `messages[0]` | 固定 5045 字符人格串（`You are 星辰超级智能体…`） | DSH 自己的 system 提示词，或无 | **明文 body，最容易被匹配** |
| `X-Session-Id` / `X-Message-Id` / `X-Teleai-Root-Session-Id` | 每次都有 | 已补齐（本地生成，协议正确） | 已对齐 |
| TLS 指纹 | Electron/Chromium | Node undici | 网关层可见 |
| 请求节奏 | 人工交互 | 可能突发/并发 | 建议配合熔断 |

**为什么不注入官方人格串**：

1. 会污染行为——模型会自称「星辰超级智能体」并弱化 DSH 的指令；
2. 属于伪造客户端身份，在账号申诉时反而说不清；
3. 封禁是**账号级**的（换新 token 依然被拒），补人格串并不能解除既有标记。

如果你需要最大化兼容性，可以自行在 `lib/upstream.js` 的 `chat()` / `chatStream()`
里把人格串前置为第一条 system —— 但请清楚代价。

## 账号异常与清除登录态

卡片会区分两种情况：

| 情况 | 卡片显示 | 可做的操作 |
|---|---|---|
| 本机没有登录态 | `未登录` + 原因 | **去登录** |
| 有凭据但失效 / 账号被封 | `账号异常` + 原因 | **去登录** 或 **清除登录态** |

「清除登录态」分两步：第一次点击进入确认态，第二次才执行。

**只会删除 `<scope>/app-auth/token.json`**，保留 `skills/`、`USER.md`、日志等全部个人数据。
执行前会先退出 TeleAgent 桌面端（否则它会把凭据重写回来）。
对应接口：`POST /plugins/dsh-connect-teleagent/logout`（仅 loopback）。

这样被封的账号可以摘掉，换号登录后新凭据自动生效。

## 换账号

1. 在 TeleAgent 桌面端点卡片→「去登录」，或在应用内直接退出后重新登录；
2. 插件按 `token.json` 的 mtime+size 计算**凭据指纹**，指纹一变就重建客户端，
   并清除上一个账号的错误状态（例如封禁提示）——**不需要重启 DSH**；
3. 多个账号目录并存时，优先读 `current-owner.json`，否则选 `token.json` 最新的那个；
4. 用 `node lib/doctor.js` 确认新账号的登录态与签名自检。

## 与 dsh-connect-workbuddy 的差异

WorkBuddy 有官方开放的插件 OAuth 端点（`/v2/plugin/auth/*`），可以纯浏览器完成登录。
TeleAgent 没有这类端点，登录仍通过唤起桌面端完成（`lib/lifecycle.js`），
但**模型调用**已和 WorkBuddy 一样是直连上游的纯 OpenAI 客户端。

## 免责声明

本项目是对本机已安装客户端行为的**互操作研究**，用于把已有账号接到自己的工具链里；
请遵守 TeleAgent / DeepSeek Harness 的使用条款与当地法律，风险自负。
仓库不包含任何真实账号凭据、cookie 或上游密钥。
