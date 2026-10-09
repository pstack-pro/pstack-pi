import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentConfig, PACKAGE_ROOT } from "./config.ts";

export const MAX_DEPTH = 3;
const MAX_CONCURRENCY = 6;
const OUTPUT_CAP = 50 * 1024;
const PARENT_ALIASES = new Set(["inherit-parent", "auto", "inherit", ""]);
const EFFORTS = ["max", "xhigh", "high", "medium", "low", "minimal", "off"];

export const depth = Number(process.env.PSTACK_DEPTH ?? "0") || 0;
const sessionDir = path.join(os.tmpdir(), "pi-pstack-sessions");

export interface TaskRun {
	id: string;
	agent: AgentConfig;
	description: string;
	model?: string;
	thinking?: string;
	readonly: boolean;
	cwd: string;
	status: "running" | "done" | "failed" | "aborted";
	output: string;
	note?: string;
	cost: number;
	turns: number;
	promise: Promise<TaskRun>;
	awaited: boolean;
	abort: () => void;
}

export const runs = new Map<string, TaskRun>();

interface ResolvedModel {
	model?: string;
	thinking?: string;
	note?: string;
}

/**
 * Accepts pi patterns (`provider/id[:thinking]`, bare `id[:thinking]`) and
 * Cursor-style slugs (`claude-opus-5-5-max`, `grok-4.7-xhigh-fast`). Anything
 * unavailable falls back to the parent model with a note, so a stale default
 * in a skill never blocks a delegation.
 */
export function resolveModel(requested: string | undefined, ctx: ExtensionContext): ResolvedModel {
	const parent: ResolvedModel = {
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinking: ctx.thinkingLevel,
	};
	const raw = (requested ?? "").trim();
	if (PARENT_ALIASES.has(raw)) return parent;

	const available = ctx.modelRegistry.getAvailable();
	const [spec, level] = raw.split(":");
	const candidates: Array<{ id: string; thinking?: string }> = [{ id: spec, thinking: level }];
	const slug = spec.match(new RegExp(`^(.*?)-(${EFFORTS.join("|")})(-fast)?$`));
	if (slug) candidates.push({ id: slug[1], thinking: level ?? slug[2] });

	for (const c of candidates) {
		const [provider, id] = c.id.includes("/") ? c.id.split(/\/(.*)/s, 2) : [undefined, c.id];
		const hit = available.find((m) => m.id === id && (!provider || m.provider === provider));
		if (hit) return { model: `${hit.provider}/${hit.id}`, thinking: c.thinking };
	}
	return {
		...parent,
		note: `requested model "${raw}" is not available in pi; ran on the parent model ${parent.model ?? "(default)"}. Run /skill:setup-pstack to map roles to models you have.`,
	};
}

let active = 0;
const queue: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (active >= MAX_CONCURRENCY) await new Promise<void>((r) => queue.push(r));
	active++;
	try {
		return await fn();
	} finally {
		active--;
		queue.shift()?.();
	}
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/") && fs.existsSync(script)) {
		return { command: process.execPath, args: [script, ...args] };
	}
	const exec = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function truncate(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP) return text;
	return `[pstack: earlier output truncated]\n\n${text.slice(-OUTPUT_CAP)}`;
}

export interface StartOptions {
	agent: AgentConfig;
	description: string;
	prompt: string;
	resolved: ResolvedModel;
	readonly: boolean;
	cwd: string;
	trusted: boolean;
	resume?: TaskRun;
	onProgress?: (run: TaskRun, line: string) => void;
}

export function startTask(opts: StartOptions): TaskRun {
	const id = opts.resume?.id ?? randomUUID();
	const controller = new AbortController();
	const run: TaskRun = {
		id,
		agent: opts.agent,
		description: opts.description,
		model: opts.resolved.model,
		thinking: opts.resolved.thinking,
		readonly: opts.readonly,
		cwd: opts.cwd,
		status: "running",
		output: "",
		note: opts.resolved.note,
		cost: 0,
		turns: 0,
		awaited: false,
		abort: () => controller.abort(),
		promise: undefined as unknown as Promise<TaskRun>,
	};
	run.promise = withSlot(() => execute(run, opts, controller.signal));
	runs.set(id, run);
	return run;
}

async function execute(run: TaskRun, opts: StartOptions, signal: AbortSignal): Promise<TaskRun> {
	fs.mkdirSync(sessionDir, { recursive: true });
	const args = ["--mode", "json", "-p", "--session-dir", sessionDir, "--session-id", run.id];
	args.push("-e", path.join(PACKAGE_ROOT, "extensions", "pstack", "index.ts"));
	args.push("--skill", path.join(PACKAGE_ROOT, "skills"));
	if (run.model) args.push("--model", run.model);
	if (run.thinking) args.push("--thinking", run.thinking);
	if (run.readonly) args.push("--exclude-tools", "edit,write");
	if (opts.trusted) args.push("--approve");

	let promptFile: string | undefined;
	if (run.agent.systemPrompt.trim()) {
		promptFile = path.join(os.tmpdir(), `pi-pstack-${run.id}.md`);
		fs.writeFileSync(promptFile, run.agent.systemPrompt, { mode: 0o600 });
		args.push("--append-system-prompt", promptFile);
	}
	args.push("--", opts.prompt);

	const texts: string[] = [];
	let stderr = "";
	let failed = false;
	try {
		const code = await new Promise<number>((resolve) => {
			const inv = piInvocation(args);
			const proc = spawn(inv.command, inv.args, {
				cwd: run.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PSTACK_DEPTH: String(depth + 1) },
			});
			let buf = "";
			const onLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;
				const msg = event.message;
				run.turns++;
				run.cost += msg.usage?.cost?.total ?? 0;
				if (msg.stopReason === "error") failed = true;
				if (msg.errorMessage) stderr += `${msg.errorMessage}\n`;
				for (const part of msg.content ?? []) {
					if (part.type === "text" && part.text.trim()) texts.push(part.text.trim());
					if (part.type === "toolCall") opts.onProgress?.(run, `→ ${part.name}`);
				}
			};
			proc.stdout.on("data", (d) => {
				buf += d.toString();
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";
				lines.forEach(onLine);
			});
			proc.stderr.on("data", (d) => {
				stderr += d.toString();
			});
			proc.on("close", (c) => {
				onLine(buf);
				resolve(c ?? 0);
			});
			proc.on("error", (e) => {
				stderr += String(e);
				resolve(1);
			});
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => proc.killed || proc.kill("SIGKILL"), 5000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		});
		if (signal.aborted) run.status = "aborted";
		else run.status = code === 0 && !failed ? "done" : "failed";
		// Return every assistant text, not just the last one: models often put the
		// analysis in an early turn and end with a one-line confirmation.
		const transcript = texts.join("\n\n");
		run.output = truncate(run.status === "done" ? transcript || "(no output)" : stderr.trim() || transcript || "(no output)");
	} finally {
		if (promptFile) fs.rmSync(promptFile, { force: true });
	}
	return run;
}

export function formatRun(run: TaskRun): string {
	const head = [
		`task_id: ${run.id}`,
		`agent: ${run.agent.name}`,
		`status: ${run.status}`,
		`model: ${run.model ?? "(default)"}${run.thinking ? `:${run.thinking}` : ""}`,
		`turns: ${run.turns}${run.cost ? `, cost: $${run.cost.toFixed(4)}` : ""}`,
	];
	if (run.note) head.push(`note: ${run.note}`);
	return `${head.join("\n")}\n\n${run.output}`;
}
