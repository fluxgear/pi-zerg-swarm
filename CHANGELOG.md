# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to semantic versioning after the bootstrap line is established.


## [Unreleased]

## [1.0.0-rc.2] - 2026-05-05

### Added

- Added release-candidate notes for the single `v1.0.0-rc.2` gate and the mandatory RC audit set.

### Changed

- Bumped package manifest versions from `0.9.1` to `1.0.0-rc.2` in `package.json` and `package-lock.json` (top-level + root package).
- Updated README current-candidate wording, runtime/help strings, and matching tests from `v0.9.1` to `v1.0.0-rc.2`.
- Finalized candidate metadata without introducing new feature scope.

### Known Limitations

- `npm run check:version` is a post-tag confirmation; skip it during pre-tag RC prep until `v1.0.0-rc.2` exists at `HEAD`.
- Manual end-to-end smoke for TUI, lifecycle, intervention, and mode switching remains required before tagging.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.1] - 2026-05-05

### Added

- Added canonical repository metadata for the public GitHub repository in `package.json` so npm/`pi` consumers can discover and verify project origin: `git+https://github.com/fluxgear/pi-zerg-swarm.git`.
- Documented publication/readiness status updates for README/CHANGELOG and check:version guidance in public docs.

### Changed

- Bumped package manifest versions from `0.9.0` to `0.9.1` in `package.json` and `package-lock.json` (top-level + root package).
- Updated current-release wording from v0.9.0 to v0.9.1 in public release notes.

### Fixed

- Polished README and changelog `check:version` guidance to reflect state-aware, post-tag behavior.
- Removed stale statements claiming canonical repository metadata was still unavailable.
- Updated publication-readiness wording so repository metadata and release checks are documented as resolved for v0.9.1.

### Known Limitations

- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.9.0] - 2026-05-04

### Added

- Added v0.9.0 release-prep documentation polish for README hierarchy, Mermaid visuals, and truthful current-release status.
- Added release/package-readiness context for package-check behavior and post-tag `check:version` expectations.

### Changed

- Updated release messaging in public docs and version references from v0.8.1 to v0.9.0 while preserving completed milestone history.
- Bumped package metadata versions from `0.8.1` to `0.9.0` in package manifest files.
- Reserved the follow-up audit backlog (`prompts/audit/themed-cleanup_v2-0-0.md` and `prompts/audit/generalized-deep-audit_v2-0-0.md`) for v0.9.1.

### Known Limitations

- `npm run check:version` is a post-tag check; pre-tag release-prep failures were expected while `v0.9.0` was not yet tagged.
- Live TUI overlays, chat, and external transport remain unimplemented and unvalidated.

## [0.8.1] - 2026-05-04

### Fixed

- Split the v0.8.0 audit follow-ups into an audit bugfix patch release.
- Added direct `renderHelp` header regression coverage and renamed stale v0.7-labeled intervention/render test titles to version-neutral wording.

### Changed

- Bumped package/package-lock top-level versions to `0.8.1`.
- Updated README and changelog release references plus command/status/help/runtime version strings and matching tests to v0.8.1 while preserving v0.8.0 as the completed package-readiness/config-hardening implementation milestone.

## [0.8.0] - 2026-05-03

### Added

- Added package-readiness/config-hardening release checks (`check:package`, `check:version`) and private-path build/package guards for `prompts`, `planning`, `.pi`, `.claude`, `.codex`, and `.agents` to prevent release/compile leakage.
- Added package metadata validation for MIT license consistency and package-lock sync checks, with repository metadata warning until canonical URL is configured.

### Changed

- Bumped package/package-lock top-level versions to `0.8.0` and aligned command/status/render/help surfaces and tests to the same release surface.
- Updated README roadmap, development script guidance, and changelog scope statements for v0.8.0 package/readiness hardening.

### Known Limitations

- Canonical repository URL is still unavailable in this environment; `check:package` warns about missing repository metadata until configured.

## [0.7.1] - 2026-05-03

### Fixed

- Fixed read-only `/zerg mode status` handling so status is available without writable-state permission.
- Fixed `/zerg mode revert` to clear `contextId` when reverting to the prior mode snapshot.
- Added regression coverage for invalid mode actions and invalid mode reasons (control-only and overlong), asserting rejection without state mutation.

