/**
 * pstack runtime for pi.
 *
 * pstack's skills are written against Cursor's agent tools. Rather than
 * rewriting every skill, this extension provides tools with the same names and
 * parameters: `Task` (subagents, background runs, resume), `Await`, and
 * `AskQuestion`. It also injects the project's `.pi/pstack-models.md` role map
 * into the system prompt, the way Cursor injects an always-applied rule.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { findAgent, loadAgents, MODELS_FILE, readModelsFile } from "./config.ts";
import { depth, formatRun, MAX_DEPTH, resolveModel, runs, startTask, type TaskRun } from "./task.ts";

const ADAPTATION_NOTES = `You are running pstack on pi, not Cursor. Where a pstack skill mentions Cursor-only behavior:
- \`Task\`, \`Await\`, and \`AskQuestion\` exist here with Cursor's parameters. Several \`Task\` calls in one message run in parallel.
- \`environment: "cloud"\` is unsupported; every subagent runs locally in this checkout. Give parallel writers separate git worktrees via \`cwd\`.
- A \`Task\` whose model is unavailable runs on the parent model and says so in its \`note\`. Report that to the user instead of hiding it.
- Model roles come from \`${MODELS_FILE}\` (shown below when present). \`/skill:setup-pstack\` writes it.
- Cursor built-ins (\`create-skill\`, \`/loop\`, its babysit skill, Plan Mode, automations, the cloud dashboard) do not exist. Follow the pstack playbook directly. For a wake loop, run a background \`Task\` watcher or tell the user to schedule \`pi -p\` externally.
- pi has no todo tool. Keep the playbook todolist as a markdown checklist in your messages. Never write a TODO file outside the project.
- Skills from other Cursor plugins (\`/deslop\` from cursor-team-kit, \`create-skill\`) are not installed and need no search. In place of \`/deslop\`, review the diff yourself for slop and run the \`no-comments\` skill.
- "agent-transcripts" means pi session files (JSONL). Sessions live under \`~/.pi/agent/sessions/<cwd slug>/\`; subagent sessions live under the OS temp dir in \`pi-pstack-sessions/\`.`;

const TaskParams = Type.Object({
	description: Type.String({ description: "Short (3-5 word) label for the task" }),
	prompt: Type.String({ description: "Full brief for the subagent. It starts with no context from this chat." }),
	subagent_type: Type.Optional(
		Type.String({ description: 'Agent to run, e.g. "poteto-agent", "Comment Sicko", "generalPurpose" (default)' }),
	),
	model: Type.Optional(
		Type.String({
			description:
				'Model for the subagent: pi pattern "provider/id[:thinking]", a Cursor slug, or "inherit-parent"/"auto" for the parent model',
		}),
	),
	readonly: Type.Optional(Type.Boolean({ description: "Disable edit/write tools for the subagent" })),
	run_in_background: Type.Optional(
		Type.Boolean({ description: "Return a task_id immediately; the result arrives as a message when done" }),
	),
	resume: Type.Optional(Type.String({ description: "task_id of a finished subagent to continue with its context" })),
	cwd: Type.Optional(Type.String({ description: "Working directory, e.g. a git worktree path" })),
	environment: Type.Optional(Type.String({ description: 'Ignored on pi ("cloud" runs locally)' })),
});

const AwaitParams = Type.Object({
	task_ids: Type.Optional(Type.Array(Type.String(), { description: "Background task ids. Omit to wait for all." })),
	timeout_seconds: Type.Optional(Type.Number({ description: "Stop waiting after this many seconds" })),
});

const AskQuestionParams = Type.Object({
	title: Type.Optional(Type.String()),
	questions: Type.Array(
		Type.Object({
			id: Type.String(),
			prompt: Type.String(),
			options: Type.Array(Type.Object({ id: Type.String(), label: Type.String() })),
			allow_multiple: Type.Optional(Type.Boolean()),
		}),
	),
});

const OTHER = "Other (type an answer)";
const DONE = "Done";

export default function pstack(pi: ExtensionAPI) {
	const agents = loadAgents();

	pi.on("before_agent_start", (event, ctx) => {
		const models = readModelsFile(ctx.cwd);
		event.systemPromptOptions.sections.pstack = [
			ADAPTATION_NOTES,
			models
				? `<pstack_models file="${MODELS_FILE}">\n${models.trim()}\n</pstack_models>`
				: `No ${MODELS_FILE} in this project: every role uses its skill default, and defaults this pi cannot run fall back to the parent model.`,
			`Current session file: ${ctx.sessionManager.getSessionFile() ?? "(ephemeral)"}`,
		].join("\n\n");
	});

	pi.registerTool({
		name: "Task",
		label: "Task",
		description: [
			"Launch a subagent in a separate pi process with its own context window.",
			`Agents: ${agents.map((a) => `${a.name}${a.description ? ` (${a.description.slice(0, 80)})` : ""}`).join("; ")}.`,
			"Put several Task calls in one message to run them in parallel.",
		].join(" "),
		parameters: TaskParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (depth >= MAX_DEPTH) throw new Error(`Subagent nesting is capped at ${MAX_DEPTH} levels. Do this work yourself.`);
			const previous = params.resume ? runs.get(params.resume) : undefined;
			if (params.resume && !previous) throw new Error(`Unknown task_id "${params.resume}" in this pi session.`);
			if (previous?.status === "running") throw new Error(`Task ${previous.id} is still running. Await it first.`);

			const agentName = params.subagent_type ?? previous?.agent.name ?? "generalPurpose";
			const agent = findAgent(agents, agentName);
			if (!agent) throw new Error(`Unknown subagent_type "${agentName}". Available: ${agents.map((a) => a.name).join(", ")}`);

			const resolved = previous
				? { model: previous.model, thinking: previous.thinking }
				: resolveModel(params.model ?? agent.model, ctx);
			const run = startTask({
				agent,
				description: params.description,
				prompt: params.prompt,
				resolved,
				readonly: params.readonly ?? previous?.readonly ?? false,
				cwd: params.cwd ?? previous?.cwd ?? ctx.cwd,
				trusted: ctx.isProjectTrusted(),
				resume: previous,
				onProgress: params.run_in_background
					? undefined
					: (r, line) => onUpdate?.({ content: [{ type: "text", text: `${r.agent.name}: ${line}` }], details: undefined }),
			});
			signal?.addEventListener("abort", () => params.run_in_background || run.abort(), { once: true });

			if (params.run_in_background) {
				run.promise.then((done) => {
					if (done.awaited || ctx.mode !== "tui") return;
					done.awaited = true;
					pi.sendMessage(
						{ customType: "pstack-task", content: `Background task finished.\n\n${formatRun(done)}`, display: true },
						{ triggerTurn: true, deliverAs: "followUp" },
					);
				});
				const extra = run.note ? `\nnote: ${run.note}` : "";
				return {
					content: [{ type: "text", text: `Started in background.\ntask_id: ${run.id}${extra}\nThe result arrives as a message when it finishes, or call Await.` }],
					details: undefined,
				};
			}
			const done = await run.promise;
			done.awaited = true;
			return { content: [{ type: "text", text: formatRun(done) }], details: undefined, isError: done.status !== "done" };
		},
		renderCall(args, theme) {
			const agent = args.subagent_type ?? "generalPurpose";
			const flags = [args.model, args.run_in_background ? "background" : undefined, args.resume ? "resume" : undefined]
				.filter(Boolean)
				.join(", ");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("Task "))}${theme.fg("accent", agent)} ${theme.fg("dim", args.description ?? "")}${flags ? theme.fg("muted", ` [${flags}]`) : ""}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "Await",
		label: "Await",
		description: "Wait for background Task subagents and return their results.",
		parameters: AwaitParams,
		async execute(_id, params, signal) {
			const targets = params.task_ids?.length
				? params.task_ids.map((id) => runs.get(id)).filter((r): r is TaskRun => Boolean(r))
				: [...runs.values()].filter((r) => !r.awaited);
			if (targets.length === 0) return { content: [{ type: "text", text: "No matching background tasks." }], details: undefined };
			for (const r of targets) r.awaited = true;
			const waits: Array<Promise<unknown>> = [Promise.all(targets.map((r) => r.promise))];
			if (params.timeout_seconds) waits.push(new Promise((r) => setTimeout(r, params.timeout_seconds! * 1000)));
			if (signal) waits.push(new Promise((r) => signal.addEventListener("abort", r, { once: true })));
			await Promise.race(waits);
			for (const r of targets) if (r.status === "running") r.awaited = false;
			const text = targets
				.map((r) => (r.status === "running" ? `task_id: ${r.id}\nstatus: running (${r.description})` : formatRun(r)))
				.join("\n\n---\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "PstackModels",
		label: "PstackModels",
		description:
			"List the models pi can run (credentials present) with price in $ per million tokens and supported thinking levels. Used by setup-pstack.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
			const rows = ctx.modelRegistry
				.getAvailable()
				.map((m) => {
					const map = (m.thinkingLevelMap ?? {}) as Record<string, string | null | undefined>;
					const thinking = m.reasoning ? levels.filter((l) => map[l] !== null).join("/") : "none";
					const c = m.cost;
					return `${m.provider}/${m.id} | in ${c.input} | out ${c.output} | cacheRead ${c.cacheRead} | thinking ${thinking} | ctx ${m.contextWindow}`;
				})
				.sort();
			return {
				content: [
					{
						type: "text",
						text: `model | $/M input | $/M output | $/M cache read | thinking levels | context\n${rows.join("\n")}`,
					},
				],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "AskQuestion",
		label: "AskQuestion",
		description: "Ask the user structured multiple-choice questions. Returns the chosen option ids or typed answers.",
		parameters: AskQuestionParams,
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text: "No interactive user in this run. Decide per the Autonomy rules, act on the default, and report it.",
						},
					],
					details: undefined,
				};
			}
			const answers: string[] = [];
			for (const q of params.questions) {
				const title = params.title ? `${params.title}: ${q.prompt}` : q.prompt;
				const labels = q.options.map((o) => o.label);
				const picked: string[] = [];
				while (true) {
					const choices = q.allow_multiple
						? [...labels.filter((l) => !picked.includes(l)), OTHER, DONE]
						: [...labels, OTHER];
					const choice = await ctx.ui.select(q.allow_multiple && picked.length ? `${title} (picked: ${picked.join(", ")})` : title, choices);
					if (choice === undefined || choice === DONE) break;
					if (choice === OTHER) {
						const typed = await ctx.ui.input(q.prompt);
						if (typed) picked.push(`other: ${typed}`);
					} else {
						picked.push(choice);
					}
					if (!q.allow_multiple) break;
				}
				const ids = picked.map((p) => q.options.find((o) => o.label === p)?.id ?? p);
				answers.push(`${q.id}: ${ids.length ? ids.join(", ") : "(skipped)"}`);
			}
			return { content: [{ type: "text", text: answers.join("\n") }], details: undefined };
		},
	});

	// A print-mode subagent exits when its turn settles, which would orphan its
	// background tasks. Wait for them and hand the results back for one more turn.
	pi.on("agent_before_settle", async (_event, ctx) => {
		if (ctx.mode === "tui") return;
		const pending = [...runs.values()].filter((r) => !r.awaited);
		if (pending.length === 0) return;
		for (const r of pending) r.awaited = true;
		await Promise.all(pending.map((r) => r.promise));
		return {
			entries: [
				{
					type: "custom_message",
					customType: "pstack-task",
					content: `Background tasks finished.\n\n${pending.map(formatRun).join("\n\n---\n\n")}`,
					display: true,
				},
			],
			continue: true,
		};
	});

	pi.on("session_shutdown", () => {
		for (const r of runs.values()) if (r.status === "running") r.abort();
	});
}
