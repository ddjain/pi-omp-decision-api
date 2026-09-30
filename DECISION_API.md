# Decision API routing for Pi and OMP

This project includes a shared, pure-advisory decision API implementation:

- `.pi/extensions/decision-api.ts` for Pi
- `.omp/extensions/decision-api.ts` for OMP, which reuses the Pi implementation

Both agents share the same routing behavior, audit records, and environment variables. The extension never inspects, gates, delays, or blocks a tool call — it only appends a suggested route/risk note to context. See the "Install from this git repo" section in `README.md` for global vs. project-level install, and its "Verify the install" steps for catching duplicate loads.

## Pi

Pi auto-loads `.pi/extensions/decision-api.ts` when started in a project that has it.

## OMP

OMP auto-loads `.omp/extensions/decision-api.ts` when started in a project that has it.

```bash
omp
```

To load it explicitly without installing into the project:

```bash
omp -e ./.omp/extensions/decision-api.ts
```

The OMP entrypoint is intentionally a small re-export. Keep behavior changes in `.pi/extensions/decision-api.ts` so both agents remain identical.

## Setup

Requires Ollama `0.35.0` or newer. System One is local-only.

```bash
ollama pull nimble
pi   # or: omp
```

The extension calls the configured TypeSafe/Jev-compatible `POST /v1/systemone` endpoint before meaningful Pi or OMP LLM context changes. It sends the current user request, the last ~8 messages of compacted context, and the last tool result (name + truncated output), and evaluates three typed questions:

- `route` — `clarify`, `inspect`, `change`, `run`, `explain`, or `unknown`
- `risk` — score from informational-only (0) to destructive/remote/infrastructure action (4)
- `reason` — a short tag explaining elevated risk (e.g. touches remote/infra, broad scope, ambiguous request, risky recent tool result), or `none`

The result is appended to context as a `[System One routing signal — local decision model, advisory only]` note, but **only when it's actionable**: risk 3+, or route `clarify`/`unknown`. Lower-risk decisions are still recorded to the audit log but never enter the transcript — this avoids training the main model to skim past a boilerplate note on every turn. That's the entire effect — there is no policy engine, no tool-class classification, no confirmation requirement, and no tool gating. The decision model is a suggestion for the main coding model to weigh; it cannot stop, delay, or permit a tool call.

Two efficiency mechanisms sit on top of this:

- **Cache**: identical requests (same request text + same last tool name) within a 15-second window reuse the previous decision instead of calling Ollama again.
- **Backoff**: after 3 consecutive classification failures, the extension stops calling Nimble for ~60 seconds before retrying, instead of paying the full `TYPESAFE_TIMEOUT_MS` on every turn while Ollama is down.

If the request to Nimble fails or times out, the extension logs the failure (if auditing is enabled) and silently skips the advisory note for that turn — nothing fails closed, nothing blocks.

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
| `NIMBLE_ENABLED` | `1` | Initial enabled state |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |

Legacy `NIMBLE_URL`, `NIMBLE_MODEL`, `NIMBLE_API_KEY`, and `NIMBLE_TIMEOUT_MS` variables remain supported as fallbacks. `TYPESAFE_*` values take precedence.

## Commands

```text
/decision-api enable
/decision-api disable
/decision-api stats
/decision-api help
```

`/decision-api help` shows the extension version/last-updated date, the short local Ollama setup, and required `TYPESAFE_*` environment variables. Check the version here first whenever behavior seems out of date — it's the fastest way to tell whether a running session picked up your latest edit or is loading a stale duplicate (see README's "Verify the install").

`/decision-api disable` turns off decision-model calls entirely for the session (persisted via a session entry) — no request is sent and no advisory note is added until re-enabled.

## Audit log

Auditing is enabled by default. Each successful decision records:

- timestamp and model
- the (redacted) user request
- route, risk, confidence, and reason (if any)
- whether the note was actually injected into context
- request duration and cache-hit status

Failed decision-model requests are recorded separately with the error. Records are stored as agent-session custom entries and do not enter the LLM context. Use `/decision-api stats` inside Pi or OMP to see enabled/disabled state, decision/failure/cache-hit counts, how many decisions were actually injected, a route breakdown, a risk histogram, and current backoff status for the current session. Set `NIMBLE_AUDIT=0` to disable recording.

## Direct smoke check

```bash
curl http://localhost:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nimble",
    "state": {
      "request": "Please inspect the repository and identify the relevant configuration file."
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
      "risk": {
        "type": "score",
        "instructions": "How risky is the next action?",
        "criteria": [
          "Informational only",
          "Read-only inspection",
          "Local reversible change",
          "Command or broad modification",
          "Destructive, remote, credential, or infrastructure action"
        ]
      },
      "reason": {
        "type": "choice",
        "instructions": "If risk is elevated, why? Choose none if there is no specific concern.",
        "criteria": {
          "remote_or_infra": "Touches a remote host, credentials, or infrastructure",
          "broad_scope": "Affects a broad or unclear set of files",
          "ambiguous_request": "The request is ambiguous or underspecified",
          "risky_history": "A recent tool result suggests something already went wrong",
          "none": "No specific concern"
        }
      }
    }
  }'
```
