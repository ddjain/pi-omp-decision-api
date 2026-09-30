import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

// Pure advisory routing: ask a local decision model what to do next and how
// risky it looks, and surface that as a note in context when it's actually
// actionable. It never blocks, gates, or delays a tool call — the active
// model always decides for itself.
const EXTENSION_VERSION = "0.6.0";
const EXTENSION_LAST_UPDATED = "2026-09-30";

type Route = "clarify" | "inspect" | "change" | "run" | "explain" | "unknown";

type DecisionResult = {
	route: Route;
	risk: number;
	confidence?: number;
	reason?: string;
};

type DecisionInput = {
	request: string;
	context: string;
	lastTool?: { name: string; result: string };
};

type DecisionAudit = {
	kind: "decision" | "error";
	timestamp: string;
	model: string;
	request: string;
	context: string;
	lastTool?: { name: string; result: string };
	answer?: DecisionResult;
	injected?: boolean;
	error?: string;
	durationMs: number;
	cacheHit?: boolean;
};

const ROUTES: Record<Route, string> = {
	clarify: "Ask one focused clarifying question before doing anything else.",
	inspect: "Inspect relevant files or project state with read-only tools first.",
	change: "Make the requested file changes.",
	run: "Run the requested command, test, or build.",
	explain: "Answer or explain directly without using project tools.",
	unknown: "The request is unclear; consider asking for clarification.",
};

const REASON_TAGS: Record<string, string> = {
	remote_or_infra: "Touches a remote host, credentials, or infrastructure.",
	broad_scope: "Affects a broad or unclear set of files.",
	ambiguous_request: "The request is ambiguous or underspecified.",
	risky_history: "A recent tool result suggests something already went wrong.",
	none: "No specific concern.",
};

const DECISION_QUESTIONS = {
	route: {
		type: "choice" as const,
		instructions: "What should the coding agent do next?",
		criteria: ROUTES,
	},
	risk: {
		type: "score" as const,
		instructions: "How risky is the next action?",
		criteria: [
			"Informational only; no project tool.",
			"Read-only inspection; no side effect.",
			"Local reversible file change.",
			"Command execution or broad modification.",
			"Destructive, remote, credential, or infrastructure action.",
		],
	},
	reason: {
		type: "choice" as const,
		instructions: "If risk is elevated, why? Choose 'none' if there is no specific concern.",
		criteria: REASON_TAGS,
	},
};

// After this many consecutive failures, stop calling Nimble until the
// cool-down window elapses, so a downed Ollama server doesn't cost a full
// timeout on every single turn.
const BACKOFF_THRESHOLD = 3;
const BACKOFF_COOLDOWN_MS = 60_000;

// Short-lived cache so several tool calls in a row for the same request
// don't each trigger a fresh classification.
const CACHE_TTL_MS = 15_000;
const CACHE_MAX_ENTRIES = 20;

// Only worth interrupting the transcript with a note when the model chose
// something ambiguous, or when risk crosses into "broad/destructive" territory.
const NOTEWORTHY_RISK_THRESHOLD = 3;

// Nimble's context window is ~8194 tokens for the whole prompt, including the
// serialized question schema (typically several hundred tokens on its own).
// Keep these conservative — dense text like code, logs, or file paths can run
// well under 4 chars/token, so budgeting near the raw token ceiling in chars
// still overflows on real tool output.
const MAX_REQUEST_CHARS = 1_500;
const MAX_CONTEXT_CHARS = 3_000;
const MAX_LAST_TOOL_RESULT_CHARS = 800;

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
		.map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
		.filter(Boolean)
		.join("\n");
}

