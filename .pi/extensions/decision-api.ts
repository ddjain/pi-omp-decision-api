import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

type Route = "clarify" | "inspect" | "change" | "run" | "explain" | "unknown";
type ToolClass = "none" | "read_only" | "write" | "execution" | "remote";
type Policy = "allow" | "inspect_only" | "confirm" | "block";

type DecisionResult = {
	route: Route;
	risk: number;
	sufficientContext: boolean;
	needsConfirmation: boolean;
	toolClass: ToolClass;
	policy: Policy;
	confidence?: number;
	probabilities?: Record<string, number>;
};
type DecisionInput = {
	cwd: string;
	request: string;
	context: string;
	lastTool?: {
		name: string;
		result: string;
	};
};

type DecisionAudit = {
	kind: "decision" | "error";
	timestamp: string;
	model: string;
	question: unknown;
	state: DecisionInput;
	answer?: DecisionResult;
	error?: string;
	durationMs: number;
	cacheHit?: boolean;
	escalated?: boolean;
};

const ROUTES: Record<Route, string> = {
	clarify: "Ask one focused clarifying question; do not inspect or modify the project yet.",
	inspect: "Inspect relevant files or project state with read-only tools before deciding anything else.",
	change: "Inspect first, then make the requested file changes. Do not run commands until a later decision allows it.",
	run: "Run the requested command, test, or build. Do not modify files in this step.",
	explain: "Answer or explain directly without using project tools or changing files.",
	unknown: "The request does not fit safely; ask for clarification instead of guessing.",
};
const TOOL_CLASSES: Record<ToolClass, string> = {
	none: "No project tool is needed.",
	read_only: "Only read-only inspection tools are needed.",
	write: "A file-writing or file-editing tool may be needed.",
	execution: "A local command or test tool may be needed.",
	remote: "A remote, infrastructure, credential, or potentially destructive tool may be needed.",
};
const ROUTE_QUESTION = {
	type: "choice" as const,
	instructions: "What should the coding agent do next? Choose the safest valid route. Use unknown when context is insufficient.",
	criteria: ROUTES,
};
const RISK_QUESTION = {
	type: "score" as const,
	instructions: "How risky is the next action? Use the lowest level that accurately describes the possible side effect.",
	criteria: [
		"Informational only; no project tool.",
		"Read-only inspection; no side effect.",
		"Local reversible file change.",
		"Command execution or broad modification.",
		"Destructive, remote, credential, or infrastructure action.",
	],
};
const SUFFICIENT_CONTEXT_QUESTION = {
	type: "noul" as const,
	instructions: "Is there enough information in the state to choose a safe next step without guessing?",
};
const CONFIRMATION_QUESTION = {
	type: "noul" as const,
	instructions: "Would the next action require explicit user confirmation before execution?",
};
const TOOL_CLASS_QUESTION = {
	type: "choice" as const,
	instructions: "Which class of project tool, if any, would the next step need?",
	criteria: TOOL_CLASSES,
};

