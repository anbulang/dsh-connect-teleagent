# dsh-connect-teleagent

把本机登录的 **TeleAgent（天翼 AI 星辰超级智能体桌面版）** 的模型接入 DeepSeek Harness 模型选择器。

状态：**链路已端到端验证通过**（PoC 见 `poc/kernel-bridge.mjs`），插件工程待搭建。

---

## 一、已验证的事实

### 目标应用
| 项 | 值 |
|---|---|
| 应用 | `/Applications/TeleAgent.app`，版本 **2.7.1**（x86_64 Electron） |
| Bundle ID | `com.teleai.superagent` |
| 后端 kernel | `~/Library/Application Support` 之外的 `~/.local/share/TeleAgent/runtimes/super-agent-code/bin/TeleAgent`（Go，48 MB） |
| 主进程 | bytenode 字节码 `dist-electron/main.jsc`；**但真正可读的代码在 `dist-electron/main-runtime-*.js`（4 MB 明文）** |
| 数据目录 | `~/.local/share/TeleAgent/`（owner scope: `users/v1_public_<uid>/`） |
| 配置目录 | `~/.config/TeleAgent/users/<scope>/TeleAgent.jsonc` |

### 模型（provider = `NewApi`，上游 OpenAI 兼容）
| modelID | 名称 | 上下文 | 输出 | 积分倍率 |
|---|---|---|---|---|
| `chat-pro` | 智能 | 400K | 65536 | x0.6 |
| `chat-flagship` | 旗舰 | 400K | 65536 | x1.0 |
| `chat-flash` | 极速 | 400K | 65536 | x0.2 |
| `chat-lite` | 轻量 | 100K | 16384 | — |
| `chat-nano` | 轻速 | 100K | 16384 | — |

上游：`https://agent.teleai.com.cn/superCowork/sapi/api/v1`（apiKey 由本机配置提供：环境变量 `TELEAGENT_API_KEY` 或 `local.secrets.json`；仓库不提交真实值。头 `X-Route-Target: ops-gateway`，`useSuperAgentAuth: true`）

---

## 二、三道鉴权（全部已解）

### 1. 登录态：Electron safeStorage
`$APP_DATA/users/<scope>/app-auth/token.json` → `{version, encryptedToken, scheme:"safe_storage"}`

解密：
```
password = `security find-generic-password -s "TeleAgent Safe Storage" -w`
key      = PBKDF2-SHA1(password, "saltysalt", 1003 iters, 16 bytes)
plain    = AES-128-CBC(key, IV = 16 × 0x20).decrypt(base64(encryptedToken)[3:])   // 跳过 "v10"
```
明文 = `<tenant>:<JWT>`，JWT 含 `accountId/userId/tenant/accountName/exp`。

### 2. 本地鉴权：X-SA 签名
kernel 读环境变量 `SUPER_AGENT_LOCAL_SESSION_KEY`（32 字节随机 base64url），每个请求需：

| Header | 值 |
|---|---|
| `X-SA-Sign-Version` | `local-v1` |
| `X-SA-Timestamp` | `Date.now()` |
| `X-SA-Nonce` | 12 字节随机 hex |
| `X-SA-Signature` | `HMAC-SHA256(sessionKey, ["local-v1", METHOD, pathWithQuery, ts, nonce].join("\n")).base64url` |

> 注：主进程 JS 里是 `join(" ")`，但**服务端实际校验用换行分隔**（实测：空格 401，换行 200）。

### 3. 上游鉴权：kernel 代签
启动 kernel 时传 `SUPER_AGENT_AUTH_STATE`：
```
payload  = JSON.stringify({ token, deviceId, installId })
key      = SHA-256(sessionKey)
envelope = AES-256-GCM(key, iv=12B) → {version:"v1", iv, tag, ciphertext}  (均 base64url)
```
kernel 解密后自己给上游请求加 `X-SuperAgent-Timestamp/Device-Id/Signature` 与 `X-TeleAI-*` 头。
**插件不需要复刻上游签名。**

---

## 三、启动 kernel 的方式（已跑通）

- 二进制：`$APP_DATA/runtimes/super-agent-code/bin/TeleAgent`
- **无参数启动**；全部环境变量通过 **stdin** 传入：`4 字节大端长度 + JSON(env)`
- 默认监听 `8080`（日志写文件，不是 stdout）；就绪探针 `GET /global/health`
- 建议用 `XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_CACHE_HOME` 隔离，避免与桌面端抢 SQLite

必需 env：
```
SUPER_AGENT_APP_CONFIG_DIR / SUPER_AGENT_APP_DATA_DIR / SUPER_AGENT_APP_VERSION
OPENCODE_SERVER_USERNAME=super-agent  OPENCODE_SERVER_PASSWORD=<random>
SUPER_AGENT_LOCAL_SESSION_KEY=<sessionKey>
SUPER_AGENT_AUTH_STATE=<envelope JSON>
OPENCODE_CONFIG_CONTENT=<JSON: provider.NewApi{options{baseURL,apiKey,headers,useSuperAgentAuth},models}>
SUPER_AGENT_MODEL_CATALOG=<model-catalog.json 内容>
XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_CACHE_HOME
```

---

## 四、kernel HTTP API（opencode 风格，均需签名头）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/global/health` | 就绪探针 |
| GET | `/config/providers` | provider/模型清单 |
| POST | `/session` | 建会话 → `{id}` |
| POST | `/session/:id/message` | 发消息，body `{model:{providerID,modelID}, parts:[{type:"text",text}]}` → 返回完整消息（含 tokens/finish） |
| GET | `/event` | SSE 事件流（流式用） |

---

## 五、PoC 实测结果

```
$ node poc/kernel-bridge.mjs
reply: 你好
tokens: {"total":15001,"input":150,"output":3,"reasoning":0,"cache":{"read":14848,"write":0}}
```
→ 用本机 TeleAgent 登录态、经自建 kernel、真实打到上游并返回，`finish: stop`。

---

## 六、插件设计（下一步）

```
DSH llm adapter (provider: teleagent)
   │  spawn + 持有 kernel（进程内单例，随机 sessionKey）
   ▼
X-SA 签名 HTTP  →  kernel :8080  →  上游 TeleAgent 网关
```

要点：
1. plugin 启动时读取/解密 token，随机生成 sessionKey，spawn kernel，等待 ready；
2. 注册 provider `teleagent`，5 个模型（名称内嵌倍率，如 `智能 · x0.6`）；
3. 每个 DSH 请求 → `POST /session`（可复用会话）+ `POST /session/:id/message`，把 `parts` 映射为文本/工具调用；
4. 卡片：登录状态、账号昵称、kernel 健康度、模型开关（对应 `dsh-connect-workbuddy` 的 SettingsSection）；
5. kernel 退出自动重启；DSH 关闭时 SIGTERM 清理。

风险与对策：
- kernel 与桌面端共用 DB → 用独立 XDG 目录 + 独立 APP_DATA（已验证可用）；
- token 过期（JWT exp 约 30 天）→ 失败时提示重登录；
- 桌面端未安装 → 明确报错并给出安装引导。
