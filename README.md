# dsh-session-bridge

A file-queue bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions.

It does four things, all inside the Host process (no shell, no HTTP auth, no network listener of its own):

1. **Deliver a prompt** into another session and wake it if idle.
2. **Create workspaces and stage sessions** (`session_init_workspace`, `session_handoff`).
3. **Queue one-shot UI navigation** (`session_jump`) that the companion browser half performs.
4. **Relay machine notifications** to a creator session through a continuable child ("courier").

## Why a file queue

DSH exposes no public "notify a script" API, and a script outside the Host cannot reach `ctx.sessionController`.
The queue is the smallest honest IPC: JSON files in one directory, atomic rename, an outbox result per request.
It is also the trust boundary — whoever can write the queue can drive sessions, so keep it inside your workspace or `$DSH_HOME`.

## Install

```sh
# from this directory
dsh plugin add <path-or-git-url>
```

or, inside a DSH session:

```
plugin_manager action=install_bundle target=<absolute path of this directory>
```

The Host half registers itself as row `session-bridge`; the companion `dsh-session-jump` bundle adds the browser half.

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

## Queue protocol

```
<root>/inbox/<id>.json      request   (write <id>.json.tmp then rename)
<root>/working/<id>.<x>.json  claimed, in flight
<root>/outbox/<id>.json     result    (always written, atomically)
<root>/done/<id>.json       finished  (also the idempotency ledger)
<root>/failed/<id>.json     failure copy
<root>/heartbeat.json       liveness
```

Request `action` values: `deliver`, `sessions`, `events`, `init_workspace`, `handoff`, `notify`, `relay`,
`list_children`, `jump`, `delete_workspace`, `probe_workspace_stream`.

A finished request id is never processed twice: retry with the same `id` returns the first result.
While a request is in flight, a second file with the same id is archived as `done/<id>.repeat-<ts>.json`.

## Model tools

`session_init_workspace`, `session_handoff`, `session_jump` are registered on `ctx.tools`, so they work
even where the shell is unavailable (for example under the default `workspace-write` sandbox, where this
plugin's own queue still works because everything runs in the Host).

## Browser routes (same origin, browser peers only)

`GET /session-bridge/client-report`, `/jump`, `/jump-used`, `/back`, `/auto-jump`, `/auto-jump-used`.

## Security model

- No network listener of its own; routes ride the Host web server and only answer browser peers.
- No credentials, no tokens: the queue directory is the authorization boundary.
- Session ids and preset ids are always parameters; nothing is bound to a particular user or project.

## License

MIT
