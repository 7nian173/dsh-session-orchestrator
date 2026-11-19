# Session Orchestrator

> **If you are an agent, skip this file.** Read the [Agent Guide](./AGENT-GUIDE.en.md) instead.
>
> 如果你是人，想看中文说明 → [中文 README](../README.md)

Installing this gives your sessions four capabilities: **start new sessions, jump between them, write letters to each other, and `@`-mention people**.

## Start a new session

Create a workspace and its first session from a preset. Directory, initial task and title are handed over together — no manual window opening, directory switching or preset picking.

You can also have the current session hand work off to a session under another preset.

## Jump to another session

When an assistant reply references a session id, an "Open session" button appears below the message. Click it to switch there.

The session you were taken to shows "Back to creator" to the left of its input box — one click returns you. Both buttons are one-shot: they do not linger after a refresh.

## Write letters to each other

Send a letter to another session. The body is written to a file in the workspace; the receiver gets an index line with source, location and current status, and decides whether to read the body.

What it gives you:

- **The other side need not be online.** The letter sits in a file and is picked up at its next start.
- **Receipts.** Delivery is acknowledged automatically when the letter reaches a turn; if nobody reads it in time it becomes a todo, and picks up again once read.
- **Quiet by default.** Ordinary letters are not pushed into the receiver's dialogue; it is told there is unread mail and pulls it itself.
- **Cancellable.** A letter that became obsolete can be cancelled and shows as expired.
- **Urgent.** Urgent letters jump the queue regardless of whether the target is busy.
- **Groups form automatically.** After a few round trips the pair gets a group and routes through it.

## `@`-mention people

Type `@` in the composer. Besides the built-in "reference files and past sessions" there is a **Friends** category, each row showing `name · session id`.

Selecting one inserts a real session reference (clickable), not dead text.

Names may be Chinese, so you can register something like `会话编排插件维护者` and find it by Chinese search in `@` too.

## Settings

Configure the plugin under **DSH Settings → Session Orchestration**. The page has three sections: Mailbox / Safety / Advanced, each with its explanation inline.

Edits save automatically and take effect immediately — no app restart.

## Install

### First install

Pick the plugin directory in the DSH plugin panel, or have your assistant run:

```
plugin_manager action=install_bundle target=<absolute path to the plugin directory>
```

### After changing code

To make edited `.js` actually load, **remove first, then install** — the order matters:

```
plugin_manager action=remove_bundle  target=dsh-session-orchestrator
plugin_manager action=install_bundle target=<absolute path to the plugin directory>
```

Three things to know:

1. **Toggling does nothing.** `set_bundle enabled=false → true` does not reload the module; the UI looks unchanged and the old code keeps running.
2. **Order matters.** Install-then-remove leaves you with nothing.
3. **Judge by the receipt.** Success means `application === 'applied'` in the receipt — not the logs, not whether the process is alive.

Keep the plugin directory somewhere it will not be moved. Moving it breaks the profile link and you must install again.

### Command line (headless profile)

```
dsh plugin --profile <profile> add github:<account>/dsh-session-orchestrator
```

Not available on desktop — the `desktop` profile is owned by Electron; use `plugin_manager` above.

## Requirements

- DeepSeek Harness `0.2.2-rc.3` or newer (release candidates included)
- Node 20+
- The queue directory (default `$DSH_HOME/session-bridge`) and workspace directories must be writable

## Troubleshooting

### Installed but nothing changed

The receipt's `application` is not `applied`, or you only toggled a switch. Reinstall using the two commands above.

### A letter will not send

Usually the previous letter has not been settled. Ask your assistant what is unprocessed, or wait ten minutes for the automatic release.

### A letter went out but the other side did not react

Ordinary letters are not pushed. The receiver sees an "unread" notice at its next start and pulls it. For urgent matters, ask your assistant to send it as urgent.

### A button is missing

Both buttons are one-shot: once clicked they are gone, and a refresh does not bring them back. A session reference received from someone else has no "Back to creator" at all — that only exists when you arrived by jumping.

## Version

| Version | Date | Theme |
|---|---|---|
| `0.3.0` | 2026-11-19 | Settings page, safety guards, agent guide, `@` friends, portability |
| `0.2.1` | 2026-11-18 | Delivery gating, cancel and expiry, urgent, timestamps |
| `0.2.0` | 2026-11-18 | Automatic receipt on delivery, start-of-work banner |
| `0.1.0` | 2026-11-17 | First release |

Full history is in GitHub Releases.

## License

[CC BY-NC 4.0](./LICENSE)
