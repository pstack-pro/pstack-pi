// Scripted OpenAI-compatible server for deterministic end-to-end tests.
// The reply depends on the scenario keyword in the first user message and on
// what the conversation already contains. Every request is logged as JSONL.
import * as fs from "node:fs";
import * as http from "node:http";

const port = Number(process.argv[2] ?? 18765);
const log = process.argv[3] ?? "requests.jsonl";
let callSeq = 0;

const text = (m) =>
	typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");

function task(args) {
	return { name: "Task", arguments: JSON.stringify({ description: "test task", ...args }) };
}

function decide(body) {
	const msgs = body.messages;
	const system = msgs.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n");
	const firstUser = text(msgs.find((m) => m.role === "user") ?? {});
	const last = msgs[msgs.length - 1];
	const toolResults = msgs.filter((m) => m.role === "tool").map(text);
	const tools = (body.tools ?? []).map((t) => t.function?.name);

	if (firstUser.includes("CHILD_TASK")) {
		const flags = [
			`pstack_section=${system.includes("You are running pstack on pi")}`,
			`poteto_skill=${system.includes("poteto-mode")}`,
			`agent_prompt=${system.includes("Poteto subagent")}`,
			`tools=${tools.join("+")}`,
		].join(" ");
		const users = msgs.filter((m) => m.role === "user").map(text);
		const latest = users[users.length - 1];
		return { content: `child ok turn=${users.length} ${flags} :: ${(latest.split("CHILD_TASK")[1] ?? latest).trim()}` };
	}

	const scenario = firstUser.match(/TEST_\w+/)?.[0];
	if (last.role === "tool" || text(last).includes("Background task")) {
		if (scenario === "TEST_RESUME" && toolResults.length === 1) {
			const id = toolResults[0].match(/task_id: (\S+)/)?.[1];
			return { toolCalls: [task({ resume: id, prompt: "CHILD_TASK second turn" })] };
		}
		if (scenario === "TEST_BG" && !msgs.some((m) => text(m).includes("Background tasks finished"))) {
			return { content: "started, ending turn" };
		}
		return { content: `parent done :: ${[...toolResults, text(last)].join(" || ").slice(0, 2000)}` };
	}

	switch (scenario) {
		case "TEST_SYNC":
			return { toolCalls: [task({ subagent_type: "poteto-agent", model: "grok-4.7-xhigh-fast", prompt: "CHILD_TASK sync" })] };
		case "TEST_MODEL":
			return { toolCalls: [task({ model: "mock/mock-b:low", prompt: "CHILD_TASK model" })] };
		case "TEST_PARALLEL":
			return {
				toolCalls: [task({ prompt: "CHILD_TASK alpha" }), task({ prompt: "CHILD_TASK beta" }), task({ subagent_type: "Comment Sicko", prompt: "CHILD_TASK gamma" })],
			};
		case "TEST_READONLY":
			return { toolCalls: [task({ readonly: true, prompt: "CHILD_TASK readonly" })] };
		case "TEST_BG":
			return { toolCalls: [task({ run_in_background: true, prompt: "CHILD_TASK background" })] };
		case "TEST_RESUME":
			return { toolCalls: [task({ prompt: "CHILD_TASK first turn" })] };
		case "TEST_PROMPT":
			return { content: `system has pstack=${system.includes("You are running pstack on pi")} models=${system.includes("<pstack_models")} tools=${tools.join("+")}` };
		default:
			return { content: "unknown scenario" };
	}
}

http
	.createServer((req, res) => {
		let raw = "";
		req.on("data", (d) => (raw += d));
		req.on("end", () => {
			if (!req.url?.endsWith("/chat/completions")) {
				res.writeHead(200, { "content-type": "application/json" });
				return res.end(JSON.stringify({ data: [{ id: "mock-a" }, { id: "mock-b" }] }));
			}
			const body = JSON.parse(raw);
			const out = decide(body);
			fs.appendFileSync(log, `${JSON.stringify({ model: body.model, out, messages: body.messages.length })}\n`);
			res.writeHead(200, { "content-type": "text/event-stream" });
			const send = (delta, finish = null) =>
				res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			send({ role: "assistant" });
			if (out.content) send({ content: out.content });
			(out.toolCalls ?? []).forEach((tc, index) =>
				send({ tool_calls: [{ index, id: `call_${++callSeq}`, type: "function", function: tc }] }),
			);
			send({}, out.toolCalls ? "tool_calls" : "stop");
			res.write(`data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
			res.end("data: [DONE]\n\n");
		});
	})
	.listen(port, () => console.log(`mock listening on ${port}`));