## [0.7.0] - 2026-05-03

### Added

- Added command-host control grammar for `/zerg mode status|manual|assisted|automatic|revert [reason]` and `/zerg intervene agent|subagent|leader ...` without enabling live external transport.
- Added fake-Pi/shared-state regression coverage for registered command-host mode transitions and intervention recording paths.

### Changed

- Promoted package metadata and public version/help/status surfaces to v0.7.0.
- Mode control now records auditable and reversible global `state.mode` transitions including controller and prior-mode snapshots.
- Intervention records are sanitized and bounded before persistence, and rendered across status/help/tree surfaces with active target markers and previews.

### Known Limitations

- Live TUI overlays and chat/external process/network transport remain planned and unvalidated for this release.

## [0.6.1] - 2026-05-02

### Fixed

- Fixed v0.6.1 audit regressions in runtime monitoring: same-timestamp lifecycle activity ordering, explicit-tree runtime hints, sanitized runtime activity output, and fallback to the newest displayable activity.

## [0.6.0] - 2026-05-02

### Added

- Added subagent runtime and monitoring state for agent/team lifecycle transitions, runtime health, task/activity snapshots, and shared Pi command/event-bus reporting.
- Added fake-Pi lifecycle and monitoring regression coverage for `/zerg` agent/team create/progress/stop flows, latest activity, and tree runtime hints.

### Changed

- Promoted package metadata and command/status/help/test version surfaces to v0.6.0 for the subagent runtime and monitoring milestone.

### Known Limitations

- Manual Pi host command/runtime validation has been performed for /zerg help/status/tree and agent/team lifecycle commands in a tmux pseudo-TTY; live TUI overlay/intervention validation has not been performed, so avoid claiming live overlay validation has passed.

## [0.5.1] - 2026-05-02

### Fixed

- Fixed fallback tree rendering to honor `AgentIdentity.childIds`-only hierarchy without duplicate roots while preserving cycle and truncation guards.
- Added bounded explicit-tree missing-child markers and durable render regression coverage for fallback childIds, explicit missing/orphan/duplicate/selected/cycle paths, team fallback, truncation, and non-mutation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.1 for the audit bugfix patch.

## [0.5.0] - 2026-05-02

### Added

- Added expanded render/tree visibility for explicit `state.tree` nodes, team/agent fallback hierarchies, selected/status markers, orphan/missing-child/cycle safety, duplicate suppression, and bounded output with truncation.

### Changed

- Promoted package metadata and public command/status/help/docs/test version surfaces to v0.5.0 for the render/tree milestone.

### Known Limitations

- Manual Pi overlay verification has not been performed; live TUI overlays, subagent runtime loops, task queues, and intervention controls remain planned.

## [0.4.1] - 2026-05-02

### Fixed

- Fixed audit release-hygiene drift by aligning package metadata, command/status/help output, README current-release wording, tests, and the top changelog section on v0.4.1.
- Clarified this patch as a consistency-only audit bugfix while preserving v0.4.0 as the historical internal-patch milestone.

## [0.4.0] - 2026-05-01

### Added

- Added safe Pi event-bus internal bridge validation for emit and subscription observation, including focused regression coverage for forwarding `eventBus.on(...)` subscriptions and preserving original disposable return values.
- Added regression coverage for duplicate controllers sharing one Pi event bus so duplicate installation does not double-observe subscriptions or restore the active wrapper.

### Changed

- Promoted command/status/help/docs public version surfaces to v0.4.0 for the internal patch milestone.

### Fixed

- Preserved event-bus wrapper behavior after duplicate-controller disposal and verified no subscription telemetry is recorded after the active patch is disposed.

## [0.3.0] - 2026-05-01

### Added

- Added deterministic thinking-step derivation with source-line IDs, LF/CRLF parity, explicit status aliases, checkbox precedence, malformed-input skipping, and `/zerg steps` integration coverage.
- Expanded regression coverage for ordinary hyphenated bullet, numbered, star, and checkbox titles.

### Changed

- Promoted user-facing command/status/help version strings to v0.3.0 for the parse/thinking-step milestone.

### Fixed

- Required known status prefixes to use `:`/`：` or a whitespace-delimited hyphen separator, preserving titles such as `done-task`, `failed-first`, `todo-list`, and `needs-attention-task` instead of truncating them.

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
