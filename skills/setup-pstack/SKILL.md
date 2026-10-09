---
name: setup-pstack
description: Configure which models pstack uses per role and at what reasoning budget, for this project only. Detects the models pi can run with their prices, proposes a cost-aware preset, and writes .pi/pstack-models.md, which the pstack extension injects into every prompt. Use for /skill:setup-pstack, "configure pstack models", "pstack budget", or changing pstack's model choices.
---

# Setup pstack (pi)

Write `.pi/pstack-models.md` in the project root. The pstack extension reads it on every prompt and injects it into the system prompt, so it takes effect on the next message. It is project-local by design. Other pi projects are not affected.

## Presets

Check these in order and propose the first whose models are all detected and pass the smoke test. A preset is a starting proposal, not a lock: the user can change any role in step 3 (d). When the user's request already names models or rules, those win over the preset.

### mimo-deepseek

Needs `xiaomi/mimo-v2.6-pro`, `xiaomi/mimo-v2.6-flash`, `deepseek/deepseek-flash`, `deepseek/deepseek-v4-pro`. Judgment goes to the cheaper strong model, code to DeepSeek V4.1 Flash, the expensive Pro only to the hardest tasks, and panels mix both families.

```
feature, refactoring: deepseek/deepseek-flash
bug-fix: deepseek/deepseek-flash
perf-issue: deepseek/deepseek-flash
hillclimb: deepseek/deepseek-flash
judgment and prose: xiaomi/mimo-v2.6-pro
hardest tasks: deepseek/deepseek-v4-pro
how explorer: deepseek/deepseek-flash
how explainer: xiaomi/mimo-v2.6-pro
why investigators: deepseek/deepseek-flash
why synthesizer: xiaomi/mimo-v2.6-pro
reflect tooling: deepseek/deepseek-flash
reflect judgment, divergent, synthesizer: xiaomi/mimo-v2.6-pro
arena runners: xiaomi/mimo-v2.6-pro, deepseek/deepseek-flash, xiaomi/mimo-v2.6-flash
arena cross-judge pool: xiaomi/mimo-v2.6-pro, deepseek/deepseek-flash, xiaomi/mimo-v2.6-flash
swarm workers: deepseek/deepseek-flash
architect runners: xiaomi/mimo-v2.6-pro, deepseek/deepseek-flash, xiaomi/mimo-v2.6-flash
interrogate reviewers: xiaomi/mimo-v2.6-pro, deepseek/deepseek-flash, xiaomi/mimo-v2.6-flash
```

If only part of a preset is available (for example `deepseek-v4-pro` fails), keep the preset and remap only the missing model's roles with the cost rules below, and say which roles moved.

With no matching preset, build the mapping from step 3 (b).

## Cost rules

Prices come from the `PstackModels` tool, in dollars per million tokens. Rank by output price first, since pstack subagents write long reports, then by cache-read price, since they reread the same skill files.

- Within a slot, pick the cheapest model of comparable strength. A flagship model that costs several times a slightly weaker one is not the default.
- Never pick premium-speed variants (`-ultraspeed`, `-fast` surcharges, `:batch`, priority tiers) unless the user asks for them.
- The most expensive model in the mapping goes only to `hardest tasks`. If it would land anywhere else, swap in the next cheaper model and say so.
- Panels run one subagent per entry, so their cost multiplies. Prefer entries from different families at mid price over three flagships.

## Steps

### 1. Detect available models

Call the `PstackModels` tool. It lists every model pi has credentials for, with input, output, and cache-read prices and the thinking levels each model supports. Treat every listed `provider/id` as detected. The aliases `inherit-parent` and `auto` are always valid. Both mean the role runs on the parent chat model. Never write a model you have not seen in that list.

### 2. Load current state

If `.pi/pstack-models.md` exists, read it and treat its `# budget` line and role values as the current choices. Otherwise start from the first matching preset, or from the defaults in step 5. A line whose role is not in step 5 is from a retired role. Drop it.

### 3. Budget, map, and confirm

**(a) Ask for a budget** with the `AskQuestion` tool. Offer these four options with these exact labels, and name the current budget when the file records one. If the user's request already names a budget, use it without asking.