const DECISION_QUESTIONS = {
	route: ROUTE_QUESTION,
	risk: RISK_QUESTION,
	sufficient_context: SUFFICIENT_CONTEXT_QUESTION,
	needs_confirmation: CONFIRMATION_QUESTION,
	tool_class: TOOL_CLASS_QUESTION,
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

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, Math.floor(maxChars * 0.35))}\n...[truncated]...\n${value.slice(-Math.floor(maxChars * 0.65))}`;
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	return textFromContent(message.content).replace(/\n\n\[System One routing signal[\s\S]*$/, "");
}

function compactDecisionState(messages: readonly unknown[], cwd: string): DecisionInput {
	const requestMessage = [...messages].reverse().find(
		(message) => isRecord(message) && message.role === "user" && messageText(message),
	);
	const request = truncate(messageText(requestMessage), 8_000);
	const recent = messages
		.slice(-8)
		.map((message) => {
			if (!isRecord(message)) return "";
			const role = typeof message.role === "string" ? message.role : "message";
			const tool = typeof message.toolName === "string" ? `:${message.toolName}` : "";
			const text = messageText(message);
			return text ? `[${role}${tool}] ${text}` : `[${role}${tool}]`;
		})
		.filter(Boolean)
		.join("\n");
	const maxContext = envNumber("TYPESAFE_MAX_CONTEXT_CHARS", 20_000);
	const lastToolMessage = [...messages].reverse().find(
		(message) => isRecord(message) && (message.role === "tool" || typeof message.toolName === "string"),
	);
	const lastTool = lastToolMessage && isRecord(lastToolMessage)
		? {
			name: typeof lastToolMessage.toolName === "string" ? lastToolMessage.toolName : "tool",
			result: truncate(messageText(lastToolMessage), 8_000),
		}
		: undefined;
	return {
		cwd,
		request,
		context: truncate(recent, maxContext),
		...(lastTool ? { lastTool } : {}),
	};
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

async function classify(state: DecisionInput, signal: AbortSignal | undefined): Promise<DecisionResult> {
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
			questions: DECISION_QUESTIONS,
		}),
	});

	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`System One returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}

	const payload: unknown = await response.json();
	const answers = isRecord(payload) && isRecord(payload.answers) ? payload.answers : undefined;
	const readAnswer = (name: string): Record<string, unknown> | undefined => {
		const answer = answers?.[name];
		return isRecord(answer) ? answer : undefined;
	};
	const routeAnswer = readAnswer("route");
	const route = routeAnswer?.choice;
	if (!isRoute(route)) throw new Error("System One returned an invalid route choice");
	const riskAnswer = readAnswer("risk");
	const sufficientAnswer = readAnswer("sufficient_context");
	const confirmationAnswer = readAnswer("needs_confirmation");
	const toolClassAnswer = readAnswer("tool_class");
	const risk = typeof riskAnswer?.score === "number" ? Math.max(0, Math.min(4, riskAnswer.score)) : 4;
	const sufficientContext = typeof sufficientAnswer?.noul === "number" && sufficientAnswer.noul >= 0.5;
	const needsConfirmation = typeof confirmationAnswer?.noul === "number"
		? confirmationAnswer.noul >= 0.5
		: true;
	const toolClass = typeof toolClassAnswer?.choice === "string" && toolClassAnswer.choice in TOOL_CLASSES
		? toolClassAnswer.choice as ToolClass
		: "remote";
	const decision: DecisionResult = {
		route,
		risk,
		sufficientContext,
		needsConfirmation,
		toolClass,
		policy: "block",
		confidence: typeof routeAnswer?.confidence === "number" ? routeAnswer.confidence : undefined,
		probabilities: numericProbabilities(routeAnswer?.probabilities),
	};
	decision.policy = policyForDecision(decision);
	return decision;
}

function policyForDecision(decision: DecisionResult): Policy {
	const minConfidence = Number(process.env.TYPESAFE_MIN_CONFIDENCE ?? "0.55");
	const probabilities = Object.values(decision.probabilities ?? {}).sort((a, b) => b - a);
	const margin = probabilities.length > 1 ? probabilities[0] - probabilities[1] : 1;
	if (!decision.sufficientContext || decision.route === "unknown" || decision.route === "clarify") return "block";
	if (decision.needsConfirmation || decision.risk >= 4) return "confirm";
	if ((decision.route === "change" || decision.route === "run")
		&& ((decision.confidence ?? 0) < minConfidence || margin < 0.15)) return "inspect_only";
	if (decision.route === "explain") return "allow";
	if (decision.route === "inspect" || decision.risk >= 3) return "inspect_only";
	return "allow";
}

function decisionText(decision: DecisionResult): string {
	const confidence = decision.confidence === undefined ? "" : ` (${decision.confidence.toFixed(3)} confidence)`;
	return `Next route: ${decision.route}${confidence}; risk ${decision.risk.toFixed(1)}; policy ${decision.policy}. ${ROUTES[decision.route]}`;
}