function truncate(value: string, maxChars: number): string {
	return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated]`;
}

function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	return textFromContent(message.content).replace(/\n\n\[System One routing signal[\s\S]*$/, "");
}

function compactDecisionState(messages: readonly unknown[]): DecisionInput {
	const requestMessage = [...messages].reverse().find((m) => isRecord(m) && m.role === "user");
	const request = truncate(messageText(requestMessage), MAX_REQUEST_CHARS);
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
	const lastToolMessage = [...messages].reverse().find(
		(message) => isRecord(message) && (message.role === "tool" || typeof message.toolName === "string"),
	);
	const lastTool = lastToolMessage && isRecord(lastToolMessage)
		? {
			name: typeof lastToolMessage.toolName === "string" ? lastToolMessage.toolName : "tool",
			result: truncate(messageText(lastToolMessage), MAX_LAST_TOOL_RESULT_CHARS),
		}
		: undefined;
	return { request, context: truncate(recent, MAX_CONTEXT_CHARS), ...(lastTool ? { lastTool } : {}) };
}

function addRoutingMessage(messages: AgentMessage[], text: string): AgentMessage[] {
	const userIndex = messages.findLastIndex((message) => message.role === "user");
	if (userIndex < 0) return messages;

	const routingText = `\n\n[System One routing signal — local decision model, advisory only]\n${text}`;
	return messages.map((message, index) => {
		if (index !== userIndex) return message;
		if (typeof message.content === "string") return { ...message, content: message.content + routingText };
		return { ...message, content: [...message.content, { type: "text", text: routingText }] };
	});
}

function redactText(value: string): string {
	return value
		.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[redacted]")
		.replace(/((?:api[_-]?key|token|secret|password|passwd|private[_-]?key)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
		.replace(/(-----BEGIN [^-]+-----)[\s\S]*?(-----END [^-]+-----)/g, "$1[redacted]$2");
}

function redactState(state: DecisionInput): { request: string; context: string; lastTool?: { name: string; result: string } } {
	return {
		request: redactText(state.request),
		context: redactText(state.context),
		...(state.lastTool ? { lastTool: { name: state.lastTool.name, result: redactText(state.lastTool.result) } } : {}),
	};
}

type DecisionApiConfig = { endpoint: string; model: string; apiKey?: string };

function decisionApiConfig(): DecisionApiConfig {
	const baseUrl = (process.env.TYPESAFE_BASE_URL ?? process.env.NIMBLE_URL ?? "http://localhost:11434").replace(/\/+$/, "");
	const endpoint = baseUrl.endsWith("/v1/systemone") ? baseUrl : `${baseUrl}${baseUrl.endsWith("/v1") ? "/systemone" : "/v1/systemone"}`;
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
		body: JSON.stringify({ model: config.model, state, questions: DECISION_QUESTIONS }),
	});
	if (!response.ok) {
		const detail = (await response.text()).slice(0, 300);
		throw new Error(`System One returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
	}

	const payload: unknown = await response.json();
	const answers = isRecord(payload) && isRecord(payload.answers) ? payload.answers : undefined;
	const routeAnswer = answers && isRecord(answers.route) ? answers.route : undefined;
	const riskAnswer = answers && isRecord(answers.risk) ? answers.risk : undefined;
	const reasonAnswer = answers && isRecord(answers.reason) ? answers.reason : undefined;
	const route = routeAnswer?.choice;
	if (!isRoute(route)) throw new Error("System One returned an invalid route choice");
	const reasonTag = typeof reasonAnswer?.choice === "string" ? reasonAnswer.choice : undefined;
	const reason = reasonTag && reasonTag !== "none" ? REASON_TAGS[reasonTag] : undefined;
	return {
		route,
		risk: typeof riskAnswer?.score === "number" ? Math.max(0, Math.min(4, riskAnswer.score)) : 4,
		confidence: typeof routeAnswer?.confidence === "number" ? routeAnswer.confidence : undefined,
		...(reason ? { reason } : {}),
	};
}

// Full-length text for the note injected into context, where wrapping is fine.
function decisionText(decision: DecisionResult): string {
	const confidence = decision.confidence === undefined ? "" : ` (${decision.confidence.toFixed(2)} confidence)`;
	const reason = decision.reason ? ` Why: ${decision.reason}` : "";
	return `Suggested next step: ${decision.route}${confidence}; risk ${decision.risk.toFixed(1)}/4. ${ROUTES[decision.route]}${reason} This is advisory only — use your own judgment.`;
}

// One-line text for the status bar, which truncates with "…" past a small
// character budget. Keep this short enough to always fit: route, risk, and a
// terse reason if there is one — no restated route description, confidence,
// or disclaimer (those only matter in the full injected note, if any).
const STATUS_TEXT_MAX_CHARS = 70;
function statusText(decision: DecisionResult): string {
	const reason = decision.reason ? ` — ${decision.reason}` : "";
	const text = `${decision.route}, risk ${decision.risk.toFixed(1)}/4${reason}`;
	return text.length <= STATUS_TEXT_MAX_CHARS ? text : `${text.slice(0, STATUS_TEXT_MAX_CHARS - 1)}…`;
}

function isNoteworthy(decision: DecisionResult): boolean {
	return decision.risk >= NOTEWORTHY_RISK_THRESHOLD || decision.route === "clarify" || decision.route === "unknown";
}

function cacheKeyFor(state: DecisionInput): string {
	return `${state.request}\u0000${state.lastTool?.name ?? ""}`;
}

