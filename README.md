# dsh-session-bridge

让 DeepSeek Harness 里的多个会话可以互相创建、互相跳转、互相写信。

[English](./README.en.md) · [架构图](./docs/architecture.html) · 当前版本 v0.1

## 这个软件能做什么

装上之后，你的会话多出三种能力。

**开新会话**。按预设建一个工作区和它的一期会话，目录、初始任务、标题一起交出去。不用手动开窗口、切目录、挑预设。

**跳到别的会话**。助手回复里出现某个会话的编号时，正文下方会有一个「打开会话」按钮，点一下就切过去。被切过去的那个会话，输入框上方出现「返回创建者」，点一下回到把它建出来的会话。两个按钮都是一次性的，刷新之后不会一直挂着。

**写信**。给另一个会话发一封信。正文写进工作区的文件里，对方收到的只是一条索引，写明来源、位置和当前状态。要不要读正文由它自己决定。没回执的信在超时后转成待办，收到回执就进处理中，关闭之后归档。同一对人来回几封之后会自动结成一个群，之后这一对人的信都按群路由走。

开新会话的时候，上面三件事自动接上。双方互相注册进好友表，各自的工作区里建好信箱，再开一条只给他们两人用的专用通道，默认 24 小时有效期内随时能来回通信。

## 快速开始

装好之后第一次用，走这三步就够。

```
# 1. 给自己登记一个名字，注册的同时会建好工作区信箱
session_register_name  name=lead

# 2. 给另一个会话写信。peerSessionId 是对方的会话编号
mail_send  owner=lead  peer=reviewer  type=S-PROGRESS  body="这一版看下"  peerSessionId=session-xxxx

# 3. 看这封信走到哪了
mail_status  mailId=M-20261017-0001
```

第三步的返回里会带 `fromPath` 与 `toPath`，比如 `A>R>D` 和 `P>R>D`，这就是这封信在发信方和收信方各自走过的路。

外部程序不用这些工具，直接往队列里投文件即可，写法见下面的「两条入口」。

## 装它需要什么

- 一个跑起来的 DSH Desktop。插件用到的宿主服务是 `sessionController`、`sessionPersistence`、`schedule`、`webServer`。
- 插件目录的绝对路径，路径里可以有中文。
- 没有第三方运行时依赖，只用系统自带的 Node。
- 队列目录（默认 `$DSH_HOME/session-bridge`）和工作区目录都要能写。
- 宿主事件要对得上：`agent/pre-step`、`agent/status` 两个钩子缺一个，回执与哨兵就不工作。

## 安装

### 给 AI 执行

装一次：

```
plugin_manager action=install_bundle target=<插件目录绝对路径>
```

改过 `.js` 之后必须重载，两条命令顺序不能反：

```
plugin_manager action=remove_bundle target=dsh-session-orchestrator
plugin_manager action=install_bundle target=<插件目录绝对路径>
```

判定成功的依据是回执里的 `application` 为 `applied`，不是日志，也不是进程还在不在。

### 给人操作

1. 把整个插件目录放在一个不会被移动的位置。目录一挪，profile 里的 `link:` 就断了，需要重新装一次。
2. 在 DSH 的插件面板里装这个目录，或者让助手跑上面那两条命令。装完会看到一行 `session-bridge`，版本 `0.1.0`。
3. 改动代码之后不要只切开关。`set_bundle enabled=false → true` 不会重新加载模块，界面上看起来没变化，实际还是旧的那份。必须走卸载加重装。
4. 浏览器半身改了之后要整页刷新。刷新一次即可，不用重启应用。
5. 想确认装好了，随便发一封信，看回执里 `push.via` 是不是 `schedule`，`mailBox` 是不是真实的工作区路径。

## 配置

| 字段 | 默认值 | 作用 |
|---|---|---|
| `dir` | `''`（即 `$DSH_HOME/session-bridge`） | 队列根目录 |
| `pollMs` | `1000` | 队列扫描间隔 |
| `replyTimeoutMs` | `180000` | 等一轮回复的默认时长 |
| `maxReplyChars` | `8000` | 回复截断长度 |
| `deliverMode` | `queue` | `queue` 或 `steer` |
| `maxConcurrent` | `4` | 同时处理的请求数 |
| `parseAttempts` | `3` | 文件写一半时的重试次数 |
| `parseRetryDelayMs` | `400` | 每次重试的间隔 |
| `autoJump` | `true` | 允许排队的界面跳转 |
| `allowCrossWorkspace` | `false` | 允许好友跨工作区 |
| `ackTimeoutMs` | `300000` | 超过这段时间没有回执，信转待办 |
| `notifyToken` | `''` | `/session-bridge/notify` 的共享令牌，留空表示不校验 |
| `backTtlMs` | `1800000` | 一次跳转后，返回按钮保留多久 |
| `childNamePrefix` | `agent-` | 建会话自动注册时的名字前缀 |
| `taskChannelTtlMs` | `86400000` | 创建者与新会话之间专用通道的存活时长 |
| `taskChannelIdleMs` | `600000` | 群内信件全部落定后静默多久回收该通道 |

## 两条入口

外部程序和 Agent 走的是同一套能力，入口不同。

### 文件队列，给外部程序

不需要登录态，也不需要端口。往一个目录里投 JSON，读另一个目录拿结果。

```
<root>/inbox/<id>.json        请求（先写 .tmp 再 rename）
<root>/working/<id>.<x>.json  已认领，处理中
<root>/outbox/<id>.json       结果（一定写，原子写）
<root>/done/<id>.json         已完成，同时是幂等账本
<root>/failed/<id>.json       失败副本
<root>/heartbeat.json         存活心跳
```

