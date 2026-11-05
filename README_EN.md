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
  Bring the models of your locally logged-in <b>TeleAgent</b> desktop app
  (China Telecom's AI assistant) into <b>DeepSeek Harness</b>.
  <br>
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

---

Reuses the existing login of the TeleAgent desktop app — no separate account needed.
By default the plugin drives TeleAgent's own Go kernel, so role structure, multi-turn
history, tool calls and streaming stay under DSH's control.

## ✨ Features

- **5 official models** — Smart / Flagship / Fast / Lite / Nano, with vision support and credit multipliers
- **Native kernel traffic** — the plugin drives TeleAgent's own kernel (credential decryption + native signing)
- **True streaming** — SSE forwarded as-is; `reasoning_content` (thinking) is shown as a collapsible row in DSH
- **Tool bridge (MCP)** — DSH tools are exposed to the model; tool calls still execute in DSH (cards + permissions)
- **Image input** — `chat-pro` / `chat-flash` via the host's durable attachment service
- **Credits** — balance display and idempotent daily claim, in the settings card and composer capsule
- **Subscribable** — ships a format-1 plugin index; install from DSH's *Discover* tab
- **Burst protection** — concurrency cap and auth-failure circuit breaker

## Models

| modelID | Name | Context | Output | Image | Credit |
|---|---|---|---|---|---|
| `chat-pro` | Smart | 400K | 65536 | ✅ | x0.6 |
| `chat-flagship` | Flagship | 400K | 65536 | ❌ | x1.0 |
| `chat-flash` | Fast | 400K | 65536 | ✅ | x0.2 |
| `chat-lite` | Lite | 100K | 65536 | ❌ | x0.5 |
| `chat-nano` | Nano | 100K | 65536 | ❌ | x0.1 |

## Requirements

1. macOS with the TeleAgent desktop app installed and **logged in** (`/Applications/TeleAgent.app`)
2. DeepSeek Harness **0.2.1-rc.1+** (so the plugin index / Discover tab is available)
3. The upstream gateway apiKey configured locally (see below)

## Install

### A. DSH plugin index (recommended)

1. Open **Plugins** → **More** next to *Experimental plugins* → enable **Custom plugin market**
2. Open **Discover** → **Add index source**:

   ```text
   https://raw.githubusercontent.com/anbulang/dsh-connect-teleagent/main/market/index.json
   ```

3. Pick **dsh-connect-teleagent**, install and restart DSH

### B. Package manager

```bash
dsh plugin --profile web add github:anbulang/dsh-connect-teleagent
```

### C. Release tarball

Download `dsh-connect-teleagent-<version>.tgz` from
[Releases](https://github.com/anbulang/dsh-connect-teleagent/releases/latest), unpack it into
`~/.dsh/plugins/dsh-connect-teleagent/`, or use the bundled scripts:

```bash
bash scripts/install.sh
bash scripts/uninstall.sh
```

Restart DeepSeek Harness after installing.

### Upstream apiKey

The plugin needs the gateway apiKey bundled in the TeleAgent desktop app. **The repository never
contains the real value**; configure it locally in one of two ways:

1. Environment variable: `export TELEAGENT_API_KEY=sk-...`
2. `local.secrets.json` in the repository root (git-ignored):

   ```json
   { "apiKey": "sk-..." }
   ```

## Usage

- **Model toggles** in the settings card; persisted across restarts
- **Credits**: balance + daily claim (idempotent); auto-claim can be disabled
- **Switch account**: after re-login in TeleAgent, the plugin rebuilds its client via the
  credential fingerprint — no DSH restart needed
- **Clear login state**: two-step confirmation; deletes only `token.json`

## How it works

Kernel mode (default): the plugin drives TeleAgent's own Go kernel, which decrypts the login
state and signs requests natively. `direct` mode (legacy) re-implements the signature in the
plugin as a fallback.

```text
DSH (pi-ai) ──OpenAI──► loopback shim (127.0.0.1:random port)
                              │  transparent proxy (messages/tools untouched)
                              ▼
                  TeleAgent kernel (Go, local ~/.dsh-teleagent-kernel)
                              │  credential decryption + native signing
                              ▼
                  TeleAgent upstream /superCowork/sapi/api/v1
```

| File | Responsibility |
|---|---|
| `lib/kernel.js` | Spawn kernel, sessions/SSE/multi-turn/images/tool suspension |
| `lib/shim.js` | Local OpenAI-compatible endpoint, transparent proxy |
| `lib/mcp-bridge.js` | Mount DSH tools into the kernel's MCP; execution stays in DSH |
| `lib/index.js` | Assemble the pi-ai provider and register the `teleagent` route |
| `lib/upstream.js` | `direct` fallback signing (see [docs/DESIGN.md](docs/DESIGN.md)) |

## Configuration

Stored in `$DSH_HOME/teleagent-plugin.json` (default `~/.dsh/teleagent-plugin.json`),
editable from the DSH settings card:

```jsonc
{
  "transport": "kernel",
  "kernelAllowedTools": [],
  "denyBuiltinTools": true,
  "kernelReadyTimeoutMs": 60000,
  "enabledModelIds": [],
  "guard": { "maxConcurrent": 2, "failureThreshold": 3, "cooldownMs": 600000 }
}
```

Environment: `TELEAGENT_KERNEL_PORT` (default 47823), `TELEAGENT_API_KEY`.

## Credits

Balance via `/meter/super-agent/user/portal/points/detail`; daily claim at most once per day
(checked both upstream `claimed_today` and locally). Failures only affect the card.

## Guard

| Mechanism | Default | Note |
|---|---|---|
| Max concurrency | 2 | Avoid DSH burst traffic |
| Circuit breaker | 3 consecutive 401/403 | Pause 10 minutes |
| Half-open probe | 1 request | Probe after cooldown |

## Diagnostics & tests

```bash
node lib/doctor.js          # environment / login / signature / model catalog checks
npm test                    # 233 unit tests (no real kernel)
npm run verify              # unit + CLI + status routes + shim shape + routes + UI render
```

## Known limitations

- **macOS only** — the TeleAgent desktop app is macOS-only
- **Image input** — only `chat-pro` / `chat-flash`; `chat-lite` hallucinates, `chat-nano` / `chat-flagship` reject
- **Protocol is reverse-engineered** — upstream/kernel updates may need adaptation (`doctor` surfaces signature drift)
- **Model behavior** — some models write progress narration into the answer body (not a rendering bug)
- **Not a disguised official client** — system prompt, tool set, TLS fingerprint and request rhythm differ

## Differences from the official client

| Dimension | Official client | This plugin |
|---|---|---|
| `messages[0]` | Fixed persona prompt | DSH's own system prompt |
| Tool set | Built-in client tools | DSH MCP tools (`dsh_*`) |
| TLS fingerprint | Electron/Chromium | Node undici (shim ↔ kernel is loopback) |
| Request rhythm | Human interaction | Possibly bursty; concurrency cap + breaker included |

Impersonating the official client is intentionally not supported: it would pollute model behavior
and does not help with account appeals.

## Account issues & logout

The card distinguishes *not logged in* from *account abnormal (credential invalid/banned)*.
Logout deletes only `<scope>/app-auth/token.json`, keeps skills/notes/logs, and closes the
TeleAgent desktop app first so it cannot rewrite the credential. Endpoint:
`POST /plugins/dsh-connect-teleagent/logout` (loopback only).

## Disclaimer

This project is interoperability research against a locally installed client, intended to connect
your own account to your own tools. Respect the TeleAgent / DeepSeek Harness terms of service and
local law; use at your own risk. The repository contains no real credentials, cookies or upstream keys.

## License

[MIT](LICENSE)
