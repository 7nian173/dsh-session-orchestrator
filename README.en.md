# dsh-session-bridge

[中文](./README.md) · Architecture [docs/architecture.html](./docs/architecture.html)

A file-queue bridge **and a workspace mailbox** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions.
Everything runs inside the Host process: no shell, no HTTP auth, no network listener of its own.

It does five things:

1. **Deliver a prompt** into another session and wake it if idle.
2. **Create workspaces and stage sessions** (`session_init_workspace`, `session_handoff`).
3. **Queue one-shot UI navigation** (`session_jump`) that the companion browser half performs.
4. **Mailbox**: letters that live in the *workspace*, pushed as a short index notice — never the body.
5. **Session groups**: a routing table of session ids, with automatic creation and intersection merge.

## Why a file queue

DSH exposes no public "notify a script" API, and a script outside the Host cannot reach `ctx.sessionController`.
The queue is the smallest honest IPC: JSON files in one directory, atomic rename, an outbox result per request.
It is also the trust boundary — whoever can write the queue can drive sessions, so keep it inside your workspace or `$DSH_HOME`.

> The Desktop build refuses non-renderer HTTP requests (`403 Browser access is disabled`), so the routes below are
> for the bundled browser half only. **External programs talk to the queue, not to HTTP.**

## Install

```
plugin_manager action=install_bundle target=<absolute path of this directory>
```

The Host half registers as row `session-bridge`. Changing `.js` files needs a real remount
(`remove_bundle` then `install_bundle`) — toggling `enabled` does **not** reload modules.

## Config

| field | default | meaning |
|---|---|---|
| `dir` | `''` → `$DSH_HOME/session-bridge` | queue root |
| `pollMs` | `1000` | scan interval |
| `replyTimeoutMs` | `180000` | default wait for one turn of reply |
| `maxReplyChars` | `8000` | reply truncation |
| `deliverMode` | `queue` | `queue` or `steer` |
| `maxConcurrent` | `4` | requests handled at once |
| `parseAttempts` | `3` | in-place parse retries for half-written files |
| `parseRetryDelayMs` | `400` | delay between retries |
| `autoJump` | `true` | allow queued UI navigation |
| `allowCrossWorkspace` | `false` | let friends reach across workspaces |
| `ackTimeoutMs` | `300000` | letter → 待办 after this long without a receipt |
| `notifyToken` | `''` | shared token for `POST /session-bridge/notify` (renderer-only route) |
| `backTtlMs` | `1800000` | how long a recorded jump keeps offering the 返回创建者 button |
| `childNamePrefix` | `agent-` | prefix for names auto-registered on session creation |
| `taskChannelTtlMs` | `86400000` | TTL of the dedicated creator↔child channel |
| `taskChannelIdleMs` | `600000` | retire a channel when every letter settled and stayed idle this long |

## Queue protocol

```
<root>/inbox/<id>.json        request   (write <id>.json.tmp then rename)
<root>/working/<id>.<x>.json  claimed, in flight
<root>/outbox/<id>.json       result    (always written, atomically)
<root>/done/<id>.json         finished  (also the idempotency ledger)
<root>/failed/<id>.json       failure copy
<root>/heartbeat.json         liveness
```

Actions: `deliver`, `sessions`, `events`, `init_workspace`, `handoff`, `notify`, `relay`, `list_children`,
`jump`, `delete_workspace`, `probe_workspace_stream`, `mail_send`, `mail_ack`, `mail_list`, `mail_status`, `mail_group`.

A finished request id is never processed twice: retry with the same `id` returns the first result.

## Model tools

`session_init_workspace` · `session_handoff` · `session_jump` · `session_register_name` · `session_list_names` ·
`session_tell` · `mail_send` · `mail_ack` · `mail_list` · `mail_status` · `mail_group`

## Browser routes (same origin, browser peers only)

