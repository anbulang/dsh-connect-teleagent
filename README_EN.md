<p align="center">
  <a href="https://github.com/anbulang/dsh-connect-teleagent/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/anbulang/dsh-connect-teleagent?label=release&color=2ea44f"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent/blob/main/package.json"><img alt="version" src="https://img.shields.io/badge/version-0.12.0-blue"></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-purple"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.1--rc.1%2B-orange"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="index" src="https://img.shields.io/badge/index-format--1-blueviolet"></a>
  <a href="https://github.com/anbulang/dsh-connect-teleagent"><img alt="tests" src="https://img.shields.io/badge/tests-262%20passing-brightgreen"></a>
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
- **Multi-account** — local account list plus an *Add account* entry; logging in another account
  **keeps the previous account's login state**, so you can switch at any time
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

1. **TeleAgent 2.7.1 or later** on macOS or Windows. Launch the app at least once and sign in.
2. DeepSeek Harness **0.2.1-rc.1+** (so the plugin index / Discover tab is available)
3. The upstream gateway apiKey configured locally (see below)

`dsh-connect-teleagent doctor --json` and the plugin diagnostics show the installed version. Model access requires a readable, supported version.

On Windows, run DSH as the same Windows user who signed in to TeleAgent. For a custom installation, set
`$env:TELEAGENT_APP_PATH = 'D:\Apps\TeleAgent\TeleAgent.exe'` before launching DSH.
The standalone CLI requires Node.js 22.19+ (22.x) or 24+.

On Windows, TeleAgent locks its points cookie database while running. After signing in, open the points page once and fully quit TeleAgent so the plugin can read it.

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
[Releases](https://github.com/anbulang/dsh-connect-teleagent/releases/latest) (the archive holds
the plugin only — it does **not** ship `scripts/`) and unpack it into
`~/.dsh/plugins/dsh-connect-teleagent/`. On macOS you can also use the bundled scripts:

```bash
mkdir -p ~/.dsh/plugins/dsh-connect-teleagent
tar -xzf dsh-connect-teleagent-<version>.tgz --strip-components=1 \
  -C ~/.dsh/plugins/dsh-connect-teleagent      # strip the archive's top-level package/ prefix
```

**Unpacking is only step one**: DSH does not discover that directory on its own, and you still
need **two registrations** in the profile (the repository's `scripts/install.sh` does exactly
these two things — when working from a git checkout you can just run `bash scripts/install.sh`
and it copies and registers in one go). To do it by hand, edit
`~/.dsh/profiles/desktop/package.json` (substitute your profile name if it is not `desktop`):

```jsonc
{
  "dependencies": {
    "dsh-connect-teleagent": "file:/Users/<you>/.dsh/plugins/dsh-connect-teleagent"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …leave the existing bundles untouched…
        "dsh-connect-teleagent"          // ← append to the end of the list
      ]
    }
  }
}
```

1. **`dependencies`** — a `file:` spec pointing at the plugin directory (an absolute path;
   `~` is expanded too).
2. **`dsh.profile.bundles`** — append the package name to this ordered list; only bundles listed
   there are loaded. The plugin's own `cordis.patch.yml` takes effect through the bundle
   mechanism, so you do **not** need to hand-write `- id: dsh-connect-teleagent` in the profile's
   `cordis.patch.yml`.

Then install the profile dependencies inside the profile directory (this is what the Plugins page
does in the background):

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

> `desktop` is reserved for the desktop app, and `dsh plugin --profile desktop ...` is rejected,
> so use pnpm directly.

Finally **quit DeepSeek Harness completely and restart it**; the five TeleAgent models appear
under *Settings → Models*.

Skipping either step fails differently — "the directory exists" is not evidence it works:

| Missing | Symptom |
|---|---|
| `dependencies` | stderr prints `skipping profile bundle "dsh-connect-teleagent": … cannot resolve profile bundle …` at startup and the plugin never loads (DSH still boots, so it is easy to miss) |
| `dsh.profile.bundles` | the package is installed but never activated — the model list still has no TeleAgent |

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
- **Add account (multi-account)**: settings card → *Account* → *Local accounts* → *Add account*,
  or `dsh-connect-teleagent accounts --add`. The plugin backs up the current login state,
  then you sign out in TeleAgent and sign in with another account; the previous credential is
  written back verbatim, and both accounts stay usable (see *Multi-account* below)
- **Switch account**: pick an account in the local list; it rewrites the owner pointer
  (TeleAgent must be fully quit) and rebuilds the client so the next request uses it
- **Clear login state**: two-step confirmation; deletes only `token.json`

## Multi-account

The TeleAgent desktop app keeps a single *current owner* (`current-owner.json`), but its data
directory is isolated per account (`users/<scope>/` — tasks, skills and memory each get a copy).
This plugin adds multi-account usage on top of it:

1. **Add account** — settings card → *Account* → *Local accounts* → *Add account*, or:

   ```bash
   dsh-connect-teleagent accounts --add
   ```

   Flow: back up the current `token.json` → launch TeleAgent → you sign out in the app
   (*Settings → Account → Sign out*) → sign in with **another** account → the plugin detects the
   new account and writes the previous credential back verbatim → both accounts are usable.

2. **Account list** — shows each account's name, expiry and **its own** credit balance.
   *Switch* rewrites `current-owner.json` (atomic replace + backup rollback); it only moves the
   owner pointer and never touches any token.

3. **Per-account claims** — each account claims its daily credits with its own partition cookies.

### Why backup + write back is required

Reverse engineering the desktop main process shows that in-app sign-out executes
`setToken("")` → deletes the current owner's `app-auth/token.json`. So signing in with another
account **also deletes the previous account's credential** — without a backup, multi-account in
this plugin would degrade to single-account (the other account shows `no_token` and cannot be used).

The plugin therefore stores a byte-for-byte backup atomically under the DSH home
(`teleagent-login-backup.json`):

- After the new account signs in, the previous `token.json` is written back **only if it is
  missing**; if it exists (same account re-login), the fresh credential is never overwritten
- Timeout, cancel, or a crash mid-flow all restore the previous login state (DSH also restores any
  leftover backup at startup)
- `current-owner.json` is never modified and no new credential is ever generated

### Limitations

- The login window is owned by the TeleAgent main process (`login:open` IPC) and cannot be opened
  from outside, so the sign-out → sign-in step is manual; the plugin handles launching, detection,
  backup and write-back
- Switching writes the owner file, which the desktop app overwrites while running — so switching is
  refused while TeleAgent is running (quit it first)

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
| `lib/accounts.js` | Local account listing / per-account credits / switch / delete |
| `lib/add-account.js` | Multi-account login: back up token → wait for sign-in → write back |

## Configuration

Configuration comes in **two kinds**, stored in different places. Mixing them up fails silently
(the value simply has no effect):

| Kind | Location | Read/written by | Fields |
|---|---|---|---|
| **Persisted settings** | `$DSH_HOME/teleagent-plugin.json` (default `~/.dsh/teleagent-plugin.json`) | the plugin itself; the settings card writes it | `enabledModelIds`, `providerDisabled`, `toolsAllowlist`, `welfare` |
| **Runtime configuration** | the `config:` of this plugin's entry in the profile's `cordis.patch.yml` | the host, passed to `apply(ctx, config)` | `transport`, `guard`, `kernelAllowedTools`, `denyBuiltinTools`, `kernelReadyTimeoutMs`, `toolBridge`, `baseUrl`/`timeoutMs`, `probeOnBoot`/`probeTimeoutMs`, `ui.allowChatProbe`, `welfare.*` |

### Persisted settings (`~/.dsh/teleagent-plugin.json`)

You normally never edit this by hand — *Settings → Plugins → TeleAgent* writes it. If you do edit
it, keep **only** these fields; runtime fields (such as `transport`) are ignored there:

```jsonc
{
  "enabledModelIds": ["chat-pro", "chat-flash"],  // [] = all enabled
  "providerDisabled": false,                      // true = provider off (disappears from the picker)
  "toolsAllowlist": null,                         // null/[] = send everything; array = only matches
  "welfare": { "autoClaimDaily": true }           // daily credit auto-claim
}
```

> Precedence note: `enabledModelIds` is **config > store** (an explicit host config beats the
> card), while `toolsAllowlist` is **store > config** (the card edits it, so a value saved in the
> UI must actually take effect).

### Runtime configuration (the profile's `cordis.patch.yml`)

**Switching transport, kernel options and guard thresholds only works here** — the plugin reads
them from `config` during `apply()`, so writing them into `teleagent-plugin.json` does nothing.
Edit `~/.dsh/profiles/desktop/cordis.patch.yml`:

```yaml
- id: dsh-connect-teleagent
  name: dsh-connect-teleagent
  config:
    transport: kernel              # kernel (default) or direct
    kernelAllowedTools: []         # extra tools the kernel may execute (empty by default)
    denyBuiltinTools: true         # deny kernel built-ins; only DSH's MCP tools remain
    kernelReadyTimeoutMs: 60000
    toolBridge: true               # false = disable the DSH tool bridge entirely
    guard: { maxConcurrent: 2, failureThreshold: 3, cooldownMs: 600000 }
```

Restart DeepSeek Harness afterwards: these `config` values are read once, during `apply()` at
startup. (`toolsAllowlist`, `enabledModelIds`, `providerDisabled` and `welfare.autoClaimDaily` are
the exceptions — they are persisted settings from the table above and re-read on every request.)

Environment (read at startup): `TELEAGENT_KERNEL_PORT` (default 47823), `TELEAGENT_API_KEY`.

## Credits

Balance via `/meter/super-agent/user/portal/points/detail`; daily claim at most once per day
(checked both upstream `claimed_today` and locally). Failures only affect the card.

## Cost & credits (important)

- The upstream bills **tokens × credit multiplier**: input tokens (**including tool schemas and full history**) + output tokens
- With long sessions and many plugin tools, a single step can reach **100k–360k input tokens** (measured ~10.09M input tokens across two days)
- Every tool call also triggers the kernel's `security/instruction/review` requests (kernel behavior, one for input and one for output)
- Tips to save credits:
  - Use `chat-flash` (x0.2) or `chat-pro` (x0.6) for long tasks; keep `chat-flagship` (x1.0) for short Q&A
  - Start new sessions and compact context often; disable unused DSH plugins to shrink the `tools` array
  - Claim the daily 100 credits; when the quota is exhausted the upstream returns 402/5005 and the plugin reports `insufficient quota` instead of retrying

### Saving tokens: tool allowlist

DSH puts **every plugin's tools** into each request (measured: 255 tools, ~875 KB schema
≈ 220k tokens), re-sent on every step.

Edit it in **Settings → Plugins → TeleAgent → Models → Tool allowlist** (one per line,
`foo*` wildcards supported; applies on the next request), or in `~/.dsh/teleagent-plugin.json`:

```jsonc
{
  "toolsAllowlist": [
    "bash", "read", "write", "edit", "glob", "grep",
    "web_*", "job_*", "task", "skill*", "ask_user_question", "todo_write",
    "mcp__rea__*"
  ]
}
```

- Unset / `null` / `[]` / `["*"]` = send everything (previous behavior)
- Exact names or suffix wildcards; if nothing matches, it falls back to all tools and logs a warning
- The settings card shows "last request: ~N tokens · tools x/y" and hints when more than 60 tools are sent

## Guard

| Mechanism | Default | Note |
|---|---|---|
| Max concurrency | 2 | Avoid DSH burst traffic |
| Circuit breaker | 3 consecutive 401/403 | Pause 10 minutes |
| Half-open probe | 1 request | Probe after cooldown |

## Diagnostics & tests

```bash
node lib/doctor.js          # environment / login / signature / model catalog checks
npm test                    # full unit suite (no real kernel)
npm run verify              # unit + CLI + status routes + shim shape + routes + UI render
```

## Known limitations

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
