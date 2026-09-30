# Pi/OMP Decision API

Nimble-powered preflight routing for [Pi](https://pi.dev/) and [OMP](https://github.com/oh-my-pi/oh-my-pi) coding agents.

Before meaningful LLM context changes, the extension sends the current user request to Ollama's local System One API. One Nimble request evaluates a suggested route and a risk score. The extension adds that as an advisory note in context — it never gates, blocks, or delays a tool call. The active Pi/OMP model decides what to actually do; Nimble's opinion is a suggestion, not an enforcement layer.

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
      }
    }
  }'
```

## Install from this git repo

First, clone the repo somewhere permanent (this is the copy you'll edit and re-sync from, so don't put it in a temp directory):

```bash
git clone <this-repo-url> ~/pi-omp-decision-api
```

Pick **one** of the two install modes below — global or project-level, not both. Running both at once loads two independent copies of the extension with two separate `enabled` states: disabling it in one command surface leaves the other copy still running, and advisory notes get duplicated. If you only need it in a couple of projects, project-level is simpler to reason about; if you want it available everywhere, install it globally once and only edit the source repo afterward.

### Global install (available in every project)

```bash
omp install ~/pi-omp-decision-api
# or, for Pi:
pi install ~/pi-omp-decision-api
```

This registers the extension once, for every project the agent runs in, from `~/.omp/plugins/node_modules/@ddjain/pi-omp-decision-api` (path may vary by agent version — use the verification step below to confirm the actual location). Do **not** also copy the extension files into a project's `.pi/extensions/` or `.omp/extensions/` — that creates the duplicate-instance problem described above.

After pulling changes or editing `~/pi-omp-decision-api` locally, re-run the same `install` command (or reinstall) to refresh the global copy — editing the cloned repo does not automatically update the installed plugin.

### Project-level install (one project only)

Copy the extension files directly into the target project instead of installing globally:

```bash
cd /path/to/your-project
mkdir -p .pi/extensions .omp/extensions
cp ~/pi-omp-decision-api/.pi/extensions/decision-api.ts .pi/extensions/
cp ~/pi-omp-decision-api/.omp/extensions/decision-api.ts .omp/extensions/
```

Pi auto-loads `.pi/extensions/*.ts`; OMP auto-loads `.omp/extensions/*.ts` (which just re-exports the shared `.pi` implementation — both files are needed). No `-e` flag or restart-time flag is required once the files are in place; just start the agent from the project:

```bash
pi
# or
omp
```

If you'd rather not copy files into the project at all, load the extension explicitly for a one-off session instead, without touching the project:

```bash
pi -e ~/pi-omp-decision-api/.pi/extensions/decision-api.ts
omp -e ~/pi-omp-decision-api/.omp/extensions/decision-api.ts
```

After editing the source repo, re-copy the changed file(s) into every project-level install you've made — each copy is independent and does not update itself.

### Verify the install

Run this after any install, reinstall, or edit, before trusting the extension's behavior:

1. Start the agent in the target project and run `/decision-api help`. Confirm the version and date match the source you expect (check `EXTENSION_VERSION` / `EXTENSION_LAST_UPDATED` near the top of `.pi/extensions/decision-api.ts` in the repo you edited).
2. Check for a duplicate load before trusting `/decision-api disable`:
   ```bash
   find . ~/.omp ~/.pi -iname "decision-api.ts" 2>/dev/null
   ```
   If this lists more than one path that could plausibly be loaded for your session (a project-local copy *and* a global plugin copy, or two different global plugin locations), you have a duplicate — pick one per the install modes above and remove the other.
3. Run `/decision-api stats` — it should report exactly the enabled/disabled state you last set. If it flips back or seems to ignore `/decision-api disable`, that's the duplicate-instance symptom; re-run step 2.
4. As a functional check, `/decision-api disable` and confirm the `[System One routing signal — local decision model, advisory only]` note stops appearing in context after your next message; `/decision-api enable` to turn it back on.

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

Enables decision-model calls. Advisory notes start appearing in context again.

```text
/decision-api disable
```

Disables decision-model calls entirely — no request is sent to Ollama and no advisory note is added. The setting is persisted in the current agent session.

The initial state is enabled. Override it for a process with:

```bash
NIMBLE_ENABLED=0 pi
NIMBLE_ENABLED=0 omp
```

### Statistics

```text
/decision-api stats
```

Shows enabled/disabled state, decision/failure/cache-hit counts, how many notes were actually injected into context, a route breakdown, a risk histogram, and current backoff status for the current session.

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
| `NIMBLE_ENABLED` | `1` | Initial enabled state |
| `NIMBLE_AUDIT` | `1` | Persist decision and failure audit records |

The old `NIMBLE_URL`, `NIMBLE_MODEL`, `NIMBLE_API_KEY`, and `NIMBLE_TIMEOUT_MS` variables remain supported as fallbacks. `TYPESAFE_*` values take precedence.

## Advisory behavior

The extension sends the current user request, the last ~8 messages of context, and the last tool result to Nimble on every meaningful context change. One request evaluates a route (`clarify`, `inspect`, `change`, `run`, `explain`, or `unknown`), a risk score (0–4), and — when risk is elevated — a short reason tag (e.g. "touches a remote host or credentials", "a recent tool result suggests something already went wrong").

The note is only appended to context (`[System One routing signal — local decision model, advisory only]`) when it's actually actionable: risk 3+, or route `clarify`/`unknown`. Lower-risk decisions are still recorded in the audit log but stay out of the transcript, so the model isn't fed the same boilerplate every turn.

Identical requests within a 15-second window (keyed on request text + last tool name) are served from a small in-memory cache instead of triggering another Ollama call. If Nimble fails 3 turns in a row, the extension backs off for ~60 seconds before retrying, so a downed Ollama server doesn't cost a full timeout on every single turn.

This is purely informational: the extension never inspects, gates, or blocks tool calls. On any failure it silently skips the advisory note for that turn and the agent proceeds as normal — nothing fails closed.

## Privacy and safety

The extension sends the current, truncated user request plus recent conversation context and the last tool result to the local Ollama server. It does not send data to a remote decision API by default. Audit records include that truncated data in the local agent session. Use `NIMBLE_AUDIT=0` if local audit storage is not wanted.

Do not commit `.env` files, API keys, session files, logs, model caches, or credentials. The repository `.gitignore` excludes common sensitive files and local agent state.

## Repository layout

```text
.pi/extensions/decision-api.ts   Shared Pi-compatible implementation
.omp/extensions/decision-api.ts   OMP entrypoint
DECISION_API.md                   Additional implementation notes
README.md                            Installation and usage guide
```