- `unlimited — keep max`
- `large — xhigh reasoning`
- `medium — high reasoning`
- `small — medium reasoning`

**(b) Map roles to detected models** when no preset matched. The step 5 defaults name three slots. `<claude>` wants a strong judgment and prose model. `<grok>` wants a fast, capable code model. `<gpt>` wants a strong model from a different family than the `<claude>` pick, so panels get a second opinion. Any detected family qualifies: `anthropic/claude-*`, `openai/gpt-*`, `xai/grok-*`, `xiaomi/mimo-*`, `deepseek/*`, and so on. Apply the cost rules to every pick. Prefer the newest version of a family. A slot with no fitting model is marked as needing a choice. Prefer `inherit-parent` over inventing one.

**(b2) Smoke-test every distinct model you picked.** A listed model only proves a credential exists, not that it works. Test one model per provider first. If it fails with an authentication error (401/403), drop that whole provider without testing its other models. Then test every remaining distinct model in one bash call, in parallel, so setup stays fast:

```bash
for m in <provider/id> <provider/id> ...; do
  ( out=$(pi --model "$m" --no-session -p "Reply with: ok" < /dev/null 2>&1 | tail -1); echo "$m => $out" ) &
done; wait
```

The `< /dev/null` matters; without it pi waits on stdin. Retry a model once only if its line shows a timeout or network error. Drop any model whose call errors, tell the user which ones failed and why, and remap its roles with the cost rules.

**(c) Apply the budget** as a pi thinking suffix on every real model, panel entries included. The target is `max` for `unlimited`, `xhigh` for `large`, `high` for `medium`, `medium` for `small`. Use the target when the model's thinking levels (from `PstackModels`) include it, else the highest supported level below it, else the lowest supported level above it. Models with thinking `none` take no suffix. Aliases take no suffix.

**(d) Show the roles and confirm.** Show a table of every role with its model and that model's output price, then a one-line cost note: which model is the most expensive and which roles use it. Mark roles that need a choice and list each line step 2 dropped. Ask with `AskQuestion` whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent`. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, so the list length sets the count. If only one family is detected, say so plainly: the panel still runs, but its cross-model check is weaker. `arena cross-judge pool` is also a list. Arena selects one value whose family differs from the parent's when possible. `swarm workers` is the default model for every worker.

### 4. Validate

Every real model written must be in the detected list and must have passed the step 3 (b2) smoke test. If a chosen model fails either check, stop and ask again.

### 5. Write the file

Write `.pi/pstack-models.md` (create `.pi/` if needed), overwriting the whole file so re-runs stay idempotent. One line per role, using the role labels below. Record the preset name, if one was used, in a `# preset:` line. Defaults by slot when no preset matched:

```
# pstack model configuration for this project. One line per role. Delete a line to fall back to the skill default.
# Values are pi model patterns (provider/id:thinking). `inherit-parent` runs the role on the parent chat model.
# budget: unlimited (max)
# preset: none
feature, refactoring: <grok>
bug-fix: <grok>
perf-issue: <grok>
hillclimb: <grok>
judgment and prose: <claude>
hardest tasks: <claude>
how explorer: <grok>
how explainer: <claude>
why investigators: <grok>
why synthesizer: <claude>
reflect tooling: <gpt>
reflect judgment, divergent, synthesizer: <claude>
arena runners: <claude>, <gpt>, <grok>
arena cross-judge pool: <claude>, <gpt>, <grok>
swarm workers: <grok>
architect runners: <claude>, <gpt>, <grok>
interrogate reviewers: <claude>, <gpt>, <grok>
```

Never commit the file or run any git command that changes history. Ask once whether to add `.pi/pstack-models.md` to `.gitignore`, since it names the user's providers. Without an interactive user, leave `.gitignore` alone and mention the choice in the reply.

### 6. Confirm

Tell the user the file was written and applies from the next message. Re-running this skill updates it. Deleting the file restores the skill defaults, which fall back to the parent model when pi cannot run them.

### 7. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /skill:create-verification-skill." On yes, run that skill. On no, move on without pushing.
