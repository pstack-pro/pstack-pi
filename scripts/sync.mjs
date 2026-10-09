#!/usr/bin/env node
// Regenerates skills/ and agents/ from an upstream pstack checkout.
// Usage: node scripts/sync.mjs [path/to/plugins/pstack]
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(process.argv[2] ?? path.join(os.homedir(), "Code/opensource/plugins/pstack"));
if (!fs.existsSync(path.join(src, "skills", "poteto-mode", "SKILL.md"))) {
	console.error(`not a pstack checkout: ${src}`);
	process.exit(1);
}

// Ordered: specific paths before the generic prefixes they contain.
const REPLACEMENTS = [
	["~/.cursor/rules/pstack-models.mdc", ".pi/pstack-models.md"],
	["the `pstack-models.mdc` rule", "`.pi/pstack-models.md`"],
	[/(?<![\w./-])pstack-models\.mdc/g, ".pi/pstack-models.md"],
	[
		"Transcripts live at `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl`, where `<slug>` is the workspace path with the leading slash dropped and each \"/\" turned into \"-\" (so `/Users/you/proj` becomes `Users-you-proj`). Every line is one chat message.",
		"Transcripts are pi session files at `~/.pi/agent/sessions/<slug>/<timestamp>_<uuid>.jsonl`, where `<slug>` is the workspace path with each \"/\" turned into \"-\" and wrapped in `--` (so `/Users/you/proj` becomes `--Users-you-proj--`). Every line is one session entry.",
	],
	["~/.cursor/projects/*/", "~/.pi/agent/sessions/*/"],
	["~/.cursor/projects/", "~/.pi/agent/sessions/"],
	["~/.cursor/skills/", "~/.pi/agent/skills/"],
	["~/.cursor/plugins/", "~/.pi/agent/git/"],
	[".cursor/skills/", ".pi/skills/"],
	["Cursor's built-in `create-skill` skill", "the **authoring-a-skill** playbook"],
	["Cursor's built-in `create-skill`", "the **authoring-a-skill** playbook"],
];

function transform(text) {
	for (const [from, to] of REPLACEMENTS) text = typeof from === "string" ? text.split(from).join(to) : text.replace(from, to);
	return text;
}

function setFrontmatter(text, edit) {
	const m = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!m) return text;
	const lines = edit(m[1].split("\n"));
	return `---\n${lines.join("\n")}\n---\n${text.slice(m[0].length)}`;
}

function copyTree(from, to) {
	fs.cpSync(from, to, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
	const stack = [to];
	while (stack.length) {
		const dir = stack.pop();
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) stack.push(p);
			else if (e.name.endsWith(".md")) fs.writeFileSync(p, transform(fs.readFileSync(p, "utf-8")));
		}
	}
}

for (const dir of ["skills", "agents"]) {
	fs.rmSync(path.join(root, dir), { recursive: true, force: true });
	copyTree(path.join(src, dir), path.join(root, dir));
}

// pi derives the /skill: command from `name`, so keep it equal to the directory.
for (const name of fs.readdirSync(path.join(root, "skills"))) {
	const file = path.join(root, "skills", name, "SKILL.md");
	if (!fs.existsSync(file)) continue;
	const text = setFrontmatter(fs.readFileSync(file, "utf-8"), (lines) =>
		lines.map((l) => (l.startsWith("name:") ? `name: ${name}` : l)),
	);
	fs.writeFileSync(file, text);
}

for (const name of fs.readdirSync(path.join(root, "agents"))) {
	const file = path.join(root, "agents", name);
	fs.writeFileSync(
		file,
		setFrontmatter(fs.readFileSync(file, "utf-8"), (lines) => lines.filter((l) => !l.startsWith("is_background:"))),
	);
}

const overrides = path.join(root, "overrides");
if (fs.existsSync(overrides)) fs.cpSync(overrides, root, { recursive: true });

const leftovers = (() => {
	try {
		return execFileSync("grep", ["-rln", "--include=*.md", "\\.cursor/", "skills", "agents"], { cwd: root, encoding: "utf-8" });
	} catch {
		return "";
	}
})();
const rev = (() => {
	try {
		return execFileSync("git", ["-C", src, "rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
})();
const version = JSON.parse(fs.readFileSync(path.join(src, ".cursor-plugin", "plugin.json"), "utf-8")).version;
fs.writeFileSync(path.join(root, "UPSTREAM.json"), `${JSON.stringify({ pstack: version, commit: rev }, null, "\t")}\n`);
console.log(`synced pstack ${version} (${rev}) from ${src}`);
if (leftovers) console.log(`files still mentioning .cursor/:\n${leftovers}`);
