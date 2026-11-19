# 配置与命令链

> 投递路径见 [架构图](./architecture.html)。这份文档只讲**东西怎么被配置、命令怎么进来**。

---

## 一、谁在改配置

```
人
├─ DSH 设置 → 会话编排          ← 主路径，自动保存
│   ├─ 信箱    回执窗口 / 静默放行 / 结群阈值 / 信箱目录名
│   ├─ 安全    二次确认 / 允许建会话 / 先问预设 / 保护系统盘 / 跨区放行 / 额外禁区
│   └─ 高级    工具超时 / 轮询间隔 / 队列目录 / 通知令牌
│
└─ 直接改 cordis.patch.yml      ← 兜底，需要重载插件
```

### 设置页怎么把改动写进去

```
设置页（浏览器）
  │ 改一个值
  │ 600ms 防抖
  ▼
POST /session-bridge/config  { patch: {...} }
  │ ① 先过 access check（未通过 401，不碰配置）
  ▼
configEditor.configuration()  → 找到 id 为 session-bridge 的那一行
  │
  ▼
configEditor.edit(entry, current => ({...current, ...patch}))
  │
  ├─ 写回 profile 的 cordis.patch.yml
  └─ Loader 重新组合 → 插件重新 apply → 新配置生效
```

**没有「保存」按钮**，也没有「需要重启」这回事。关掉页面时若还有没写出去的改动，会补写一次。

### 配置读回来的路径

```
GET /session-bridge/config
  ▼
configEditor.configuration()
  ▼ 取 entry.options.config（叠加 inherited / override）
  ▼
返回 { ok: true, config: {...} }
```

页面在拿到数据之前，先渲染一版**骨架**（值都是空的），整块淡化 + 禁止点击；
拿到数据后变亮并填入真实值。**骨架期禁止写入**，避免拿空值覆盖真实配置。

---

## 二、谁在发命令

三条路，对应三种「入口」，最终都落到同一批工具。

```
                    ┌─────────────────────────────────────┐
                    │  同一个能力层（14 个模型工具）        │
                    └─────────────────────────────────────┘
                          ▲            ▲            ▲
                          │            │            │
        ① 模型自己决定      │  ② 人类敲命令  │  ③ 人类说人话
                          │            │            │
     ┌────────────────────┴──┐  ┌──────┴──────┐  ┌──┴──────────────────┐
     │ 工具调用               │  │ 斜杠命令     │  │ 自然语言种子         │
     │ session_* / mail_*    │  │ /register-me │  │ pre-step 认 4 类意图 │
     │                       │  │ /register-peer│  │ 追加一段流程提示     │
     │                       │  │ /new-workspace│  │                      │
     └───────────────────────┘  └──────────────┘  └─────────────────────┘
              │                        │                     │
              │                        │                     │
              │                 不进模型上下文            只在第 1 步判断一次
              │                 由宿主直接执行            不拦截、不改写人话
              ▼                        ▼                     ▼
        ┌──────────────────────────────────────────────────────────┐
        │  需要「人类同意」的动作：建会话、删工作区                    │
        │  ↓                                                        │
        │  人类授权表（10 分钟 · 用一次就消耗）                        │
        │    · 种子认出「建工作区」→ 发一次授权                        │
        │    · 命令被执行        → 发一次授权                        │
        │    · agent 自己想建     → 没有授权 → AGENT_CREATE_DISABLED  │
        └──────────────────────────────────────────────────────────┘
```

### 三条路的差别

| | 谁发起 | 进模型上下文 | 能不能被门控拦 |
|---|---|---|---|
| 工具调用 | 模型 | 是（工具结果） | 能（靠授权表） |
| 斜杠命令 | 人类 | **否** | 不拦，人类本来就是发起人 |
| 自然语言种子 | 人类说、模型读 | 是（runtime-context） | 能（种子会发授权） |

**关键**：命令和种子都能发授权，但**只有人类的真实发言/操作能触发**。agent 无法凭空造出人类消息。

---

## 三、3 条斜杠命令

人类敲的命令。**由宿主直接执行，不进入模型上下文**。

### 关键约束：命令的 text 只有人类看得到

`command/done` 事件里的 `text` 只写进会话日志并显示给用户，**不会进入模型的下一轮上下文**。

所以：
- ❌ 不要在命令结果里写「请 agent 去做某某事」——agent 收不到
- ✅ 结果里只放**人类能直接执行的东西**：格式说明、可复制的命令、当前状态

想让人接着做，就给一条**能复制的命令**。

### `/register-me <名字>`

```
成功  → 〔信箱·注册〕已登记为 `名字`。原名 a、b 已被替换。
缺参  → 正确格式 + 「把下面这行复制给助手」
```

- 名字自动清洗：空格折连字符、标点删掉、超长截 32
- **覆盖语义**：一个会话只保留一个主名，旧名会被替换并告知

### `/register-peer [会话线索] [名字]`

