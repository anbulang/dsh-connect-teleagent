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
                '钥匙串：' + (probe.keychain?.detail ?? '未知')),
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
        onRefresh, onLogin, onClear, onToggle, onClaim, onToggleAuto, onRefreshWelfare, onToggleProvider } = props

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
              !signedIn ? h(Button, { variant: 'primary', onClick: onLogin }, '去登录') : null,
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
            accountList.length > 0
              ? h(AccountList, {
                  accounts: accountList, appRunning, current, busy,
                  onSwitch: onSwitchAccount,
                  onDelete: onDeleteAccount,
                  canDeleteAccount: status.capabilities?.deleteAccount === true,
                  confirming: deleteConfirm,
                  onConfirm: onConfirmDelete,
                })
              : h('div', { style: { fontSize: 12, color: C.text3 } }, '本机只找到一个账号。'),
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
    function Card() {
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

      const load = React.useCallback(async () => {
        try {
          const res = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          if (!res.ok) throw new Error('HTTP ' + res.status)
          const next = await res.json()
          setStatus(next)
          setError(null)
          // 账号列表（含逐账号积分）：独立请求，失败不影响卡片
          void loadAccounts()
          // 福利数据与主状态并行拉取；失败不影响卡片其余部分
          try {
            const w = await fetch(WELFARE_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            if (w.ok) setWelfare(await w.json())
          } catch { /* ignore */ }
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        }
      }, [])

      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        const timer = setInterval(load, 15000)
        return () => clearInterval(timer)
      }, [load])

      const toggle = React.useCallback(async (id, next) => {
        setBusy(true)
        try {
          // 用函数式更新读取最新 status，避免闭包拿到旧值
          const current = await fetch(STATUS_PATH, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)
          if (!current) throw new Error('读取状态失败')
          const ids = (current.models || []).filter((m) => (m.id === id ? next : m.enabled)).map((m) => m.id)
          const res = await fetch(MODELS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ enabledModelIds: ids }),
          })
          if (!res.ok) throw new Error('保存失败 HTTP ' + res.status)
          await load()
        } catch (e) {
          setHint(e && e.message ? e.message : String(e))
        } finally {
          setBusy(false)
        }
      }, [load])

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
            setHint(`已切换到 ${data.account?.accountName ?? scope}，重启 DSH 后生效`)
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
          const res = await fetch(MODELS_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ providerDisabled: disabled }),
          })
          if (!res.ok) throw new Error('保存失败 HTTP ' + res.status)
          await load()
        } catch (e) {
          setHint(e?.message ?? '操作失败')
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

      return h(CardView, {
        status, error, busy, hint, confirmClear, welfare, tab, onTab: setTab,
        accounts, appRunning: accountsAppRunning, current: accountsCurrent, onSwitchAccount: switchAccount,
        onDeleteAccount: deleteAccount,
        deleteConfirm: confirmDelete, onConfirmDelete: setConfirmDelete,
        // status 首次渲染时是 null（还在加载）：这里必须用可选链，
        // 否则整个卡片在挂载瞬间就抛错，界面表现为「插件信息一片空白」。
        canProbe: status?.allowChatProbe === true, onProbe: probeModel, probing,
        onRefresh: load, onLogin: openLogin, onClear: clearAccount, onToggle: toggle,
        onToggleProvider: toggleProvider,
        onClaim: () => welfarePost({ action: 'claim' }),
        onToggleAuto: (enabled) => welfarePost({ action: 'auto', enabled }),
        onRefreshWelfare: () => welfarePost({ action: 'refresh' }),
      })
    }

    /**
     * 两种宿主形态各注册一套（参数形态不同，必须分开）：
     *
     *  - `plugins.bundle.config` / `plugins.row.config`：插件管理页（0.2.x），
     *    参数是 `{ name, key, priority, inject }`。key 要同时覆盖 bundle 自身 id
     *    与 include 形式（cordis-plugin-include 会让同一 bundle 以
     *    `include:<id>` 出现在树里）。
     *  - `settings.plugins.tab`：设置页的插件 tab（0.1.x），
     *    参数是 `{ name, id, order }`。
     *
     * 各自独立 try/catch：一个形态不匹配不能拖垮另一个。
     */

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

    const CARD_KEYS = ['dsh-connect-teleagent', 'include:dsh-connect-teleagent']

    function registerKeyed(ctx, slotName, key, styles) {
      try {
        return ctx.slots.inject(slotName, () => ctx.slots.register({
          name: slotName,
          key,
          priority: 30,
          inject: () => ({}),
        }, makeCard(styles)))
      } catch (e) {
        console.error(`[dsh-connect-teleagent] ${slotName}(${key}) 注册失败:`, e)
        return undefined
      }
    }

    function registerTab(ctx, styles) {
      try {
        return ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-connect-teleagent',
          order: 40,
        }, makeCard(styles)))
      } catch (e) {
        console.error('[dsh-connect-teleagent] settings.plugins.tab 注册失败:', e)
        return undefined
      }
    }

    /** 宿主可能注入样式容器；这里做成可选，缺失时卡片自带内联样式 */
    function makeCard(styles) {
      return styles ? Card : Card
    }

    /** 输入框左下角的积分胶囊（可选挂载点：不存在时不报错） */
    function registerCapsule(ctx) {
      const targets = ['conversation.input.left', 'conversation.composer.dock']
      for (const slotName of targets) {
        try {
          const dispose = ctx.slots.inject(slotName, () => ctx.slots.register({
            name: slotName,
            id: 'dsh-connect-teleagent-points',
            key: 'dsh-connect-teleagent-points',
            order: 30,
            priority: 30,
            inject: () => ({}),
          }, PointsCapsuleGate))
          if (dispose) return slotName
        } catch { /* 该宿主没有这个槽位，换下一个 */ }
      }
      return undefined
    }

    function apply(ctx, inject) {
      try {
        const styles = inject && inject.styles
        const ok = []
        for (const key of CARD_KEYS) {
          if (registerKeyed(ctx, 'plugins.bundle.config', key, styles)) ok.push(`bundle:${key}`)
          if (registerKeyed(ctx, 'plugins.row.config', `${key}#${key}`, styles)) ok.push(`row:${key}`)
        }
        if (registerTab(ctx, styles)) ok.push('settings.plugins.tab')
        const capsuleSlot = registerCapsule(ctx)
        if (capsuleSlot) ok.push('capsule:' + capsuleSlot)
        console.info(`[dsh-connect-teleagent] 卡片挂载点：${ok.length} 个`, ok)
      } catch (e) {
        console.error('[dsh-connect-teleagent] 卡片挂载失败（模型仍可用）:', e)
      }
    }

    // 供离线渲染测试使用（宿主只读取 name/inject/apply）
    exports.__internals = { CardView, Card, PointsCapsule, PointsCapsuleGate, ProbeList, selectedProviderOf }
    exports.name = 'dsh-connect-teleagent-client'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
