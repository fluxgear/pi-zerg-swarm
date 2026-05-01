# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to semantic versioning after the bootstrap line is established.

## [0.2.0] - 2026-05-01

### Added

- Added v0.2.0 state schema metadata, lifecycle/revision guard fields, team/tree/context/thinking contracts, and deterministic state container APIs.
- Added focused regression coverage for shared state snapshots, container read/update/replace flows, team/tree helpers, registration state snapshots, and type fixture surfaces.

### Changed

- Promoted package metadata and public command/status/help version strings to v0.2.0 for the completed types/state milestone.
- Routed extension registration and internal patch event writes through snapshot-safe state container helpers.

## [0.1.1] - 2026-05-01

### Fixed

- Corrected README validation-scope wording so `npm test` is documented as covering parser, command-surface, and render behavior.
- Added command-registration disposal cleanup for disposable Pi command hosts, including idempotent dispose behavior and clean re-registration after dispose.
- Released owned internal patch context state during extension disposal to keep repeated registration lifecycles isolated.

### Changed

- Expanded tests for duplicate-registration disposal lifecycle and nested tree rendering; current validation covers 12 Node tests.
- Updated package and user-facing status/help version strings for the v0.1.1 Session B audit bugfix patch.

## [0.1.0] - 2026-04-30

### Added

- Hardened slash-free Pi command registration for `/zerg`, `/zerg-swarm`, and `/swarm` command aliases.
- Added Pi-shaped command handler notifications for help, status, tree, and thinking-step parser output.
- Added command-surface tests for aliases, normalization, unknown usage, multiline steps, and duplicate registration.

### Changed

- Updated package metadata and user-facing scaffold status/help text for the v0.1.0 command-surface milestone.

### Not Yet Implemented

- Real subagent spawning, team runtime/loops, task queues, live Pi TUI overlays, and manual/automation intervention controls remain planned.

## [0.0.0] - 2026-04-30

### Added

- Initial Pi extension package scaffold with `pi.extensions` pointing to `./index.ts`.
- Strict TypeScript no-emit configuration and Node test script.
- Structural contracts for commands, agents, tasks, hook events, state, and minimal Pi context support.
- Pure thinking-step parser, state helpers, text renderers, and no-op-safe internal patch bridge.
- Public README, MIT license, and parser tests for the bootstrap surface.

### Not Yet Implemented

- Real subagent spawning, team loops, task queues, live Pi TUI overlays, and manual/automation intervention controls.