可用 action 有 `deliver`、`sessions`、`events`、`init_workspace`、`handoff`、`notify`、`relay`、`list_children`、`jump`、`delete_workspace`、`probe_workspace_stream`，信箱相关的有 `mail_send`、`mail_ack`、`mail_list`、`mail_status`、`mail_group`。同一个 id 不会处理两次，用相同 id 重试拿到的是第一次的结果。

### 模型工具，给 Agent

共 11 个。

| 工具 | 用途 |
|---|---|
| `session_init_workspace` | 建工作区并起一期会话 |
| `session_handoff` | 按新预设交棒出一个新会话 |
| `session_jump` | 排队一次界面跳转 |
| `session_register_name` | 在当前工作区登记名字，顺带建信箱 |
| `session_list_names` | 列出已登记的名字 |
| `session_tell` | 给登记过的名字发一条即时口信 |
| `mail_send` | 写信 |
| `mail_ack` | 回执，带 close 表示结案 |
| `mail_list` | 按 owner 列出信件 |
| `mail_status` | 看某一封走过的路径、所属群、是否逾期 |
| `mail_group` | 建群、列群，或取本工作区候选会话 |

## 信件怎么流转

信箱落在工作区里，一个工作区一套。

```
<工作区>/.dsh-mail/
    _letters.json                这个工作区的信件状态
    envelope/<mail_id>.<side>.md 两侧各一份信封，side 是 from 或 to
    _index.json                  每封信每一侧的路径索引
    _ledger.json                 只追加的留痕
    group.json                   群与会话路由
```

状态、目录、字母三者对应关系固定：

| 字母 | 状态 | 含义 |
|---|---|---|
| `A` | 已发送 | 已经出手，等回执 |
| `P` | 已接收 | 到了对端，对方还没动 |
| `R` | 处理中 | 对方已经开始处理 |
| `B` | 待办 | 投不出去，或者超时没人回 |
| `D` | 已解决 | 结案 |

路径只追加不回退。发信方通常走 `A>R>D`，收信方走 `P>R>D`；中途卡住会看到 `A>B` 这样的分支。

投递本身只送三行索引，正文留在信封文件里。对方读过并回执之后，索引才从已接收变处理中。超过 `ackTimeoutMs` 还没有回执，两侧同时收到待办通知。

同一对人来回超过阈值（默认 3 封）会自动结群，有交集的两个群会合并成一个。建会话时开的那条专用通道是另一回事，它带 `scope=task`，不参与合并，成员会话归档、TTL 到期、或者群内信件全部落定后静默十分钟，就退休并在留痕里记一笔。

## 维护与自检

```
node tools/mail-test.mjs                 # v3 契约套件
node tools/mail-push-test.mjs            # 推送、哨兵、群、工作区信箱，34 项
node tools/mail-index-repair.mjs <cwd>   # 用 _ledger.json 重算 _index.json，先加 --dry-run
```

索引修好后信封里的 `path:` 行会一起同步。这个脚本只补不删，跑多少遍结果一样。

## 故障排查

| 现象 | 原因与处理 |
|---|---|
| `NO_MAILBOX` | 目标工作区里没有任何已注册会话。先让对方 `session_register_name` |
| `UNRESOLVED` | 名字对不上任何已注册名或左栏标题。返回体里带候选列表，挑一个再发 |
| `SENDER_NOT_REGISTERED` | 带 `senderSessionId` 却没用这个身份登记过。这是故意的限制 |
| `owned by subagent routing` | 目标是个子 agent 会话。信箱只推顶层会话 |
| `queue:false` 且 `no-controller` | 宿主服务没就绪，等插件重新挂载后再试 |
| 按钮不出现 | 客户端改动没有整页刷新，或者这次不是真实跳转触发的 |

## 项目结构

```
lib/index.js     宿主半身。队列、工具注册、同源路由、好友表、会话编排
lib/mail.js      信箱引擎。状态机、信封落盘、索引、留痕、群与专用通道
lib/client.js    浏览器半身。跳转按钮与返回按钮
cordis.patch.yml 挂载入口，行 id 是 session-bridge
docs/            架构图与生成回执
tools/           自检脚本（在上一级目录）
```

## 几条容易踩的

- Desktop 构建会拒绝非渲染进程的 HTTP 请求，外部程序一律走文件队列，不要指望 `/session-bridge/*` 那几条路由。
- 子 agent 会话不能作为推送目标，宿主会以 `owned by subagent routing` 拒收。信箱只推顶层会话。
- 每投递一次，宿主会额外注入一条 `[SCHEDULE CHANGE]`。这是 `schedule` 服务自己发的，插件侧消不掉。
- `mail_status` 里有的老信路径偏短，比如只有 `A>D`，那是记录规则改之前留下的历史，不是算错。
- 好友名会随会话归档回收。冷启动扫一次，之后最多每 30 分钟一次。空快照时不清表。

## 架构与工作流

打开 [docs/architecture.html](./docs/architecture.html) 看完整拓扑，支持深浅色和缩放。图的读法是这样走的。

外部程序把请求写进 `inbox/`，分发器认领之后按 action 分派。Agent 走工具调用，落在同一个分发器上，只是不用经过文件。

建会话走 `sessionController.create`，成功后写一条跳转登记，浏览器半身轮询到记录就切页，同时把「返回创建者」的凭据记下来。

写信走信箱引擎。引擎先把两侧的信封落到各自工作区，再更新状态索引和留痕，然后把一条三行的索引交给 `schedule` 服务，由它投递到目标会话。目标会话读过之后回执，索引里的路径从已接收变处理中，关闭之后变已解决。

## 版本

v0.1.0，首个发布版本，2026-11-17。MIT 许可。

## 许可证

MIT