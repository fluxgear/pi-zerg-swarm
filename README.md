# pi-zerg-swarm

`pi-zerg-swarm` is a Pi coding-agent extension scaffold for high-capacity agentic coding teams and subagents. It is **not** a Raspberry Pi hardware swarm project.

> v0.7.0 status: command-host runtime monitoring plus intervention/mode controls are implemented for `/zerg` command flows, covered by fake-Pi and Node tests, and aligned with package metadata. This release includes slash-free Pi command registration, `/zerg` aliases, deterministic thinking-step parsing with source-line IDs, snapshot-safe state helpers, auditable/reversible global mode state, sanitized bounded intervention records, event-bus observation, expanded tree rendering, and runtime health/activity summaries. Manual Pi host command/runtime validation has been performed in a tmux pseudo-TTY against the Pi-loaded extension; live TUI overlays and chat/external transport remain planned and unvalidated.

## Commands

- `/zerg` — canonical command
- `/zerg-swarm` — alias
- `/swarm` — alias

At v0.7.0 these commands display scaffold help, status, expanded tree visibility, deterministic thinking-step parser output, and agent/team runtime lifecycle monitoring through Pi command handlers backed by snapshot-safe shared state. Command-host control grammar is available via `/zerg mode status|manual|assisted|automatic|revert [reason]` and `/zerg intervene agent|subagent|leader ...`; live overlay chat/transport wiring is still out of scope.

## Architecture

```mermaid
flowchart LR
  Pi[Pi extension context] --> Index[index.ts command entry]
  Index --> State[state.ts shared state]
  Index --> Patch[internal-patch.ts safe bridge]
  Patch --> State
  Parse[parse.ts thinking-step parser] --> State
  State --> Render[render.ts text renderers]
  Render --> User[operator output]
```

Future milestones keep runtime, hooks, tasks, and rendering separate so monitoring can evolve without coupling to private Pi internals.

```mermaid
graph TD
  Leader[team leader - planned] --> SubA[subagent - planned]
  Leader --> MateA[teammate loop - planned]
  MateA --> TaskA[task queue - planned]
  Operator[operator] --> Control[/zerg mode + /zerg intervene - command host]
  Control --> Leader
```

## Package shape

The package advertises a Pi extension entry in `package.json`:

```json
{
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

The TypeScript modules are intentionally small:

- `types.ts` — shared contracts and structural Pi context types
- `state.ts` — deterministic state helpers
- `parse.ts` — pure thinking-step derivation
- `render.ts` — width-aware text rendering
- `internal-patch.ts` — no-op-safe internal bridge scaffold
- `index.ts` — extension registration and command handling

## Development

```sh
npm install
npm run build
npm test
```

`npm run build` performs strict TypeScript no-emit checking. `npm test` runs parser plus command-surface coverage, v0.2.0 state/container behavior, registration snapshot semantics, v0.3.0 thinking-step parser coverage, internal-patch event-bus wrapping/duplicate/rollback/dispose paths, v0.4.1 release-hygiene assertions, v0.5.1 render regressions, v0.6.1 lifecycle/monitoring/shared-state coverage, and v0.7.0 mode/intervention command-host controls with fake-Pi shared-state parity checks using Node's built-in test runner and `tsx`.

## Roadmap

- v0.1.0: command surface hardening (completed)
- v0.2.0: richer types and state (completed)
- v0.3.0: baseline thinking-step parser hardening and Pi command integration (completed)
- v0.4.0: Pi internal bridge validation and safe event-bus observation (completed)
- v0.4.1: audit bugfix and release-hygiene version-surface consistency (completed)
- v0.5.0: render and tree visibility expansion with explicit tree, fallback hierarchy, safety markers, and truncation bounds (completed)
- v0.5.1: audit bugfix patch for fallback childIds hierarchy, explicit missing-child markers, and durable render regressions (completed)
- v0.6.1: subagent runtime lifecycle and monitoring/status/tree command surfaces (completed)
- v0.7.0: command-host mode/intervention controls with audited global state transitions and bounded intervention records (current release)
- v0.8.0+: live TUI overlays and chat/external transport validation
- v1.0.0-rc.1+: package readiness and release hardening

## License

MIT © pi-zerg-swarm contributors
