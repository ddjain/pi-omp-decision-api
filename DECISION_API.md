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

The extension calls the configured TypeSafe/Jev-compatible `POST /v1/systemone` endpoint before **every Pi or OMP LLM call**, including calls after a tool result. It asks the configured decision model to choose one next-step route:

- `clarify` — ask a focused question
- `inspect` — use read-only project tools
- `change` — inspect, then edit or write
- `run` — run a command, test, or build
- `explain` — answer without project tools

The selected route is added to the current context as routing metadata. By default, `edit`, `write`, `bash`, and `powershell` are blocked when the current route does not permit them. After a tool result, Pi or OMP calls the decision model again, so a request can move from `inspect` to `change` or `run`.

The decision model is a typed classifier, not a planner or a replacement for the main coding model. Its decision is a routing signal; the main model still performs the work.

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
| `TYPESAFE_TIMEOUT_MS` | `10000` | Decision request timeout |
| `TYPESAFE_KEEP_ALIVE` | `5m` | Optional model keep-alive value |
| `NIMBLE_ENABLED` | `1` | Initial enabled state |
| `NIMBLE_REQUIRED` | `1` | On failure, do not allow tool calls without a decision |
| `NIMBLE_GATE_TOOLS` | `1` | Enforce route permissions for tool calls |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |

Legacy `NIMBLE_URL`, `NIMBLE_MODEL`, `NIMBLE_API_KEY`, `NIMBLE_TIMEOUT_MS`, and `NIMBLE_KEEP_ALIVE` variables remain supported as fallbacks. `TYPESAFE_*` values take precedence.

## Commands

Use either command alias:

```text
/decision-api enable
/decision-api disable
/decision-api stats


## Audit log

Auditing is enabled by default. Each successful decision records:

- timestamp and model
- the exact typed question and criteria sent to Nimble
- the truncated conversation state sent as input
- Nimble's route, confidence, and probabilities
- request duration

Failed decision-model requests are recorded separately with the error. Records are stored as agent-session custom entries and do not enter the LLM context. Use `/decision-api stats` inside Pi or OMP:

```text
/decision-api stats
```

It shows the number of successful decisions, failures, and the ten most recent questions, inputs, and answers for the current session. Set `NIMBLE_AUDIT=0` to disable recording.

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
    "state": "Please inspect the repository and identify the relevant configuration file.",
    "questions": {
      "next_step": {
        "type": "choice",
        "instructions": "What should the coding agent do next?",
        "criteria": {
          "inspect": "Inspect files read-only",
          "change": "Edit or write files",
          "run": "Run a command or test",
          "explain": "Answer without tools"
        }
      }
    }
  }'
```
