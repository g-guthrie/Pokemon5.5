# Pokemon Showdown Model Arena

Public-ready benchmark arena for model-vs-model Pokemon Showdown battles. The
default format is official `[Gen 9] Random Doubles Battle`
(`gen9randomdoublesbattle`) using local checkouts of the Showdown server
simulator, random team generator, and client.

## What Is Here

- `vendor/pokemon-showdown`: official Showdown server/simulator checkout.
- `vendor/pokemon-showdown-client`: official Showdown client served under `/ps/`.
- `src/battle-session.mjs`: local canonical battle wrapper and protocol relay.
- `src/legal-choices.mjs`: pure Showdown request to exact legal choice builder.
- `src/protocol-view.mjs`: Showdown protocol to visible history and known-info state.
- `src/observation.mjs`: hidden-info-correct `PlayerObservation` primitives.
- `src/prompt-pipeline.mjs`: versioned model prompt and response contract.
- `src/agent-runtime.mjs`: shared stand-in, OpenAI, and OpenRouter agent interface.
- `src/match-runner.mjs`: websocket match runner and JSON artifact writer.
- `src/event-log.mjs`: newline-delimited event stream writer for indexing/analysis.
- `src/usage-summary.mjs`: provider-neutral token/cost usage normalization.
- `src/ladder-runner.mjs`: pairwise battle batches with win/loss summaries.
- `src/series-store.mjs`: persistent per-matchup series records for the arena.
- `src/transcript.mjs`: plain-text match transcripts for post-game AI analysis.
- `src/tournament-runner.mjs`: round-robin scheduler over multiple model specs.
- `src/server.mjs`: local web server, websocket API, reset API, artifact browser.
- `public/index.html` + `public/arena.js`: the LLM Arena — a spectator UI with
  live model-vs-model viewing, per-model reasoning panels, animated button
  clicks inside the official Showdown client, multi-game runs, and running
  series records per matchup.

## Setup

```sh
mkdir -p vendor
git clone --depth 1 https://github.com/smogon/pokemon-showdown.git vendor/pokemon-showdown
git clone --depth 1 https://github.com/smogon/pokemon-showdown-client.git vendor/pokemon-showdown-client
npm install
npm run setup:showdown
npm start
```

Open `http://localhost:3107`.

The two upstream Showdown repositories and generated `artifacts/` are ignored
by this repository. Clone the upstream projects before local setup or before
building the Docker image from a fresh GitHub checkout.

## LLM Arena

The default page is the arena: one battle screen, two model controllers. The
models play headlessly — each receives a structured observation and returns
one exact legal choice — and the arena visualizes those structured choices as
animated button presses, like watching two joysticks drive one screen.

The stage is literally the native Showdown client, in its official dark
theme. The arena starts a model-vs-model match (agent specs like
`standin`, `openai:gpt-5.5:low`, `openrouter:<slug>:<effort>`) and shows
Player 1's complete native client — field, battle log, and real controls.
When it is Player 2's turn to act, Player 2's native controls appear over the
controls area (the battle screen never changes); a "P1/P2 controls" pill in
the header tracks whose controls are on screen. Every structured choice a
model submits is re-enacted by a cursor pressing the actual native buttons —
moves, targets, switches, Terastallize — inside the real client UI. Each
side's "model mind" panel shows the structured tactical analysis behind the
choice. For a normal turn, prompt v9 walks through the board, revealed set
archetypes, known unknowns, opponent plan, immediate threats, win and loss
conditions, Tera and switching, candidate choices, projected outcomes, and a
final robustness check. Forced replacements use a focused three-part appraisal
of matchups, risks, and the plan enabled by the chosen send-in.

**You can take the controls yourself**: pick "🎮 You" as Player 1 and the
decision deck stops re-enacting and becomes your actual controls — click a
move, aim it from the target flyout, arm Tera, pick switches; every press is
validated against the exact legal choice space before it submits (agent spec
`human`, always Player 1). While you play, the AI opponent's mind panel and
private board stay hidden (the server withholds them from run summaries);
when the game ends its full reasoning is revealed. Human games count into
the same series records and write the same transcripts.

