# Pi/OMP Decision API

Nimble-powered preflight routing for [Pi](https://pi.dev/) and [OMP](https://github.com/oh-my-pi/oh-my-pi) coding agents.

Before meaningful LLM context changes, the extension sends a compact state to Ollama's local System One API. One Nimble request evaluates the route, risk, context sufficiency, confirmation requirement, and tool class. Deterministic policy code then adds routing metadata and gates tool calls.

## Routes

Nimble chooses one route:

- `clarify` — ask one focused question
- `inspect` — use read-only tools
- `change` — inspect, then edit or write
- `run` — run a command, test, or build
- `explain` — answer without project tools
- `unknown` — insufficient context; do not guess

Nimble is a classifier, not the primary coding model or a planner. The active Pi/OMP model still performs the work.

## Requirements

- macOS, Linux, or Windows
- Node.js 22+ for Pi, or Bun for OMP
- Ollama `0.35.0+`
- The Nimble model
- Pi or OMP installed and working

## Ollama setup

```bash
ollama pull nimble
```

Verify the local System One endpoint:

```bash
curl http://localhost:11434/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "nimble",
    "state": {
      "request": "Please inspect the repository and identify the relevant configuration file.",
      "context": "The user asked for a read-only inspection.",
      "lastTool": null
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
      }
    }
  }'
```

## Install as a Pi/OMP package

After publishing the package to npm, install it through the native agent package managers:

```bash
pi install npm:@ddjain/pi-omp-decision-api
omp install npm:@ddjain/pi-omp-decision-api
```

These commands use npm package resolution and register the extension for the corresponding agent. The package manifest declares both Pi and OMP entrypoints, so no manual file copying is required.

If Pi or OMP is not installed globally, run the agent CLI through your existing `npx` workflow, then use the same install subcommand. The extension itself has no runtime npm dependencies.

To publish a new version:

```bash
npm login
npm publish --access public
```

The package name is:

```text
@ddjain/pi-omp-decision-api
```

## Install in a project

Clone this repository, then copy or symlink the extension directories into the project where the agent runs.

### Pi

```bash
mkdir -p .pi/extensions
cp /path/to/pi-omp-decision-api/.pi/extensions/decision-api.ts .pi/extensions/
```

Pi auto-loads `.pi/extensions/*.ts`.

### OMP

```bash
mkdir -p .omp/extensions
cp /path/to/pi-omp-decision-api/.omp/extensions/decision-api.ts .omp/extensions/
cp /path/to/pi-omp-decision-api/.pi/extensions/decision-api.ts .pi/extensions/
```

The OMP entrypoint reuses the shared implementation. Both files are needed when installing into another project.

Alternatively, load either extension explicitly:

```bash
pi -e /path/to/pi-omp-decision-api/.pi/extensions/decision-api.ts
omp -e /path/to/pi-omp-decision-api/.omp/extensions/decision-api.ts
```

Start the agent from the target project:

```bash
pi
# or
omp
```

## Commands

Both agents expose the same commands:

```text
/decision-api enable
/decision-api disable
/decision-api stats
/decision-api help
```

### Setup help

```text
/decision-api help
```

Displays the short local Ollama setup and required `TYPESAFE_*` exports.


### Enable and disable

```text
/decision-api enable
```

Enables decision-model calls and route-based tool gating.

```text
/decision-api disable
```

Disables decision-model calls and bypasses the extension's tool gate. The setting is persisted in the current agent session.

The initial state is enabled. Override it for a process with:

```bash
NIMBLE_ENABLED=0 pi
NIMBLE_ENABLED=0 omp
```

### Statistics

```text
/decision-api stats
```

Shows decisions, failures, cache hits, average and p95 latency, route counts, and the ten most recent redacted inputs and outcomes.

Audit entries are stored as agent-session custom entries and are not sent back to the LLM context. Disable auditing with:

```bash
NIMBLE_AUDIT=0 pi
NIMBLE_AUDIT=0 omp
```

## Configuration

The preferred variables use the TypeSafe/Jev-compatible naming:

```bash
export TYPESAFE_BASE_URL=http://localhost:11434
export TYPESAFE_API_KEY=ollama
export TYPESAFE_DEFAULT_MODEL=nimble
```

The extension calls `${TYPESAFE_BASE_URL}/v1/systemone`. If the base URL already ends in `/v1` or `/v1/systemone`, it does not duplicate the path. `TYPESAFE_API_KEY` is sent as a Bearer token.

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
| `NIMBLE_REQUIRED` | `1` | Fail closed for tool calls when the decision service is unavailable |
| `NIMBLE_GATE_TOOLS` | `1` | Enforce route and risk permissions for tool calls |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |

The old `NIMBLE_URL`, `NIMBLE_MODEL`, `NIMBLE_API_KEY`, `NIMBLE_TIMEOUT_MS`, and `NIMBLE_KEEP_ALIVE` variables remain supported as fallbacks. `TYPESAFE_*` values take precedence.

For a long-running session with sufficient memory:

```bash
NIMBLE_KEEP_ALIVE=-1 pi
NIMBLE_KEEP_ALIVE=-1 omp
```

To use Nimble only as context guidance without tool blocking:

```bash
NIMBLE_GATE_TOOLS=0 pi
NIMBLE_GATE_TOOLS=0 omp
```

## Decision policy

The extension sends a compact state containing the current request, recent context, and latest tool result. One Nimble request evaluates route, risk, context sufficiency, confirmation, and tool class together.

With tool gating enabled:

- `inspect` or `inspect_only` allows read-only tools such as `read`, `grep`, `find`, and `ls`.
- `change` allows edits and writes only when risk and confidence permit it.
- `run` allows command execution only when policy permits it.
- `clarify`, `explain`, `unknown`, insufficient context, confirmation-required, and high-risk decisions block project tools.
- Unchanged decision states use the in-memory cache until its TTL expires.

After every meaningful context change, the extension calls Nimble again, so the route can change during one request.

## Privacy and safety

The extension sends the current, truncated conversation context to the local Ollama server. It does not send data to a remote decision API by default. Audit records include that truncated context in the local agent session. Use `NIMBLE_AUDIT=0` if local audit storage is not wanted.

`NIMBLE_REQUIRED=1` cannot cancel the provider's textual LLM response because Pi/OMP context hooks do not expose a request-cancellation result. It does fail closed for actual tool calls when Nimble is unavailable.

Do not commit `.env` files, API keys, session files, logs, model caches, or credentials. The repository `.gitignore` excludes common sensitive files and local agent state.

## Repository layout

```text
.pi/extensions/decision-api.ts   Shared Pi-compatible implementation
.omp/extensions/decision-api.ts   OMP entrypoint
DECISION_API.md                   Additional implementation notes
README.md                            Installation and usage guide
```
