# Pi/OMP Decision API

Nimble-powered preflight routing for [Pi](https://pi.dev/) and [OMP](https://github.com/oh-my-pi/oh-my-pi) coding agents.

Before each LLM context request, the extension calls Ollama's local System One API. Nimble classifies the next action, then the extension adds that route to the agent context and optionally gates tool calls.

## Routes

Nimble chooses one route:

- `clarify` — ask one focused question
- `inspect` — use read-only tools
- `change` — inspect, then edit or write
- `run` — run a command, test, or build
- `explain` — answer without project tools

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

## Install in a project

Clone this repository, then copy or symlink the extension directories into the project where the agent runs.

### Pi

```bash
mkdir -p .pi/extensions
cp /path/to/pi-omp-decision-api/.pi/extensions/nimble-decision.ts .pi/extensions/
```

Pi auto-loads `.pi/extensions/*.ts`.

### OMP

```bash
mkdir -p .omp/extensions
cp /path/to/pi-omp-decision-api/.omp/extensions/nimble-decision.ts .omp/extensions/
cp /path/to/pi-omp-decision-api/.pi/extensions/nimble-decision.ts .pi/extensions/
```

The OMP entrypoint reuses the shared implementation. Both files are needed when installing into another project.

Alternatively, load either extension explicitly:

```bash
pi -e /path/to/pi-omp-decision-api/.pi/extensions/nimble-decision.ts
omp -e /path/to/pi-omp-decision-api/.omp/extensions/nimble-decision.ts
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
```

Short alias:

```text
/nimble enable
/nimble disable
/nimble stats
```

Compatibility alias:

```text
/nimble-stats
```

### Enable and disable

```text
/decision-api enable
```

Enables Nimble calls and route-based tool gating.

```text
/decision-api disable
```

Disables Nimble calls and bypasses the extension's tool gate. The setting is persisted in the current agent session.

The initial state is enabled. Override it for a process with:

```bash
NIMBLE_ENABLED=0 pi
NIMBLE_ENABLED=0 omp
```

### Statistics

```text
/decision-api stats
```

Shows the current enabled state, successful decisions, failures, and the ten most recent questions, inputs, and answers.

Audit entries are stored as agent-session custom entries and are not sent back to the LLM context. Disable auditing with:

```bash
NIMBLE_AUDIT=0 pi
NIMBLE_AUDIT=0 omp
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NIMBLE_URL` | `http://localhost:11434/v1/systemone` | Ollama System One endpoint |
| `NIMBLE_MODEL` | `nimble` | Decision model name |
| `NIMBLE_ENABLED` | `1` | Initial enabled state |
| `NIMBLE_REQUIRED` | `1` | Fail closed for tool calls when Nimble is unavailable |
| `NIMBLE_GATE_TOOLS` | `1` | Enforce route permissions for tool calls |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |
| `NIMBLE_TIMEOUT_MS` | `10000` | Nimble request timeout |
| `NIMBLE_KEEP_ALIVE` | `5m` | Ollama model keep-alive duration |

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

## Tool policy

With tool gating enabled:

- `inspect` allows read-only tools such as `read`, `grep`, `find`, and `ls`.
- `change` allows edits and writes but blocks command execution until a later route.
- `run` allows command execution but blocks `edit` and `write`.
- `clarify` and `explain` block project tools.

After every tool result, the extension calls Nimble again, so the route can change during one request.

## Privacy and safety

The extension sends the current, truncated conversation context to the local Ollama server. It does not send data to a remote decision API by default. Audit records include that truncated context in the local agent session. Use `NIMBLE_AUDIT=0` if local audit storage is not wanted.

`NIMBLE_REQUIRED=1` cannot cancel the provider's textual LLM response because Pi/OMP context hooks do not expose a request-cancellation result. It does fail closed for actual tool calls when Nimble is unavailable.

Do not commit `.env` files, API keys, session files, logs, model caches, or credentials. The repository `.gitignore` excludes common sensitive files and local agent state.

## Repository layout

```text
.pi/extensions/nimble-decision.ts   Shared Pi-compatible implementation
.omp/extensions/nimble-decision.ts   OMP entrypoint
NIMBLE_PI.md                         Additional implementation notes
README.md                            Installation and usage guide
```
