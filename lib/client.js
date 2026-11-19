/**
 * 浏览器半身 · v2（单次触发 + 用后销毁 + 返回键）
 *
 * 两个入口，都是一次性的：
 *  1) 助手回复的动作条：「打开会话 →」——只在那条消息正文含 `sa-session:<id>` 时出现；
 *     点一次就跳转，并在 Host 账本记一笔，之后刷新也不会再长出来。
 *  2) 输入框上沿：「← 返回创建者」——当前会话登记过创建者时出现（Host 的 jumps/links 或 parentSession）；
 *     同样点一次即销毁。
 *
 * 所有"要不要显示"的判断都在 Host 侧做；浏览器端只有 messageId / sessionId 两个事实。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-orchestrator',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let ctx0

    async function report(event, extra) {
      try {
        const payload = { event, at: Date.now(), ...(extra || {}) }
        await fetch('/session-bridge/client-report?data=' + encodeURIComponent(JSON.stringify(payload)), {
          method: 'GET',
          cache: 'no-store',
        })
      } catch (error) {
        /* 回报失败不影响主功能 */
      }
    }

    async function getJson(url) {
      const response = await fetch(url, { method: 'GET', cache: 'no-store' })
      return response.ok ? await response.json() : { ok: false }
    }

    async function markUsed(key) {
      try {
        await getJson('/session-bridge/jump-used?key=' + encodeURIComponent(key))
      } catch (error) {
        /* 账本写失败不阻塞跳转 */
      }
    }

    /** 记一笔“这次跳转是谁跳到谁”；返回按钮只认这条记录，所以要先落地再导航。 */
    function recordJump(from, to, kind) {
      if (!from || !to || from === to || kind === 'back') return Promise.resolve(false)
      return getJson(
        '/session-bridge/jump-record?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to) + '&kind=' + encodeURIComponent(kind || 'forward'),
      )
        .then((result) => Boolean(result && result.ok))
        .catch(() => false)
    }

    function jumpTo(target, extra) {
      try {
        const ui = ctx0 && ctx0.get ? ctx0.get('uiWorkspace') : undefined
        if (ui && typeof ui.openSession === 'function') {
          const from = extra && extra.from
          const kind = extra && extra.kind
          // 先写账本再切页面：目标页首屏就要读这条记录，晚了会读不到
          recordJump(from, target, kind)
            .then(() => ui.openSession(target))
            .catch(() => ui.openSession(target))
          void report('jump-clicked', { target, ok: true, ...(extra || {}) })
          return true
        }
        void report('jump-clicked', { target, ok: false, reason: 'uiWorkspace unavailable', ...(extra || {}) })
        return false
      } catch (error) {
        void report('jump-clicked', { target, ok: false, reason: (error && error.message) || String(error), ...(extra || {}) })
        return false
      }
    }

    const buttonStyle = {
      fontSize: '11px',
      lineHeight: '1.4',
      padding: '2px 8px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-line-secondary, #8884)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
    }

    const pillStyle = {
      fontSize: '11px',
      lineHeight: '1.4',
      height: '24px',
      padding: '0 8px',
      borderRadius: '12px',
      border: '1px solid var(--dsw-alias-line-secondary, #8884)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    /** 回复动作条上的前向跳转：一次性。 */
    function ForwardButton(props) {
      const [target, setTarget] = React.useState(undefined)
      const checked = React.useRef(false)

      React.useEffect(() => {
        if (checked.current) return
        checked.current = true
        const sessionId = props && props.sessionId
        const messageId = props && props.messageId
        if (!sessionId || !messageId) return
        void (async () => {
          try {
            const found = await getJson(
              '/session-bridge/jump?sessionId=' + encodeURIComponent(sessionId) + '&messageId=' + encodeURIComponent(messageId),
            )
            if (found && found.found && !found.used) {
              setTarget(found.target)
              void report('forward-shown', { sessionId, messageId, target: found.target })
            }
          } catch (error) {
            void report('forward-lookup-failed', { message: (error && error.message) || String(error) })
          }
        })()
      }, [])

      if (!target) return null

      return h(
        'button',
        {
          type: 'button',
          'data-session-jump': 'forward',
          title: '跳到会话 ' + target,
          onClick: () => {
            const ok = jumpTo(target, { kind: 'forward', from: props && props.sessionId })
            if (ok) {
              setTarget(undefined)
              void markUsed(props.messageId)
            }
          },
          style: buttonStyle,
        },
        '打开会话 →',
      )
    }

    /** 输入框上沿：返回键（一次性）+ 自动跳转轮询。 */
    function BackBar(props) {
      const [creator, setCreator] = React.useState(undefined)
      const checked = React.useRef(false)

      // 自动跳转模式：agent 投了待跳转记录，这里 2 秒内把它消费掉（页面自己切过去）。
      React.useEffect(() => {
        const sessionId = props && props.sessionId
        if (!sessionId) return undefined
        let stopped = false
        const poll = async () => {
          if (stopped) return
          try {
            const pending = await getJson('/session-bridge/auto-jump?sessionId=' + encodeURIComponent(sessionId))
            if (!stopped && pending && pending.found && pending.target) {
              const ok = jumpTo(pending.target, { kind: 'auto', from: sessionId })
              void report('auto-jump', { target: pending.target, ok, key: pending.key })
              if (ok) await getJson('/session-bridge/auto-jump-used?key=' + encodeURIComponent(pending.key))
            }
          } catch (error) {
            /* 轮询失败下一轮继续 */
          }
        }
        void poll()
        const timer = setInterval(poll, 2000)
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [props && props.sessionId])

      React.useEffect(() => {
        if (checked.current) return
        checked.current = true
        const sessionId = props && props.sessionId
        if (!sessionId) return
        void (async () => {
          try {
            const back = await getJson('/session-bridge/back?sessionId=' + encodeURIComponent(sessionId))
            if (back && back.found && !back.used) {
              setCreator(back.creatorSessionId)
              void report('back-shown', { sessionId, creator: back.creatorSessionId, source: back.source })
              // 渲染一次即消费：本次跳转的返回按钮只属于这一次进入，刷新后不会再长出来
              void getJson('/session-bridge/back-consume?sessionId=' + encodeURIComponent(sessionId))
            }
          } catch (error) {
            void report('back-lookup-failed', { message: (error && error.message) || String(error) })
          }
        })()
      }, [])

      if (!creator) return null

      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center' } },
        h(
          'button',
          {
            type: 'button',
            'data-session-jump': 'back',
            title: '返回创建者会话 ' + creator,
            onClick: () => {
              const ok = jumpTo(creator, { kind: 'back', from: props && props.sessionId })
              if (ok) {
                setCreator(undefined)
                void markUsed('back-' + (props && props.sessionId))
              }
            },
            style: pillStyle,
          },
          '← 返回创建者',
        ),
      )
    }

    /* ============ 设置页：会话编排 ============ */

    /** 一行偏好：左标题+说明，右控件。 */
    function Field({ label, hint, children }) {
      return h(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid rgba(128,128,128,0.15)' } },
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontSize: '13px', fontWeight: 500 } }, label),
          hint ? h('div', { style: { fontSize: '11.5px', opacity: 0.7, marginTop: '3px', lineHeight: 1.5 } }, hint) : null,
        ),
        h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: '8px' } }, children),
      )
    }

    function Section({ title, description, children }) {
      return h(
        'section',
        { style: { marginBottom: '26px' } },
        h('div', { style: { fontSize: '12px', letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.55, marginBottom: '4px' } }, title),
        description ? h('div', { style: { fontSize: '11.5px', opacity: 0.65, marginBottom: '8px' } }, description) : null,
        children,
      )
    }

    function NumInput({ value, onChange }) {
      return h('input', {
        type: 'number',
        value: value === undefined || value === null ? '' : value,
        onChange: (event) => onChange(Number(event.target.value)),
        style: { width: '110px', padding: '5px 8px', fontSize: '12px' },
      })
    }

    function TxtInput({ value, placeholder, onChange }) {
      return h('input', {
        type: 'text',
        value: value === undefined || value === null ? '' : value,
        placeholder: placeholder || '',
        onChange: (event) => onChange(event.target.value),
        style: { width: '240px', padding: '5px 8px', fontSize: '12px' },
      })
    }

    function Toggle({ value, onChange }) {
      return h('input', { type: 'checkbox', checked: value === true, onChange: (event) => onChange(event.target.checked) })
    }

    const CONFIG_ENTRY_ID = 'session-bridge'

    function pickEntry(rows) {
      if (!Array.isArray(rows)) return undefined
      return rows.find((row) => row && row.entry && row.entry.options && row.entry.options.id === CONFIG_ENTRY_ID)
    }

    function effectiveConfig(row) {
      if (!row) return {}
      return {
        ...(row.inherited || {}),
        ...((row.entry && row.entry.options && row.entry.options.config) || {}),
        ...(row.override || {}),
      }
    }

    function SettingsPage() {
      const [draft, setDraft] = React.useState({})
      // 立刻渲染骨架，配置在后台补进来：
      // 原来整页阻塞在「正在读取配置…」，host 那一趟约 100-150ms，用户体感就是"卡一下"。
      const [status, setStatus] = React.useState({ kind: 'filling' })
      // 自动保存：连续改动合并成一次写入，避免每敲一个字符就打一次 host。
      const pendingRef = React.useRef(null)
      const timerRef = React.useRef(null)

      // 配置读写经 host 的 /session-bridge/config 中转：
      // configEditor 是 host 服务，浏览器端拿不到，只能让 host 代办。
      React.useEffect(() => {
        let stopped = false
        void (async () => {
          try {
            const data = await getJson('/session-bridge/config')
            if (stopped) return
            if (!data || data.ok !== true) {
              const message =
                data && data.error && data.error.code === 'NO_CONFIG_EDITOR'
                  ? '宿主未提供 configEditor 服务，无法在此修改配置。可改用 cordis.patch.yml 手工配置。'
                  : '读取配置失败：' + ((data && data.error && data.error.message) || '未知原因')
              setStatus({ kind: 'unavailable', message })
              return
            }
            setDraft(data.config || {})
            setStatus({ kind: 'ready' })
          } catch (error) {
            if (!stopped) setStatus({ kind: 'unavailable', message: (error && error.message) || String(error) })
          }
        })()
        return () => {
          stopped = true
        }
      }, [])

      /** 把一整份配置写回 host；失败时把错误留在状态里，不清空用户已改的值。 */
      const persist = async (next) => {
        setStatus({ kind: 'saving' })
        try {
          const response = await fetch('/session-bridge/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch: next }),
            cache: 'no-store',
          })
          const data = await response.json().catch(() => ({}))
          if (!response.ok || data.ok !== true) {
            setStatus({ kind: 'error', message: (data && data.error && data.error.message) || 'HTTP ' + response.status })
            return
          }
          setStatus({ kind: 'saved' })
        } catch (error) {
          setStatus({ kind: 'error', message: (error && error.message) || String(error) })
        }
      }

      /** 改一个值：立刻更新界面，并把保存推迟 600ms，连续改动只写一次。 */
      const set = (key, value) => {
        // 配置还没读回来时不要写：否则会把骨架上的空值当成用户意图覆盖真实配置。
        if (status.kind === 'filling') return
        setDraft((prev) => {
          const next = { ...prev, [key]: value }
          pendingRef.current = next
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => {
            timerRef.current = null
            void persist(pendingRef.current)
          }, 600)
          return next
        })
      }

      // 卸载时补一次，避免「改完立刻离开页面」丢掉最后一次修改
      React.useEffect(
        () => () => {
          if (timerRef.current) {
            clearTimeout(timerRef.current)
            timerRef.current = null
            if (pendingRef.current) void persist(pendingRef.current)
          }
        },
        [],
      )

      if (status.kind === 'unavailable') {
        return h(
          'div',
          { style: { padding: '18px', fontSize: '13px', lineHeight: 1.7 } },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '配置不可用'),
          h('div', { style: { opacity: 0.75 } }, status.message),
        )
      }

      // 右上角状态：自动保存的落点提示。saved 时短暂显示，saving 时标「保存中」。
      const savedLabel =
        status.kind === 'filling'
          ? '读取中…'
          : status.kind === 'saving'
            ? '保存中…'
            : status.kind === 'saved'
              ? '已自动保存'
              : '修改后自动保存'
      const savedColor = status.kind === 'error' ? '#d9534f' : status.kind === 'saved' ? '#4caf50' : 'inherit'

      const filling = status.kind === 'filling'

      return h(
        'div',
        {
          style: {
            padding: '4px 18px 30px',
            maxWidth: '760px',
            // 骨架期整块淡化且不可交互：配置填进来之前点不动，
            // 避免拿空值覆盖真实配置（set() 也会拦，这是第二道）。
            opacity: filling ? 0.55 : 1,
            pointerEvents: filling ? 'none' : 'auto',
            transition: 'opacity 120ms linear',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '12px', margin: '14px 0 4px' } },
          h('h2', { style: { fontSize: '16px', margin: 0 } }, '会话编排'),
          h('span', { style: { fontSize: '11.5px', opacity: 0.75, color: savedColor, whiteSpace: 'nowrap' } }, savedLabel),
        ),
        h('p', { style: { fontSize: '12px', opacity: 0.7, margin: '0 0 20px', lineHeight: 1.6 } }, '跨会话信箱与会话编排插件。改动后自动保存，由宿主重新组合并立即生效，不需要重启应用。'),
        status.kind === 'error' ? h('div', { style: { fontSize: '12px', color: '#d9534f', marginBottom: '12px' } }, '保存失败：' + status.message) : null,

        h(
          Section,
          { title: '信箱', description: '信件投递的节奏与容量。' },
          h(Field, { label: '回执窗口（秒）', hint: '信被对方读到之后，多久没回执就转待办。默认 300 秒。' }, h(NumInput, { value: Math.round((draft.ackTimeoutMs || 300000) / 1000), onChange: (v) => set('ackTimeoutMs', v * 1000) })),
          h(Field, { label: '静默放行（秒）', hint: '同一对角色上一封长时间没回执时，等这么久就允许发下一封。0 表示只认显式回执。' }, h(NumInput, { value: Math.round((draft.backpressureReleaseMs || 0) / 1000), onChange: (v) => set('backpressureReleaseMs', v * 1000) })),
          h(Field, { label: '自动结群阈值（封）', hint: '同一对角色往返达到这么多封就自动建群，最小 2。' }, h(NumInput, { value: draft.groupAutoThreshold, onChange: (v) => set('groupAutoThreshold', v) })),
          h(Field, { label: '信箱目录名', hint: '工作区里存信件的目录名，默认 .dsh-mail。改名后旧目录不会自动迁移。' }, h(TxtInput, { value: draft.mailDirName, placeholder: '.dsh-mail', onChange: (v) => set('mailDirName', v) })),
        ),

        h(
          Section,
          { title: '安全', description: '这些开关直接决定 Agent 能对磁盘做什么。' },
          h(
            Field,
            { label: '递归删除需要二次确认', hint: '开启时删除工作区目录必须再回一次「确认删除」并带令牌。关掉后一次请求即可删除。路径护栏不受此开关影响。' },
            h(Toggle, { value: draft.requireDeleteConfirm !== false, onChange: (v) => set('requireDeleteConfirm', v) }),
          ),
          h(
            Field,
            {
              label: '保护系统盘与应用安装目录',
              hint: '拒绝在 C 盘、DSH_HOME、DSH 安装目录内建工作区或递归删除。安装目录每次升级会被清空重建，工作区放进去会和升级一起消失；系统盘放项目会占系统空间、也容易被清理工具误删。只在确实只在 C 盘工作时才关掉。',
            },
            h(Toggle, { value: draft.guardSystemDrive !== false, onChange: (v) => set('guardSystemDrive', v) }),
          ),
          h(Field, { label: '跨工作区放行', hint: '关闭时只有同工作区或嵌套目录之间能发信；开启后允许跨到无关工作区。' }, h(Toggle, { value: draft.allowCrossWorkspace === true, onChange: (v) => set('allowCrossWorkspace', v) })),
          h(
            Field,
            { label: '额外禁区（逗号分隔）', hint: '在这些绝对路径下也不建工作区、不递归删除。只能追加，无法删除内置保护。' },
            h(TxtInput, {
              value: Array.isArray(draft.guardedPaths) ? draft.guardedPaths.join(', ') : '',
              placeholder: 'E:\\不动的目录, D:\\另一处',
              onChange: (v) => set('guardedPaths', v.split(/[,，]/).map((x) => x.trim()).filter(Boolean)),
            }),
          ),
        ),

        h(
          Section,
          { title: '高级', description: '一般不需要改。' },
          h(Field, { label: '工具超时（毫秒）', hint: '工具经文件队列等处理实例的上限。慢机器或大工作区调大，默认 60000。' }, h(NumInput, { value: draft.toolTimeoutMs, onChange: (v) => set('toolTimeoutMs', v) })),
          h(Field, { label: '队列轮询间隔（毫秒）', hint: '扫描收件目录的间隔，默认 1000。' }, h(NumInput, { value: draft.pollMs, onChange: (v) => set('pollMs', v) })),
          h(Field, { label: '队列目录', hint: '外部程序投递请求的根目录。留空表示 $DSH_HOME/session-bridge。' }, h(TxtInput, { value: draft.dir, placeholder: '(默认)', onChange: (v) => set('dir', v) })),
          h(Field, { label: '通知共享令牌', hint: 'POST /session-bridge/notify 的校验令牌。留空表示不校验（仅限本机回环）。' }, h(TxtInput, { value: draft.notifyToken, placeholder: '(不校验)', onChange: (v) => set('notifyToken', v) })),
        ),

      )
    }

    return {
      inject: ['sessions', 'slots'],
      apply(ctx) {
        ctx0 = ctx
        ctx.effect(() => {
          void report('loaded')
        })

        // 一次性诊断：当前浏览器页面的 locale 是什么（子会话那个权限控件变英文，先看是不是整页切了语言）
        try {
          const locale = ctx.get ? ctx.get('locale') : undefined
          const snap = locale && typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined
          void report('locale-snapshot', { locale: snap, hasLocaleService: Boolean(locale) })
        } catch (error) {
          void report('locale-snapshot-failed', { message: (error && error.message) || String(error) })
        }

        const register = (slot, id, order, Component, label) => {
          try {
            ctx.slots.inject(slot, () =>
              ctx.slots.register({ name: slot, id, order }, (props) => {
                try {
                  return h(Component, props)
                } catch (error) {
                  void report('component-render-error', { slot, message: (error && error.message) || String(error) })
                  return null
                }
              }),
            )
            void report('slot-injected', { ok: true, slot, label })
          } catch (error) {
            void report('slot-inject-failed', { slot, message: (error && error.message) || String(error) })
          }
        }

        // 来源徽章：把「〔友·X〕」开头的用户消息标成“来自好友”，而不是人类输入。
        try {
          ctx.slots.inject('conversation.chat.user.before', () =>
            ctx.slots.register(
              {
                name: 'conversation.chat.user.before',
                select: (owner) => {
                  try {
                    const text = owner && (owner.text || (owner.message && owner.message.text) || '')
                    return /^〔友·[^〕]{1,32}〕/.test(String(text || '')) ? { from: String(text).match(/^〔友·([^〕]{1,32})〕/)[1] } : null
                  } catch {
                    return null
                  }
                },
              },
              (props) => {
                const from = props && props.from ? String(props.from) : '友'
                return React.createElement(
                  'div',
                  { style: { fontSize: '11px', opacity: 0.75, padding: '2px 0 0' } },
                  '来自好友 · ' + from,
                )
              },
            ),
          )
          void report('slot-injected', { ok: true, slot: 'conversation.chat.user.before', label: 'friend-badge' })
        } catch (error) {
          void report('slot-inject-failed', { slot: 'conversation.chat.user.before', message: (error && error.message) || String(error) })
        }

        // —— @ 好友来源：把注册好友挂进输入框的 @ 菜单（与内置"引用"并列）——
        // 候选只带注册名 + 会话 id；选中后插入 DSH 原生会话引用，agent 看到的是 @[名字](dsh-session:...)
        try {
          const encodeSessionId = (sessionId) => {
            const json = JSON.stringify(String(sessionId))
            let b64 = ''
            try {
              b64 = btoa(unescape(encodeURIComponent(json)))
            } catch (error) {
              b64 = btoa(json)
            }
            return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
          }
          const friendMention = (friend) => '@[' + String(friend.name).replace(/[\[\]]/g, '') + '](dsh-session:' + encodeSessionId(friend.sessionId) + ')'
          const friendSource = {
            trigger: '@',
            name: 'friend',
            showGroupTitle: true,
            async candidates(session, request) {
              const query = String((request && request.query) || '').toLowerCase()
              const data = await getJson('/session-bridge/friends')
              const friends = Array.isArray(data && data.friends) ? data.friends : []
              return friends
                .filter((friend) => {
                  const hay = String(friend.name).toLowerCase() + ' ' + String(friend.sessionId).toLowerCase()
                  return query === '' || hay.includes(query)
                })
                .map((friend) => ({
                  name: String(friend.name) + ' · ' + String(friend.sessionId),
                  description: '注册好友',
                  icon: 'session',
                  section: '好友',
                  value: JSON.stringify({ kind: 'friend', name: friend.name, sessionId: friend.sessionId }),
                }))
            },
            onPick({ candidate }) {
              const value = candidate && candidate.value ? JSON.parse(candidate.value) : null
              if (!value || value.kind !== 'friend') return undefined
              const mention = friendMention(value)
              return { insert: { source: 'reference', ref: mention, label: value.name, appearance: 'session', clipboardText: mention } }
            },
            codec: { clipboardText: (ref) => ref, serialize: (ref) => Promise.resolve(ref) },
          }
          // 用 ctx.inject 等 inputTriggers 就绪；没有该服务的旧客户端会安静跳过
          const attach = (scope) => {
            try {
              const inputTriggers = scope && typeof scope.get === 'function' ? scope.get('inputTriggers') : undefined
              if (!inputTriggers || typeof inputTriggers.registerSource !== 'function') {
                void report('at-source-unavailable', { hasInputTriggers: Boolean(inputTriggers) })
                return
              }
              scope.effect(() => inputTriggers.registerSource(friendSource), 'mailbox: @ friends source')
              void report('at-source-registered', { ok: true, name: 'friend' })
            } catch (error) {
              void report('at-source-failed', { message: (error && error.message) || String(error) })
            }
          }
          if (typeof ctx.inject === 'function') ctx.inject(['inputTriggers'], attach)
          else attach(ctx)
        } catch (error) {
          void report('at-source-failed', { message: (error && error.message) || String(error) })
        }

        register('conversation.chat.assistant-actions', 'session-jump-action', 60, ForwardButton, 'forward')
        register('conversation.input.left', 'session-back', 50, BackBar, 'back-input-left')

        // —— 设置页：会话编排（一个入口、一页、页内分三节）——
        // 配置读写走宿主 configEditor；它不可用时页面自己显示「配置不可用」。
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({ name: 'settings.section', id: 'session-orchestrator', order: 50, label: '会话编排' }, () => h(SettingsPage)),
          )
          void report('settings-section-registered', { ok: true })
        } catch (error) {
          void report('settings-section-failed', { message: (error && error.message) || String(error) })
        }
      },
    }
  },
})