# dsh-session-bridge

DeepSeek Harness 的文件队列桥，外加一套落在工作区里的信箱。全部逻辑跑在 Host 进程里，不启动 shell，不另开端口，也不自己做 HTTP 鉴权。

功能有五项：

1. 把一条 prompt 投进另一个会话，对方空闲时顺带唤醒。
2. 建工作区与阶段会话（`session_init_workspace`、`session_handoff`）。
3. 排队一次性界面跳转（`session_jump`），由配套的浏览器半身执行。
4. 信箱：信件落在工作区，投递只推索引通知，正文不进消息。
5. 会话群：一份会话 ID 路由表，支持按阈值自动建群与交集合并。

英文版见 [README.md](./README.md)。

## 为什么用文件队列

DSH 没有对外的通知接口，Host 之外的脚本也拿不到 `ctx.sessionController`。文件队列是最小的可信 IPC：一个目录里放 JSON，原子 rename，每个请求配一份结果文件。

队列目录本身就是信任边界。能写队列的人就能驱动会话，所以把它放在自己的工作区或 `$DSH_HOME` 里。

> Desktop 构建会拒绝非渲染进程的 HTTP 请求（`403 Browser access is disabled`）。下面的路由只服务于配套的浏览器半身，**外部程序走文件队列，不走 HTTP**。

## 安装

```
plugin_manager action=install_bundle target=<本目录的绝对路径>
```

Host 半身注册为 `session-bridge` 一行。改过 `.js` 之后必须重新挂载（先 `remove_bundle` 再 `install_bundle`）。只切 `enabled` 不会重载模块。

## 配置

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dir` | `''` → `$DSH_HOME/session-bridge` | 队列根目录 |
| `pollMs` | `1000` | 扫描间隔 |
| `replyTimeoutMs` | `180000` | 等待一轮回复的默认时长 |
| `maxReplyChars` | `8000` | 回复截断长度 |
| `deliverMode` | `queue` | `queue` 或 `steer` |
| `maxConcurrent` | `4` | 同时处理的请求数 |
| `parseAttempts` | `3` | 文件写一半时的原地重试次数 |
| `parseRetryDelayMs` | `400` | 每次重试的间隔 |
| `autoJump` | `true` | 允许排队的界面跳转 |
| `allowCrossWorkspace` | `false` | 允许好友跨工作区 |
| `ackTimeoutMs` | `300000` | 超过这段时间没有回执，信件转待办 |
| `notifyToken` | `''` | `POST /session-bridge/notify` 的共享令牌（该路由只给渲染进程） |
| `backTtlMs` | `1800000` | 一次跳转后，返回按钮保留多久 |
| `childNamePrefix` | `agent-` | 建会话自动注册时的名字前缀 |
| `taskChannelTtlMs` | `86400000` | 创建者与新会话之间专用通道的存活时长 |
| `taskChannelIdleMs` | `600000` | 群内信件全部落定后静默多久回收该通道 |

## 队列协议

```
<root>/inbox/<id>.json        请求（先写 <id>.json.tmp 再 rename）
<root>/working/<id>.<x>.json  已认领，处理中
<root>/outbox/<id>.json       结果（一定写，原子写）
<root>/done/<id>.json         已完成，同时是幂等账本
<root>/failed/<id>.json       失败副本
<root>/heartbeat.json         存活心跳
```

可用的 action：`deliver`、`sessions`、`events`、`init_workspace`、`handoff`、`notify`、`relay`、`list_children`、`jump`、`delete_workspace`、`probe_workspace_stream`、`mail_send`、`mail_ack`、`mail_list`、`mail_status`、`mail_group`。

同一个 id 不会处理两次。用相同 id 重试，拿到的是第一次的结果。

## 模型工具

`session_init_workspace` · `session_handoff` · `session_jump` · `session_register_name` · `session_list_names` · `session_tell` · `mail_send` · `mail_ack` · `mail_list` · `mail_status` · `mail_group`

## 浏览器路由

同源，只应答浏览器半身：`/session-bridge/client-report` · `/jump` · `/jump-used` · `/back` · `/back-consume` · `/jump-record` · `/auto-jump` · `/auto-jump-used` · `/notify`。

「返回创建者」只在真实跳转之后出现。`/jump-record` 会写下 `jumps/links/<会话>.json`，其中 `source` 为 `jump`；`/back` 不认其他来源，也不再退化为 `parentSession`。按钮渲染的同时客户端会调 `/back-consume`，刷新之后不会再长出来。

## 信箱（v6：一切按工作区走）

```
<工作区>/.dsh-mail/
    _letters.json                本工作区的信件状态
    envelope/<mail_id>.<side>.md 两侧各一份正文，side 为 from 或 to
    _index.json                  状态索引，记录每一侧走过的路径
    _ledger.json                 只追加的留痕（发信、送达、哨兵节拍、转待办）
    group.json                   会话群路由表
