import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");
export const MODELS_FILE = path.join(".pi", "pstack-models.md");

export interface AgentConfig {
	name: string;
	description: string;
	systemPrompt: string;
	model?: string;
}

const GENERAL_PURPOSE: AgentConfig = {
	name: "generalPurpose",
	description: "General-purpose subagent with the default pi prompt and full tools.",
	systemPrompt: "",
};

export function loadAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [GENERAL_PURPOSE];
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
	} catch {
		return agents;
	}
	for (const file of entries) {
		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(
			fs.readFileSync(path.join(AGENTS_DIR, file), "utf-8"),
		);
		if (typeof frontmatter.name !== "string") continue;
		agents.push({
			name: frontmatter.name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			systemPrompt: body,
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
		});
	}
	return agents;
}

export function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
	const normalized = name.trim().toLowerCase().replace(/[\s_]+/g, "-");
	return agents.find((a) => a.name.toLowerCase().replace(/[\s_]+/g, "-") === normalized);
}

export function readModelsFile(cwd: string): string | undefined {
	try {
		return fs.readFileSync(path.join(cwd, MODELS_FILE), "utf-8");
	} catch {
		return undefined;
	}
}