```
给 id 且存在   → 直接注册
给 id 但不存在 → 列出候选 + 「复制 /register-peer <id> 再接一次」
给工作区名     → 唯一命中直接注册；多个命中列候选
```

- 候选**只显示名字**（注册名 > 清洗后的标题 > 工作区名-尾号），不印完整 UUID
- 候选范围受 `allowCrossWorkspace` 管：关着只看本工作区

### `/new-workspace <项目名> <目录>`

```
参数齐全 → 当场建工作区 + 开会话，回「工作区已建好」+ 会话 id + 注册名
缺参数   → 格式说明 + 「把下面这行复制给助手」
```

- 路径解析：按空白切，取最后一个以盘符/根开头的片段
- 先过 `guardCreatablePath`（系统目录直接拒）
- 自己发一次人类授权，绕过「禁止 agent 自主建会话」的门控
- 走 `submitLocal`，与工具同一条执行路径
- **检查 `value.ok`**：失败时不会回「已建好」

### 三条命令的统一模式

| 项 | 做法 |
|---|---|
| 异常 | `withEcho` 统一包装，转成 `/命令名 执行出错：<原因>` |
| 缺参 | 正确格式 + 一行可复制给助手的话 |
| 成功 | 一句话结论 + 关键字段 |
| 面向对象 | **只面向人类**，不写「请 agent 如何如何」 |

---

## 四、11 条 HTTP 路由各干什么

全部走同源访问检查，未通过返回 401/403 空 body。

```
配置类
  /config              GET 读配置 / POST 写配置

好友类
  /friends             GET 只读好友表（只给名字和 id，供 @ 菜单）

通知类
  /notify              POST 外部脚本按名字或 id 投一条通知（可带 token）

跳转类（一次性，用后销毁）
  /jump                GET  查某会话最近助手消息里的 sa-session: 标记
  /jump-used           GET  记「这个按钮用过了」
  /back                GET  查创建者（links 登记优先，退化到父会话）
  /back-consume        GET  记「返回按钮用过了」
  /jump-record         GET  确认跳转后写 links 登记（返回键的唯一授权来源）
  /auto-jump           GET  取该会话最早一条待跳转记录
  /auto-jump-used      GET  消费掉那条待跳转记录

诊断类
  /client-report       GET  浏览器回报（插槽挂载失败、渲染错误等）
```

---

## 五、14 个模型工具

```
会话类
  session_init_workspace    建工作区 + 开会话（受授权表管）
  session_handoff           交给另一个预设的会话（受授权表管）
  session_jump              排队一次界面跳转
  session_register_name     给自己登记名字
  session_list_names        看这个工作区都有谁
  session_tell              发即时口信（无状态跟踪）

信箱类
  mail_send                 寄信（可 urgent / 可 S-EXPIRE 撤销）
  mail_ack                  回执 / 结案
  mail_inbox                拉未读
  mail_status               查一封信走到哪
  mail_list                 按 owner 列信
  mail_friends              查有哪些好友
  mail_pause                暂停 / 恢复投递
  mail_group                建群 / 列群
```

**另有队列动作**（外部脚本可用，不是模型工具）：
`deliver` `sessions` `events` `init_workspace` `handoff` `notify` `relay` `list_children` `jump` `delete_workspace` `mail_*` `peer_state` `commands` `sweep_friends` `prefs_get` `prefs_set`

---

## 六、落盘面一览

```
每个工作区
  .dsh-mail/_letters.json      信件状态
  .dsh-mail/envelope/          信封本体（正文在这）
  .dsh-mail/_index.json        状态索引（A/P/R/B/D/E 路径）
  .dsh-mail/_ledger.json       操作留痕
  .dsh-mail/group.json         群路由表
  .dsh-mail/_courier.json      投递通道

队列根（默认 $DSH_HOME/session-bridge）
  friends.json                 全局好友表
  agent-prefs.json             助手记下的说法
  heartbeat.json               插件活着没
  deleted-workspaces.jsonl     删过的工作区留痕
  client-reports/              浏览器诊断
  jumps/{links,pending,used}/  跳转账本
```

---

## 七、四份文档的分工

| 文档 | 给谁 | 内容 | 要装吗 |
|---|---|---|---|
| [README.md](../README.md) | 人 | 能做什么、怎么装、怎么用、越权说明 | — |
| [AGENT-GUIDE.md](./AGENT-GUIDE.md) | 助手 | 完整说明书：参数、状态流转、拒绝码、全部配置项 | 不用，随插件发布 |
| [SKILL.md](../skills/session-orchestrator/SKILL.md) | 助手 | 精简操作版：怎么用、边界、不要问什么 | **需人同意才装** |
| [architecture.html](./architecture.html) | 都行 | 一封信怎么走完全程 | — |
| **本文档** | 都行 | 配置从哪来、命令从哪进 | — |

人想让助手做对这件事，最省事的办法不是装 skill，而是说一句：

> 用会话编排插件的时候，先读 `docs/AGENT-GUIDE.md`
