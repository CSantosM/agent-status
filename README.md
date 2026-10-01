<p align="center"><img src="media/icon.png" width="96" alt="The Agent Status icon: a robot head with three status dots under it, yellow, red and green."></p>

# Agent Status

A status bar chip that shows every running coding agent session at a glance: the Agent Status robot, the number of agents working, and one dot per session. For now it supports [Claude Code](#supported-agents).

<p align="center">
  <img src="docs/images/hover.png" width="820" alt="The chip at the right of the VS Code status bar, next to the notifications bell: a red robot icon followed by five colored dots. Above it, the hover card lists the five sessions in the same order, each with its title, status, time and folder, plus filter links for All, Working, Waiting and Idle.">
</p>

| Dot | Status  | Meaning                               |
| --- | ------- | ------------------------------------- |
| 🟡  | Working | The agent is running a turn           |
| 🔴  | Waiting | It needs your permission or an answer |
| 🟢  | Idle    | It finished and is ready for more     |

The number after the robot counts the agents working right now, like the Source Control count of changes; the panel's badge in the activity bar shows the same number. The robot takes the color of the most urgent status: red if any session is waiting, yellow if any is working. With no sessions, the chip says *No agents*, in the language VS Code uses (English and Spanish so far).

<p align="center">
  <img src="docs/images/states.png" width="560" alt="Six states of the chip: no sessions shows the robot and "No agents"; all idle shows green dots after a gray robot; some working turns the robot yellow and adds the number of agents working; someone waiting turns it red; a filter to Waiting shows one red dot and a funnel; more than eight sessions shows eight dots and +3.">
</p>

## Supported agents

Agent Status is not tied to a single agent, but for now it supports only Claude Code.

| Agent                                  | Support                         | Needs                                                                       |
| -------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- |
| [Claude Code](https://code.claude.com) | Supported (tested with 2.1.286) | The Claude Code extension for VS Code, or the `claude` CLI in a VS Code terminal |

Sessions open in the Claude Code extension's chat; CLI sessions focus their terminal instead. It works best on Linux; see [Limitations](#limitations).

This is a community project, not affiliated with or endorsed by Anthropic.

## Using it

- **Hover the chip** to see the sessions in the same order as the dots, numbered, each with its title, status, time in that status, folder and branch, and what it is doing right now. Click a title to open that session. The filter links at the top (All · Working · Waiting · Idle) choose which sessions the chip and the panel show.
- **Click the chip** to open a searchable session picker. The first waiting session is highlighted, so Enter takes you to it. The funnel button in its title bar opens the status filter.
- A funnel appears in the chip while a filter is active. The filter is remembered across restarts.

<p align="center">
  <img src="docs/images/picker.png" width="760" alt="The session picker at the top of the window: a search box and the five sessions, each with its dot, number, title, status and time, and below it what it is doing, its folder and its branch. The waiting session is highlighted.">
</p>

### The panel

The robot in the activity bar opens the **Agent Status** panel: every session in one tree, with a badge counting the agents working.

<p align="center">
  <img src="docs/images/panel.png" width="820" alt="The Agent Status panel in the side bar, grouped by branch. Under main, the session fix/login-redirect is expanded: it is editing auth.ts in web-app and has edited three tracked files, each with its folder and lines added and removed. Below it, a waiting and a working session on main, and two idle sessions in their own worktrees. The activity bar icon, the robot with three dots under its head, shows a badge with 2, the agents working.">
</p>

- **Expand a session** to see what it is doing, its folder and the files it edited, with the lines added and removed against HEAD (or *deleted*, *no changes*). Only files inside the workspace open in VS Code are listed, so an agent's scratch files, say in `/tmp`, are left out. Inside a git repository a file must also be tracked, which leaves out ignored and build files, and new files until they are added to git; in a workspace without git, every file edited inside it is listed. Each file is compared with the repository it lives in, also in multi-root workspaces.
- **Click a file** to open its changes against HEAD in a diff; the second button on the row opens the file itself. Edits made by the session's subagents count too.
- **Group by branch** with the branch button in the panel's title bar (or `agentStatus.groupBy`). Sessions that share a working tree land in the same group, which shows at a glance which agents may step on each other; each worktree is a group of its own. Grouping also applies to the chip (groups are separated by ` · `), the hover and the picker.

### What each agent is doing

While a session works, the hover, the picker and the panel show its latest tool call in words, read from the session's transcript: *Editing auth.ts*, *Running: Run the tests*, *Searching for "login"*, *Running a subagent: Explore the API*. Until it calls a tool it shows *Thinking…*; while it waits, what it waits for. Activity updates every few seconds.

### Notifications

When a session in this window stops to wait for your decision, a notification says which one and what it needs, with an **Open** button that takes you to it. **Turn Off** in the notification (or `agentStatus.notifyOnWaiting`) disables them.

_The images are mockups drawn by `docs/render.js` with made-up sessions, using VS Code's icons and Dark Modern colors._

Agent Status only takes you to sessions that already exist; it never starts one. Clicking a session shows it in Claude Code:

- If it is open in a tab, or in Claude Code's sidebar, it is shown there.
- Otherwise it reopens in a tab from its transcript, with its whole conversation.

Chats that have no messages yet are hidden (set `agentStatus.showEmptySessions` to see them) and never opened: Claude Code cannot restore an empty chat, and asked to, it starts a new one instead. Your Claude Code settings are never touched.

Sessions running in an integrated terminal focus that terminal instead.

### Sounds

A sound plays when a session in this window changes state, so you can look away while agents work:

| When                                    | Sound        | Hear it with                      | Turn it off                  | Use your own `.wav`            |
| --------------------------------------- | ------------ | --------------------------------- | ---------------------------- | ------------------------------ |
| It finishes its turn (working → idle)   | "blip"       | **Agent Status: Play Finish Sound**  | `agentStatus.soundOnFinish`  | `agentStatus.finishSoundFile`  |
| It needs your decision (working → waiting), such as a permission request | A short alert | **Agent Status: Play Waiting Sound** | `agentStatus.soundOnWaiting` | `agentStatus.waitingSoundFile` |

Several sessions changing at the same moment make one sound, and if one finishes while another starts waiting, only the waiting sound plays. Each window only sounds for its own sessions. Sounds are played with the system player (`pw-play`, `paplay` or `aplay` on Linux, `afplay` on macOS). The finish blip is generated by `scripts/make-sounds.js`; the waiting sound is a recording by another author (see [Credits](#credits)).

## How it works

Each agent is read by a **provider** (see [Adding an agent](#adding-an-agent)). For Claude Code:

- **Sessions:** Claude Code writes one record per running session to `~/.claude/sessions/<pid>.json` (or `$CLAUDE_CONFIG_DIR/sessions`) with its `status` (`busy`, `waiting`, `idle`), `cwd` and start time. The extension watches that directory and re-checks every 5 seconds. It only reads the `.json` records, never the `.key` files next to them.
- **Titles, activity and edited files:** read from the session's transcript in `~/.claude/projects/` and its subagents' transcripts. Each refresh reads only what was appended since the last one.
- **Branches and changes:** the branch comes from the folder's `.git` (worktrees included) without running git; line counts and diffs run `git status`, `git diff` and `git show`, only when the panel asks.

And for every agent:

- **Liveness:** a session whose process is gone, or whose PID was reused by another process, is ignored.
- **Which window owns a session (Linux):** chats opened by an agent's VS Code extension are child processes of the window's extension host; CLI sessions descend from one of the window's terminal shells. The extension walks `/proc` to tell them apart.

Nothing leaves the machine: no network calls, no telemetry.

### Reliability

- **It never starts a session.** Only sessions with a transcript are handed to Claude Code, in the mode that reveals or restores them rather than the sidebar route, which opens a new empty chat when Claude Code's sidebar is closed. Clicks are handled one at a time.
- **Nothing blocks VS Code.** Files are read asynchronously; a terminal that never reports its process, a refresh that hangs or an audio player that gets stuck are all cut off after a timeout.
- **Odd data is skipped, not shown.** Half-written records, invalid fields, records from another machine or PID namespace (a dev container sharing `~/.claude`), dead processes and reused PIDs are ignored. Two processes on the same session show as one dot. Titles are escaped before they reach the hover, which runs trusted command links.
- **Invalid settings fall back to their defaults.**
- Problems are written to the **Agent Status** output channel (**Agent Status: Show Log**), once per distinct problem.

## Settings

| Setting                                | Default          | Description                                                                                        |
| -------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `agentStatus.scope`              | `window`         | `window`: sessions started from this window. `workspace`: also others inside this workspace. `all`: every session on the machine. |
| `agentStatus.showEmptySessions` | `false`          | Also show chats that have no messages yet. They are never opened from here.                        |
| `agentStatus.soundOnFinish`      | `true`           | Play a blip when a session in this window finishes its turn.                                       |
| `agentStatus.soundOnWaiting`     | `true`           | Play an alert when a session in this window waits for your decision.                              |
| `agentStatus.finishSoundFile`    | (empty)          | `.wav` file to play instead of the built-in finish blip.                                           |
| `agentStatus.waitingSoundFile`   | (empty)          | `.wav` file to play instead of the built-in waiting sound.                                         |
| `agentStatus.notifyOnWaiting`    | `true`           | Show a notification with an Open button when a session in this window waits for your decision.     |
| `agentStatus.order`              | `stable`         | `stable`: start order, every dot keeps its place. `status`: waiting first, then working, then idle. |
| `agentStatus.groupBy`            | `none`           | `branch`: keep sessions in the same branch or worktree together in the chip, hover, picker and panel. |
| `agentStatus.icon`               | `agent-status-robot` | Icon at the start of the chip: the extension's robot, or any codicon such as `robot` or `sparkle`. |
| `agentStatus.iconReflectsStatus` | `true`           | Color the icon with the most urgent status.                                                        |
| `agentStatus.maxDots`            | `8`              | Dots shown before the rest are grouped as `+N`.                                                    |
| `agentStatus.hideWhenEmpty`      | `false`          | Hide the chip when no sessions are running.                                                        |
| `agentStatus.dots`               | `🟡 🔴 🟢`       | Character for each status (`busy`, `waiting`, `idle`).                                             |

Sessions that belong to another window or to a terminal outside VS Code are shown with the `workspace` and `all` scopes, but are not opened from here: attaching a second client to a running session would conflict with it.

## Adding an agent

Everything specific to an agent lives in a provider under `src/providers/`. A provider lists its sessions in a shared shape (process, folder, status, what it waits for), describes each one (title, current action, edited files, branch) and, if the agent has a VS Code extension, opens a session in it. The chip, hover, picker, panel, sounds and notifications work from those fields alone. `src/providers/index.js` documents the interface and registers the providers; `src/providers/claude-code/` is the reference implementation.

## Limitations

- Claude Code's session records and transcripts are internal formats, not a documented API. If an update changes them, sessions or their activity may stop showing; Claude Code itself is unaffected.
- A status bar item takes a single text color and a single click target. That is why the dots are emoji, and why sessions are opened from the hover or the picker rather than by clicking an individual dot.
- Window ownership needs `/proc` (Linux). Elsewhere, sessions inside the workspace folders count as this window's.

## Build and install

No dependencies are needed, only `node` (18 or later), `zip` and VS Code's `code` command:

```sh
git clone https://github.com/CSantosM/agent-status.git
cd agent-status
./package.sh --install
```

It runs the tests first and refuses to package if any fails. Then run **Developer: Reload Window** in each open VS Code window. To uninstall: `code --uninstall-extension local.agent-status`.

## Development

| Path            | What it holds                                                                  |
| --------------- | ------------------------------------------------------------------------------ |
| `extension.js`  | Everything that talks to VS Code: the chip, hover, picker, notifications and opening sessions and files |
| `src/panel.js`  | The Agent Status panel                                                          |
| `src/providers/` | One provider per agent; `claude-code/` reads Claude Code's records and transcripts and opens its chats |
| `src/sessions.js` | Provider-neutral checks: liveness, window ownership, machine, deduplication  |
| `src/git.js`    | Branches, worktrees, file changes and HEAD contents                            |
| `src/sound.js`  | The finish and waiting sounds and their audio player fallbacks                 |
| `src/util.js`   | Formatting and timeout helpers                                                 |
| `test/`         | `node:test` suites; `test/helpers.js` stands in for the `vscode` module        |
| `docs/render.js` | Draws the README images in `docs/images` with headless Chrome (`node docs/render.js`) |
| `scripts/make-icons.py` | Draws the robot once and writes the status bar font glyph, the activity bar icon and the extension icon, the last two with the three status dots (`python3 scripts/make-icons.py`; needs fontTools and Chrome) |
| `l10n/`         | Translations of the extension's own texts (`bundle.l10n.<language>.json`)      |
| `scripts/make-sounds.js` | Synthesizes the finish blip                                                    |

Run the tests with `npm test` (or `node --test 'test/*.test.js'`). The extension tests start real `sleep` processes to stand in for Claude sessions, so they need Linux.

## Credits and license

The code is under the [MIT License](LICENSE).

`media/waiting.wav`, the waiting sound, is ["Gunpoint"](https://freesound.org/people/LilMati/sounds/527850/) by LilMati on Freesound, released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/). The file's own metadata names Mattias "MATRIXXX" Lahoud and a Creative Commons Attribution license, so it is credited here either way.
