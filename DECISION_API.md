# Decision API routing for Pi and OMP

This project includes a shared decision API implementation:

- `.pi/extensions/decision-api.ts` for Pi
- `.omp/extensions/decision-api.ts` for OMP, which reuses the Pi implementation

Both agents share the same routing behavior, tool gate, audit records, and environment variables.

## Pi

Pi auto-loads `.pi/extensions/decision-api.ts` when started in this project.

## OMP

OMP auto-loads `.omp/extensions/decision-api.ts` when started in this project.

```bash
omp
```

To load it explicitly:

```bash
omp --extension ./.omp/extensions/decision-api.ts
```

The OMP entrypoint is intentionally a small re-export. Keep behavior changes in `.pi/extensions/decision-api.ts` so both agents remain identical.

## Setup

Requires Ollama `0.35.0` or newer. System One is local-only.

```bash
ollama pull nimble
pi   # or: omp
```

The extension calls the configured TypeSafe/Jev-compatible `POST /v1/systemone` endpoint before meaningful Pi or OMP LLM context changes, including calls after a tool result. It sends a compact state and evaluates these typed questions together:

- `route` — `clarify`, `inspect`, `change`, `run`, `explain`, or `unknown`
- `risk` — score from informational-only to destructive/remote/infrastructure action
- `sufficient_context` — whether the state contains enough information to act safely
- `needs_confirmation` — whether explicit user confirmation is required
- `tool_class` — no tool, read-only, write, execution, or remote

The policy engine combines those answers with confidence and probability margin. Low-confidence changes/runs are downgraded to inspection. Unknown, insufficient-context, confirmation-required, and high-risk decisions block project tools. Unchanged compact states are served from an in-memory cache.

The decision model is a typed classifier, not a planner or a replacement for the main coding model. Its result is a routing signal; deterministic policy code remains the final authority for tool permissions, and the main model still performs the work.

## Current phase

This phase implements compact state, batched typed questions, in-memory caching, confidence/margin safeguards, deterministic tool policy, and expanded session statistics. Stronger-model escalation, a dedicated confirmation UI, and a persistent cross-session cache are intentionally not enabled yet; those are the next phase.

## Configuration

Environment variables are optional. The preferred TypeSafe/Jev-compatible configuration is:

```bash
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=nimble
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_BASE_URL` | `http://localhost:11434` | System One service base URL |
| `TYPESAFE_API_KEY` | unset | Optional Bearer token |
| `TYPESAFE_DEFAULT_MODEL` | `nimble` | Decision model name |
| `TYPESAFE_TIMEOUT_MS` | `30000` | Decision request timeout |
| `TYPESAFE_KEEP_ALIVE` | `5m` | Optional model keep-alive value |
| `TYPESAFE_DECISION_CACHE` | `1` | Reuse unchanged decisions within the session |
| `TYPESAFE_DECISION_CACHE_TTL_MS` | `60000` | Decision cache lifetime |
| `TYPESAFE_DECISION_CACHE_MAX_ENTRIES` | `100` | Maximum in-memory cached decisions |
| `TYPESAFE_MAX_CONTEXT_CHARS` | `20000` | Maximum compact decision context size |
| `TYPESAFE_MIN_CONFIDENCE` | `0.55` | Minimum route confidence for change/run decisions |
| `NIMBLE_ENABLED` | `1` | Initial enabled state |
| `NIMBLE_REQUIRED` | `1` | On failure, do not allow tool calls without a decision |
| `NIMBLE_GATE_TOOLS` | `1` | Enforce route and risk permissions for tool calls |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |

Legacy `NIMBLE_URL`, `NIMBLE_MODEL`, `NIMBLE_API_KEY`, `NIMBLE_TIMEOUT_MS`, and `NIMBLE_KEEP_ALIVE` variables remain supported as fallbacks. `TYPESAFE_*` values take precedence.

## Commands

```text
/decision-api enable
/decision-api disable
/decision-api stats
/decision-api help
```

`/decision-api help` shows the short local Ollama setup and required `TYPESAFE_*` environment variables.

## Audit log

Auditing is enabled by default. Each successful decision records:

- timestamp and model
- compact decision state
- route, risk, confidence, probabilities, and policy
- cache-hit status and request duration
- tool class, context sufficiency, and confirmation result

Failed decision-model requests are recorded separately with the error. Records are stored as agent-session custom entries and do not enter the LLM context. Use `/decision-api stats` inside Pi or OMP:

```text
/decision-api stats
```

It shows decisions, failures, cache hits, average and p95 latency, route counts, and the ten most recent redacted inputs and outcomes for the current session. Set `NIMBLE_AUDIT=0` to disable recording.

For a long-running session where memory is available:

```bash
NIMBLE_KEEP_ALIVE=-1 pi   # or: omp
```

To use the classifier only as guidance and not block tool calls:

```bash
NIMBLE_GATE_TOOLS=0 pi   # or: omp
```

`NIMBLE_REQUIRED=1` cannot cancel a provider request because Pi/OMP context hooks can modify the prompt but do not expose a request-cancellation return value. It does fail closed for actual tool calls when Nimble is unavailable.

## Direct smoke check

```bash
curl http://localhost:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nimble",
    "state": {
      "request": "Please inspect the repository and identify the relevant configuration file.",
      "context": "The user asked for a read-only inspection."
    },
    "questions": {
      "route": {
        "type": "choice",
        "instructions": "What should happen next?",
        "criteria": {
          "inspect": "Inspect files read-only",
          "change": "Edit or write files",
          "run": "Run a command or test",
          "explain": "Answer without tools",
          "clarify": "Ask a focused question",
          "unknown": "Insufficient context"
        }
      },
      "sufficient_context": {
        "type": "noul",
        "instructions": "Is there enough information to choose a safe next step?"
      }
    }
  }'
```
