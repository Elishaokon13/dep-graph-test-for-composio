## Background and Motivation

The goal of this take-home is to build a **tool dependency graph** so an agent can decide:

- What **prerequisite tool calls** must happen before a target tool can be executed (e.g., “need `thread_id` before replying to a Gmail thread”).
- What **information to ask the user** for vs. what can be **looked up via other tools** (e.g., user provides a name → agent can fetch email via contacts, then send email).

Scope is intentionally limited to Composio toolkits:

- **Google Super** (`googlesuper`)
- **GitHub** (`github`)

The final deliverable must include a **visualized graph** (nodes + edges) so a reviewer can quickly confirm it exists and looks reasonable.

## Key Challenges and Analysis

- **Tool schema variability**: Tools may encode requirements implicitly (parameter names like `thread_id`, `owner`, `repo`) and some prerequisites are domain-specific (e.g., “you can obtain `thread_id` by listing threads, searching threads, or reading last message”).
- **Multiple ways to satisfy a requirement**: A single required input can be produced by several tools; the graph should support **alternative edges**.
- **User-provided vs tool-derived inputs**: Some inputs can come from the user (free-form), but if there is a reliable tool-based derivation path, the graph should reflect that so agents prefer automation.
- **Keeping scope small**: Don’t attempt “perfect” universal planning; prefer a **useful, explainable baseline** for two toolkits.

Assumptions (to revisit if the codebase disproves them):

- We can fetch tool definitions/metadata from Composio via the scaffolded example in `src/index.ts`.
- We can treat “dependency” as “this tool produces a value required by that tool” or “this tool discovers identifiers needed by that tool”.

## High-level Task Breakdown

### 1) Inspect available tools and their schemas (Google Super + GitHub)
- **What**: Programmatically pull the raw tool list and parameter schemas for both toolkits.
- **Output**: A normalized internal representation (tool name, description, params, required params, return shape if available).
- **Success criteria**:
  - We can enumerate tools for `googlesuper` and `github`.
  - For each tool, we can identify required parameters (or confidently mark “unknown”).

### 2) Build a dependency extraction heuristic
- **What**: Infer edges based on parameter semantics, examples, and/or explicit schema fields.
- **Output**: A directed multigraph where:
  - Nodes = tools (plus optionally “user input” nodes for values that must be asked)
  - Edges = “produces/derives X needed by”
- **Success criteria**:
  - At least the README example is captured (e.g., `GMAIL_LIST_THREADS` → `GMAIL_REPLY_TO_THREAD` via `thread_id`).
  - GitHub common flows work (e.g., listing repos/issues/PRs yields IDs/numbers for subsequent actions).

### 3) Materialize the graph into a reviewable visualization
- **What**: Output Graphviz DOT and render to SVG/PNG (or output an HTML visualization using a graph library).
- **Success criteria**:
  - A file exists in the repo that visually shows nodes and edges.
  - Graph is readable (reasonable labeling, not a single unreadable hairball for all tools).

### 4) Provide a simple CLI entrypoint
- **What**: One command that generates artifacts (graph JSON + visualization).
- **Success criteria**:
  - Running the command from repo root produces output deterministically.
  - Errors include actionable debugging info (API key missing, network errors, etc.).

### 5) Document how to run and what is generated
- **What**: Update/extend README instructions minimally (don’t over-document).
- **Success criteria**:
  - A reviewer can run the generator end-to-end after setting `COMPOSIO_API_KEY`.

## Project Status Board

- [ ] Step 1: Inspect tools + schemas (googlesuper, github)
- [ ] Step 2: Dependency extraction heuristic
- [ ] Step 3: Visualization output
- [ ] Step 4: CLI entrypoint
- [ ] Step 5: Minimal run documentation

## Current Status / Progress Tracking

- Step 1 implementation added:
  - Added `package.json` with `@composio/core` and `tsx`
  - Added `src/step1_dump_tools.ts` and `npm run step1:dump-tools` script
  - Script writes `artifacts/*_raw_tools.json`, `artifacts/*_normalized_tools.json`, and `artifacts/step1_summary.json`
- Fixes after initial run:
  - Patched `scaffold.sh` to send `x-composio-api-key` header when requesting the OpenRouter key (prevents `.env` creation failure)
  - Updated `src/step1_dump_tools.ts` to auto-load `.env` if present
  - Updated schema detection to use `inputParameters` (camelCase) so `requiredParams` and `paramKeys` populate
- Verified:
  - `npm install` succeeds
  - Script fails gracefully with clear instructions when `COMPOSIO_API_KEY` is missing (exit code 2)
- Verified with a real key:
  - Enumerates tools for both toolkits (`googlesuper`: 431, `github`: 867)
  - `requiredParams` and `paramKeys` are extracted for tools with JSON Schema `required` / `properties`
- Blocker to fully verify Step 1 success criteria: need a valid `COMPOSIO_API_KEY` exported in the environment (or `.env` loaded).

- Step 2 implementation added:
  - Added `src/step2_build_graph.ts` and `npm run step2:build-graph`
  - Writes `artifacts/dependency_graph.json` with nodes (tool slugs) + edges (inferred dependencies)
  - Added alias mapping for Google Super references like `GMAIL_LIST_THREADS` → `GOOGLESUPER_LIST_THREADS`
  - Confirmed the README-style Gmail dependency is captured:
    - `GOOGLESUPER_LIST_THREADS` → `GOOGLESUPER_REPLY_TO_THREAD` (via `thread_id`)
    - `GOOGLESUPER_FETCH_EMAILS` → `GOOGLESUPER_REPLY_TO_THREAD` (via `thread_id`)

- Step 3 implementation added:
  - Added `src/step3_visualize.ts` and `npm run step3:visualize`
  - Writes:
    - `artifacts/dependency_graph.dot` (Graphviz DOT)
    - `artifacts/dependency_graph.html` (interactive viewer)
  - Graphviz `dot` binary not present in this environment; HTML viewer provides the required visualization regardless.

- Step 4/5 implementation added:
  - Added `npm run generate` (one-shot entrypoint) which runs steps 1→3
  - Updated `readme.md` with minimal run instructions and expected outputs

- Submission packaging fix:
  - Patched `upload.sh` to exclude large raw tool dumps:
    - `artifacts/*_raw_tools.json`
    - `artifacts/*_normalized_tools.json`
  - Prevents HTTP 413 “Request Entity Too Large” during upload.

## Executor's Feedback or Assistance Requests

- Need to run `COMPOSIO_API_KEY=... sh scaffold.sh` (creates `.env`) and re-run the script to confirm:
  - tools enumerate for both `googlesuper` and `github`
  - required params extraction works with real schema fields (`required`, `properties`)
- Need to decide visualization format: **Graphviz DOT→SVG** is simplest if `dot` is available; otherwise use a browser-based HTML visualization.

## Lessons

- Include actionable debugging info in program output (missing keys, which API call failed, etc.).
- Always read files before editing them.