export default function decisionApi(pi: ExtensionAPI) {
	const auditEnabled = envBool("NIMBLE_AUDIT", true);
	const decisionModel = decisionApiConfig().model;
	let enabled = envBool("NIMBLE_ENABLED", true);
	let consecutiveFailures = 0;
	let backoffUntil = 0;
	const cache = new Map<string, { decision: DecisionResult; createdAt: number }>();

	const showHelp = async (_args: string, ctx: ExtensionCommandContext) => {
		ctx.ui.notify(
			[
				`Decision API v${EXTENSION_VERSION} (last updated ${EXTENSION_LAST_UPDATED})`,
				"Pure advisory routing — never blocks a tool call.",
				"1. Start Ollama if needed: ollama serve",
				"2. Download the model: ollama pull nimble",
				"3. export TYPESAFE_BASE_URL=http://localhost:11434",
				"4. export TYPESAFE_API_KEY=ollama; export TYPESAFE_DEFAULT_MODEL=nimble",
				"5. Restart Pi/OMP, then /decision-api enable or /decision-api stats",
				"Notes only appear in context when risk is high or the route is clarify/unknown.",
				"Use /decision-api log [n] to see the actual (redacted) request/context sent and the raw decision received.",
			].join("\n"),
			"info",
		);
	};

	const showStats = async (_args: string, ctx: ExtensionCommandContext) => {
		const records = ctx.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === "decision-api",
		);
		const data = records.map((entry) => entry.data).filter(isRecord);
		const successful = data.filter((entry) => entry.kind === "decision");
		const failed = data.filter((entry) => entry.kind === "error");
		const cached = successful.filter((entry) => entry.cacheHit === true);
		const injected = successful.filter((entry) => entry.injected === true);
		const routes = successful.reduce<Record<string, number>>((counts, entry) => {
			const answer = isRecord(entry.answer) ? entry.answer : undefined;
			const route = answer && typeof answer.route === "string" ? answer.route : "unknown";
			counts[route] = (counts[route] ?? 0) + 1;
			return counts;
		}, {});
		const riskBuckets = successful.reduce<Record<number, number>>((counts, entry) => {
			const answer = isRecord(entry.answer) ? entry.answer : undefined;
			const risk = answer && typeof answer.risk === "number" ? Math.round(answer.risk) : undefined;
			if (risk === undefined) return counts;
			counts[risk] = (counts[risk] ?? 0) + 1;
			return counts;
		}, {});
		ctx.ui.notify(
			[
				`Decision API v${EXTENSION_VERSION}: ${enabled ? "enabled" : "disabled"}`,
				`Decisions: ${successful.length} (${cached.length} cache hits), failures: ${failed.length}`,
				`Notes injected into context: ${injected.length}/${successful.length}`,
				`Routes: ${Object.entries(routes).map(([route, count]) => `${route}=${count}`).join(", ") || "none"}`,
				`Risk histogram: ${[0, 1, 2, 3, 4].map((r) => `${r}=${riskBuckets[r] ?? 0}`).join(", ")}`,
				backoffUntil > Date.now() ? `Backing off until ${new Date(backoffUntil).toLocaleTimeString()} after ${consecutiveFailures} consecutive failures.` : "",
			].filter(Boolean).join("\n"),
			failed.length ? "warning" : "info",
		);
	};

	const DEFAULT_LOG_ENTRIES = 3;
	const MAX_LOG_ENTRIES = 10;
	const LOG_FIELD_MAX_CHARS = 400;

	const showLog = async (args: string, ctx: ExtensionCommandContext) => {
		const requested = Number.parseInt(args.trim(), 10);
		const count = Number.isFinite(requested) && requested > 0
			? Math.min(requested, MAX_LOG_ENTRIES)
			: DEFAULT_LOG_ENTRIES;

		const records = ctx.sessionManager.getEntries().filter(
			(entry) => entry.type === "custom" && entry.customType === "decision-api",
		);
		const data = records.map((entry) => entry.data).filter(isRecord).slice(-count);
		if (data.length === 0) {
			ctx.ui.notify("No decision-api audit entries in this session yet.", "info");
			return;
		}

		const clip = (value: string) => truncate(value, LOG_FIELD_MAX_CHARS);
		const blocks = data.map((entry, index) => {
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "unknown time";
			const request = typeof entry.request === "string" ? entry.request : "";
			const context = typeof entry.context === "string" ? entry.context : "";
			const lastTool = isRecord(entry.lastTool) ? entry.lastTool : undefined;
			const lines = [
				`#${index + 1} ${timestamp} (${entry.kind === "error" ? "error" : "decision"})`,
				`  sent request: ${clip(request) || "(empty)"}`,
				`  sent context: ${clip(context) || "(none)"}`,
			];
			if (lastTool) {
				lines.push(`  sent last tool: ${lastTool.name} → ${clip(typeof lastTool.result === "string" ? lastTool.result : "")}`);
			}
			if (entry.kind === "error") {
				lines.push(`  error: ${String(entry.error ?? "unknown")}`);
			} else if (isRecord(entry.answer)) {
				const answer = entry.answer;
				const reason = typeof answer.reason === "string" ? `, reason: ${answer.reason}` : "";
				const confidence = typeof answer.confidence === "number" ? `, confidence ${answer.confidence.toFixed(2)}` : "";
				lines.push(`  received: route ${String(answer.route)}, risk ${String(answer.risk)}${confidence}${reason}`);
				lines.push(`  injected into context: ${entry.injected === true ? "yes" : "no"}; cache hit: ${entry.cacheHit === true ? "yes" : "no"}`);
			}
			return lines.join("\n");
		});
		ctx.ui.notify(`Last ${data.length} decision-api call(s) (requests/context are redacted):\n\n${blocks.join("\n\n")}`, "info");
	};

	const setEnabled = (value: boolean, ctx: ExtensionCommandContext) => {
		enabled = value;
		consecutiveFailures = 0;
		backoffUntil = 0;
		pi.appendEntry("decision-api-state", { enabled });
		ctx.ui.setStatus("decision-api", `Decision API ${enabled ? "enabled" : "disabled"}`);
		ctx.ui.notify(`Decision API ${enabled ? "enabled" : "disabled"}.`, "info");
	};

	pi.registerCommand("decision-api", {
		description: "Enable, disable, or inspect the decision API",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const action = (spaceIndex < 0 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
			const rest = spaceIndex < 0 ? "" : trimmed.slice(spaceIndex + 1);
			if (action === "enable" || action === "on") return setEnabled(true, ctx);
			if (action === "disable" || action === "off") return setEnabled(false, ctx);
			if (action === "stats" || action === "") return showStats(action, ctx);
			if (action === "help") return showHelp(action, ctx);
			if (action === "log") return showLog(rest, ctx);
			ctx.ui.notify(`Usage: /decision-api enable|disable|stats|help|log [n] (n defaults to ${DEFAULT_LOG_ENTRIES}, max ${MAX_LOG_ENTRIES})`, "warning");
		},
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

	// Runs before every LLM call. Best-effort: on any failure it just skips
	// the advisory note and lets the turn proceed normally.
	pi.on("context", async (event, ctx) => {
		if (!enabled) return;
		if (backoffUntil > Date.now()) return;

		const state = compactDecisionState(event.messages);
		if (!state.request) return;

		const cacheKey = cacheKeyFor(state);
		const cached = cache.get(cacheKey);
		const cacheHit = Boolean(cached && Date.now() - cached.createdAt < CACHE_TTL_MS);

		const startedAt = Date.now();
		try {
			const decision = cacheHit ? cached!.decision : await classify(state, ctx.signal);
			consecutiveFailures = 0;
			backoffUntil = 0;
			if (!cacheHit) {
				cache.set(cacheKey, { decision, createdAt: Date.now() });
				while (cache.size > CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
			}

			const noteworthy = isNoteworthy(decision);
			if (auditEnabled) {
				pi.appendEntry("decision-api", {
					kind: "decision",
					timestamp: new Date().toISOString(),
					model: decisionModel,
					...redactState(state),
					answer: decision,
					injected: noteworthy,
					durationMs: cacheHit ? 0 : Date.now() - startedAt,
					cacheHit,
				} satisfies DecisionAudit);
			}
			ctx.ui.setStatus("decision-api", `Decision API: ${decisionModel} — ${statusText(decision)}`);
			if (!noteworthy) return;
			return { messages: addRoutingMessage(event.messages, decisionText(decision)) };
		} catch (error) {
			consecutiveFailures += 1;
			if (consecutiveFailures >= BACKOFF_THRESHOLD) backoffUntil = Date.now() + BACKOFF_COOLDOWN_MS;
			const reason = error instanceof Error ? error.message : String(error);
			if (auditEnabled) {
				pi.appendEntry("decision-api", {
					kind: "error",
					timestamp: new Date().toISOString(),
					model: decisionModel,
					...redactState(state),
					error: reason,
					durationMs: Date.now() - startedAt,
				} satisfies DecisionAudit);
			}
			ctx.ui.setStatus(
				"decision-api",
				backoffUntil > Date.now()
					? `Decision API unavailable (${consecutiveFailures}x): ${reason}. Backing off ~${Math.ceil((backoffUntil - Date.now()) / 1000)}s.`
					: `Decision API unavailable: ${reason}`,
			);
			return;
		}
	});
}
