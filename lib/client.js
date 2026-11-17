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

        register('conversation.chat.assistant-actions', 'session-jump-action', 60, ForwardButton, 'forward')
        register('conversation.input.left', 'session-back', 50, BackBar, 'back-input-left')
      },
    }
  },
})