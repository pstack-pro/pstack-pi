# pstack-pi

A pi package that adapts [pstack](https://github.com/cursor/plugins/tree/main/pstack) (poteto's rigorous agent workflow) to the [pi](https://pi.dev) coding agent.

pstack's skills are written against Cursor's tools. Rather than rewriting each skill, this package provides tools in pi with **the same names and parameters**, so the skill bodies can stay essentially unchanged:

| Tool | What it does |
|---|---|
| `Task` | Runs a subagent as a separate `pi` child process. Supports `subagent_type`, `model`, `readonly`, `run_in_background`, `resume`, and `cwd`. Multiple `Task` calls in the same message run in parallel |
| `Await` | Waits for the result of a background `Task` |
| `AskQuestion` | Structured multiple-choice questions. With no UI (`-p` mode), the model decides on its own following the Autonomy rules |
| `PstackModels` | Lists the models pi can currently use, with their pricing and supported thinking levels, for `setup-pstack` |

Before each prompt, the extension also injects the project's `.pi/pstack-models.md` (per-role model configuration) and a short pi adaptation note into the system prompt — the equivalent of Cursor's always-applied rule.

## Prerequisites

- [pi](https://pi.dev) 1.0 or later (tested on 1.0.2)
- At least one model provider usable by pi; check with `pi --list-models`
- `git` installed locally if you install via `git:`

## Install / try / uninstall

Run these from the root of the project where you want pstack:

```bash
# Enable for this project only (writes .pi/settings.json; pi asks you to trust the project on first run)
pi install -l git:github.com/pstack-pro/pstack-pi

# Try it once without writing any config
pi -e git:github.com/pstack-pro/pstack-pi

# Uninstall from this project
pi remove -l --approve git:github.com/pstack-pro/pstack-pi
```

To hack on the code or pin a local version, clone it anywhere and install from the local path:

```bash
git clone https://github.com/pstack-pro/pstack-pi.git <any-dir>
pi install -l <any-dir>
```

Note: pi stores the path in `.pi/settings.json` **relative to that file**. If you later move the project or the clone, reinstall.

This package writes nothing to `~/.pi/agent/`: agent definitions are read from the package's own `agents/` directory, model configuration lives in the project's `.pi/pstack-models.md`, and subagent sessions are stored under `pstack-pi-sessions/` in the system temp directory.

## Getting started

1. `/skill:setup-pstack`: uses `PstackModels` to detect available models and prices, pings them in parallel to confirm they work, then writes per-role assignments to `.pi/pstack-models.md`.
2. `/skill:poteto-mode <task>`: the main entry point; it picks the right playbook automatically.

How `setup-pstack` assigns models (same as upstream):

- **No built-in named presets.** It detects the available models and fills the three slots (judgment / coding / a different model family) using cost-aware rules: prefer the cheaper model at equal capability, skip premium high-speed variants such as ultraspeed, and reserve the most expensive model for the hardest tasks.
- You can still change any role at the confirmation step. To add your own preset, edit the "Presets" section of `overrides/skills/setup-pstack/SKILL.md`.

It also works without running setup: if pi can't run a skill's default model (e.g. `grok-4.7-xhigh-fast`), `Task` falls back to the parent session's model and says so in the result's `note`.

Models can be written in pi format (`provider/id:thinking`) or as Cursor-style slugs (`claude-opus-5-5-max`); for the latter the thinking level is split out automatically.

## Tracking upstream

```bash
node scripts/sync.mjs                        # shallow-clones github.com/cursor/plugins into the system temp dir
node scripts/sync.mjs <plugins-repo>/pstack   # or point at an existing local checkout
PSTACK_SRC=<plugins-repo>/pstack node scripts/sync.mjs

test/run.sh                                  # end-to-end test with a mock model: no real model calls, doesn't touch ~/.pi/agent
```

`sync.mjs` regenerates `skills/` and `agents/`: it replaces Cursor paths, normalizes each skill's `name` to its directory name (pi uses it as the `/skill:` command name), then layers the hand-written files from `overrides/` on top (currently just `setup-pstack`). The upstream version is recorded in `UPSTREAM.json`.

## Known differences

- `environment: "cloud"` isn't supported; everything runs locally. When several subagents write code in parallel, give each its own git worktree via `cwd`.
- Cursor built-ins (`create-skill`, `/loop`, Plan Mode, automations, the cloud dashboard) don't exist in pi. The injected note tells the model to follow pstack's playbooks directly.
- `automations/benny` is not ported. `poteto-mode/scripts/worktree-audit.sh` still reads `~/.cursor/projects`.
- Subagents nest at most 3 levels deep, with at most 6 running at once.
- In interactive (TUI) mode, the main session is notified via a follow-up message when a background task finishes; this path has no automated test. The `-p` mode path for awaiting background tasks is covered by tests.

## License

pstack was created by Lauren Tan and is MIT-licensed; see `LICENSE-pstack`.

## Related repositories

- Chinese edition (skill descriptions and bodies translated to Chinese, preview): <https://github.com/pstack-pro/pstack-pi-zh>
- The other port: <https://github.com/pstack-pro/pstack-claude>
- Upstream pstack: <https://github.com/cursor/plugins/tree/main/pstack>