function redactText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
		.replace(/((?:api[_-]?key|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
		.replace(/(-----BEGIN [^-]+-----)[\s\S]*?(-----END [^-]+-----)/g, "$1[redacted]$2");
}

function auditState(state: DecisionInput): DecisionInput {
	return {
		cwd: state.cwd,
		request: redactText(state.request),
		context: redactText(state.context),
		...(state.lastTool
			? { lastTool: { name: state.lastTool.name, result: redactText(state.lastTool.result) } }
			: {}),
	};
}

function auditLine(value: unknown): string {
	if (!isRecord(value)) return "invalid audit record";
	const timestamp = typeof value.timestamp === "string" ? value.timestamp : "unknown time";
	const kind = value.kind === "decision" ? "decision" : "error";
	const state = isRecord(value.state) && typeof value.state.request === "string"
		? redactText(value.state.request).replace(/\s+/g, " ").slice(-180)
		: "unknown input";
	const answer = isRecord(value.answer) && typeof value.answer.route === "string"
		? `${value.answer.route}/${String(value.answer.policy ?? "unknown")}`
		: kind === "error"
			? String(value.error ?? "unavailable")
			: "unknown";
	const cache = value.cacheHit === true ? " cache" : "";
	return `${timestamp} | ${state} | ${answer}${cache}`;
}

export default function decisionApi(pi: ExtensionAPI) {
	const required = envBool("NIMBLE_REQUIRED", true);
	const gateTools = envBool("NIMBLE_GATE_TOOLS", true);
	const auditEnabled = envBool("NIMBLE_AUDIT", true);
	const decisionModel = decisionApiConfig().model;
	let enabled = envBool("NIMBLE_ENABLED", true);
	let currentDecision: DecisionResult | undefined;
	const cacheEnabled = envBool("TYPESAFE_DECISION_CACHE", true);
	const cacheTtlMs = envNumber("TYPESAFE_DECISION_CACHE_TTL_MS", 60_000);
	const cacheMaxEntries = Math.floor(envNumber("TYPESAFE_DECISION_CACHE_MAX_ENTRIES", 100));
	const decisionCache = new Map<string, { decision: DecisionResult; createdAt: number }>();

	const showStats = async (_args: string, ctx: ExtensionCommandContext) => {
		const records = ctx.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === "decision-api",
		);
		const data = records.map((entry) => entry.data).filter(isRecord);
		const successful = data.filter((entry) => entry.kind === "decision");
		const failed = data.filter((entry) => entry.kind === "error");
		const cached = successful.filter((entry) => entry.cacheHit === true);
		const durations = successful
			.map((entry) => typeof entry.durationMs === "number" ? entry.durationMs : undefined)
			.filter((duration): duration is number => duration !== undefined)
			.sort((a, b) => a - b);
		const routes = successful.reduce<Record<string, number>>((counts, entry) => {
			const answer = isRecord(entry.answer);
			const route = answer && typeof answer.route === "string" ? answer.route : "unknown";
			counts[route] = (counts[route] ?? 0) + 1;
			return counts;
		}, {});
		const averageMs = durations.length
			? Math.round(durations.reduce((sum, duration) => sum + duration, 0) / durations.length)
			: 0;
		const p95Ms = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : 0;
		const recent = data.slice(-10).map(auditLine);
		const summary = [
			`Decision API: ${enabled ? "enabled" : "disabled"}`,
			`Decisions: ${successful.length} (${cached.length} cache hits)`,
			`Failures: ${failed.length}`,
			`Latency: average ${averageMs}ms, p95 ${p95Ms}ms`,
			`Routes: ${Object.entries(routes).map(([route, count]) => `${route}=${count}`).join(", ") || "none"}`,
			recent.length ? "Recent decision records:" : "No decision audit records in this session.",
			...recent,
		].join("\n");
		ctx.ui.notify(summary, failed.length ? "warning" : "info");
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
		const state = compactDecisionState(event.messages, ctx.cwd);
		const cacheKey = JSON.stringify(state);
		try {
			const cached = cacheEnabled ? decisionCache.get(cacheKey) : undefined;
			const cacheValid = cached && Date.now() - cached.createdAt < cacheTtlMs;
			const cacheHit = Boolean(cacheValid);
			if (cacheHit) {
				currentDecision = cached!.decision;
			} else {
				currentDecision = await classify(state, ctx.signal);
				if (cacheEnabled) {
					decisionCache.set(cacheKey, { decision: currentDecision, createdAt: Date.now() });
					while (decisionCache.size > cacheMaxEntries) {
						decisionCache.delete(decisionCache.keys().next().value as string);
					}
				}
			}
			if (auditEnabled) {
				pi.appendEntry("decision-api", {
					kind: "decision",
					timestamp: new Date().toISOString(),
					model: decisionModel,
					question: DECISION_QUESTIONS,
					state: auditState(state),
					answer: currentDecision,
					durationMs: cacheHit ? 0 : Date.now() - startedAt,
					cacheHit,
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
					question: DECISION_QUESTIONS,
					state: auditState(state),
					error: reason,
					durationMs: Date.now() - startedAt,
				} satisfies DecisionAudit);
			}
			ctx.ui.setStatus("decision-api", `Decision API unavailable: ${reason}`);
			const fallback =
				`Decision API failed: ${reason}. Do not use project tools until the configured decision service is available.`;
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

			const { route, policy } = currentDecision;
			if (policy === "block" || route === "clarify" || route === "explain" || route === "unknown") {
				return { block: true, reason: `Decision API policy is ${policy}; no project tool is allowed for route ${route}.` };
			}
			if (policy === "confirm") {
				return { block: true, reason: "Decision API requires explicit user confirmation before this action." };
			}
			if (policy === "inspect_only" && !READ_ONLY_TOOLS[event.toolName]) {
				return { block: true, reason: "Decision API permits read-only inspection only for this step." };
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