```

- **注册门控**。工作区里没有任何已注册会话，就不建 `.dsh-mail`，一个文件也不建。
- **通知只给索引**。投递内容是三行：来源、位置、状态。要看正文，自己去读信封文件。
- **状态与目录、字母一一对应**。`A` 已发送（awaiting_ack），`P` 已接收（pending），`R` 处理中（running），`B` 待办（blocked），`D` 已解决（done）。`A>R>D`、`P>R>D` 这样的路径记录这封信经历过什么；路径只追加，不回退。
- **投递通道**。通知走 Host 的 `schedule` 服务，在界面上表现为一张自动化任务卡片；`schedule` 不可用时退回 `sessionController.prompt`。已知副作用：宿主每次投递会额外注入一条 `[SCHEDULE CHANGE]`，插件无法抑制。
- **哨兵**。目标空闲就起 10 秒确认窗，到点重推索引；目标忙则等 idle 边。窗口内对方又忙起来，本次推送作废，节拍从 10 秒缩到 5 秒、3 秒、2 秒（下限 2 秒）。每一拍都写进 `_ledger.json`。
- **没有回执就转待办**。两侧收到的是同一份三行通知。
- **建会话会把这一对接通**。`session_init_workspace` / `session_handoff` 成功后自动注册双方（名字取「前缀 + 标题」，标题还没生成时取「前缀 + 会话 ID 尾号」）、建好两边信箱，并开一条 `scope:"task"` 的专用通道，默认 24 小时 TTL。回执里带 `wire` 字段，写明注册了谁、通道 ID 是多少。专用通道不参与交集合并；这对会话一旦要建普通群，通道会被**提升**成普通群而不是再建一个。它会在 TTL 到期，或群内信件全部落定后静默 10 分钟时退休；退休只删群记录，并在 `_ledger.json` 留一行 `channel:retired`。
- **好友名跟着会话生命周期走**。冷启动扫一次，之后最多每 30 分钟扫一次：会话进了宿主的归档表（`storages/workspace.json` 的 `global.archivedSessionIds`），或从持久化列表里彻底消失超过 10 分钟，对应的好友名就被清掉。持久化返回空表时不清，防止一次读空把整张表抹掉。
- **群只做路由**。A 与 B 的往返信件超过阈值（默认 3 封）就自动建群；两组群有交集时合并。群按成员表查到会话 ID 直接投递，回执仍走普通来信。
- **子 agent 会话不能作为推送目标**（`owned by subagent routing`）。信箱只推顶层会话。
- 工具：`mail_send` · `mail_ack` · `mail_list` · `mail_status` · `mail_group`。

## 维护

```
node tools/mail-test.mjs                 # v3 契约套件
node tools/mail-push-test.mjs            # 推送、哨兵、群、工作区信箱，共 28 项
node tools/mail-index-repair.mjs <cwd>   # 用 _ledger.json 重算 _index.json 的路径，先加 --dry-run
```

## 安全模型

- 不另开监听端口。路由挂在 Host 的 web server 上，只应答浏览器端。
- 除可选的 `notifyToken` 外没有凭据。队列目录就是授权边界。
- 会话 ID 与预设 ID 一律从参数传入，不绑定到某个用户或项目。

## 许可证

MIT