A **games** picker runs the same matchup back-to-back (1–100 games per
start); the server plays them in sequence on the same stage and records each
result. Every finished game also rolls into a persistent **series record**
for that exact model pairing — run one game, come back later and run five
more, and the record keeps accumulating until either model changes (the
series score chip resets it on click). `GET/POST /api/series` expose the
records. Each game also writes a plain-text **transcript** artifact
(`*.transcript.txt`: full teams, every decision with the model's stated
reason, and the public play-by-play) — the ⧉ transcript button copies the
latest one for pasting into an AI for post-game analysis.

**Theater mode** (the `⛶` button on the stage, or the `t` key; `Esc` exits)
hides everything except the native client, scaled to fill the screen — the
whole display is just the official Showdown client with two models invisibly
at the controls.

Batch workflows run from the CLI: `npm run ladder:batch` for head-to-head ladders,
`npm run tournament:batch` for round-robins, and `npm run benchmark:openrouter`
for the top-model suite; their `/api/ladder`, `/api/tournament`, and
`/api/benchmark` endpoints stay available for scripting. Use `standin`,
`human` (live runs, Player 1 only), `openai:<model>:<effort>`, or
`openrouter:<model>:<effort>` agent specs.
Pause/resume applies before the next model decision; stop aborts the run,
propagates cancellation to in-flight provider fetches, and marks the artifact
invalid.
Provider agents default to `AGENT_MAX_TOKENS=16384` and request strict structured
JSON with the exact legal choices in the schema, so tactical notes plus the final
choice stay parseable. Override that environment value if you want a cheaper or
larger response budget.

## Secrets

Do not put API keys in prompts, source files, artifacts, command output, or docs.
CLI workflows use local environment values:

```sh
OPENAI_API_KEY=...
OPENROUTER_API_KEY=...
```

The public arena currently accepts only an OpenRouter key. It stores that key in
the visitor's browser `localStorage` until the visitor explicitly changes or
logs out, sends it to the server only when starting a match, and the server
clears its in-memory run copy as soon as the match ends. Keys are never written
to artifacts. The adapters do not read `.env` files or credentials from other
projects.

## One Battle

Cost-free stand-in agents:

```sh
MAX_TURNS=40 MOVE_DELAY_MS=200 npm run model:standin
```

Generic agent runner:

```sh
AGENT_P1=standin AGENT_P2=standin npm run model:agent
AGENT_P1=openai:gpt-5.5:low AGENT_P2=standin MAX_TURNS=3 npm run model:agent
AGENT_P1=openrouter:openai/gpt-4o-mini:low AGENT_P2=standin MAX_TURNS=3 npm run model:agent
```

Agent spec format:

```text
standin
openai:<model>:<reasoning-effort>
openrouter:<model-slug>:<reasoning-effort>
```

Examples of reasoning effort are `low`, `medium`, and `high`. Fallback choices
are disabled by default; set `ALLOW_FALLBACK=1` only for debugging because any
fallback marks the artifact as `validBenchmark: false`.

Each runner uses its own generated `battleId` by default, so benchmark runs do
not reset the browser's default `local` battle. Set `BATTLE_ID=...` when you want
to attach a script to a specific server-side battle session.

## Preflight

Run a tiny paid-call check before a full API battle:

```sh
npm run openai:preflight
AGENT=openrouter:openai/gpt-4o-mini:low npm run provider:preflight
```

## Ladder Batches

Pairwise ladder batch with alternating sides and deterministic seeds:

```sh
BATTLE_COUNT=10 \
AGENT_A=standin \
AGENT_B=openrouter:openai/gpt-4o-mini:low \
LADDER_DIR=artifacts/ladder-local \
npm run ladder:batch
```

This writes one JSON artifact and one `.events.jsonl` stream per battle plus
`artifacts/ladder-local/summary-latest.json` with wins, invalid benchmark count,
usage/error totals, side mapping, and seeds.

The browser can also launch a watched ladder batch with the same run code. Use
the ladder controls next to the model run panel, or call:

