import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Route = "clarify" | "inspect" | "change" | "run" | "explain";

type DecisionResult = {
	route: Route;
	confidence?: number;
	probabilities?: Record<string, number>;
};
type DecisionInput = {
	cwd: string;
	conversation: string;
};

type DecisionAudit = {
	kind: "decision" | "error";
	timestamp: string;
	model: string;
	question: {
		type: "choice";
		instructions: string;
		criteria: Record<Route, string>;
	};
	state: DecisionInput;
	answer?: DecisionResult;
	error?: string;
	durationMs: number;
};


const ROUTES: Record<Route, string> = {
	clarify: "Ask one focused clarifying question; do not inspect or modify the project yet.",
	inspect: "Inspect relevant files or project state with read-only tools before deciding anything else.",
	change: "Inspect first, then make the requested file changes. Do not run commands until a later decision allows it.",
	run: "Run the requested command, test, or build. Do not modify files in this step.",
	explain: "Answer or explain directly without using project tools or changing files.",
};
const QUESTION = {
	type: "choice" as const,
	instructions: "What should the coding agent do next for this request? Choose exactly one route.",
	criteria: ROUTES,
};

const READ_ONLY_TOOLS: Record<string, true> = { read: true, grep: true, find: true, ls: true };
const WRITE_TOOLS: Record<string, true> = { edit: true, write: true };
const EXECUTION_TOOLS: Record<string, true> = { bash: true, powershell: true };

function envBool(name: string, fallback: boolean): boolean {
	const value = process.env[name];
	if (value === undefined) return fallback;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envNumber(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRoute(value: unknown): value is Route {
	return typeof value === "string" && value in ROUTES;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (!isRecord(block) || typeof block.text !== "string") return "";
			return block.text;
		})
		.filter(Boolean)
		.join("\n");
}

function transcriptForDecision(messages: readonly unknown[]): string {
	const transcript = messages
		.map((message) => {
			if (!isRecord(message)) return "";
			const role = typeof message.role === "string" ? message.role : "message";
			const tool = typeof message.toolName === "string" ? `:${message.toolName}` : "";
			const text = textFromContent(message.content);
			return text ? `[${role}${tool}] ${text}` : `[${role}${tool}]`;
		})
		.filter(Boolean)
		.join("\n");

	// System One rejects requests over 64 KiB. The latest context is the useful part.
	return transcript.length > 14_000 ? transcript.slice(-14_000) : transcript;
}

function addRoutingMessage(messages: AgentMessage[], text: string): AgentMessage[] {
	const userIndex = messages.findLastIndex((message) => message.role === "user");
	if (userIndex < 0) return messages;

	const routingText = `\n\n[System One routing signal — local decision model]\n${text}\nTreat this as routing metadata. Follow the selected next step unless the current tool result makes it impossible; after each tool result, re-evaluate the next step.`;
	return messages.map((message, index) => {
		if (index !== userIndex) return message;
		if (typeof message.content === "string") {
			return { ...message, content: message.content + routingText };
		}
		return {
			...message,
			content: [...message.content, { type: "text", text: routingText }],
		};
	});
}

function numericProbabilities(value: unknown): Record<string, number> | undefined {
	if (!isRecord(value)) return undefined;
	const result: Record<string, number> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (typeof candidate !== "number") return undefined;
		result[key] = candidate;
	}
	return result;
}

type DecisionApiConfig = {
	endpoint: string;
	model: string;
	apiKey?: string;
};

function decisionApiConfig(): DecisionApiConfig {
	const baseUrl = process.env.TYPESAFE_BASE_URL ?? process.env.NIMBLE_URL ?? "http://localhost:11434";
	const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
	const endpoint = normalizedBaseUrl.endsWith("/v1/systemone")
		? normalizedBaseUrl
		: `${normalizedBaseUrl}${normalizedBaseUrl.endsWith("/v1") ? "/systemone" : "/v1/systemone"}`;
	return {
		endpoint,
		model: process.env.TYPESAFE_DEFAULT_MODEL ?? process.env.NIMBLE_MODEL ?? "nimble",
		apiKey: process.env.TYPESAFE_API_KEY ?? process.env.NIMBLE_API_KEY,
	};
}

