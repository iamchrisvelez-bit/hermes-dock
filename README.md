# Hermes Dock

A central **dock** run by a **Hermes administrator agent** that governs siloed **observation decks**, one per AI-agent project. This is a fresh project, separate from Aureus and meant to replace it.

```
                         ┌────────────────────────── HERMES STATION ──────────────────────────┐
                         │  Hermes (tier 0)  — reviews, recruits/supplants agents, researches │
                         │                     online, evolves its playbook, codes/erases decks│
                         │  Auditors (tier 0) — silo-integrity · operations · viability ·      │
                         │                      adversarial red-team, scored 0..1 per deck     │
                         │  Approval queue    — erasures + any external action wait on a human │
                         └──────────┬───────────────────┬───────────────────┬──────────────────┘
                              uplink│             uplink│             uplink│   (only links)
                    ┌───────────────▼──┐  ┌─────────────▼─────┐  ┌──────────▼────────┐
                    │  Emittime Lab    │  │ 3D Asset Render   │  │ Online Sales Lab  │
                    │  manager (t1)    │  │ manager (t1)      │  │ manager (t1)      │
                    │  workers (t2)    │  │ workers (t2)      │  │ workers (t2)      │
                    │  own silo on disk│  │ own silo on disk  │  │ own silo on disk  │
                    └──────────────────┘  └───────────────────┘  └───────────────────┘
                         decks have no reference to one another
```

## How the requirements map to the code