```sh
curl -X POST http://localhost:3107/api/ladder \
  -H 'content-type: application/json' \
  -d '{"command":"start","agentA":"standin","agentB":"standin","battleCount":2,"watchLocal":true}'

curl http://localhost:3107/api/ladder
curl -X POST http://localhost:3107/api/ladder -H 'content-type: application/json' -d '{"command":"pause"}'
curl -X POST http://localhost:3107/api/ladder -H 'content-type: application/json' -d '{"command":"resume"}'
curl -X POST http://localhost:3107/api/ladder -H 'content-type: application/json' -d '{"command":"stop"}'
```

`watchLocal: true` runs each ladder battle through the visible `local` battle so
the two official clients show the batch live. The CLI and browser ladder both use
`src/ladder-runner.mjs`, write per-battle JSON/JSONL artifacts, and write a
`showdown-ladder-summary.v1` summary.

## Tournaments

Round-robin tournament batch across multiple agent specs:

```sh
TOURNAMENT_AGENTS='standin, openai:gpt-5.5:low, openrouter:openai/gpt-5.5:low' \
BATTLES_PER_PAIR=4 \
TOURNAMENT_DIR=artifacts/tournament-local \
npm run tournament:batch
```

This schedules every unique pair, calls `src/ladder-runner.mjs` for each pair,
and writes `showdown-tournament-summary.v1` with pair summaries, standings,
usage totals, and links to every underlying battle/event artifact.

The browser can also launch a watched tournament:

```sh
curl -X POST http://localhost:3107/api/tournament \
  -H 'content-type: application/json' \
  -d '{"command":"start","agents":"standin, heuristic, standin:alt","battlesPerPair":1,"watchLocal":true}'

curl http://localhost:3107/api/tournament
curl -X POST http://localhost:3107/api/tournament -H 'content-type: application/json' -d '{"command":"pause"}'
curl -X POST http://localhost:3107/api/tournament -H 'content-type: application/json' -d '{"command":"resume"}'
curl -X POST http://localhost:3107/api/tournament -H 'content-type: application/json' -d '{"command":"stop"}'
```

Only one live run, ladder, tournament, or benchmark runs at a time from the
browser server, so the visible `local` Showdown clients always represent one
active workflow.

## OpenRouter Top-10 Benchmark Suite

The OpenRouter comparison suite builds a cross-provider matrix: selected
OpenRouter models vs direct OpenAI baselines. It uses the same canonical doubles
runner as ladder batches, but avoids accidentally running every OpenRouter
model against every other OpenRouter model.

Plan the current suite without paid model calls:

```sh
npm run benchmark:openrouter
```

This fetches OpenRouter model metadata from `https://openrouter.ai/api/v1/models`,
resolves the weekly-usage top-candidate roster, filters to models that advertise
`response_format` or `structured_outputs`, fills any strict-JSON gaps from the
latest benchmarkable catalog entries, and writes:

```text
artifacts/benchmark-suites/<run-id>/suite-plan.json
```

The default OpenAI baselines are:

```text
openai:gpt-5.5:low, openai:gpt-5.5:medium
```

Override the roster or baselines explicitly:

```sh
OPENROUTER_TOP_MODELS='moonshotai/kimi-k2.6,anthropic/claude-sonnet-4.6,deepseek/deepseek-v4-flash' \
OPENAI_BASELINES='openai:gpt-5.5:low,openai:gpt-5.5:medium' \
npm run benchmark:openrouter
```

Run the paid benchmark only after the plan looks right:

```sh
RUN_PAID_BENCHMARK=1 \
BATTLES_PER_PAIR=2 \
MAX_TURNS=40 \
MATCH_TIMEOUT_MS=180000 \
npm run benchmark:openrouter -- run
```

The paid run writes `showdown-openrouter-benchmark-run.v1` under
`artifacts/benchmark-suites/<run-id>/summary-latest.json`, with one ladder
summary per OpenAI-vs-OpenRouter pair, usage/cost metadata, and invalid
benchmark counts.

