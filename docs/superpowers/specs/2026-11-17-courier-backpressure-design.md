# 信使通道与背压（v0.2 设计规格）

状态：待审。落款日期 2026-11-17。

## 1. 背景：三个根因

现状 `lib/mail.js` 的待办与提醒机制有三处结构问题，导致「排队越来越多」和「重复提醒」：

1. `block()` 对每一封信**立刻**投两张卡（发信方、收信方）。N 封过期就是 2N 张卡。没有排队，也没有落盘。
2. 哨兵没有上限：`noteStatus()` 每次 `idle` 边都重新装填，`attempts` 无界，节拍缩到 2 秒不再缩。同一封信会被反复推。
3. 同一个人对同一个目标可以连续发信，只要不结案。没有任何发送闸门。

副作用是决策方看到一堆「待办」卡，把它读成「对方没理我」，然后停等回执，整条部署停摆。

## 2. 目标

- 堆积有上限：同一 (发信方, 收信方) 对，未结案的信最多 1 封。
- 提醒分两个形态：对收信方催收（逐封），对发信方摘要（聚合，且**替他把话解释清楚**）。
- 目标陷入长任务时，信进持有队列并**持久化**；目标空闲时先报数，再一封一封递。
- 提醒次数有界，靠「状态变化」触发，不靠时间轮询。
- 信封本身记录这些状态，重启不丢。
- 好友表能显示对方是否在任务中。

非目标：逐秒扫描、跨工作区广播、GUI 暂停按钮。

## 3. 术语

| 词 | 含义 |
| --- | --- |
| 通道 | `<工作区>/.dsh-mail/_courier.json`，全局唯一的串行投递队列 |
| 持有队列 | 通道里 `state=held` 的条目：目标忙，信先存着不投 |
| 催收 | 形态 A，发给收信方，一封信一张卡 |
| 摘要 | 形态 B，发给发信方，一个发信方一张卡 |
| 背压 | 发送闸门：上一封没结案就不许再发 |

## 4. 状态模型

### 4.1 信件层（不变的五件套，加一个可重开边）

```
pending → pushed → delivered → acked → done
                     ↓            ↓
                   held        blocked
```

- `held`（待办，目录 B）：目标忙或超时未消费，信被通道接管，卡片停投。信封头 `paused: true`。
- `held` **可重开**：目标回到空闲后，通道从持有队列取出，重新投递一次。
- 重开**不新增字母**：两侧在对方消费前后都仍算 `B`，回执到了才变 `R`，所以路径是 `A>B>R>D` / `P>B>R>D`，不会出现 `A>B>A` 这种噪声。
- 重开记录在信封 `paused: false` 与 `_ledger.json` 的 `courier:reopen` 里，字母表保持五个。

### 4.2 通道条目

```json
{
  "seq": 12,
  "mailId": "M-20261117-0031",
  "sessionId": "session-x",
  "side": "to",
  "form": "a",
  "state": "queued | held | inflight | done | dropped",
  "attempts": 0,
  "enqueuedAt": "2026-11-17T11:00:00.000Z",
  "lastNoticeAt": null
}
```

`seq` 单调递增，排位就是按它排序后的序号。

## 5. 四条不变式

**I1 背压。** 对 (from, to) 这一对，只要有一封处于 `pending | pushed | delivered`（未结案且未被通道接管），`mail_send` 拒绝，返回 `PAIR_OUTSTANDING`，带上那封的 mail_id、状态、已等多久。豁免 `S-ACK` 与 `S-TODO-NOTICE`：它们是对已有信的动作，不该被自己挡。

> **决策（2026-11-17）：放行。** 进入 `held` 之后不挡新信，但回执里带 `prior: {mailId, status: "held", heldMinutes: N}`，并触发形态 B 摘要。理由：held 说明这封已经处理不了，此时再挡等于封死发信方。

**I2 在途 ≤ 1。** 同一目标会话，未被消费（`deliveredAt` 为空）的信箱卡最多 1 张。上一张被消费后才发下一张。这是「LLM 单线」的直接结论：多推的卡只是占位，不会加速。

**I3 忙则持有。** 目标 `running` 持续超过 `busyHoldMs`（默认 3 分钟），未消费的信转 `held`，写持有队列，信状态 `blocked`，信封头 `paused: true`。不投卡。

**I4 空闲则报数再逐封。** 目标出现 `agent/status=idle` 且持有队列非空：
1. 先投一张**收信方摘要**：「有 N 封没处理，我按顺序给你」；
2. 然后按 `seq` 逐封投递，每封之间以「上一封被消费」为闸门；
3. 一封被消费却无回执，走看门狗，不重复投卡。

## 6. 提醒的两个形态