| Requirement | Where |
|---|---|
| Central dock run by Hermes | `hermes_dock/station.py` — `Station`, `Station.hermes()`, `Station.review()` |
| Hermes reviews work | `deck_status`, `run_audits` tools; `review()` runs auditors then Hermes |
| Builds / recruits agents, replaces weaker ones | `recruit_agent`, `supplant_agent` (bumps the agent's `generation`), `retire_agent` |
| Evolves as it learns | `record_learning` — lessons, strategy notes and a self-rewritten, versioned playbook fed back into every Hermes run |
| Strategy and online research | Hermes runs with Anthropic's hosted `web_search` tool; `hermes-dock research "<question>"` |
| Tiers: one manager per deck reporting to Hermes | `hermes_dock/deck.py` — manager (tier 1) delegates with `assign_task`, reports with `report_to_hermes`; workers (tier 2) can't delegate or report |
| Decks siloed, connected only to the station | each deck gets a `DeckSilo` (path-guarded directory) and an uplink closure, nothing else |
| Auditors stress-testing every deck | `hermes_dock/auditors.py` — `hermes-dock audit`, or `hermes-dock watch` for continuous rounds |
| Hermes can code, transform or erase decks | `create_deck`, `transform_deck` (versioned, full history), `erase_deck` (archived first; goes through approval) |

**Canon** is reference material only you supply (`hermes-dock canon <deck> <file>`). It sits in the deck's silo. Every agent on that deck can read it, no agent can write it, and it outranks anything the crew proposes:

```bash
hermes-dock canon emittime-lab emittime.md
```

Every agent's tools are scoped to its tier. If an agent calls a tool it wasn't given, the call is refused.

## Starter decks

Templates live in `hermes_dock/deck_templates/`:

- **Emittime Lab** (`emittime-lab`): stewards the Emittime story universe. A lore keeper maintains the story bible, a worldbuilder and a story architect write proposals, and a continuity checker flags contradictions. Until the Emittime document is added as canon, the crew only builds the bible structure and lists questions for you. They don't invent lore.
- **3D Asset Render Lab** (`render-lab-3d`): demand scout → asset spec → Blender Python build script → technical QA.
- **Online Sales Lab** (`online-sales-lab`): product research → listings/offers → unit economics/pricing → customer-ops drafts. Spending, publishing and customer contact always need approval.

## Workshop: decks that build, not just write

Three tools let a deck actually execute its work. They're granted per agent in the deck spec, and Hermes can grant them with `recruit_agent`/`supplant_agent`.

| Tool | What it does |
|---|---|
| `run_blender_script` | Runs a Blender Python script from the deck's artifacts with real Blender (`bpy`). It collects whatever the script writes to `HERMES_OUTPUT_DIR` into `artifacts/builds/<script>/`. Each run gets its own folder inside the silo, a minimal environment (no API keys) and a timeout. |
| `convert_to_rs` | Converts an exported `.glb`/`.obj`/`.ply` into verified RuneScape model files, plus `preview.png` and `sprite.png`, through the RSPS---reimagined pipeline (stage 3). |
| `view_image` | Shows an image (a canon design, a preview render) to the agent *as an image*, so QA can compare by eye. |

Canon now also accepts images and whole folders: `hermes-dock canon <deck> <file-or-folder> [--glob '*.png']`.

Setup (environment variables; each tool explains itself if its part is missing):
```bash
# Blender as a Python module (from the RSPS---reimagined checkout)
./scripts/setup_blender.sh                      # creates .venv-blender with bpy 5.2
export HERMES_BLENDER_PYTHON=/path/to/RSPS---reimagined/.venv-blender/bin/python
export HERMES_RSPS_DIR=/path/to/RSPS---reimagined
```
Scripts are ordinary Python processes, not a sandbox. Only grant these tools to decks you trust, as you would any build script.

### RSPS Asset Forge (`rsps-forge`)
A deck dedicated to the RSPS equipment designs:
- An **asset-designer** looks at each design and writes a build spec.
- A **procedural-modeler** scripts the item in Blender, runs it, fixes it until it builds, and converts it to RS.
- **render-qa** compares the RS preview with the design and passes or fails it with concrete fixes.

The `render-lab-3d` modeller can now run its Blender scripts too.

```bash
hermes-dock init                                                  # adds rsps-forge to an existing station
python3 /path/to/RSPS---reimagined/pipeline/stage1_designs_to_3d.py # cut the designs out of the sheet
hermes-dock canon rsps-forge /path/to/RSPS---reimagined/pipeline_out/01_views
hermes-dock cycle rsps-forge                                       # needs ANTHROPIC_API_KEY
```
Results land in `.hermes/decks/rsps-forge/artifacts/`:
- `scripts/`: the Blender scripts
- `builds/`: the exported models
- `rs/`: the RS `.dat`/`.gz` files with preview and sprite
- `qa/`: the QA verdicts

Scripts can use `blender_mold.mold_item`, `build_object` and `export_glb` from the RSPS pipeline as a starting point and refine from there.

## Quick start

```bash
pip install -e '.[dev]'
export ANTHROPIC_API_KEY=...        # or `ant auth login`

hermes-dock init                    # station + 3 decks in ./.hermes
hermes-dock status
hermes-dock cycle render-lab-3d     # one manager-led operating cycle
hermes-dock audit                   # all auditors, all decks
hermes-dock review                  # Hermes: audit → act → learn
hermes-dock watch --minutes 60      # continuous audit + review loop
hermes-dock approvals               # what's waiting on you
hermes-dock approve <ticket>        # or: reject <ticket>
hermes-dock memory                  # Hermes' lessons, strategy, playbook
```

Add `--offline` to any command to use the deterministic offline backend (no API calls).

## Autonomy

The station starts **supervised**: deck erasures and every external action (spend, publish, contact) go into the approval queue. `--autonomy autonomous` lets Hermes erase decks on its own. External actions still always need a human.

## Model

Agents run on Claude (`claude-opus-5-5` by default; override it with `HERMES_DOCK_MODEL`). They use adaptive thinking, per-agent effort, and server-side refusal fallback. The brain sits behind the small `Backend` protocol in `hermes_dock/llm.py`, so you can swap in another agent runtime, such as a self-hosted Nous Research Hermes model, without touching the station.

## Tests

```bash
python -m pytest -q
```

The tests cover silo enforcement, manager→worker delegation, tool scoping by tier, approval gating, deck creation/transformation/supplanting, Hermes memory evolution, cross-deck leak detection, and the Claude request shape.
