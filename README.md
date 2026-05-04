# pi-zerg-swarm

`pi-zerg-swarm` is a Pi coding-agent extension scaffold for high-capacity agentic coding teams and subagents. It is **not** a Raspberry Pi hardware swarm project.

> **v0.9.0 release-prep status**
> Documentation hierarchy, Mermaid diagrams, package metadata, and package-readiness notes are aligned for the release-prep gate.
> Runtime capability is unchanged: live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## Release status

- Current release: **v0.9.0** (release preparation and documentation polish on `develop`).
- Historical milestones preserved for audit traceability: v0.8.0 implementation milestone and v0.8.1 audit follow-up patch.
- Follow-up audit prompts reserved for v0.9.1: `prompts/audit/themed-cleanup_v2-0-0.md` and `prompts/audit/generalized-deep-audit_v2-0-0.md`.
- Canonical repository metadata is not configured yet; package checks warn rather than fabricating a URL.

## Commands

- `/zerg` — canonical command
- `/zerg-swarm` — alias
- `/swarm` — alias

At v0.9.0 these commands display help, status, expanded tree visibility, deterministic thinking-step parser output, and agent/team lifecycle monitoring through snapshot-safe shared-state-backed Pi command handlers.
Command-host control grammar is available via `/zerg mode status|manual|assisted|automatic|revert [reason]` and `/zerg intervene agent|subagent|leader ...`; live overlay chat/process-transport wiring is still out of scope.

## Architecture

```mermaid
flowchart TB
  subgraph Runtime["Public command runtime (implemented)"]
    PiContext["Pi extension context"] --> Index["index.ts command entry"]
    Index --> State["state.ts shared state"]
    Index --> Patch["internal-patch.ts safe bridge"]
    Patch --> State
    Parse["parse.ts thinking-step parser"] --> State
    State --> Render["render.ts text renderers"]
    Render --> Operator["operator output"]
  end

  Parse -->|"thinking-step derivation"| Render
  Index -->|"registered commands"| Operator
```

```mermaid
flowchart TD
  subgraph CommandHost["Command-host flows (implemented)"]
    Operator["operator"] --> Host["/zerg mode + /zerg intervene command surface"]
    Host --> Views["help / status / tree"]
    Views --> Snapshots["shared snapshots + audit records"]
    Snapshots -->|"renders"| Rendered["visible runtime text"]
  end

  subgraph Planned["Planned runtime"]
    Leader["team leader"] --> SubA["subagent"]
    SubA --> Queue["task queue"]
  end

  Host -.-> Leader
```

Future milestones keep runtime, hooks, tasks, and rendering separate so monitoring can evolve without coupling to private Pi internals.

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
npm run check:package
npm run check:version
```

`npm run build` performs strict TypeScript no-emit checking. `npm test` runs parser plus command-surface coverage, v0.2.0 state/container behavior, registration snapshot semantics, v0.3.0 thinking-step parser coverage, internal-patch event-bus wrapping/duplicate/rollback/dispose paths, v0.4.1 release-hygiene assertions, v0.5.1 render regressions, v0.6.1 lifecycle/monitoring/shared-state coverage, v0.7.1 mode/intervention coverage, and audit-bugfix/publish-readiness regressions with fake-Pi shared-state parity checks using Node's built-in test runner and `tsx`.
`npm run check:package` validates MIT/license metadata, package/build private-path guards, and package-lock↔package version sync for release readiness, while warning if repository metadata is not yet configured.
`npm run check:version` confirms that the package release tag `v0.9.0` is at `HEAD`. It is a post-tag gate by design; skip it during pre-tag release prep because it is expected to fail before the v0.9.0 tag exists.

## Roadmap

- v0.1.0: command surface hardening (completed)
- v0.2.0: richer types and state (completed)
- v0.3.0: baseline thinking-step parser hardening and Pi command integration (completed)
- v0.4.0: Pi internal bridge validation and safe event-bus observation (completed)
- v0.4.1: audit bugfix and release-hygiene version-surface consistency (completed)
- v0.5.0: render and tree visibility expansion with explicit tree, fallback hierarchy, safety markers, and truncation bounds (completed)
- v0.5.1: audit bugfix patch for fallback childIds hierarchy, explicit missing-child markers, and durable render regressions (completed)
- v0.6.1: subagent runtime lifecycle and monitoring/status/tree command surfaces (completed)
- v0.7.0: command-host mode/intervention controls with audited global state transitions and bounded intervention records (completed)
- v0.7.1: audit bugfix patch for read-only `/zerg mode status`, mode-revert `contextId` clearing, and invalid/control-only/overlong mode reason regression coverage (completed)
- v0.8.0: package readiness and config hardening (completed implementation milestone)
- v0.8.1: audit bugfix patch for release-surface/version-alignment follow-ups (completed milestone)
- v0.9.0: release-prep/doc and package-readiness polish (current release)
- v0.9.1: planned themed-cleanup / generalized-deep-audit follow-up fixes
- v0.9.2+: live TUI overlays, chat, and external transport validation

## License

MIT © pi-zerg-swarm contributors
