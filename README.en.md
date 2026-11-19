# Session Orchestrator

> **If you are an agent, skip this file.** Read the [Agent Guide](./docs/AGENT-GUIDE.en.md) instead.
>
> 如果你是人，想看中文说明 → [中文 README](./README.md)

This document is **for humans**. The plugin ships two manuals aimed at assistants:

| Document | Audience | When |
|---|---|---|
| **This README** | humans | what it does, how to install, how to use |
| [**Agent Guide**](./docs/AGENT-GUIDE.en.md) ｜ [中文](./docs/AGENT-GUIDE.md) | the assistant | full manual, shipped with the plugin, **no install needed** |
| [`skills/session-orchestrator/`](./skills/session-orchestrator/SKILL.md) | the assistant | condensed operating version, **install only with your consent** |

**The cheapest way to make the assistant get this right** is not the skill — just tell it:

> When using the session orchestrator plugin, read `docs/AGENT-GUIDE.en.md` first.

That is usually enough. The skill suits daily use where you want fewer questions; the manual suits one-off work where details matter.

## Contents

**Getting started**

- [Start a new session](#start-a-new-session) · [Jump to another session](#jump-to-another-session) · [Write letters](#write-letters-to-each-other) · [`@`-mention people](#@-mention-people)
- [Friend registration and naming](#friend-registration-and-naming) — how names work, why a prefix helps, how to type the commands
- [Asking for a workspace explicitly](#asking-for-a-workspace-explicitly) — one sentence, or `/new-workspace`
- [Use your own wording](#use-your-own-wording) — no fixed phrasing to memorise

**Read before you start**

- [It touches your disk](#it-touches-your-disk--read-this-first) — privileged behaviour, where data lives, the two gates

**Configuration and install**

- [Settings](#settings) — what each of the four safety gates controls
- [Install](#install) — first install / after changing code
- [Requirements](#requirements) · [Troubleshooting](#troubleshooting)

**Other**

- [Bundled skill](#bundled-skill-optional-works-without-it) — optional; fewer questions with it
- [Architecture diagram](./docs/architecture.html) — how one letter travels end to end
- [Config and command chains](./docs/config-chains.md) — where settings come from, how commands arrive, 11 routes, 14 tools
- [Version](#version) · [License](#license)

---

Installing this gives your sessions four capabilities: **start new sessions, jump between them, write letters to each other, and `@`-mention people**.

In one line: **spin up a new workspace in a sentence, have your agent jump to any session, and let agents talk across sessions (and across workspaces) through a mailbox.**

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

To see whether anything arrived, or whether something is still unprocessed, just ask the assistant:

> what is waiting for me?

It lists them for you. No need to hunt through files.

## Friend registration and naming

For others to find you, you need to **register a name**. A name is an address, not a nickname — sending letters, `@` search and jumps all resolve through it.

### What a name looks like

1–32 characters: letters, digits, `_`, `-` and **CJK**.

```
lead
会话编排插件维护者
FatFish-Whisper-workspace-b2b6
本地-c91e
```

### Why a prefix is recommended

Names are **global**: there is a single friends table on the machine. If two projects both use `lead`, the later registration replaces the earlier one — so a letter meant for "your project's lead" may land in another project's lead.

The convention is **`<workspace group>-<role or purpose>`**:

| Case | Preferred | Avoid |
|---|---|---|
| Dispatcher inside one project | `FatFish-Whisper-workspace-dispatcher` | `dispatcher` |
| Two sessions in the same workspace | `本地-c91e`, `本地-796a` | `A`, `B` |
| A team's lead | `Super-agent-lead` | `lead` |

**The prefix is a collision guard you apply for yourself** — the plugin does not enforce it. Names without a prefix work fine; they just collide sooner as projects multiply.

### Auto-registered names

When the plugin creates a session for you it registers automatically, with a fixed format:

```
<workspace folder name>-<last 4 of sessionId>
```

For workspace `D:\dshdata\本地` and session `session-...7e5c91e` → **`本地-c91e`**.

- **The workspace segment is never dropped.** Sessions in one workspace can differ only in the last four characters; across workspaces only the prefix distinguishes them.
- A collision on the last four (rare within one workspace) appends `-2`, `-3`.
- For a custom prefix, set `childNamePrefix` in settings.

### Renaming and history

- A session has exactly one **primary name**; re-registering replaces it.
- To keep an old name alive (say a doc still references the English one), add a second record for the same session in `friends.json` — both resolve.
- Names do **not** follow session title changes; renaming a session leaves the name unchanged.

### Where to register

Two commands, two different jobs:

| Command | Effect |
|---|---|
| **`/register-me <name>`** | Register **yourself** under that name |
| **`/register-peer`** | Add **someone else** to the friends table and name them |

```
/register-me 本地-c91e
/register-peer Super-agent session-42635e1a-0089-425f-9441-7c9b1ffc8431 决策
```

**Which sessions it can see depends on the cross-workspace switch**:

| Switch | Whom `/register-peer` can register |
|---|---|
| **Off** (default) | Only sessions in **this workspace** (subdirectories included) |
| **On** | Sessions in every workspace |

This is the **same switch** that decides whether you may send letters to another workspace, so you never end up able to register a peer you cannot write to.

`/register-peer` **has no fixed format** — give whatever you have:

```
/register-peer session-42635e1a-0089-425f-9441-7c9b1ffc8431
/register-peer Super-agent
/register-peer session-42635e1a-… 决策
```

- Id only → the name is derived as `<workspace>-<last 4 of id>`
- Workspace only → a single match registers directly; several are listed for you to pick
- A name with spaces goes in quotes
- Nothing matches → no "format error"; it lists existing sessions for you to copy

Press Enter to run; you get a confirmation. An invalid name reports the rules.

### You do not have to type the full command name

DSH completes it for you: type **`/rep`** or **`/rem`** in the composer, pick the matching row and press **Tab** to complete the name, then add your arguments.

```
/rep⌨  → completes to /register-peer or /register-me (whichever you picked with Tab)
```

The difference between the two:

- **`/register-me`** — name yourself; the argument is the name you want
- **`/register-peer`** — name someone else; the argument is a session name or session id (name optional)

**Note**: pressing Enter on a bare command name does nothing — DSH waits for arguments. Always include an argument before pressing Enter.

You can also open the `@` menu to see who is already registered and confirm there is no collision.

## `@`-mention people

Type `@` in the composer. Besides the built-in "reference files and past sessions" there is a **Friends** category, each row showing `name · session id`.

Selecting one inserts a real session reference (clickable), not dead text.

Names may be Chinese, so you can register something like `会话编排插件维护者` and find it by Chinese search in `@` too.

## It touches your disk — read this first

This plugin does things that go **beyond an ordinary sandbox**. Below is what it changes on your filesystem without asking again.

### It creates directories inside other people's workspaces

When a friend connection is made, when the first letter is sent, or when talking across workspaces, the plugin creates a `.dsh-mail/` directory **inside the other side's workspace**:

```
.dsh-mail/_letters.json      letter state
.dsh-mail/envelope/          envelopes (the body lives here)
.dsh-mail/_index.json        status index (A/P/R/B/D/E paths)
.dsh-mail/_ledger.json       operation ledger
.dsh-mail/group.json         group routing table
.dsh-mail/_courier.json      delivery channel
```

**Why**: the ledger and delivery mechanism need to persist. Without it a letter has no traceable carrier.

This is created in the workspace you connect to, not only your own. Back up `.dsh-mail/` before deleting a workspace — it is not tracked by git.

### Letter bodies are real files

A letter is not a "message"; it is a **Markdown file on disk**. The body goes to `.dsh-mail/envelope/<id>.to.md`, and the receiver gets an index line (source, location, status).

**Only notifications enter the LLM context.** What the plugin pushes is a short notice ("you have unread mail", "X wrote to you"). The body is **never injected** into the receiver's conversation; reading it is the receiver's decision.

### It creates, archives and deletes sessions and workspaces

| Action | Effect |
|---|---|
| Create workspace | `mkdir` at the given path, then register it in DSH's workspace list |
| Create session | Start a new session in that workspace, optionally with a preset |
| Delete workspace | Remove it from DSH's list; **with `removeDir` it deletes the whole directory recursively** |

Deletion is **not recoverable**. Two gates exist (below), but what gets deleted ultimately depends on the confirmation you give.

### It can post into any session

It calls `prompt` to place text into any session's next turn. That equals **speaking inside someone else's conversation under your identity**.

- Notifications use this channel by default, so they appear in the receiver's transcript.
- They carry machine prefixes such as `〔信箱·…〕`, but visually they look like ordinary human messages.

### It reads and writes a global friends table

`$DSH_HOME/session-bridge/friends.json` maps names to session ids. Any session can read it and change it (`session_register_name`).

Names are therefore **global and overwritable**: if two projects both use `lead`, the later registration wins.

### It reads DSH's own state files

To know which sessions are archived and what their titles are, the plugin reads DSH's own storage:

```
$DSH_HOME/storages/workspace.json        archived session ids
$DSH_HOME/storages/session_projcache/    session title cache
$DSH_HOME/session-bridge/friends.json    friends table
```

Host services are preferred; these files are only a fallback when a service is unavailable, and they are **read-only**.

### What it does not do

- It does not read your source code, execute anything, or reach the external network.
- It does not modify files outside `.dsh-mail/` in any workspace.
- It does not modify DSH's own storage files (read-only).
- It does not delete a directory recursively without the confirmation gate (on by default).

### Where the data lives, and how to clean up

```
<workspace>/.dsh-mail/                    letters and ledger (one per workspace)
$DSH_HOME/session-bridge/friends.json     global friends table
$DSH_HOME/session-bridge/agent-prefs.json phrasings the assistant remembered
$DSH_HOME/session-bridge/heartbeat.json   is the plugin alive
$DSH_HOME/session-bridge/deleted-workspaces.jsonl  deleted-workspace ledger
$DSH_HOME/session-bridge/client-reports/  browser-side diagnostics
```

**Backup / cleanup**:

- Before deleting a workspace, copy that workspace's `.dsh-mail/` out; otherwise the letters go with it.
- Full reset: delete `$DSH_HOME/session-bridge/` and every workspace's `.dsh-mail/`; the plugin rebuilds them.
- `client-reports/` is diagnostics only; deleting it breaks nothing.

### Two gates

| Gate | Effect |
|---|---|
| **Protected directories** | System directories, program directories, the **application install directory**, `DSH_HOME`, and the user home are never created in or deleted. The install directory matters most: every DSH upgrade wipes and rebuilds it |
| **Second confirmation** | Recursive deletion requires an explicit "确认删除" with a token, valid for 10 minutes |

Both are adjustable in settings: protected directories can only be **extended**, never reduced; the second confirmation can be switched off (path guards still apply when it is).

## Bundled skill (optional, works without it)

The plugin ships a skill: **`session-orchestrator`**.

What it does: when the assistant hears plain speech like "make me a new workspace" or "tell the decision session about this", the skill tells it **which flow to run and where the boundaries are**.
It explains **how to use the plugin, not how the plugin works** — an operating manual aimed at the assistant.

The plugin works without it — the built-in hints already spell the intent out. With it, the assistant judges better and asks less.

### Why install it

Without the skill the assistant sometimes reads "make a workspace" as "generate a project skeleton" or "tidy a directory", then asks a string of unrelated questions.
The skill pins the boundary: this plugin only **registers a DSH workspace and opens a session**. Skeleton generation is not its job.

### How to install

Copy the `skills/session-orchestrator/` folder from the plugin directory into your skills directory:

| Location | Scope |
|---|---|
| `<workspace>/.dsh/skills/` | this workspace only |
| `D:\dshdata\skills/` | global (adjust to your DSH_HOME) |

Refresh the page afterwards; if `session-orchestrator` shows up in the skill list, it is installed.

**Not required**, and **the assistant will not install it on its own**. If it thinks the detailed guide would help, it asks you first; only then does it install.

If your assistant is already accurate, skip this section.

### Simpler: point the assistant at the guide

If all you want is for the assistant to get this right, **you do not need the skill at all**. Just tell it:

> When using the session orchestrator plugin, read `docs/AGENT-GUIDE.en.md` first.

Or hand it the link:

- English: [Agent Guide](./docs/AGENT-GUIDE.en.md)
- 中文：[Agent 手册](./docs/AGENT-GUIDE.md)

Those are the plugin's full manuals (install, parameters, state flow, rejection codes, every config key).
The skill is a condensed operating version for repeated use; the manual suits one-off work where details matter.

### How the three fit together

| Thing | Audience | Contents |
|---|---|---|
| The README you are reading | humans | what it does, how to install, how to use |
| [`docs/AGENT-GUIDE.en.md`](./docs/AGENT-GUIDE.en.md) | the assistant | full manual, shipped with the plugin |
| `skills/session-orchestrator/` | the assistant | condensed operating version, install only with your consent |

## Use your own wording

After a registration the assistant tells you "from here you can say: send <what> to <name>".

You do **not** have to use exactly that. "deliver it to him", "give them a heads-up", "pass this along" all work — the first time a new phrasing shows up the assistant does the job and records it, and from then on it recognises that phrasing.

Where it lives: `$DSH_HOME/session-bridge/agent-prefs.json` — plugin-level preference, never written into a workspace.

## Asking for a workspace explicitly

Natural language can be misread, so **say it plainly when you can**. These two phrasings are recognised precisely:

```
帮我建立个新的工作区
帮我建立个 dsh 工作区
```

The plugin matches these (the word 工作区 must appear), and the assistant then asks only: **where the directory goes, and what the project is called**.

### Or just use the command

```
/new-workspace my-project D:\work\myproj
```

**With both a project name and a directory, the command creates the workspace right away** — no back-and-forth with the assistant. Paths with spaces are parsed as one argument.

If something is missing it shows you the correct format plus a line you can copy to the assistant; hand it over and the assistant finishes the job.

**The command and the phrasing are two equivalent routes** to the same action: register a DSH workspace and open one session. There is no third interpretation.

### What it does not do

This plugin **only registers a workspace and opens a session**; it does not scaffold a project. So it will never ask "Node or Python?" or "README/AGENTS.md?" — those are ordinary file work, outside this plugin.

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
| `0.3.1` | 2026-11-19 | Slash commands (`/new-workspace`, `/register-me`, `/register-peer`), natural-language seeds, safety gates, preference memory, archive hygiene |
| `0.3.0` | 2026-11-19 | Settings page, safety guards, agent guide, `@` friends, portability |
| `0.2.1` | 2026-11-18 | Delivery gating, cancel and expiry, urgent, timestamps |
| `0.2.0` | 2026-11-18 | Automatic receipt on delivery, start-of-work banner |
| `0.1.0` | 2026-11-17 | First release |

Full history is in GitHub Releases.

## License

[CC BY-NC 4.0](./LICENSE)
