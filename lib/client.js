/**
 * dsh-connect-teleagent 浏览器端：把 TeleAgent 状态面板挂到「设置 → 插件」。
 *
 * 视觉规范对齐 DSH 内置卡片（参考 dsh-connect-workbuddy）：
 *  - 只使用 `--dsw-alias-*` 主题令牌，并给出深色回退值，深浅主题都不会失真
 *  - 卡片容器用 bg-secondary + border-l1 + radius-lg，与宿主面板同层级
 *  - 行式布局：左侧标签/说明，右侧控件；行间用 1px border-l1 分隔
 *  - 状态用胶囊（成功/警告/错误三态），不用彩色大色块
 *
 * 严格遵循 DSH 客户端插件规范：
 *  - 不 require 任何 Harness Client 包（dsh.client.inject 只用于排序激活）
 *  - 整个 apply 包 try/catch：卡片挂了也不影响模型可用
 */

window.__ModuleLoader__.load({
  id: 'dsh-connect-teleagent',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const BASE = '/plugins/dsh-connect-teleagent'
    const STATUS_PATH = BASE + '/status'
    const MODELS_PATH = BASE + '/models'
    const LOGIN_PATH = BASE + '/login'
    const LOGOUT_PATH = BASE + '/logout'
    const ACCOUNTS_PATH = '/plugins/dsh-connect-teleagent/accounts'
    const PROBE_PATH = '/plugins/dsh-connect-teleagent/probe'
    const WELFARE_PATH = BASE + '/welfare'
    const TOOLS_PATH = BASE + '/tools'

    /** 主题令牌：统一带深色回退，避免宿主换主题时出现"看不见"的字 */
    const C = {
      border: 'var(--dsw-alias-border-l1, rgba(127,127,127,.22))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(127,127,127,.34))',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06))',
      layer3: 'var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))',
      text: 'var(--dsw-alias-label-primary, inherit)',
      text2: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.95))',
      text3: 'var(--dsw-alias-label-tertiary, rgba(127,127,127,.75))',
      ok: 'var(--dsw-alias-state-success-primary, #3fb950)',
      warn: 'var(--dsw-alias-state-warn-primary, #d29922)',
      bad: 'var(--dsw-alias-state-error-primary, #f85149)',
      brand: 'var(--dsw-alias-brand-primary, #4c8dff)',
      radius: 'var(--dsw-radius-lg, 12px)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    }

    const TONE = {
      ok: { color: C.ok, bg: 'color-mix(in srgb, ' + C.ok + ' 14%, transparent)' },
      warn: { color: C.warn, bg: 'color-mix(in srgb, ' + C.warn + ' 14%, transparent)' },
      bad: { color: C.bad, bg: 'color-mix(in srgb, ' + C.bad + ' 14%, transparent)' },
      muted: { color: C.text3, bg: C.layer2 },
    }

    // ---------------------------------------------------------------- 设置读写
    //
    // DSH 原生设置是唯一真相源（契约 .temp/settings-contract.md §6）：
    //
    //   读：settingsScope.getSnapshot().value.<field>   →  回退 /status
    //   写：settingsScope.set(field, value)              →  回退现有 HTTP 路由
    //
    // settingsScope 由 configForms.whileServed(...) 绑定。configForms 这个服务
    // 在老宿主上根本不存在 —— 那时 settingsScope 永远是 undefined，本文件里
    // 所有读写都退化成原来的 HTTP 行为，不会崩（这是硬约束，不是优化）。

    /**
     * `settings.section` 的 id：**插件自有的稳定值**，不是 Loader entry id。
     *
     * 两者必须分开（契约 §7）：namespace 是 Loader entry id（部署可以写成
     * `include:<id>`，见 SETTINGS_NAMESPACE_CANDIDATES），而 section id 是我们
     * 自己的导航地址 —— 宿主用 `settings.section.icon` 的 `{ only: row.id }`
     * 去匹配它，只有这个值是稳定的。
     *
     * 为什么配置入口从 `plugins.bundle.config` / `plugins.row.config` 搬过来
     * （对齐 dsh-connect-workbuddy 5.19.0）：那一对是 **keyed** 槽位，页面用
     * `entryKey: pkg.name` 渲染、并且拿 `ledger.bundles.has(pkg.name)` 做精确
     * 字符串比较去门控；同一份代码挂在不同 Loader entry id 下就一个字都不显示
     * —— 没有 section、没有占位、没有报错。`settings.section` 是按 id 注册的
     * 列表槽位，id 是我们自己的，这类不匹配整体消失。
     *
     * 同时**删除**上面那两个 keyed 注册：同一项配置有两个编辑入口，用户改了
     * 一个、另一个看着没变，是更糟的体验。卡片（`settings.plugins.tab`）保留，
     * 它是运维视图（账号/登录/诊断/福利），不是配置表单。
     */
    const SETTINGS_SECTION_ID = 'dsh-connect-teleagent'

    /**
     * 浏览器端要跟的 namespace 拼写，按优先顺序。
     *
     * `describe()` 用 Loader entry id 作 key，而 profile patch 决定那个 id，
     * 所以插件只能**问**、不能假设。观察到的拼写是裸包名和带 `include:` 前缀
     * 的形式。`configForms.whileServed` 会跟随全部候选，并在镜像晚到时重跑
     * 回调 —— 这正是「宿主在 apply 之后才填镜像」也不会绑错 namespace 的原因。
     */
    const SETTINGS_NAMESPACE_CANDIDATES = ['dsh-connect-teleagent', 'include:dsh-connect-teleagent']

    /** 四个可配置字段（契约 §2，唯一权威列表） */
    const SETTINGS_FIELDS = ['providerDisabled', 'enabledModelIds', 'toolsAllowlist', 'autoClaimDaily']

    /**
     * 设置页左侧导航里显示的名字。
     *
     * 客户端 bundle 读不到 locale/*.json，而 locale 的 `meta.title` 是裸包名
     * （`dsh-connect-teleagent`），当导航标签太长也不好认。这里用卡片标题的
     * 同一个短名，两处看到的是同一个插件名。
     */
    const SETTINGS_SECTION_LABEL = 'TeleAgent'

    /** 任意脏值 → 非空字符串数组（保持顺序，去重交给调用方） */
    function normalizeIdList(value) {
      if (!Array.isArray(value)) return []
      return value.filter((x) => typeof x === 'string' && x.length > 0)
    }

    /**
     * 工具白名单归一化。
     *
     * 契约 §2：插件语义里 `null`（store 的历史值）和 `[]`（settings schema 只能
     * 表达的形式）**等价** = 全量发送。所有读路径都必须给出同一个答案。
     */
    function normalizeToolsList(value) {
      return normalizeIdList(value)
    }

    /** settings 快照的原始 value；拿不到（服务缺失/宿主在抛）时返回 undefined */
    function settingsSnapshotOf(scope) {
      if (scope === undefined || scope === null || typeof scope.getSnapshot !== 'function') return undefined
      try {
        const snapshot = scope.getSnapshot()
        const value = snapshot && snapshot.value
        if (!value || typeof value !== 'object') return undefined
        return value
      } catch {
        return undefined
      }
    }

    function hasSettingsField(value, field) {
      return value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(value, field)
    }

    /**
     * settings 快照里的四个字段（归一化后）。
     *
     * 快照拿不到、或者一个字段都没有（服务在、但镜像还没填）时返回 **undefined**：
     * 「读不到」和「读到了默认值」必须分开 —— 后者会拿 false/[] 去覆盖 /status
     * 的正确答案。
     */
    function readSettingsValue(scope) {
      const value = settingsSnapshotOf(scope)
      if (value === undefined) return undefined
      if (!SETTINGS_FIELDS.some((field) => hasSettingsField(value, field))) return undefined
      return {
        providerDisabled: value.providerDisabled === true,
        enabledModelIds: normalizeIdList(value.enabledModelIds),
        toolsAllowlist: normalizeToolsList(value.toolsAllowlist),
        autoClaimDaily: value.autoClaimDaily !== false,
      }
    }

    function sameFieldValue(after, field, value) {
      if (field === 'providerDisabled' || field === 'autoClaimDaily') return after[field] === value
      return JSON.stringify(after[field] ?? []) === JSON.stringify(value ?? [])
    }

    /**
     * 只走 settings scope 写一个字段，并**回读校验**。
     *
     * `scope.set()` resolve 不等于真的存下了（workbuddy 的注释里记过这个坑），
     * 所以写完回读快照、逐字段比较。回读不到（镜像还没到）时以 set 的返回为准。
     *
     * @returns {{ok: boolean, via: 'scope'|'none', value?: any, error?: string}}
     */
    async function setViaScope(scope, field, value) {
      if (scope === undefined || scope === null || typeof scope.set !== 'function') {
        return { ok: false, via: 'none' }
      }
      let snapshot
      try {
        snapshot = typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : undefined
      } catch {
        snapshot = undefined
      }
      // 宿主把设置标成只读（例如 profile 层不允许改）时不要假装写成功
      if (snapshot && snapshot.writable === false) {
        return { ok: false, via: 'none', error: 'DSH 设置当前只读' }
      }
      let delivered
      try {
        delivered = await scope.set(field, value)
      } catch (error) {
        return { ok: false, via: 'scope', error: error?.message ?? String(error) }
      }
      if (delivered === false) return { ok: false, via: 'scope', error: 'DSH 设置没有接受这次写入' }
      const after = readSettingsValue(scope)
      if (after !== undefined && !sameFieldValue(after, field, value)) {
        return { ok: false, via: 'scope', error: 'DSH 设置回读不一致' }
      }
      return { ok: true, via: 'scope', value }
    }

    /**
     * 写一个配置字段：**scope 优先，失败或缺失回退 HTTP**。
     *
     * `fallback(field, value)` 的返回值兼容两种形态：
     *  - 老宿主：`true`
     *  - task-4 的新路由契约：`{ ok, via: 'settings'|'store', value?, reason? }`
     *
     * @returns {{ok: boolean, via: 'scope'|'http'|'none', value?: any, error?: string}}
     */
    async function writeSetting({ scope, field, value, fallback }) {
      const viaScope = await setViaScope(scope, field, value)
      if (viaScope.ok) return viaScope
      if (typeof fallback !== 'function') return viaScope
      let out
      try {
        out = await fallback(field, value)
      } catch (error) {
        return { ok: false, via: 'http', error: error?.message ?? String(error) }
      }
      if (out === true) return { ok: true, via: 'http', value }
      if (out && typeof out === 'object') {
        if (out.ok === true) return { ok: true, via: 'http', value: out.value ?? value }
        return { ok: false, via: 'http', error: out.error ?? out.reason ?? '保存失败' }
      }
      return { ok: false, via: 'http', error: '保存失败' }
    }

    /** POST JSON，并把路由返回统一成 writeSetting 认得的结果 */
    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, reason: (data && data.error) || 'HTTP ' + res.status }
      if (data && data.ok === false) return { ok: false, reason: data.error ?? data.reason ?? '保存失败' }
      return data && typeof data === 'object' ? data : { ok: true }
    }

    /**
     * 四项字段各自的 HTTP 回退路由（老宿主 / scope 不可用时的唯一路径）。
     * 这些就是迁移前卡片一直在打的接口，参数与语义**一个字都没改**。
     */
    async function httpFallbackFor(field, value) {
      switch (field) {
        case 'providerDisabled':
          return postJson(MODELS_PATH, { providerDisabled: value === true })
        case 'enabledModelIds':
          return postJson(MODELS_PATH, { enabledModelIds: normalizeIdList(value) })
        case 'toolsAllowlist': {
          const list = normalizeToolsList(value)
          // 路由用 null 表示「恢复全量」，settings 里统一写 []
          return postJson(TOOLS_PATH, { toolsAllowlist: list.length > 0 ? list : null })
        }
        case 'autoClaimDaily':
          return postJson(WELFARE_PATH, { action: 'auto', enabled: value === true })
        default:
          return { ok: false, reason: '未知配置字段 ' + String(field) }
      }
    }

    /** 卡片/设置页共用的写入口：绑定到的 scope + 自动回退 */
    function writeSettingsField(scope, field, value) {
      return writeSetting({ scope, field, value, fallback: httpFallbackFor })
    }

    /**
     * settings 优先的读：把 /status 里的同名字段换成 settings 的值。
     *
     * 只覆盖快照里**确实存在**的字段；某字段缺席（镜像还没填）时保留 /status
     * 的答案，避免用默认值把真实状态盖成 false。
     */
    function overlayStatus(scope, status) {
      const value = settingsSnapshotOf(scope)
      if (!status || typeof status !== 'object' || value === undefined) return status
      const next = { ...status }
      if (hasSettingsField(value, 'providerDisabled')) {
        next.provider = { ...(status.provider || {}), disabled: value.providerDisabled === true }
      }
      if (hasSettingsField(value, 'toolsAllowlist')) {
        next.toolsAllowlist = normalizeToolsList(value.toolsAllowlist)
      }
      if (hasSettingsField(value, 'enabledModelIds')) {
        const ids = normalizeIdList(value.enabledModelIds)
        next.models = (Array.isArray(status.models) ? status.models : []).map((model) => ({
          ...model,
          // 空数组 = 全部启用（插件历史语义，契约 §2）
          enabled: ids.length === 0 || ids.includes(model.id),
        }))
      }
      return next
    }

    /** 福利快照同理：autoClaimDaily 以 settings 为准 */
    function overlayWelfare(scope, welfare) {
      const value = settingsSnapshotOf(scope)
      if (!welfare || typeof welfare !== 'object' || value === undefined) return welfare
      if (!hasSettingsField(value, 'autoClaimDaily')) return welfare
      return { ...welfare, autoClaimDaily: value.autoClaimDaily !== false }
    }

    /** 没有 settings 时的读回退：从 /status 推出四个字段 */
    function valuesFromStatus(status) {
      const models = Array.isArray(status?.models) ? status.models : []
      return {
        providerDisabled: status?.provider?.disabled === true,
        enabledModelIds: models.filter((model) => model.enabled !== false).map((model) => model.id),
        toolsAllowlist: normalizeToolsList(status?.toolsAllowlist),
        autoClaimDaily: status?.welfare?.autoClaimDaily !== false,
      }
    }

    // ---------------------------------------------------------------- 原子组件

    function Pill({ tone = 'muted', children }) {
      const t = TONE[tone] ?? TONE.muted
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, lineHeight: '20px', fontWeight: 500,
          padding: '0 8px', borderRadius: 999,
          color: t.color, background: t.bg,
          border: '1px solid ' + t.color,
          whiteSpace: 'nowrap',
        },
      },
        h('span', { style: { width: 5, height: 5, borderRadius: 999, background: t.color, flexShrink: 0 } }),
        children,
      )
    }

    function Button({ children, onClick, disabled, variant = 'default', title }) {
      const base = {
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        height: 28, padding: '0 12px', borderRadius: 8,
        fontSize: 12, fontWeight: 500, font: 'inherit',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background .15s ease, border-color .15s ease',
        whiteSpace: 'nowrap',
      }
      const skin = variant === 'primary'
        ? { color: '#fff', background: C.brand, border: '1px solid ' + C.brand }
        : variant === 'danger'
          ? { color: C.bad, background: 'transparent', border: '1px solid ' + C.bad }
          : { color: C.text, background: C.layer3, border: '1px solid ' + C.borderStrong }
      return h('button', {
        type: 'button', onClick, disabled, title,
        style: { ...base, ...skin },
        onMouseEnter: (e) => { if (!disabled) e.currentTarget.style.background = variant === 'primary' ? C.brand : C.hover },
        onMouseLeave: (e) => { e.currentTarget.style.background = skin.background },
      }, children)
    }

    function Switch({ checked, onChange, disabled }) {
      const w = 34, hgt = 20
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        disabled,
        onClick: () => { if (!disabled) onChange(!checked) },
        style: {
          position: 'relative', width: w, height: hgt, flexShrink: 0,
          borderRadius: 999, border: '1px solid ' + (checked ? C.brand : C.borderStrong),
          background: checked ? C.brand : 'transparent',
          cursor: disabled ? 'default' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          transition: 'background .15s ease, border-color .15s ease',
          padding: 0,
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? w - 16 : 2,
          width: 14, height: 14, borderRadius: 999,
          background: checked ? '#fff' : C.text3,
          transition: 'left .15s ease',
        },
      }))
    }

    function Row({ title, description, children }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '12px 0',
          borderTop: '1px solid ' + C.border,
        },
      },
        h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
          h('span', { style: { fontSize: 13, fontWeight: 500, color: C.text } }, title),
          description
            ? h('span', { style: { fontSize: 11.5, lineHeight: '16px', color: C.text3 } }, description)
            : null,
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } }, children),
      )
    }

    function Section({ title, hint, children }) {
      return h('section', { style: { marginTop: 18 } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 } },
          h('h4', { style: { margin: 0, fontSize: 12, fontWeight: 600, letterSpacing: '.02em', color: C.text2 } }, title),
          hint ? h('span', { style: { fontSize: 11, color: C.text3 } }, hint) : null,
        ),
        children,
      )
    }

    function Notice({ tone = 'warn', children }) {
      const t = TONE[tone] ?? TONE.warn
      return h('div', {
        style: {
          display: 'flex', gap: 8, alignItems: 'flex-start',
          margin: '10px 0 0', padding: '8px 10px',
          borderRadius: 8, background: t.bg,
          border: '1px solid ' + t.color,
          fontSize: 11.5, lineHeight: '17px', color: C.text,
        },
      },
        h('span', { style: { color: t.color, flexShrink: 0 } }, '●'),
        h('span', { style: { minWidth: 0 } }, children),
      )
    }

    /** 多账号列表：每行一个账号，显示余额与切换按钮 */
    function AccountList({ accounts, appRunning, current, busy, onSwitch, onDelete, confirming, onConfirm, canDeleteAccount }) {
      if (!Array.isArray(accounts) || accounts.length === 0) return null
      return h('div', {
        style: {
          marginTop: 8, padding: '4px 0',
          display: 'flex', flexDirection: 'column',
        },
      },
        accounts.map((a) => {
          const pts = a.points
          const isCurrent = a.scope === current || a.isCurrent === true
          return h('div', {
            key: a.scope,
            style: {
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 0', borderTop: '1px solid ' + C.border,
            },
          },
            h('span', { style: { fontSize: 11, color: isCurrent ? C.ok : C.text3, width: 12 } }, isCurrent ? '★' : ''),
            h('div', { style: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('span', { style: { fontSize: 12.5, fontWeight: isCurrent ? 600 : 400, color: C.text } },
                  a.accountName ?? (a.userId ? a.userId.slice(-6) : a.scope.slice(-6))),
                isCurrent ? h(Pill, { tone: 'ok' }, '当前') : null,
                a.state !== 'ok' ? h(Pill, { tone: 'warn' }, a.detail ?? a.state) : null,
              ),
              h('div', { style: { fontSize: 11, color: C.text3, display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h('span', null, pts ? (pts.ok ? '积分 ' + Number(pts.balance).toFixed(2) : '积分读取失败') : '积分未读取'),
                a.daysLeft != null ? h('span', null, '剩余 ' + a.daysLeft + ' 天') : null,
                h('span', { style: { fontFamily: C.mono, opacity: 0.7 } }, a.scope),
              ),
            ),
            isCurrent
              ? null
              : h(Button, {
                  onClick: () => onSwitch(a.scope),
                  disabled: busy || a.canSwitch !== true,
                  title: a.canSwitch === true
                    ? '切换到这个账号（会退出 DSH 吗？不会：只改 owner 文件）'
                    : (appRunning ? 'TeleAgent 桌面端运行中，需先完全退出' : (a.hasToken ? '不可切换' : '该账号没有登录凭据')),
                }, a.canSwitch === true ? '切换' : '不可切换'),
            isCurrent
              ? null
              : h(Button, {
                  variant: 'danger',
                  onClick: () => (confirming === a.scope ? onDelete(a.scope) : onConfirm(a.scope)),
                  disabled: busy || a.canDelete === false || canDeleteAccount === false,
                  title: canDeleteAccount === false
                    ? '当前宿主仍是旧版本：重启 DeepSeek Harness 后删除才可用'
                    : (confirming === a.scope
                        ? '再点一次即把该账号移入回收站（可恢复）；个人数据不删除'
                        : (a.canDelete === false ? '桌面端运行中，需先退出' : '删除该账号（移入回收站，可恢复）')),
                }, confirming === a.scope ? '确认删除' : '删除'),
          )
        }),
      )
    }

    /** 可折叠的探测详情列表（未登录时用） */
    function ProbeList({ probe }) {
      const [open, setOpen] = React.useState(false)
      if (!probe || !Array.isArray(probe.scopes)) return null
      const count = probe.scopes.length
      const bad = probe.scopes.filter((s) => s.state !== 'ok').length
      return h('div', { style: { marginTop: 8 } },
        h('button', {
          type: 'button',
          onClick: () => setOpen((v) => !v),
          style: {
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'transparent', border: 'none', padding: 0,
            color: C.text3, fontSize: 11, cursor: 'pointer', font: 'inherit',
          },
        }, (open ? '▾ ' : '▸ ') + `探测详情（${count} 个账号目录${bad ? `，${bad} 个异常` : ''}）`),

        open
          ? h('div', {
              style: {
                marginTop: 6, padding: '8px 10px', borderRadius: 8,
                background: C.layer2, border: '1px solid ' + C.border,
                display: 'flex', flexDirection: 'column', gap: 6,
              },
            },
              h('div', { style: { fontSize: 11, color: C.text3 } },
                '数据目录：' + probe.dataDir),
              h('div', { style: { fontSize: 11, color: C.text3 } },
                '当前账号：' + (probe.currentOwner ?? '（无法识别）')),
              h('div', { style: { fontSize: 11, color: probe.keychain?.ok ? C.text3 : C.bad } },
                (probe.keychain?.label ?? '钥匙串') + '：' + (probe.keychain?.detail ?? '未知')),
              ...probe.scopes.map((sc) => h('div', {
                key: sc.scope,
                style: { display: 'flex', gap: 6, fontSize: 11, alignItems: 'baseline' },
              },
                h('span', { style: { color: sc.state === 'ok' ? C.ok : C.bad } }, sc.state === 'ok' ? '✓' : '✗'),
                h('span', { style: { fontFamily: C.mono, color: C.text2 } }, sc.scope + (sc.isCurrent ? ' (当前)' : '')),
                h('span', { style: { color: C.text3, minWidth: 0 } }, '— ' + sc.detail),
              )),
              probe.verdict?.hint
                ? h('div', { style: { fontSize: 11, color: C.warn, marginTop: 2 } }, '提示：' + probe.verdict.hint)
                : null,
            )
          : null,
      )
    }

    /** 分栏标签条 */
    function Tabs({ tabs, active, onChange }) {
      return h('div', {
        style: {
          display: 'flex', gap: 2, marginTop: 10, marginBottom: 2,
          borderBottom: '1px solid ' + C.border, overflowX: 'auto',
        },
      },
        tabs.map((tab) => {
          const on = tab.id === active
          return h('button', {
            key: tab.id,
            type: 'button',
            role: 'tab',
            'aria-selected': on,
            onClick: () => onChange(tab.id),
            style: {
              background: 'transparent', border: 'none', font: 'inherit',
              padding: '7px 10px', marginBottom: -1,
              fontSize: 12, fontWeight: on ? 600 : 400,
              color: on ? C.text : C.text3,
              cursor: 'pointer',
              borderBottom: '2px solid ' + (on ? C.brand : 'transparent'),
              whiteSpace: 'nowrap',
            },
          }, tab.label + (tab.badge ? ` ${tab.badge}` : ''))
        }),
      )
    }

    function ModelRow({ model, onToggle, busy, onProbe, canProbe, probing }) {
      const meta = [
        '上下文 ' + Math.round(model.contextWindow / 1000) + 'K',
        '输出 ' + Math.round(model.maxTokens / 1000) + 'K',
        model.creditMultiplier ? '倍率 x' + model.creditMultiplier : undefined,
      ].filter(Boolean).join(' · ')
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, padding: '10px 0', borderTop: '1px solid ' + C.border,
        },
      },
        h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 500, color: model.enabled ? C.text : C.text3 } }, model.name),
            h('span', { style: { fontFamily: C.mono, fontSize: 11, color: C.text3 } }, model.id),
            model.vision
              ? h('span', {
                  title: '实测支持图片输入',
                  style: {
                    fontSize: 10, lineHeight: '16px', padding: '0 6px', borderRadius: 999,
                    color: C.ok, border: '1px solid ' + C.ok, background: 'color-mix(in srgb, ' + C.ok + ' 12%, transparent)',
                  },
                }, '图片')
              : null,
          ),
          h('span', { style: { fontSize: 11, color: C.text3 } }, meta),
        ),
        h(Switch, { checked: model.enabled, onChange: () => onToggle(model.id, !model.enabled), disabled: busy }),
      )
    }

    // ---------------------------------------------------------------- 卡片

    const card = {
      border: '1px solid ' + C.border,
      borderRadius: C.radius,
      background: C.layer2,
      padding: '14px 16px 16px',
      color: C.text,
      fontFamily: 'inherit',
    }

    /**
     * 纯展示组件：所有数据由 props 传入。
     * 抽出来的目的——可以在 Node 里用 react-dom/server 直接渲染验证，
     * 不必等宿主刷新页面才发现渲染崩了。
     */
    /** 一栏的容器：非活动栏用 hidden 隐藏（保留状态、不进无障碍树） */
    function Panel({ active, children }) {
      return h('div', { hidden: active !== true, role: 'tabpanel', style: { paddingTop: 4 } }, children)
    }

    function CardView(props) {
      const { status, error, busy, hint, confirmClear, welfare, tab, onTab, accounts, appRunning, current, onSwitchAccount, onDeleteAccount, deleteConfirm, onConfirmDelete,
        onRefresh, onLogin, onClear, onToggle, onClaim, onToggleAuto, onRefreshWelfare, onToggleProvider,
        onAddAccount, onCancelAddAccount, addAccountRunning, addAccountResult,
        toolsText, toolsHint, toolsBusy, onEditTools, onSaveTools, onResetTools } = props

      // ---- 载入失败
      if (error) {
        return h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h(Pill, { tone: 'bad' }, '不可用'),
            h('span', { style: { fontSize: 13, color: C.text2 } }, '无法读取插件状态：' + error),
          ),
          h('div', { style: { marginTop: 10 } }, h(Button, { onClick: onRefresh }, '重试')),
        )
      }
      // ---- 载入中
      if (!status) {
        return h('div', { style: card }, h('span', { style: { fontSize: 12, color: C.text3 } }, '加载中…'))
      }

      const auth = status.auth || {}
      const upstream = status.upstream || {}
      const account = status.account || {}
      const guard = status.guard || {}
      const provider = status.provider || {}
      const transport = status.transport || {}
      const transportLabel = transport.mode === 'kernel'
        ? (transport.ready === true ? 'kernel（TeleAgent 内核）' : 'kernel（未就绪）')
        : 'direct（插件直连）'
      const models = status.models || []
      const signedIn = auth.signedIn === true
      const ready = upstream.ready === true
      const abnormal = account.abnormal === true
      const circuitOpen = guard.open === true
      const lastError = upstream.lastError || null
      const providerDisabled = provider.disabled === true
      const accountList = Array.isArray(accounts) ? accounts : []
      const canProbe = props.canProbe === true
      const probing = props.probing
      const onProbe = props.onProbe
      // 「添加账号」入口：宿主能力 + 桌面端是否安装，两个条件都要满足
      const addAccountSupported = status.capabilities?.addAccount === true
      const desktopReady = status.desktop?.ok !== false
      const canAddAccount = addAccountSupported && account.canAddAccount !== false
      const addRunning = addAccountRunning === true
      const addResult = addAccountResult ?? null

      let expireText
      if (typeof auth.expiresAt === 'number') {
        try { expireText = new Date(auth.expiresAt).toLocaleDateString('zh-CN') } catch { expireText = undefined }
      }

      const healthTone = providerDisabled ? 'muted' : (circuitOpen || abnormal) ? 'bad' : (ready && signedIn) ? 'ok' : 'warn'
      const healthText = providerDisabled ? '已停用'
        : circuitOpen ? '已熔断'
          : abnormal ? '账号异常'
            : !signedIn ? '未登录'
              : ready ? '正常' : '未就绪'

      const accountDetail = signedIn
        ? [expireText ? '有效期至 ' + expireText : null,
           typeof auth.daysLeft === 'number' ? '剩余 ' + auth.daysLeft + ' 天' : null,
          ].filter(Boolean).join(' · ') || '已登录'
        : (auth.reason || (auth.expired ? '登录已过期' : '尚未登录'))

      const enabledCount = models.filter((m) => m.enabled).length

      /** 诊断事实表：只读，可以被整段贴进问题反馈 */
      const fmtTokens = (n) => (typeof n !== 'number' ? '—' : n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n))
      const lastReq = transport.lastRequest ?? null
      const facts = [
        ['插件版本', 'v' + (status.pluginVersion ?? '0.x')],
        ['TeleAgent 版本', status.desktop?.detail ?? '未知'],
        ['传输方式', transportLabel + (transport.kernel?.pid ? ` · pid ${transport.kernel.pid}` : '')],
        ...lastReq === null ? [] : [[
          '上次请求',
          `约 ${fmtTokens(lastReq.tokensApprox)} tokens · 工具 ${lastReq.toolsSent}/${lastReq.toolsTotal}` +
            (lastReq.filtered ? '（白名单）' : ''),
        ]],
        ...lastReq !== null && lastReq.filtered !== true && lastReq.toolsTotal > 60 ? [[
          '省 token',
          `工具较多（${lastReq.toolsTotal} 个），建议配置 toolsAllowlist（见 README「工具白名单」）`,
        ]] : [],
        ['模式限制', transport.warning ?? '无'],
        ['上游网关', 'agent.teleai.com.cn'],
        ['供应商', providerDisabled ? '已停用' : '启用中'],
        ['账号', signedIn ? (auth.accountName || '已登录') : (auth.state ?? '未登录')],
        ['有效期', expireText ? expireText + (typeof auth.daysLeft === 'number' ? `（剩余 ${auth.daysLeft} 天）` : '') : '—'],
        ['模型', `${models.length} 个，启用 ${enabledCount} 个`],
        ['上游连通', ready ? '正常（签名有效）' : (upstream.error || '未就绪')],
        ['熔断', circuitOpen ? `已暂停（${guard.lastReason ?? '连续认证失败'}）` : `未触发（${guard.consecutiveFailures ?? 0}/${guard.failureThreshold ?? 3}）`],
        ['积分缓存', welfare?.pointsStaleMs != null ? `${Math.round(welfare.pointsStaleMs / 1000)} 秒前读取` : '未读取'],
        ['最近上游错误', lastError ? `${lastError.code ?? ''} ${lastError.message ?? ''}`.trim() : '无'],
      ]

      return h('div', { style: card },
        // ---------- 头部
        h('div', { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, paddingBottom: 4 } },
          h('div', { style: { display: 'flex', gap: 10, minWidth: 0 } },
            h('div', {
              style: {
                width: 32, height: 32, borderRadius: 9, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: C.layer3, border: '1px solid ' + C.borderStrong,
                fontSize: 13, fontWeight: 700, color: C.brand,
              },
            }, 'TA'),
            h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600, color: C.text } }, 'TeleAgent'),
                h(Pill, { tone: healthTone }, healthText),
              ),
              h('span', { style: { fontSize: 11.5, lineHeight: '16px', color: C.text3 } },
                '复用本机 TeleAgent 登录态 · 直连上游'),
            ),
          ),
          h(Button, { onClick: onRefresh, disabled: busy }, busy ? '刷新中…' : '刷新'),
        ),

        h(Tabs, {
          tabs: [
            { id: 'account', label: '账号' },
            { id: 'models', label: '模型', badge: providerDisabled ? '已停用' : models.length },
            { id: 'welfare', label: '福利' },
            { id: 'diagnostics', label: '诊断' },
          ],
          active: tab,
          onChange: onTab,
        }),

        // ================= 账号 =================
        h(Panel, { active: tab === 'account' },
          h(Section, { title: '模型供应商' },
            h(Row, {
              title: '接入 TeleAgent 模型',
              description: providerDisabled
                ? '已停用：模型选择器里不会出现 TeleAgent 的任何模型'
                : '关闭后从模型选择器彻底撤掉（账号与勾选状态保留）',
            },
              h(Switch, { checked: !providerDisabled, onChange: (next) => onToggleProvider(!next), disabled: busy }),
            ),
          ),

          h(Section, { title: '账号' },
            h(Row, { title: signedIn ? (auth.accountName || '已登录') : '登录状态', description: accountDetail },
              !signedIn ? h(Button, { variant: 'primary', onClick: onLogin, disabled: !desktopReady }, '去登录') : null,
              (account.canClear || signedIn)
                ? h(Button, {
                    variant: confirmClear ? 'danger' : 'default',
                    onClick: onClear,
                    disabled: busy || account.canClear === false,
                    title: '只删除本机登录凭据，技能/记忆等个人数据会保留',
                  }, confirmClear ? '确认清除' : '清除登录态')
                : null,
            ),
            abnormal && account.nextStep ? h(Notice, { tone: 'bad' }, account.nextStep) : null,
            confirmClear ? h(Notice, { tone: 'warn' }, '再点一次「确认清除」才会执行；技能、记忆等个人数据不受影响。') : null,
            !signedIn && auth.remedy ? h(Notice, { tone: 'warn' }, auth.remedy) : null,
            !signedIn && status.credentialProbe ? h(ProbeList, { probe: status.credentialProbe }) : null,
            hint ? h(Notice, { tone: 'warn' }, hint) : null,
          ),

          h(Section, { title: '本机账号', hint: accountList.length > 0 ? `${accountList.length} 个` : undefined },
            // 多账号登录入口：桌面端只允许登一个账号，但它的数据目录按账号隔离。
            // 这里负责「退出旧账号 → 登录新账号」并保留旧账号凭据，登录完两个都能用。
            h(Row, {
              title: addRunning ? '添加账号（等待登录）' : '添加账号',
              description: addRunning
                ? '在 TeleAgent 里「设置 → 账号 → 退出登录」，再用另一个账号登录；完成后自动加入列表'
                : '登录另一个 TeleAgent 账号：当前账号的登录态会保留，登录后可在列表里切换',
            },
              addRunning
                ? h(Button, { onClick: onCancelAddAccount, title: '取消等待并恢复原账号登录态' }, '取消')
                : h(Button, {
                    variant: 'primary',
                    onClick: onAddAccount,
                    disabled: busy || !canAddAccount,
                    title: !addAccountSupported
                      ? '当前宿主仍是旧版本：重启 DeepSeek Harness 后添加账号才可用'
                      : (account.canAddAccount === false
                          ? (status.desktop?.detail ?? '未安装 TeleAgent 桌面端')
                          : '唤起 TeleAgent：先在应用里退出当前账号，再用另一个账号登录'),
                  }, '添加账号'),
            ),
            addRunning
              ? h(Notice, { tone: 'warn' },
                  '等待登录中（最长 5 分钟）：先备份当前账号的登录态 → 在 TeleAgent 里退出登录 → 用另一个账号登录。完成后原账号凭据会自动写回。')
              : null,
            addResult && addRunning !== true && addResult.ok === true
              ? h(Notice, { tone: 'ok' }, addResult.message ?? '已添加账号，可在列表里切换。')
              : null,
            addResult && addRunning !== true && addResult.ok !== true
              ? h(Notice, { tone: addResult.code === 'cancelled' || addResult.code === 'same_account' ? 'warn' : 'bad' },
                  (addResult.reason ?? '添加账号失败') +
                  (addResult.hint ? '。' + addResult.hint : ''))
              : null,
            accountList.length > 0
              ? h(AccountList, {
                  accounts: accountList, appRunning, current, busy,
                  onSwitch: onSwitchAccount,
                  onDelete: onDeleteAccount,
                  canDeleteAccount: status.capabilities?.deleteAccount === true,
                  confirming: deleteConfirm,
                  onConfirm: onConfirmDelete,
                })
              : h('div', { style: { fontSize: 12, color: C.text3 } },
                  signedIn
                    ? '本机只有一个账号；点上方「添加账号」登录第二个账号。'
                    : '本机还没有可用的登录账号；点上方「添加账号」或「去登录」。'),
            appRunning && accountList.length > 1
              ? h(Notice, { tone: 'warn' }, 'TeleAgent 桌面端正在运行：切换会被拒绝（它退出时会重写 owner 文件）。先完全退出应用再切换。')
              : null,
            accountList.length > 0
              ? h('div', { style: { marginTop: 8, fontSize: 11, color: C.text3 } },
                  '切换只改 owner 文件（有备份、失败回滚），不动任何账号的 token。')
              : null,
          ),

          h(Section, { title: '连接' },
            h(Row, {
              title: '上游直连',
              description: !ready
                ? (upstream.error || '未就绪')
                : lastError
                  ? (lastError.code === 'account_banned'
                      ? 'TeleAgent 上游（签名有效，但账号被封禁）'
                      : 'TeleAgent 上游（签名有效，最近一次请求被拒）')
                  : 'TeleAgent 上游（签名有效）',
            },
              h(Pill, { tone: ready && !lastError ? 'ok' : (circuitOpen ? 'bad' : 'warn') },
                ready && !lastError ? '正常' : (circuitOpen ? '已暂停' : '异常')),
            ),
            lastError
              ? h(Notice, { tone: 'bad' },
                  '最近请求被拒：' + (lastError.message || lastError.code || '未知') +
                  (lastError.remedy ? ' → ' + lastError.remedy : ''))
              : null,
            circuitOpen
              ? h(Notice, { tone: 'bad' },
                  `已暂停上游调用（${guard.lastReason || '连续认证失败'}），约 ${Math.max(1, Math.ceil((guard.cooldownRemainingMs || 0) / 60000))} 分钟后自动恢复`)
              : null,
            guard.consecutiveFailures > 0 && !circuitOpen
              ? h('div', { style: { marginTop: 8, fontSize: 11, color: C.text3 } },
                  `连续认证失败 ${guard.consecutiveFailures}/${guard.failureThreshold}，达到阈值将暂停调用`)
              : null,
          ),
        ),

        // ================= 模型 =================
        h(Panel, { active: tab === 'models' },
          h(Section, { title: '模型', hint: `共 ${models.length} 个，启用 ${enabledCount} 个` },
            h('div', { style: providerDisabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined },
              models.map((m) => h(ModelRow, {
                key: m.id, model: m, onToggle, busy: busy || providerDisabled,
                canProbe: canProbe === true, onProbe, probing,
              })),
            ),
            transport.warning
              ? h(Notice, { tone: 'warn' }, transport.warning)
              : null,
            providerDisabled
              ? h(Notice, { tone: 'warn' }, '供应商已停用，上面的勾选暂不生效；重新打开开关即恢复。')
              : null,
            h('div', { style: { marginTop: 10, fontSize: 11, color: C.text3 } },
              '勾选改动立即保存。带「图片」徽标的模型实测支持图片输入。'),
          ),
          h(Section, {
            title: '工具白名单',
            hint: lastReq === null ? '省 token' : `上次请求 工具 ${lastReq.toolsSent}/${lastReq.toolsTotal}`,
          },
            h('div', { style: { fontSize: 12, color: C.text2, lineHeight: '18px', marginBottom: 8 } },
              'DSH 会把所有插件的工具都塞进每次请求；只把白名单里的工具挂给内核可以显著降低 token。',
              '每行一个，支持 ',
              h('code', { style: { fontFamily: C.mono } }, 'foo*'),
              ' 通配；留空 = 全量发送。',
            ),
            h('textarea', {
              value: toolsText ?? '',
              onChange: (e) => onEditTools?.(e.target.value),
              rows: 7,
              spellCheck: false,
              placeholder: 'bash\nread\nwrite\nedit\nweb_*',
              style: {
                width: '100%', boxSizing: 'border-box', resize: 'vertical',
                padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: '18px',
                fontFamily: C.mono, color: C.text, background: C.layer2,
                border: '1px solid ' + C.border, outline: 'none',
              },
            }),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
              h(Button, { variant: 'primary', onClick: onSaveTools, disabled: toolsBusy }, '保存'),
              h(Button, { onClick: onResetTools, disabled: toolsBusy }, '恢复全量'),
              toolsHint ? h('span', { style: { fontSize: 11, color: C.text3 } }, toolsHint) : null,
            ),
            lastReq !== null && lastReq.filtered !== true && lastReq.toolsTotal > 60
              ? h(Notice, { tone: 'warn' }, `当前发送 ${lastReq.toolsTotal} 个工具；配置白名单后单步 token 可降一个数量级`)
              : null,
          ),
        ),

        // ================= 福利 =================
        h(Panel, { active: tab === 'welfare' },
          welfare && welfare.daily
            ? h(Section, { title: '积分福利', hint: welfare.pointsError ? '读取失败' : undefined },
                h(Row, {
                  title: '积分余额',
                  description: [
                    welfare.balance != null ? '当前可用 ' + Number(welfare.balance).toFixed(2) : '暂未读取',
                    welfare.expiresAt ? '最近到期 ' + welfare.expiresAt.slice(0, 10) : null,
                  ].filter(Boolean).join(' · '),
                },
                  h(Button, { onClick: onRefreshWelfare, disabled: busy }, '刷新'),
                ),
                h(Row, {
                  title: '每日领取',
                  description: welfare.daily.claimedToday
                    ? `今日已领${welfare.lastClaimPoints ? ' +' + welfare.lastClaimPoints : ''} · 累计 ${welfare.daily.totalDays ?? 0} 天 ${welfare.daily.totalPoints ?? 0} 积分`
                    : `今日可领 ${welfare.daily.claimable ?? 0} 积分`,
                },
                  welfare.daily.claimedToday
                    ? h(Pill, { tone: 'ok' }, '已领取')
                    : h(Button, { variant: 'primary', onClick: onClaim, disabled: busy }, '领取'),
                ),
                welfare.daily.activity && (welfare.daily.activity.title || welfare.daily.activity.endText)
                  ? (() => {
                      const act = welfare.daily.activity
                      // 结束文案形如 "10/31 结束"；能解析出日期且 ≤3 天则高亮
                      let urgent = false
                      const m = /(\d{1,2})\/(\d{1,2})/.exec(act.endText ?? '')
                      if (m) {
                        const now = new Date()
                        const end = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
                        const days = Math.ceil((end - now) / 86_400_000)
                        urgent = days >= 0 && days <= 3
                      }
                      return h(Row, {
                        title: '福利活动',
                        description: [act.title, act.endText].filter(Boolean).join(' · ') || '进行中',
                      },
                        h(Pill, { tone: urgent ? 'warn' : 'muted' }, urgent ? '即将结束' : '进行中'),
                      )
                    })()
                  : null,
                h(Row, { title: '自动领取', description: '每天自动领一次，失败会在下次检查时重试' },
                  h(Switch, { checked: welfare.autoClaimDaily !== false, onChange: (next) => onToggleAuto(next), disabled: busy }),
                ),
                welfare.pointsError
                  ? h(Notice, { tone: 'warn' }, '积分读取失败：' + welfare.pointsError + '（尝试重新登录 TeleAgent 桌面端）')
                  : null,
                welfare.daily.error ? h(Notice, { tone: 'warn' }, '领取状态读取失败：' + welfare.daily.error) : null,
              )
            : h(Section, { title: '积分福利' },
                h('div', { style: { fontSize: 12, color: C.text3 } }, '积分数据尚未读取（需要先登录 TeleAgent）。'),
              ),
        ),

        // ================= 诊断 =================
        h(Panel, { active: tab === 'diagnostics' },
          h(Section, { title: '诊断', hint: '只读，可整段复制' },
            h('div', {
              style: {
                marginTop: 4, padding: '10px 12px', borderRadius: 8,
                background: C.layer2, border: '1px solid ' + C.border,
                display: 'flex', flexDirection: 'column', gap: 5,
                fontFamily: C.mono, fontSize: 11, lineHeight: '16px',
              },
            },
              facts.map(([k, v]) => h('div', { key: k, style: { display: 'flex', gap: 8 } },
                h('span', { style: { color: C.text3, minWidth: 92, flexShrink: 0 } }, k),
                h('span', { style: { color: C.text2, wordBreak: 'break-all' } }, String(v)),
              )),
            ),
            h('div', { style: { marginTop: 8, fontSize: 11, color: C.text3 } },
              '反馈问题时请附上这一段；日志在 ~/.dsh/teleagent-boot.log。'),
          ),
        ),
      )
    }

    /** 有状态组件：只负责取数与交互，渲染交给 CardView */
    function Card(props) {
      // 宿主通过 slot 的 `inject` 传下来（见 registerSlots）；老宿主/测试里缺失
      const settingsScope = props?.settingsScope
      const [status, setStatus] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState(null)
      const [confirmClear, setConfirmClear] = React.useState(false)
      const [welfare, setWelfare] = React.useState(null)
      // 分栏：账号 / 模型 / 福利 / 诊断。切栏只是切换可见性，不重新取数
      const [tab, setTab] = React.useState('account')
      const [probing, setProbing] = React.useState(null)
      const [accounts, setAccounts] = React.useState([])
      const [accountsAppRunning, setAccountsAppRunning] = React.useState(false)
      const [accountsCurrent, setAccountsCurrent] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      // 添加账号：running 期间轮询宿主进度；result 是最近一次结果
      const [addAccount, setAddAccount] = React.useState({ running: false, result: null })
      const addTimer = React.useRef(null)
      // 工具白名单：首次载入 status 时灌入 textarea；之后以用户编辑为准
      const [toolsText, setToolsText] = React.useState('')
      const [toolsHint, setToolsHint] = React.useState(null)
      const [toolsBusy, setToolsBusy] = React.useState(false)
      const toolsInitRef = React.useRef(false)
      // settings 快照变化（宿主把镜像填上、或别处改了值）时重画，
      // 否则四项配置的读数会一直停在首次渲染的旧值上
      const [, setScopeRevision] = React.useState(0)

      React.useEffect(() => {
        if (settingsScope === undefined || typeof settingsScope.subscribe !== 'function') return undefined
        try {
          return settingsScope.subscribe(() => setScopeRevision((n) => n + 1))
        } catch {
          return undefined
        }
      }, [settingsScope])

      // 组件卸载时停掉轮询，避免定时器泄漏
      React.useEffect(() => () => {
        if (addTimer.current) clearInterval(addTimer.current)
        addTimer.current = null
      }, [])

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const next = await res.json()
          // 读：settings 优先，/status 兜底（契约 §6）
          setStatus(overlayStatus(settingsScope, next))
          setError(null)
          if (toolsInitRef.current !== true) {
            toolsInitRef.current = true
            const effTools = readSettingsValue(settingsScope)?.toolsAllowlist
              ?? normalizeToolsList(next.toolsAllowlist)
            setToolsText(effTools.join('\n'))
          }
          // 账号列表（含逐账号积分）：独立请求，失败不影响卡片
          void loadAccounts()
          // 福利数据与主状态并行拉取；失败不影响卡片其余部分
          try {
            const w = await fetch(WELFARE_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            if (w.ok) setWelfare(overlayWelfare(settingsScope, await w.json()))
          } catch { /* ignore */ }
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }, [settingsScope])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])

      // 页面刷新后接上宿主进程里可能仍在进行的「添加账号」流程；顺便恢复上次结果
      React.useEffect(() => {
        let alive = true
        void (async () => {
          try {
            const res = await fetch(LOGIN_PATH + '?mode=add', {
              headers: { accept: 'application/json' }, credentials: 'same-origin',
            })
            if (!alive || !res.ok) return
            const state = await res.json().catch(() => null)
            if (!alive || !state) return
            if (state.running === true) {
              setAddAccount({ running: true, result: null })
              pollAddAccount()
            } else if (state.result) {
              setAddAccount({ running: false, result: state.result })
            }
          } catch { /* 旧宿主没有该接口：忽略 */ }
        })()
        return () => { alive = false }
      }, [])

      const toggle = React.useCallback(async (id, next) => {
        setBusy(true)
        try {
          // 用函数式更新读取最新 status，避免闭包拿到旧值
          const raw = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          if (!raw) throw new Error('读取状态失败')
          // 先叠加 settings（空数组 = 全部启用），再算「除了这一个之外的其他模型」
          const current = overlayStatus(settingsScope, raw)
          const ids = (current.models || []).filter((m) => (m.id === id ? next : m.enabled)).map((m) => m.id)
          const out = await writeSettingsField(settingsScope, 'enabledModelIds', ids)
          if (!out.ok) throw new Error(out.error ?? '保存失败')
          await load()
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [load, settingsScope])

      const openLogin = async () => {
        setHint(null)
        try {
          const res = await fetch(LOGIN_PATH, { method: 'POST', credentials: 'same-origin' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok !== true) {
            setHint(body.remedy || body.error || '打开 TeleAgent 失败')
            return
          }
          setHint(body.message || '已唤起 TeleAgent，请在应用内完成登录（完成后会自动退出）')
          let tries = 0
          const timer = setInterval(async () => {
            tries += 1
            await load()
            if (tries >= 45) clearInterval(timer)
          }, 4000)
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        }
      }

      /** 停止添加账号的进度轮询 */
      const stopAddPolling = () => {
        if (addTimer.current) clearInterval(addTimer.current)
        addTimer.current = null
      }

      /**
       * 轮询宿主端「添加账号」流程。
       *
       * 流程本身在宿主进程里跑（唤起应用 → 等用户换号登录 → 恢复原账号 token），
       * 这里只负责把进度/结果搬回界面。失败静默重试，直到流程结束。
       */
      const pollAddAccount = () => {
        stopAddPolling()
        addTimer.current = setInterval(async () => {
          try {
            const res = await fetch(LOGIN_PATH + '?mode=add', {
              headers: { accept: 'application/json' }, credentials: 'same-origin',
            })
            if (!res.ok) return
            const state = await res.json().catch(() => null)
            if (!state || state.running === true) return
            stopAddPolling()
            setAddAccount({ running: false, result: state.result ?? null })
            await Promise.all([load(), loadAccounts()])
          } catch { /* 静默：下一轮再试 */ }
        }, 2500)
      }

      /** 多账号登录入口：启动宿主端流程（非阻塞） */
      const startAddAccount = async () => {
        setHint(null)
        setBusy(true)
        try {
          const res = await fetch(LOGIN_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ mode: 'add' }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok !== true) {
            setHint(body.remedy || body.error || body.reason || '开始添加账号失败')
            return
          }
          setAddAccount({ running: true, result: null })
          pollAddAccount()
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      /** 取消添加账号（宿主会恢复原账号凭据） */
      const cancelAddAccount = async () => {
        try {
          const res = await fetch(LOGIN_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ mode: 'add', action: 'cancel' }),
          })
          const body = await res.json().catch(() => ({}))
          if (!res.ok || body.ok !== true) setHint(body.error || body.reason || '取消失败')
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        }
      }


      /** 只刷新福利（本机接口，便宜）；卡片停在福利栏时定时调用 */
      const refreshWelfareOnly = React.useCallback(async () => {
        try {
          const res = await fetch(WELFARE_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) return
          setWelfare(await res.json())
        } catch { /* 静默 */ }
      }, [])

      // 停在「福利」栏时每 5 秒刷新一次：
      // 后端读取会按 TTL/stale 决定是否真的去上游，所以这里不会放大请求。
      React.useEffect(() => {
        if (tab !== 'welfare') return undefined
        let alive = true
        const tick = () => { if (alive) void refreshWelfareOnly() }
        tick()
        const timer = setInterval(tick, 5000)
        return () => { alive = false; clearInterval(timer) }
      }, [tab, refreshWelfareOnly])

      const loadAccounts = React.useCallback(async (withPoints = true) => {
        try {
          const res = await fetch(ACCOUNTS_PATH + (withPoints ? '?points=1' : ''), {
            headers: { accept: 'application/json' }, credentials: 'same-origin',
          })
          if (!res.ok) return
          const data = await res.json()
          setAccounts(Array.isArray(data.accounts) ? data.accounts : [])
          setAccountsAppRunning(data.appRunning === true)
          setAccountsCurrent(data.current ?? null)
        } catch { /* 静默 */ }
      }, [])

      const deleteAccount = async (scope) => {
        setBusy(true)
        try {
          const res = await fetch(ACCOUNTS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action: 'delete', scope, mode: 'purge' }),
          })
          const data = await res.json().catch(() => ({}))
          if (res.ok && data.deleted) {
            setHint(`已删除账号 ${scope.slice(-8)}（移入回收站，可恢复）`)
            setConfirmDelete(null)
            await Promise.all([loadAccounts(), load()])
          } else if (/token\.json|没有可用/.test(String(data.reason ?? ''))) {
            // 旧宿主会把 POST 当成"切换账号"，于是报 token 缺失。这类错要翻译成人话。
            setHint('当前宿主仍在运行旧版本（插件已更新但 DSH 未重启）：请重启 DeepSeek Harness 后再试')
            setConfirmDelete(null)
          } else {
            setHint(data.reason ?? data.error ?? '删除失败')
            setConfirmDelete(null)
          }
        } catch (e) {
          setHint(e?.message ?? '删除失败')
        } finally {
          setBusy(false)
        }
      }

      const switchAccount = async (scope) => {
        setBusy(true)
        try {
          const res = await fetch(ACCOUNTS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ scope }),
          })
          const data = await res.json().catch(() => ({}))
          if (res.ok && data.changed) {
            setHint(`已切换到 ${data.account?.accountName ?? scope}，下一次请求生效（旧宿主可能仍需重启 DSH）`)
            await Promise.all([load(), loadAccounts()])
          } else {
            setHint(data.reason ?? data.error ?? '切换失败')
          }
        } catch (e) {
          setHint(e?.message ?? '切换失败')
        } finally {
          setBusy(false)
        }
      }

      const probeModel = async (modelId) => {
        setProbing(modelId)
        try {
          const res = await fetch(PROBE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ model: modelId }),
          })
          const data = await res.json().catch(() => ({}))
          if (res.status === 403) setHint(data.error ?? '探测已禁用')
          else if (data.ok) setHint(`${modelId} 可用（${data.elapsedMs ?? '?'} ms）`)
          else setHint(`${modelId} 不可用：${data.message ?? data.code ?? '未知'}`)
        } catch (e) {
          setHint(e?.message ?? '测试失败')
        } finally {
          setProbing(null)
        }
      }

      const toggleProvider = async (disabled) => {
        setBusy(true)
        try {
          const out = await writeSettingsField(settingsScope, 'providerDisabled', disabled === true)
          if (!out.ok) throw new Error(out.error ?? '操作失败')
          await load()
        } catch (e) {
          setHint(e?.message ?? '操作失败')
        } finally {
          setBusy(false)
        }
      }

      /**
       * 自动领取开关。
       *
       * 走四项配置的统一写入口（scope 优先、HTTP 回退），**不再**直接打
       * `/welfare` POST —— 那个路由同时管「领取」和「刷新」，混在里面会让
       * 同一项配置有两个写路径。
       */
      const toggleAutoClaim = async (enabled) => {
        setBusy(true)
        try {
          const out = await writeSettingsField(settingsScope, 'autoClaimDaily', enabled === true)
          if (!out.ok) throw new Error(out.error ?? '保存失败')
          await load()
        } catch (e) {
          setHint(e?.message ?? '保存失败')
        } finally {
          setBusy(false)
        }
      }

      const welfarePost = async (body) => {
        setBusy(true)
        try {
          const res = await fetch(WELFARE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify(body),
          })
          const data = await res.json().catch(() => ({}))
          if (data?.welfare) setWelfare(data.welfare)
          else await load()
          if (body.action === 'claim') {
            if (data?.claimed) setHint(`已领取 +${data.points ?? 0} 积分`)
            else if (data?.alreadyClaimed) setHint('今天已经领过了')
            else if (data?.error) setHint('领取失败：' + data.error)
          }
        } catch (e) {
          setHint(e?.message ?? '操作失败')
        } finally {
          setBusy(false)
        }
      }

      const clearAccount = async () => {
        if (!confirmClear) {
          setConfirmClear(true)
          setHint('再点一次「确认清除」将删除本机登录态（技能、记忆等个人数据会保留）')
          return
        }
        setConfirmClear(false)
        setBusy(true)
        setHint(null)
        try {
          const res = await fetch(LOGOUT_PATH, { method: 'POST', credentials: 'same-origin' })
          const body = await res.json().catch(() => ({}))
          if (!res.ok) { setHint(body.error || '清除失败（HTTP ' + res.status + '）'); return }
          setHint(body.message || '已清除登录态，请点「去登录」')
          await load()
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }

      const saveTools = async (value) => {
        setToolsBusy(true)
        setToolsHint(null)
        try {
          const list = normalizeToolsList(value)
          const out = await writeSettingsField(settingsScope, 'toolsAllowlist', list)
          if (!out.ok) throw new Error(out.error ?? '保存失败')
          toolsInitRef.current = false
          setToolsHint(list.length > 0 ? '已保存（下一轮请求生效）' : '已恢复全量工具（下一轮请求生效）')
          await load()
        } catch (e) {
          setToolsHint(e?.message ?? '保存失败')
        } finally {
          setToolsBusy(false)
        }
      }

      const parseTools = (text) => String(text ?? '')
        .split(/[\n,]+/).map((x) => x.trim()).filter((x) => x.length > 0)

      return h(CardView, {
        status, error, busy, hint, confirmClear, welfare, tab, onTab: setTab,
        toolsText, toolsHint, toolsBusy,
        onEditTools: (text) => { setToolsText(text); setToolsHint(null) },
        onSaveTools: () => { const list = parseTools(toolsText); void saveTools(list.length > 0 ? list : null) },
        onResetTools: () => void saveTools(null),
        accounts, appRunning: accountsAppRunning, current: accountsCurrent, onSwitchAccount: switchAccount,
        onDeleteAccount: deleteAccount,
        deleteConfirm: confirmDelete, onConfirmDelete: setConfirmDelete,
        // status 首次渲染时是 null（还在加载）：这里必须用可选链，
        // 否则整个卡片在挂载瞬间就抛错，界面表现为「插件信息一片空白」。
        canProbe: status?.allowChatProbe === true, onProbe: probeModel, probing,
        // 添加账号：入口是否可用由宿主能力集 + 桌面端是否安装决定
        onAddAccount: startAddAccount, onCancelAddAccount: cancelAddAccount,
        addAccountRunning: addAccount.running, addAccountResult: addAccount.result,
        onRefresh: load, onLogin: openLogin, onClear: clearAccount, onToggle: toggle,
        onToggleProvider: toggleProvider,
        onClaim: () => welfarePost({ action: 'claim' }),
        onToggleAuto: toggleAutoClaim,
        onRefreshWelfare: () => welfarePost({ action: 'refresh' }),
      })
    }

    // ------------------------------------------------------- 设置页原生 section
    //
    // 这是配置的**主入口**：DSH 设置 → TeleAgent。卡片（settings.plugins.tab）
    // 保留下来做运维视图（账号/登录/诊断/福利），两者共存。
    //
    // 组件拆成两个：
    //   SettingsSectionView  纯展示，props 进 props 出 → 可在 Node 里用
    //                        react-dom/server 直接渲染断言，不用开浏览器
    //   SettingsSection      有状态外壳：取数 + 写值（scope 优先、HTTP 回退）

    /**
     * 设置页的纯展示视图。
     *
     * 四个控件（契约 §2）：providerDisabled / enabledModelIds /
     * toolsAllowlist / autoClaimDaily。全部复用现有原子组件与样式令牌 C，
     * 视觉与卡片同源，深浅主题都不会失真。
     *
     * 只做展示：任何写操作都通过 props 回调上抛，由 SettingsSection 决定
     * 走 settings scope 还是 HTTP 回退。
     */
    function SettingsSectionView(props) {
      const { value, models, busy, hint, toolsText, source, onChange, onEditTools, onSaveTools, onResetTools } = props
      const current = value || {}
      const providerDisabled = current.providerDisabled === true
      const enabledIds = normalizeIdList(current.enabledModelIds)
      const autoClaimDaily = current.autoClaimDaily !== false
      const modelList = Array.isArray(models) ? models : []
      const toolsValue = toolsText ?? normalizeToolsList(current.toolsAllowlist).join('\n')
      const allEnabled = enabledIds.length === 0
      const enabledCount = allEnabled ? modelList.length : modelList.filter((m) => enabledIds.includes(m.id)).length

      return h('div', { style: { ...card, padding: '2px 16px 18px' } },
        h(Section, { title: '模型供应商' },
          h(Row, {
            title: '接入 TeleAgent 模型',
            description: providerDisabled
              ? '已停用：模型选择器里不会出现 TeleAgent 的任何模型'
              : '关闭后从模型选择器彻底撤掉（账号与勾选状态保留）',
          },
            h(Switch, {
              checked: !providerDisabled,
              onChange: (next) => onChange?.('providerDisabled', !next),
              disabled: busy === true,
            }),
          ),
        ),

        h(Section, { title: '模型', hint: modelList.length > 0 ? `共 ${modelList.length} 个，启用 ${enabledCount} 个` : undefined },
          modelList.length === 0
            ? h('div', { style: { fontSize: 12, color: C.text3, padding: '8px 0' } },
                '模型清单尚未读取到（需要先登录 TeleAgent）；勾选状态会在读取后显示。')
            : modelList.map((model) => {
                const enabled = allEnabled || enabledIds.includes(model.id)
                return h('div', {
                  key: model.id,
                  style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 16, padding: '10px 0', borderTop: '1px solid ' + C.border,
                  },
                },
                  h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                    h('span', { style: { fontSize: 13, fontWeight: 500, color: enabled ? C.text : C.text3 } }, model.name ?? model.id),
                    h('span', { style: { fontFamily: C.mono, fontSize: 11, color: C.text3 } },
                      model.id + (model.vision === true ? ' · 图片' : '')),
                  ),
                  h(Switch, {
                    checked: enabled,
                    // 与卡片一致：供应商停用时勾选暂不生效，所以控件也一起禁用
                    disabled: busy === true || providerDisabled,
                    onChange: (next) => {
                      // 空数组 = 全部启用：第一次取消勾选时，必须显式列出除它以外的全部，
                      // 否则「全开」会被理解成「再次全开」，取消了等于没取消。
                      const base = allEnabled ? modelList.map((m) => m.id) : enabledIds.slice()
                      const nextIds = next
                        ? (base.includes(model.id) ? base : base.concat(model.id))
                        : base.filter((id) => id !== model.id)
                      // 全勾上等价于「空数组 = 全部启用」：写成 [] 而不是列出全部，
                      // 否则以后新增的模型会被这张旧清单悄悄关掉。
                      const normalized = nextIds.length === modelList.length ? [] : nextIds
                      onChange?.('enabledModelIds', normalized)
                    },
                  }),
                )
              }),
          h('div', { style: { marginTop: 8, fontSize: 11, color: C.text3 } },
            '空列表 = 全部启用。勾选改动立即保存。'),
        ),

        h(Section, { title: '工具白名单', hint: '省 token' },
          h('div', { style: { fontSize: 12, color: C.text2, lineHeight: '18px', margin: '4px 0 8px' } },
            'DSH 会把所有插件的工具都塞进每次请求；只把白名单里的工具挂给内核可以显著降低 token。',
            '每行一个，支持 ',
            h('code', { style: { fontFamily: C.mono } }, 'foo*'),
            ' 通配；留空 = 全量发送。',
          ),
          h('textarea', {
            value: toolsValue,
            onChange: (e) => onEditTools?.(e.target.value),
            rows: 5,
            spellCheck: false,
            placeholder: 'bash\nread\nwrite\nedit\nweb_*',
            style: {
              width: '100%', boxSizing: 'border-box', resize: 'vertical',
              padding: '8px 10px', borderRadius: 8, fontSize: 12, lineHeight: '18px',
              fontFamily: C.mono, color: C.text, background: C.layer2,
              border: '1px solid ' + C.border, outline: 'none',
            },
          }),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 } },
            h(Button, { variant: 'primary', onClick: onSaveTools, disabled: busy === true }, '保存'),
            h(Button, { onClick: onResetTools, disabled: busy === true }, '恢复全量'),
          ),
        ),

        h(Section, { title: '积分福利' },
          h(Row, { title: '自动领取', description: '每天自动领一次，失败会在下次检查时重试' },
            h(Switch, {
              checked: autoClaimDaily,
              onChange: (next) => onChange?.('autoClaimDaily', next),
              disabled: busy === true,
            }),
          ),
        ),

        hint ? h(Notice, { tone: 'warn' }, hint) : null,
        source === 'settings'
          ? h('div', { style: { marginTop: 10, fontSize: 11, color: C.text3 } },
              '这些设置保存在 DSH 设置里，重启后仍然有效。')
          : h('div', { style: { marginTop: 10, fontSize: 11, color: C.text3 } },
              '当前宿主未提供设置服务：改动保存在插件自己的配置文件里。'),
      )
    }

    /**
     * 设置页 section 的有状态外壳。
     *
     * 读：settings scope 快照优先，缺失时退回 `/status`（老宿主唯一来源）。
     * 写：`writeSettingsField` —— scope 优先、失败或缺失回退 HTTP，见文件头
     *     的「设置读写」一节。`settingsScope` 为 undefined 时整块逻辑退化成
     *     原来的 HTTP 行为，**不会崩**。
     */
    function SettingsSection(props) {
      const settingsScope = props?.settingsScope
      const [, setRevision] = React.useState(0)
      const [status, setStatus] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState(null)
      const [toolsText, setToolsText] = React.useState(null)
      const toolsInitRef = React.useRef(false)

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const next = await res.json()
          setStatus(next)
          if (toolsInitRef.current !== true) {
            toolsInitRef.current = true
            setToolsText(normalizeToolsList(next.toolsAllowlist).join('\n'))
          }
        } catch (e) {
          setHint('无法读取插件状态：' + (e?.message ?? String(e)))
        }
      }, [])

      React.useEffect(() => { void load() }, [load])

      // scope 变化（宿主切换 namespace / 镜像后到）后重画，读值立刻跟上
      React.useEffect(() => {
        if (settingsScope === undefined || typeof settingsScope.subscribe !== 'function') return undefined
        try {
          return settingsScope.subscribe(() => setRevision((n) => n + 1))
        } catch {
          return undefined
        }
      }, [settingsScope])

      const value = readSettingsValue(settingsScope) ?? valuesFromStatus(status)

      const commit = async (field, next) => {
        setBusy(true)
        setHint(null)
        try {
          const out = await writeSettingsField(settingsScope, field, next)
          if (!out.ok) throw new Error(out.error ?? '保存失败')
          if (field === 'toolsAllowlist') toolsInitRef.current = false
          await load()
        } catch (e) {
          setHint(e?.message ?? String(e))
        } finally {
          setBusy(false)
        }
      }

      const parseTools = (text) => String(text ?? '')
        .split(/[\n,]+/).map((x) => x.trim()).filter((x) => x.length > 0)

      return h(SettingsSectionView, {
        value,
        models: status?.models,
        busy,
        hint,
        toolsText: toolsText ?? undefined,
        source: readSettingsValue(settingsScope) === undefined ? 'status' : 'settings',
        onChange: (field, next) => void commit(field, next),
        onEditTools: (text) => { setToolsText(text); setHint(null) },
        onSaveTools: () => void commit('toolsAllowlist', parseTools(toolsText)),
        onResetTools: () => void commit('toolsAllowlist', []),
      })
    }

    /** 设置页左侧导航的小图标（`settings.section.icon`，按 section id 匹配） */
    function SettingsSectionIcon(iconProps) {
      const edge = typeof iconProps?.size === 'number' ? iconProps.size : 16
      return h('span', {
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: edge, height: edge, borderRadius: 4, flexShrink: 0,
          background: C.layer3, border: '1px solid ' + C.borderStrong,
          fontSize: Math.max(7, Math.round(edge * 0.42)), fontWeight: 700,
          lineHeight: 1, color: C.brand,
          opacity: iconProps?.active === false ? 0.75 : 1,
        },
      }, 'TA')
    }

    /**
     * 输入框左下角的积分胶囊。
     *
     * 挂在 `conversation.input.left`（与 dsh-connect-workbuddy 同一挂载点）。
     * 只读展示：余额来自宿主端缓存，点击触发一次刷新；
     * 若有可领积分，显示可点的「+100 领取」而不是只给数字。
     */
    function PointsCapsule(props) {
      // initialWelfare 仅用于离线预览/测试注入；真实宿主里为空，走下面的 fetch
      const seeded = props && props.initialWelfare ? props.initialWelfare : null
      const [welfare, setWelfare] = React.useState(seeded)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState(null)

      /**
       * 拉取积分快照。
       *
       * 轮询打的是**本机接口**（3 秒一次，代价可忽略）；真正的上游请求由宿主端
       * 按 TTL 与 stale 标记控制。`force` 才要求宿主立刻去上游取新值。
       */
      const load = React.useCallback(async (force = false) => {
        try {
          const url = force ? WELFARE_PATH + '?refresh=1' : WELFARE_PATH
          const res = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) return
          const data = await res.json()
          setWelfare(data ?? null)
        } catch { /* 静默：胶囊不该弹错误 */ }
      }, [])

      React.useEffect(() => { if (!seeded) load() }, [load, seeded])

      // 本地快照轮询：3 秒。宿主端有 15 秒 TTL + stale 标记，所以这不会放大上游请求。
      React.useEffect(() => {
        if (seeded) return undefined
        const timer = setInterval(() => { void load() }, 3000)
        return () => clearInterval(timer)
      }, [load, seeded])

      // 窗口重新获得焦点 / 页面变为可见时，强制刷新一次（用户刚用完回来）
      React.useEffect(() => {
        if (seeded || typeof window === 'undefined') return undefined
        const onFocus = () => { void load(true) }
        const onVisible = () => { if (document.visibilityState === 'visible') void load(true) }
        window.addEventListener('focus', onFocus)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.removeEventListener('focus', onFocus)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [load, seeded])

      const claim = async (event) => {
        event?.stopPropagation?.()
        if (busy) return
        setBusy(true)
        setHint(null)
        try {
          const res = await fetch(WELFARE_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ action: 'claim' }),
          })
          const body = await res.json().catch(() => ({}))
          if (body?.claimed) setHint(`+${body.points ?? 0} 积分`)
          else if (body?.alreadyClaimed) setHint('今天已领')
          else setHint(body?.error ?? '领取失败')
          // 领取后余额立刻变了，直接取新值而不是等下一轮
          if (body?.welfare) setWelfare(body.welfare)
          await load(true)
        } catch (e) {
          setHint(e?.message ?? '领取失败')
        } finally {
          setBusy(false)
          setTimeout(() => setHint(null), 4000)
        }
      }

      // 没有数据时不占位，避免输入框出现空胶囊
      if (!welfare || welfare.balance === null || welfare.balance === undefined) return null

      const balance = Number(welfare.balance)
      const canClaim = welfare.canClaimToday === true && (welfare.daily?.claimable ?? 0) > 0
      const claimable = welfare.daily?.claimable ?? 0
      const text = busy ? '处理中…' : hint ?? (canClaim ? `+${claimable} 可领` : `${balance.toFixed(2)} 积分`)

      return h('button', {
        type: 'button',
        onClick: canClaim && !hint ? claim : load,
        title: [
          `积分余额 ${balance.toFixed(2)}`,
          welfare.expiresAt ? `最近到期 ${welfare.expiresAt}` : null,
          canClaim ? `今日可领 ${claimable} 积分，点击领取` : null,
          welfare.daily?.activity?.title
            ? `${welfare.daily.activity.title}${welfare.daily.activity.endText ? '（' + welfare.daily.activity.endText + '）' : ''}`
            : null,
          welfare.pointsError ? `读取失败：${welfare.pointsError}` : null,
        ].filter(Boolean).join('\n'),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 22, padding: '0 8px', marginRight: 2,
          borderRadius: 999, border: '1px solid ' + (canClaim ? C.brand : C.borderStrong),
          background: canClaim ? 'color-mix(in srgb, ' + C.brand + ' 12%, transparent)' : 'transparent',
          color: canClaim ? C.brand : C.text3,
          font: 'inherit', fontSize: 11, lineHeight: 1,
          cursor: busy ? 'default' : 'pointer',
          opacity: busy ? 0.6 : 1,
          whiteSpace: 'nowrap',
        },
      },
        h('span', { style: { fontSize: 10, opacity: 0.9 } }, '✦'),
        text,
      )
    }


    /**
     * 胶囊的 provider 门控。
     *
     * 宿主给槽位传入 `useProjection`，`useProjection('modelSelection')` 返回当前
     * 会话的模型选择投影（`next` 优先于 `lastUsed`）。只有 provider 是 teleagent
     * 时才渲染胶囊 —— 其他模型时不渲染，也**不会启动任何轮询**（组件根本没挂载）。
     *
     * 与 dsh-connect-workbuddy 的 ComposerCreditsGate 同一做法。
     */
    const TELEAGENT_PROVIDER = 'teleagent'

    function selectedProviderOf(projection) {
      const pick = (projection?.next ?? projection?.lastUsed)?.provider
      return typeof pick === 'string' && pick !== '' ? pick : undefined
    }

    function PointsCapsuleGate(props) {
      const { useProjection, initialWelfare } = props
      // 无论是否渲染都要保持 hook 调用顺序一致
      const projection = typeof useProjection === 'function' ? useProjection('modelSelection') : undefined
      const provider = selectedProviderOf(projection)
      const ours = provider === TELEAGENT_PROVIDER
      // 宿主没有提供 useProjection（老版本）时无法判断，退化为"显示"，
      // 宁可多显示也不要把功能藏掉；有投影时严格按 provider 门控。
      const unknown = typeof useProjection !== 'function'
      if (!ours && !unknown) return null
      return h(PointsCapsule, { initialWelfare })
    }

    /**
     * 软取可选服务。
     *
     * `ctx.x` 对未声明的服务会 THROW，`?.` 挡不住；`ctx.get(name)` 才是安全的。
     * 客户端插件**不把** `configForms` 写进 `exports.inject`：那样在没这个服务的
     * 宿主上会永远卡在「等待依赖」，客户端 bundle 根本不会执行。
     */
    function softGet(ctx, name) {
      try {
        return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
      } catch {
        return undefined
      }
    }

    /** 找一个宿主真的在服务的 settings namespace（按候选顺序） */
    function servedNamespaceOf(forms) {
      for (const candidate of SETTINGS_NAMESPACE_CANDIDATES) {
        try {
          const scope = forms.get(candidate)
          if (scope !== undefined && scope !== null) return candidate
        } catch { /* 这个拼写宿主不认识，试下一个 */ }
      }
      return undefined
    }

    /**
     * 幂等的释放包装。
     *
     * `ctx.slots.inject(name, cb)` 的返回值本身会释放 `cb` 里注册的那个 entry，
     * 而我们也同时持有 `register()` 的 disposer —— 两处释放同一个注册是常态。
     * 包一层让重复释放变成 no-op，重绑时序就只有一个变量（先全释放、再全注册），
     * 不用去猜哪个 disposer 会连带释放谁。
     */
    function once(fn) {
      if (typeof fn !== 'function') return () => {}
      let done = false
      return () => {
        if (done === true) return
        done = true
        try { fn() } catch { /* ignore */ }
      }
    }

    /**
     * 注册全部槽位，返回 disposer 数组。
     *
     * ## 为什么是这三个、而不是原来的四个
     *
     * 配置表单搬到了 `settings.section`（见 SETTINGS_SECTION_ID 的注释）。
     * `plugins.bundle.config` / `plugins.row.config` 是 **keyed** 槽位，页面按
     * `entryKey: pkg.name` 渲染、用 `ledger.bundles.has(pkg.name)` 精确比较门控；
     * 同一份代码挂在别的 Loader entry id 下就一个字都不显示，而部署随时可能换
     * 那个 id（对应 workbuddy 的 issue #55）。同一项配置还出现两个编辑入口，
     * 用户改了一个另一个看着没变，是更糟的体验 —— 所以这一对**删除**。
     *
     * `settings.plugins.tab` 保留：它是运维视图（账号/登录/诊断/福利），
     * 不是配置表单，与 settings.section 共存不冲突。输入框胶囊也照旧。
     *
     * `getScope()` 每次调用都**现取**当前绑定的 scope —— 注册动作只做一次，
     * 但 inject 的求值发生在渲染时，所以镜像晚到也能拿到新 scope。
     *
     * 每个槽位各自 try/catch：一个形态不匹配不能拖垮另一个。
     */
    function registerSlots(ctx, getScope) {
      const disposers = []
      const scopeProps = () => {
        const scope = getScope()
        return scope === undefined ? {} : { settingsScope: scope }
      }

      // ---- settings.section + settings.section.icon（同一个 id，一个 inject 回调里注册）
      try {
        const disposeSection = ctx.slots.inject('settings.section', () => {
          const inner = []
          const disposePage = ctx.slots.register({
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: 35,
            label: () => SETTINGS_SECTION_LABEL,
            inject: scopeProps,
          }, SettingsSection)
          // 宿主用 `renderSlot('settings.section.icon', …, { only: row.id })` 渲染图标，
          // 所以图标必须注册在**同一个 id** 下。放在同一个回调里，配对是结构性的。
          try {
            const disposeIconInject = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
              name: 'settings.section.icon',
              id: SETTINGS_SECTION_ID,
            }, SettingsSectionIcon))
            if (typeof disposeIconInject === 'function') inner.push(once(disposeIconInject))
          } catch (e) {
            // 图标注册失败不能影响页面本身
            console.error('[dsh-connect-teleagent] settings.section.icon 注册失败（页面不受影响）:', e)
          }
          const disposePageOnce = once(disposePage)
          return () => {
            disposePageOnce()
            for (const d of inner) try { d() } catch { /* ignore */ }
          }
        })
        if (typeof disposeSection === 'function') disposers.push(once(disposeSection))
      } catch (e) {
        console.error('[dsh-connect-teleagent] settings.section 注册失败:', e)
      }

      // ---- settings.plugins.tab：保留的卡片（运维视图）
      try {
        const disposeTab = ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-connect-teleagent',
          order: 40,
          inject: scopeProps,
        }, Card))
        if (typeof disposeTab === 'function') disposers.push(once(disposeTab))
      } catch (e) {
        console.error('[dsh-connect-teleagent] settings.plugins.tab 注册失败:', e)
      }

      // ---- 输入框左下角的积分胶囊（可选挂载点：不存在时不报错）
      // disposer 必须进列表：rebind 只做「先全释放、再全注册」，漏掉这一个
      // 就会在第二次绑定时重复注册同一个 keyed 槽位（宿主会 THROW）。
      const capsule = registerCapsule(ctx)
      if (capsule !== undefined) disposers.push(once(capsule.dispose))

      return disposers
    }

    /**
     * 输入框左下角的积分胶囊。
     *
     * 挂载点按顺序探测：宿主可能只声明其中一个，也可能一个都没有（老版本）。
     * 返回命中槽位的名字和一个释放函数；都没有时返回 undefined。
     */
    function registerCapsule(ctx) {
      const targets = ['conversation.input.left', 'conversation.composer.dock']
      for (const slotName of targets) {
        try {
          let inner
          const dispose = ctx.slots.inject(slotName, () => {
            inner = ctx.slots.register({
              name: slotName,
              id: 'dsh-connect-teleagent-points',
              key: 'dsh-connect-teleagent-points',
              order: 30,
              priority: 30,
              inject: () => ({}),
            }, PointsCapsuleGate)
            return inner
          })
          if (dispose) {
            return {
              slotName,
              dispose() {
                for (const d of [inner, dispose]) {
                  try { if (typeof d === 'function') d() } catch { /* ignore */ }
                }
              },
            }
          }
        } catch { /* 该宿主没有这个槽位，换下一个 */ }
      }
      return undefined
    }

    /**
     * 绑定 settings scope，并在 namespace 变化时**先释放再重注册**全部槽位。
     *
     * 为什么不能只在启动时读一次（对应 workbuddy 4.3.0 的 issue #46）：镜像由
     * 异步的 `describe()` 填充，`apply` 时通常还没有；`ConfigFormController.derive()`
     * 又是**精确**匹配 namespace，猜错就一直 `unavailable`。`whileServed` 是宿主
     * 自己的做法（subscribe + 立即同步），还额外做到「宿主不再服务时撤回绑定」。
     *
     * 为什么必须在变化时 dispose 后重新注册：renderer 按对象身份缓存每个 entry
     * 的 inject 结果（`if (!props) { props = runInject(...) }`），所以早先注册的
     * entry 永远不会被重新求值 —— 晚绑定只能靠换掉整批注册。
     *
     * ORDER MATTERS：先 dispose 再 register。keyed 槽位同 key 重复注册会 THROW，
     * 而每处注册都各自 try/catch 吞掉错误 —— 反过来做的话会得到一个**空** ledger，
     * 比不重绑更糟。
     */
    function bindSettingsScope(ctx, state) {
      const forms = softGet(ctx, 'configForms')

      if (forms === undefined || forms === null || typeof forms.whileServed !== 'function') {
        // 老宿主：要么没有 configForms，要么只有 get()。能拿到 scope 就用，
        // 拿不到就一直是 undefined —— 所有读写自动回退 HTTP，不崩。
        if (forms !== undefined && forms !== null && typeof forms.get === 'function') {
          const ns = servedNamespaceOf(forms)
          if (ns !== undefined) {
            try { state.settingsScope = forms.get(ns) } catch { state.settingsScope = undefined }
          }
        }
        state.rebind()
        return
      }

      // `whileServed` 订阅时会**同步**跑一次回调（宿主用 mirror.subscribe + immediate
      // sync）。那次已经 rebind 过，末尾就别再重复注册一遍 —— dispose 在前所以不是
      // bug，但每次重绑都要把三个槽位全部拆掉重建，白做一轮。
      let fired = false
      const run = () => forms.whileServed(SETTINGS_NAMESPACE_CANDIDATES, (served) => {
        fired = true
        const ns = SETTINGS_NAMESPACE_CANDIDATES.find((candidate) => served && served.has(candidate))
          ?? (served ? [...served].find((entry) => /teleagent/i.test(entry)) : undefined)
        state.settingsScope = ns === undefined ? undefined : forms.get(ns)
        state.rebind()
        return () => state.disposeAll()
      })

      try {
        if (typeof ctx.effect === 'function') {
          ctx.effect(run, 'dsh-connect-teleagent: settings namespace binding')
        } else {
          // 没有 effect 的宿主：退化成一次性订阅，靠调用方自己释放
          state.whileServedDispose = run()
        }
      } catch (e) {
        console.error('[dsh-connect-teleagent] settings namespace 绑定失败（配置页可能不可用）:', e)
      }
      // 订阅没触发（宿主实现了 whileServed 但不同步回调）：至少注册一次，
      // 否则界面上一个槽位都没有 —— 这正是「什么都没显示也不报错」的那类事故。
      if (fired !== true) state.rebind()
    }

    function apply(ctx, inject) {
      try {
        const state = {
          settingsScope: undefined,
          liveDisposers: [],
          whileServedDispose: undefined,
          disposeAll() {
            for (const dispose of state.liveDisposers) try { if (typeof dispose === 'function') dispose() } catch { /* ignore */ }
            state.liveDisposers = []
          },
          rebind() {
            state.disposeAll()
            state.liveDisposers = registerSlots(ctx, () => state.settingsScope)
            try {
              console.info(
                `[dsh-connect-teleagent] 槽位：${state.liveDisposers.length} 个` +
                `（设置页表单：${state.settingsScope === undefined ? '未绑定 — 读写走 HTTP 回退' : '已绑定'}）`,
              )
            } catch { /* ignore */ }
          },
        }
        bindSettingsScope(ctx, state)
      } catch (e) {
        console.error('[dsh-connect-teleagent] 卡片挂载失败（模型仍可用）:', e)
      }
    }

    // 供离线渲染测试使用（宿主只读取 name/inject/apply）
    exports.__internals = {
      CardView, Card, PointsCapsule, PointsCapsuleGate, ProbeList, selectedProviderOf,
      SettingsSection, SettingsSectionView, SettingsSectionIcon,
      // 设置读写（测试直接验证「scope 优先 / 无 scope 回退 HTTP」）
      readSettingsValue, writeSetting, writeSettingsField, setViaScope,
      overlayStatus, overlayWelfare, valuesFromStatus,
      normalizeIdList, normalizeToolsList,
      SETTINGS_SECTION_ID, SETTINGS_NAMESPACE_CANDIDATES, SETTINGS_FIELDS,
    }
    exports.name = 'dsh-connect-teleagent-client'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