async function classify(state: unknown, signal: AbortSignal | undefined): Promise<DecisionResult> {
	const config = decisionApiConfig();
	const timeoutMs = envNumber("TYPESAFE_TIMEOUT_MS", envNumber("NIMBLE_TIMEOUT_MS", 30000));
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

	const response = await fetch(config.endpoint, {
		method: "POST",
		headers,
		signal: requestSignal,
		body: JSON.stringify({
			model: config.model,
			state,
			keep_alive: process.env.TYPESAFE_KEEP_ALIVE ?? process.env.NIMBLE_KEEP_ALIVE ?? "5m",
			questions: { next_step: QUESTION },
		}),
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`System One returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}

	const payload: unknown = await response.json();
	const answers = isRecord(payload) ? payload.answers : undefined;
	const answer = isRecord(answers) ? answers.next_step : undefined;
	const route = isRecord(answer) ? answer.choice : undefined;
	if (!isRoute(route)) throw new Error("System One returned an invalid next_step choice");

	const confidence = isRecord(answer) && typeof answer.confidence === "number" ? answer.confidence : undefined;
	const probabilities = isRecord(answer) ? numericProbabilities(answer.probabilities) : undefined;
	return { route, confidence, probabilities };
}

function decisionText(decision: DecisionResult): string {
	const confidence = decision.confidence === undefined ? "" : ` (${decision.confidence.toFixed(3)} confidence)`;
	return `Next route: ${decision.route}${confidence}. ${ROUTES[decision.route]}`;
}

function auditLine(value: unknown): string {
	if (!isRecord(value)) return "invalid audit record";
	const timestamp = typeof value.timestamp === "string" ? value.timestamp : "unknown time";
	const kind = value.kind === "decision" ? "decision" : "error";
	const question = isRecord(value.question) && typeof value.question.instructions === "string"
		? value.question.instructions
		: "unknown question";
	const state = isRecord(value.state) && typeof value.state.conversation === "string"
		? value.state.conversation.replace(/\s+/g, " ").slice(-180)
		: "unknown input";
	const answer = isRecord(value.answer) && typeof value.answer.route === "string"
		? value.answer.route
		: kind === "error"
			? String(value.error ?? "unavailable")
			: "unknown";
	return `${timestamp} | Q: ${question} | Input: ${state} | A: ${answer}`;
}

export default function decisionApi(pi: ExtensionAPI) {
	const required = envBool("NIMBLE_REQUIRED", true);
	const gateTools = envBool("NIMBLE_GATE_TOOLS", true);
	const auditEnabled = envBool("NIMBLE_AUDIT", true);
	const decisionModel = decisionApiConfig().model;
	let enabled = envBool("NIMBLE_ENABLED", true);
	let currentDecision: DecisionResult | undefined;

	const showStats = async (_args: string, ctx: ExtensionCommandContext) => {
		const records = ctx.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === "decision-api",
		);
		const successful = records.filter((entry) => isRecord(entry.data) && entry.data.kind === "decision");
		const failed = records.length - successful.length;
		const recent = records.slice(-10).map((entry) => auditLine(entry.data));
		const summary = [
			`Decision API: ${enabled ? "enabled" : "disabled"}`,
			`Decision API decisions: ${successful.length}`,
			`Decision API failures: ${failed}`,
			recent.length ? "Recent decision records:" : "No decision audit records in this session.",
			...recent,
		].join("\n");
		ctx.ui.notify(summary, failed ? "warning" : "info");
	};
	const showHelp = async (_args: string, ctx: ExtensionCommandContext) => {
		ctx.ui.notify(
			[
				"Decision API: local Ollama setup",
				"1. Start Ollama if needed: ollama serve",
				"2. Download the model: ollama pull nimble",
				"3. export TYPESAFE_BASE_URL=http://localhost:11434",
				"4. export TYPESAFE_API_KEY=ollama; export TYPESAFE_DEFAULT_MODEL=nimble",
				"5. Restart Pi/OMP, then /decision-api enable or /decision-api stats",
			].join("\n"),
			"info",
		);
	};


	const setEnabled = (value: boolean, ctx: ExtensionCommandContext) => {
		enabled = value;
		currentDecision = undefined;
		pi.appendEntry("decision-api-state", { enabled });
		ctx.ui.setStatus("decision-api", `Decision API ${enabled ? "enabled" : "disabled"}`);
		ctx.ui.notify(`Decision API ${enabled ? "enabled" : "disabled"}.`, "info");
	};

	const handleDecisionCommand = async (args: string, ctx: ExtensionCommandContext) => {
		const action = args.trim().toLowerCase();
		if (action === "enable" || action === "on") {
			setEnabled(true, ctx);
			return;
		}
		if (action === "disable" || action === "off") {
			setEnabled(false, ctx);
			return;
		}
		if (action === "stats" || action === "") {
			await showStats(action, ctx);
			return;
		}
		if (action === "help") {
			await showHelp(action, ctx);
			return;
		}
		ctx.ui.notify("Usage: /decision-api enable|disable|stats|help", "warning");
	};

	pi.registerCommand("decision-api", {
		description: "Enable, disable, or inspect the decision API",
		handler: handleDecisionCommand,
	});

	pi.on("session_start", (_event, ctx) => {
		for (const entry of [...ctx.sessionManager.getEntries()].reverse()) {
			if (entry.type !== "custom" || entry.customType !== "decision-api-state" || !isRecord(entry.data)) continue;
			if (typeof entry.data.enabled === "boolean") {
				enabled = entry.data.enabled;
				break;
			}
		}
		ctx.ui.setStatus("decision-api", `Decision API ${enabled ? "enabled" : "disabled"}`);
	});

	// `context` runs immediately before every LLM call, including calls after tools.
	pi.on("context", async (event, ctx) => {
		if (!enabled) {
			currentDecision = undefined;
			ctx.ui.setStatus("decision-api", "Decision API disabled");
			return;
		}
		const startedAt = Date.now();
		const state: DecisionInput = {
			cwd: ctx.cwd,
			conversation: transcriptForDecision(event.messages),
		};
		try {
			currentDecision = await classify(state, ctx.signal);
			if (auditEnabled) {
				pi.appendEntry("decision-api", {
					kind: "decision",
					timestamp: new Date().toISOString(),
					model: decisionModel,
					question: QUESTION,
					state,
					answer: currentDecision,
					durationMs: Date.now() - startedAt,
				} satisfies DecisionAudit);
			}
			ctx.ui.setStatus("decision-api", `Decision API: ${decisionModel} — ${decisionText(currentDecision)}`);
			return { messages: addRoutingMessage(event.messages, decisionText(currentDecision)) };
		} catch (error) {
			currentDecision = undefined;
			const reason = error instanceof Error ? error.message : String(error);
			if (auditEnabled) {
				pi.appendEntry("decision-api", {
					kind: "error",
					timestamp: new Date().toISOString(),
					model: decisionModel,
					question: QUESTION,
					state,
					error: reason,
					durationMs: Date.now() - startedAt,
				} satisfies DecisionAudit);
			}
			ctx.ui.setStatus("decision-api", `Decision API unavailable: ${reason}`);
			const fallback =
				"System One could not classify this step. Do not use tools or change files until the decision API is available; tell the user to start the configured decision service.";
			if (required) return { messages: addRoutingMessage(event.messages, fallback) };
			return { messages: addRoutingMessage(event.messages, `Decision API unavailable; proceed cautiously. ${fallback}`) };
		}
	});

	// The classifier is advisory for the LLM but fail-safe for actual side effects.
	if (gateTools) {
		pi.on("tool_call", async (event) => {
			if (!enabled) return;
			if (!currentDecision) {
				return required
					? { block: true, reason: "The decision API has not approved a route for this tool call." }
					: undefined;
			}

			const { route } = currentDecision;
			if (route === "clarify" || route === "explain") {
				return { block: true, reason: `Decision API route is ${route}; no project tool is allowed for this step.` };
			}
			if (route === "inspect" && !READ_ONLY_TOOLS[event.toolName]) {
				return { block: true, reason: "Decision API route is inspect; only read-only project tools are allowed." };
			}
			if (route === "change" && EXECUTION_TOOLS[event.toolName]) {
				return { block: true, reason: "Decision API route is change; run commands only after a later decision." };
			}
			if (route === "run" && WRITE_TOOLS[event.toolName]) {
				return { block: true, reason: "Decision API route is run; file changes are not allowed for this step." };
			}
		});
	}
}