`/session-bridge/client-report` · `/jump` · `/jump-used` · `/back` · `/back-consume` · `/jump-record` ·
`/auto-jump` · `/auto-jump-used` · `/notify`

`返回创建者` appears **only** after a real jump: `/jump-record` writes
`jumps/links/<session>.json` with `source:'jump'`; `/back` refuses anything else (no `parentSession` fallback),
and the client calls `/back-consume` the moment it renders, so a refresh never grows the button again.

## Mailbox (v6: everything rooted in the workspace)

```
<workspace>/.dsh-mail/
    _letters.json                this workspace's letter state
    envelope/<mail_id>.<side>.md one body per side (from / to) — the letter is never copied into chat
    _index.json                  state index: per-side letter path
    _ledger.json                 append-only trail (send / delivery / sentinel beats / block)
    group.json                   session-group routing table
```

- **Registration gated.** No registered session in a workspace → no `.dsh-mail`, no files at all.
- **Notice is an index, not the body.** A delivery carries three lines: source, location, state.
  The agent reads the envelope file itself if it wants the text.
- **State ↔ directory ↔ letter.** `A` 已发送 (awaiting_ack) · `P` 已接收 (pending) · `R` 处理中 (running) ·
  `B` 待办 (blocked) · `D` 已解决 (done). A path such as `A>R>D` / `P>R>D` records what the letter went through;
  paths only append, never retreat.
- **Delivery channel.** Notices go through the Host `schedule` service, so they arrive as a normal 自动化任务 card.
  Falling back to `sessionController.prompt` when `schedule` is unavailable.
  Known side effect: the Host adds one `[SCHEDULE CHANGE]` context inject per delivery; the plugin cannot suppress it.
- **Sentinel.** Target idle → 10 s confirm window → re-push the index. Target busy → wait for the idle edge.
  Busy again inside the window → drop it and shrink the cadence `10s → 5s → 3s → 2s` (floor 2 s).
  Every beat is written to `_ledger.json`.
- **No receipt → 待办.** Both sides get the same three-line notice.
- **Creating a session wires the pair.** `session_init_workspace` / `session_handoff` register both sides
  (name = prefix + title, or prefix + session id tail when the title is not there yet), create both mailbox
  boxes, and open one dedicated `scope:"task"` channel with a 24 h TTL. The result carries a `wire` field.
  A dedicated channel never joins a merge, and is promoted to an ordinary group the moment a normal group
  is requested for that pair. It retires on TTL, or once every letter of the pair settled and stayed idle
  10 minutes; retirement removes only the group record and leaves one `channel:retired` line in `_ledger.json`.
- **Friend names follow session lifecycle.** A sweep (cold start, then at most every 30 minutes) drops a
  registered name when its session is in the host archive registry (`storages/workspace.json` →
  `global.archivedSessionIds`) or vanished from persistence for more than 10 minutes. An empty persistence
  snapshot never clears the table.
- **Groups are routing only.** `A↔B` round-trips crossing the threshold (default 3) create a group; groups merge
  on set intersection (`SA ∩ SC ≠ ∅`). Group members route delivery by session id; acknowledgements still travel
  as ordinary letters.
- **Subagent sessions cannot be push targets** (`owned by subagent routing`). The mailbox only pushes to top-level sessions.
- Tools: `mail_send` · `mail_ack` · `mail_list` · `mail_status` · `mail_group`.

## Maintenance

```
node tools/mail-test.mjs                 # v3 contract suite
node tools/mail-push-test.mjs            # push / sentinel / groups / workspace boxes (28 checks)
node tools/mail-index-repair.mjs <cwd>   # rebuild _index.json paths from _ledger.json (--dry-run first)
```

## Security model

- No network listener of its own; routes ride the Host web server and only answer browser peers.
- No credentials beyond the optional `notifyToken`: the queue directory is the authorization boundary.
- Session ids and preset ids are always parameters; nothing is bound to a particular user or project.

## License

MIT