The browser exposes the same workflow through `/api/benchmark`. Planning is
always no-paid; starting a run requires an explicit `runPaidBenchmark: true`
field.

```sh
curl -X POST http://localhost:3107/api/benchmark \
  -H 'content-type: application/json' \
  -d '{"command":"plan","openRouterLimit":10,"openaiBaselines":"openai:gpt-5.5:low, openai:gpt-5.5:medium","battlesPerPair":2,"watchLocal":true}'

curl -X POST http://localhost:3107/api/benchmark \
  -H 'content-type: application/json' \
  -d '{"command":"start","runPaidBenchmark":true,"battlesPerPair":2,"watchLocal":true}'

curl http://localhost:3107/api/benchmark
curl -X POST http://localhost:3107/api/benchmark -H 'content-type: application/json' -d '{"command":"pause"}'
curl -X POST http://localhost:3107/api/benchmark -H 'content-type: application/json' -d '{"command":"resume"}'
curl -X POST http://localhost:3107/api/benchmark -H 'content-type: application/json' -d '{"command":"stop"}'
```

Only one live run, ladder, tournament, or benchmark runs at a time from the
browser server. With `watchLocal: true`, the visible two-client arena shows the
current battle in the suite.

## WebSocket API

Connect to `ws://localhost:3107/ws?role=p1`, `p2`, or `spectator`.
Add `battleId=<id>` to isolate independent battles on the same server.

Client to server:

```json
{"type":"choose","choice":"move 1 1, move 2 2"}
{"type":"auto"}
{"type":"reset","formatid":"gen9randomdoublesbattle","seed":[1,2,3,4]}
```

HTTP reset also accepts deterministic seeds:

```sh
curl -X POST http://localhost:3107/api/reset \
  -H 'content-type: application/json' \
  -d '{"battleId":"local","formatid":"gen9randomdoublesbattle","seed":[1,2,3,4]}'
```

List active server-side battles:

```sh
curl http://localhost:3107/api/battles
```

Start or control the live browser-attached model runner:

```sh
curl -X POST http://localhost:3107/api/run \
  -H 'content-type: application/json' \
  -d '{"command":"start","battleId":"local","agentP1":"standin","agentP2":"standin","maxTurns":40,"moveDelayMs":200}'

curl http://localhost:3107/api/run
curl -X POST http://localhost:3107/api/run -H 'content-type: application/json' -d '{"command":"pause"}'
curl -X POST http://localhost:3107/api/run -H 'content-type: application/json' -d '{"command":"resume"}'
curl -X POST http://localhost:3107/api/run -H 'content-type: application/json' -d '{"command":"stop"}'
```

`GET /api/run` returns sanitized live telemetry while a run is active and after
it finishes: current turn, observation/model-call/action counts, aggregate
usage, validity/error counters, the last private request summary, the last model
choice summary, and recent selected choices. It does not include full prompts,
raw model text, private teams, or secrets; those remain in the durable artifact.

Completed non-`local` battles with no connected clients are pruned from server
memory; durable records live in the JSON artifacts.

Server to client:

```json
{"type":"state","role":"p1","state":{...}}
{"type":"protocol","role":"p1","chunk":"|turn|1\n..."}
{"type":"end","data":{"winner":"Benchmark P1","turn":12}}
```

## Benchmark Contract

Models receive `state.extracted`, a `PlayerObservation` with:

- full private own team, including item, ability, nature, moves, tera type, EVs,
  IVs, current condition, and active stats where available;
- perspective and opponent role markers for side-specific prompts;
- exact legal action objects from the current Showdown request;
- visible opponent active Pokemon and revealed team only;
- visible history/protocol, field state, side conditions, boosts, volatiles,
  revealed moves, revealed abilities, item reveal/consume state, and tera reveal;
- `source.opponentHiddenTeamIncluded: false`.

Models return JSON using `showdown-choice-response.v9`. The analysis fields are
short tactical notes for auditability, not free-form hidden chain-of-thought:

```json
{
  "gameStateSummary": ["board and pressure summary"],
  "setArchetypes": ["confirmed and inferred roles of each revealed Pokemon"],
  "unknownInformation": ["credible unknown sets, speed tiers, items, and abilities"],
  "opponentLikelyPlan": ["likely opponent action from revealed info"],
  "biggestThreats": ["immediate threat to cover"],
  "winConditions": ["path to win from known information"],
  "loseConditions": ["sequences that lose and what must be prevented now"],
  "teraAndSwitchCheck": ["whether either active should Tera or switch"],
  "candidateChoices": ["exact legal choice: how it advances or covers the plan"],
  "candidateOutcomes": ["projected lines against likely and dangerous replies"],
  "decisionCheck": ["robustness, resource, flexibility, and follow-up check"],
  "choice": "move 1 1, move 2 2",
  "reason": "short final justification"
}
```

When every legal action is a forced send-in, response v9 instead requires
`replacementMatchups`, `replacementRisks`, and `replacementPlan` before the
exact `choice` and final `reason`.

`choice` must exactly match one `legalActions[]` string. Invalid choices,
API failures, max-turn caps, and fallbacks are counted in the artifact and make
`validBenchmark` false.

The prompt uses `showdown-choice-prompt.v9` and includes the exact legal choice
strings, a compact atomic legal-action catalog, full own-team private data
(including bench stats), visible opponent-only known data, field/side
conditions with turn counters and standard durations, the visible battle
log (single copy: human-readable text in the briefing, structured recent
events in the observation; raw protocol is not part of the on-screen human
view and is omitted), action syntax, a compact situation summary, a
`battleBriefing` section shaped like a player-facing tactical screen, and a
`dexContext` section carrying screen-tooltip equivalents: move cards
(type/category/power/accuracy/PP/effect) for every own and revealed opponent
move, species cards (typing, base stats, possible abilities) for every
visible Pokemon, random-battle stat estimates for revealed opponents (the
public 85 EV / 31 IV / neutral spread at the visible level), opponent
status-turn counters, and explicit revealed/unrevealed team counts. The
briefing separates own active/bench, revealed opponent active/team, the current
active board, available own bench, fainted resources, field state, recent log,
legal choice semantics, and explicit known-unknown boundaries. The response
order requires public tactical notes that separate confirmed information from
inference, appraise revealed set archetypes, preserve explicit unknowns, predict
the opponent, identify threats and win/loss conditions, weigh Tera and ordinary
switches, compare exact legal choices, project their likely outcomes, and check
the selected line for robustness before the final exact legal choice. Forced
replacement requests use their smaller matchup/risk/follow-up schema. Benchmark
seeds stay in artifacts and UI status, not in the model-facing prompt payload.

## Artifact Shape

Match artifacts use `showdown-match-artifact.v1` and include:

- format, seed, server URL, agent metadata, max turns, fallback policy;
- `battleId`, so concurrent or isolated runs can be traced to the server
  session;
- artifact-only `teamSnapshots` for both players, including generated set
  fields and stable team hashes for seed reproducibility audits;
- per-decision observations and exact legal actions;
- selected actions and model call records;
- stable `observationIndex` and `callIndex` links from each selected action back
  to the exact observation and model call that produced it;
- prompts, raw model text, response IDs, usage/cost metadata when provided;
- parsed model tactical analysis fields when provided;
- normalized `usage` buckets by role, provider, and model;
- public/private protocol chunks needed for transcripts/debugging;
- `eventsPath`/`eventsHref` for the matching `showdown-event-log.v1` JSONL
  stream;
- final state summaries, winner, turn, errors, and benchmark validity.

Event streams use `showdown-event-log.v1` with one JSON object per line:

- `match_start` and `match_end` records for seed, format, agents, team hashes,
  result, benchmark validity, and usage;
- `hello` and `protocol` records for websocket/protocol context;
- `observation` records with role, turn, request ID, visible active Pokemon,
  known own-team details, revealed opponent info, exact legal choice summaries,
  and the hidden-info source marker;
- `model_call` records with provider/model, selected choice, validity, usage,
  prompt/response hashes, and bounded response text;
- `action` records linking the exact submitted choice to `observationIndex` and
  `callIndex`.