### 形态 A：催收（收信方，逐封）

```
〔信箱·待收〕M-20261117-0031
来自 lead · S-PROGRESS · 位置：…\envelope\M-20261117-0031.to.md（2.1 KB）
状态：待办 B —— 这封还没进过你的任何一轮
（回信带上 〔信箱·M-20261117-0031〕 即结案）
```

### 形态 B：摘要（发信方，聚合）

```
〔信使〕你名下现在 5 封待办：lead 3 封、peer 2 封，最早 41 分钟前。
不是对方不理你 —— 是信没被消费或没拿到回执，别等。
你这批排在第 2 位，我正一封封递，请稍候。要重推哪封，带上 mail_id 说一声。
```

节奏：A 一封信一张，同一目标在途 ≤ 1；B 一个发信方一张，**数字变了才重发**，间隔 ≥ 10 分钟。

## 7. 看门狗（时间戳）

读取信封头 `timestamp`（未消费时）或 `deliveredAt`（已消费时），距今超过 `staleAfterMs`（默认 30 分钟）且未结案 → 允许补提醒**一次**，`notice_b += 1`。第二次不再提醒，等人工。

这是「收信人忘了处理信封」的兜底，也是唯一以时间触发的提醒。

## 8. 暂停

- 通道级：`_courier.json.paused`。置位后通道只入队不投递，落盘，重启保持。入口 `mail_pause`（`do: pause | resume | status`）。
- 信件级：信封 `paused: true`。进 `held` 自动置位；恢复时清掉并重新入队。
- 语义：暂停是**开关**，不是新状态，`path` 不变，字母表不扩。

## 9. 信封头增量

```yaml
status: blocked
todo_since: 2026-11-17T19:00:00+08:00
paused: true
notice_a: 1
notice_b: 0
queue_seq: 12
```

两份侧本同字段；`status` 仍与目录绑定，按 side 各自计算。

## 10. 好友表状态

`friends.json` 每行加 `state`（`idle | running | unknown | archived`）与 `stateAt`：

- 由 `agent/status` 事件写入（已有钩子，`index.js` 的 `noteStatus` 处）；
- `session_list` 与 `mail_status` 读时再用 `sessionController.state()` 刷新一次；
- `mail_send` 回执带 `peerState`，让发信方先知道「对方在任务中，投进去也要等」。

这是「读时计算 + 事件兜底」，不新增扫描。

## 11. 失败与回收

- 单条投递失败重试 ≤ 3 次（间隔 5 秒），之后 `state=dropped`，ledger 记 `courier:dropped`。
- 目标会话归档：条目直接 `dropped`，信转 `blocked`，`reason: target-archived`。
- 条目超过 24 小时仍未投出：`dropped`，留痕。

## 12. 测试断言（34 → 48 条，已实现）

1. 同对未结案时 `mail_send` 返回 `PAIR_OUTSTANDING`
2. `S-ACK` / `S-TODO-NOTICE` 不被背压挡住
3. 目标忙超时 → 信件 `blocked`、信封 `paused: true`、`_courier.json` 有 `held` 条目
4. 空闲边 → 先摘要后逐封，且只投 1 张
5. 上一张未消费 → 不发下一张
6. 上一张被消费 → 发下一张
7. 看门狗补提醒只发一次
8. `paused: true` 时 drain 不投
9. 新实例从 `_courier.json` 恢复 `queued` 条目
10. 好友表 `state` 反映 running / idle

> 实际结果：原有 34 条里 8 条按新语义重写（哨兵改成通道），新增 14 条，合计 48 条全绿。

## 13. 兼容

旧 `_letters.json` 没有 `sentinel`、`queue_seq`：读时补默认值，不迁移文件。
旧信封头缺新字段：按 `status` 推导，`paused` 缺省 `false`。
现存 `blocked` 信没有通道条目：冷启动时补一条 `held`，`seq` 按时间排序生成。

## 14. 实施顺序

1. `mail.js`：通道读写 + drain + I2/I3/I4 + 看门狗 + 信封头字段
2. `mail.js`：I1 背压 + 回执字段
3. `index.js`：`mail_pause` 工具、`mail_send` 错误码透传、好友表 `state`
4. `tools/mail-push-test.mjs`：新增断言
5. `README.md` / `README.en.md`：待办与重开路径、暂停、好友表状态
6. `docs/BACKLOG.md`：第 5 条标记已实现

## 15. 不做（YAGNI）

- 不做逐秒扫描，仍靠事件 + 一次性定时器。
- 不做跨工作区的通道广播，通道是每工作区一份。
- 不做 GUI 暂停按钮，先给工具入口。
- 不做提醒的富文本卡片，仍是纯文本。