Ladder summaries use `showdown-ladder-summary.v1` and include per-battle seed,
side mapping, winner, validity, errors, and `eventsPath`/`eventsHref`.

Tournament summaries use `showdown-tournament-summary.v1` and include agent
metadata, pair records, per-agent standings, aggregate usage/error totals, and
links to each pair's ladder summary.

Series records live in `artifacts/series-store.json`
(`showdown-series-store.v1`), keyed by session and exact model pairing, with
running totals and one entry per counted game (winner, turns, artifact and
transcript links). Aborted games never count.

## Deploy

The server is multi-tenant: every browser gets a persistent session ID
(localStorage) and its own battle (`s-<session>`), run slot, and series
records.

The checked-in `render.yaml` defines a free Render web service. A Render
Blueprint deployment builds the Docker image directly from this repository;
the image pins and fetches both upstream Showdown repositories during the build.
Free instances have ephemeral storage, so match artifacts and series records
reset when the service sleeps, restarts, or redeploys.

```sh
docker build -t showdown-llm-arena .
docker run -p 8123:8123 -v arena-artifacts:/app/artifacts showdown-llm-arena
```

Environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8123` | HTTP + WebSocket listen port. |
| `TRUST_PROXY` | off | Set `1` behind a reverse proxy so `x-forwarded-for` drives per-visitor rate limits. Never enable when directly exposed. |
| `MAX_CONCURRENT_RUNS` | `3` | Global cap on simultaneous live model matches (1–16). |
| `MAX_COMPLETED_LIVE_RUNS` | `250` | Maximum completed visitor run summaries retained in memory. |
| `LIVE_RUN_RETENTION_MS` | `86400000` | Maximum age of completed visitor run summaries retained in memory. |
| `MAX_LIVE_ARTIFACTS` | `400` | Newest live-run match artifacts retained on disk; older ones (with their event logs and transcripts) are pruned at run start. |
| `OPENROUTER_API_KEY` | unset | Optional house key. Visitors normally bring their own key, which is held in memory for the run only and never written to artifacts. |

Operational notes:

- Terminate TLS at a reverse proxy (Caddy/nginx) and proxy WebSocket upgrades
  for `/ws` (`Upgrade`/`Connection` headers) to the same port.
- `GET /healthz` returns `{ok, activeRuns, battles}` for load-balancer checks;
  the Dockerfile wires it into `HEALTHCHECK`.
- `SIGTERM`/`SIGINT` abort in-flight runs and close sockets gracefully.
- Rate limits: run starts 6/min/IP, key validation 10/min/IP.
- Mount `/app/artifacts` as a volume if match artifacts and series records should survive redeploys.

## Verification

```sh
npm run verify
npm run audit:production
```

`npm run verify` is the no-paid production gate. It runs the smoke contracts,
API-control smokes, a standalone stand-in ladder batch, and a key-pattern secret
scan, then writes `artifacts/verification/verify-latest.json`. It does not call
OpenAI or OpenRouter unless explicitly requested.

`npm run audit:production` reads the latest verification report plus the current
match, provider, ladder, tournament, UI screenshot, source, package, and README
evidence, then writes `artifacts/verification/production-audit-latest.json`.
The audit reports a requirement-by-requirement matrix. It can pass the no-paid
production gate while still warning that real paid OpenAI/OpenRouter preflight
remains external until `RUN_PAID_PREFLIGHT=1 npm run verify` has run with both
keys in the process environment.

Optional paid preflight, only when API keys are already in the process
environment:

```sh
RUN_PAID_PREFLIGHT=1 npm run verify
```

The underlying no-paid checks are:

```sh
npm run smoke
npm run smoke:extractor
npm run smoke:control
npm run smoke:ws
npm run smoke:lazy-battle
npm run smoke:choices
npm run smoke:legal-canonical
npm run smoke:hidden
npm run smoke:runner
npm run smoke:isolation
npm run smoke:usage
npm run smoke:credits
npm run smoke:stale-state
npm run smoke:events
npm run smoke:repro
npm run smoke:prompt
npm run smoke:live
npm run smoke:human
npm run smoke:frontend
npm run smoke:provider-config
npm run smoke:provider-artifact
npm run smoke:abort
npm run smoke:redaction
npm run smoke:ladder-ui
npm run smoke:tournament
npm run smoke:tournament-api
npm run smoke:benchmark-suite
npm run smoke:benchmark-api
```

`smoke:choices` covers doubles target syntax, forced switches, trapped Pokemon,
duplicate switch prevention, faint/pass handling, and single-Tera composition.
`smoke:legal-canonical` submits representative choices generated from real
Showdown requests across several deterministic seeds, including targeted moves,
switching, Terastallize, and an actual force-switch request, and fails if the
vendored Showdown engine rejects any generated command. Set
`LEGAL_CANONICAL_SEEDS='1,2,3,4;11,22,33,44'` to override the seed set.
`smoke:lazy-battle` proves a waiting websocket can attach before its isolated
battle exists and receive state when that battle is created. `smoke:hidden`
asserts hidden opponent species do not leak through
`PlayerObservation`. `smoke:runner` proves selected actions are exact legal
choices and are linked to their source observation/model call in the artifact.
`smoke:isolation` proves two battles with different seeds can run independently
on the same local server. `smoke:usage` proves OpenAI/OpenRouter-style usage
objects normalize into stable token/cost summaries. `smoke:credits` proves an
OpenRouter credit rejection remains a typed condition and that the paused match
offers explicit retry, key-change, automatic-move, and end-match actions without
making a paid call. `smoke:stale-state` covers
picker refresh, Model Mind shaping, and state that must not leak across
matchups. `smoke:events` proves the JSONL stream is ordered, parseable, and
carries legal choice and hidden-info markers without duplicating full prompts.
`smoke:repro` proves same-seed battles produce identical full team snapshots and
team hashes in artifacts. `smoke:prompt` proves the model prompt contains the
screen-equivalent context, exact legal choices, hidden-info marker, turn and
replacement schemas, and required tactical fields without exposing the
benchmark seed. `smoke:live` proves the browser-attached `/api/run`
path can complete a stand-in model battle on the visible `local` battle and write
match/event artifacts. `smoke:frontend` uses headless Chrome against a temporary
local server to write `artifacts/frontend-screenshot-smoke.png` and prove the
rendered arena and native-client frame contain the setup flow, live stage,
matchup controls, Model Mind placeholders, responsive layout, and expected
production assets. `smoke:localhost` is an optional check against an already
running `http://localhost:3107` server; it is not part of `npm run verify`.
`smoke:provider-config` proves provider keys are env-only
and that fake OpenAI/OpenRouter calls do not leak keys or seeds into prompts.
`smoke:provider-artifact` runs fake OpenAI and OpenRouter adapters through the
real websocket match runner and proves provider artifacts include prompts, raw
responses, usage metadata, schema markers, legal choices, and prompt/response
event refs without paid calls or key/seed leakage.
`smoke:human` proves a human-controlled side plays over its own websocket:
the runner never chooses for it, the AI mind stays hidden mid-game and is
revealed after, and the game lands in the series record with a transcript.
`smoke:abort` proves OpenAI and OpenRouter adapter fetches receive the runner
AbortSignal without using the network. `smoke:redaction` proves key-shaped agent
metadata is scrubbed from failed-run artifacts.
`smoke:ladder-ui` proves `/api/ladder`
can run a watched browser ladder batch and write a summary.
`smoke:tournament` proves the reusable round-robin scheduler writes pair
summaries and standings; `smoke:tournament-api` proves `/api/tournament` can run
the same scheduler through the browser server controls. `smoke:benchmark-suite`
proves the OpenRouter-vs-OpenAI suite planner keeps canonical random doubles and
strict-output model filtering. `smoke:benchmark-api` proves `/api/benchmark`
creates a no-paid browser plan artifact and refuses an unconfirmed paid run.

Use the browser at `http://localhost:3107` to watch the two official Showdown
clients and inspect grouped legal actions, observations, history, and artifacts.
