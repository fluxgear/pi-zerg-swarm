import { installInternalPatch } from './internal-patch.js';
import { deriveThinkingSteps } from './parse.js';
import { renderAgentDefinitionSummary, renderAgentDefinitionsList, renderAgentTree, renderHelp, renderMonitor, renderStatusLine, renderZergSubagentRunList, renderZergSubagentRunSummary } from './render.js';
import { applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createZergStateContainer, createZergSubagentRunSnapshot, getAgentDefinition, getAgentDefinitions, getSubagentRunSnapshot, getSubagentRunSnapshots, readSharedZergState, replaceSharedZergState, seedBuiltinAgentDefinitions, snapshotZergState } from './state.js';
import { ZERG_COMMANDS, type AgentStatus, type AutomationMode, type PermissionModeTransitionInput, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type StructuralPiTuiHandle, type ZergCommandName, type ZergCommandResult, type ZergConfigOverlayTab, type ZergControlState, type ZergControlController, type ZergInternalPatchController, type ZergPiCommandHandler, type ZergRuntimeEntity, type ZergRuntimeTransition, type ZergRuntimeTransitionAction, type ZergState, type ZergStateContainer, type ZergSubagentControlAdapter, type ZergSubagentLaunchRequest, type ZergSubagentRunSnapshot } from './types.js';

export interface ZergCommandHandlerOptions {
  now?: () => Date;
  subagentAdapter?: ZergSubagentControlAdapter;
}

type RuntimeCommandOptions = ZergCommandHandlerOptions & { syncSharedState?: boolean };

export interface ZergExtensionRegistration {
  commands: ZergCommandName[];
  /**
   * Snapshot of extension state at access time.
   *
   * Treat this as a read-only view: mutating the returned object does not update
   * live extension or shared state. Use state helpers or ZergStateContainer
   * read/update/replace APIs as the write channel.
   */
  readonly state: ZergState;
  patchInstalled: boolean;
  dispose(): void;
}

type ZergCommandTopic = 'help' | 'status' | 'tree' | 'steps' | 'agent' | 'team' | 'mode' | 'intervene' | 'monitor' | 'control' | 'config' | 'run' | 'interrupt' | 'agents' | 'runs';
type ZergCommandDispatcher = (payload: string) => ZergCommandResult;
type RuntimeParseResult = { ok: false; output: string } | { ok: true; transition: ZergRuntimeTransition };

type ModeTransitionAction = 'status' | 'manual' | 'assisted' | 'automatic' | 'revert';
type ModeParseResult =
  | { ok: false; output: string }
  | { ok: true; action: ModeTransitionAction; reason?: string };
type InterveneKind = 'agent' | 'subagent' | 'leader';
type InterveneParseResult =
  | { ok: false; output: string }
  | {
    ok: true;
    kind: InterveneKind;
    targetId: string;
    targetLabel?: string;
    teamId?: string;
    leaderAgentId?: string;
    message: string;
  };
type ZergStateSource = ZergState | (() => ZergState) | ZergStateContainer;

const RUNTIME_WRITABLE_STATE_ERROR = 'Runtime lifecycle commands require writable zerg state.';
const MAX_INTERVENTION_MESSAGE_LENGTH = 240;
const MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS = 140;
const ZERG_CONTROL_EXTENSION_KEY = 'zergControl';
const CONFIG_OVERLAY_TABS: ZergConfigOverlayTab[] = ['monitor', 'control', 'targets', 'config'];
const SLASH_SUBAGENT_REQUEST_EVENT = 'subagent:slash:request';
const SLASH_SUBAGENT_STARTED_EVENT = 'subagent:slash:started';
const SLASH_SUBAGENT_RESPONSE_EVENT = 'subagent:slash:response';
const SLASH_SUBAGENT_UPDATE_EVENT = 'subagent:slash:update';
const SLASH_SUBAGENT_CANCEL_EVENT = 'subagent:slash:cancel';


interface NormalizedZergCommandInput {
  topic: string;
  payload: string;
}

interface SelectedCommandRegistrar {
  target: object;
  registerCommand(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
}

interface RegisteredCommandDisposer {
  target: object;
  name: ZergCommandName;
  dispose(): void;
}

interface DisposableRegistration {
  dispose(): void;
}

const registeredCommandsByTarget = new WeakMap<object, Set<ZergCommandName>>();

export function registerZergSwarmExtension(
  context: StructuralPiExtensionContext = {},
  options: ZergCommandHandlerOptions = {},
): ZergExtensionRegistration {
  const sharedSeedSource = readSharedZergState();
  const sharedSeed = seedBuiltinAgentDefinitions(sharedSeedSource);
  const stateContainer = createZergStateContainer(sharedSeed);
  if (sharedSeed !== sharedSeedSource) {
    replaceSharedZergState(sharedSeed);
  }
  let patch: ZergInternalPatchController | undefined;
  const commandDisposers: RegisteredCommandDisposer[] = [];

  const syncSharedStateFromContainer = () => {
    replaceSharedZergState(stateContainer.snapshot());
  };

  const syncedStateContainer: ZergStateContainer = {
    read: () => stateContainer.read(),
    snapshot: () => stateContainer.snapshot(),
    replace: (nextState) => {
      const snapshot = stateContainer.replace(nextState);
      syncSharedStateFromContainer();
      return snapshot;
    },
    update: (nextState, patchOptions) => {
      const snapshot = stateContainer.update(nextState, patchOptions);
      syncSharedStateFromContainer();
      return snapshot;
    },
    subscribe: (listener) => stateContainer.subscribe?.(listener) ?? (() => undefined),
  };
  const subagentAdapter = options.subagentAdapter ?? createPiSlashBridgeAdapter(context, syncedStateContainer, { ...options, syncSharedState: true } as RuntimeCommandOptions);

  try {
    const installedPatch = installInternalPatch(context, syncedStateContainer);
    patch = installedPatch;
    const handler = createPiZergCommandHandler(syncedStateContainer, { ...options, subagentAdapter, syncSharedState: true } as RuntimeCommandOptions);

    for (const name of ZERG_COMMANDS) {
      const commandDisposer = registerCommand(context, {
        name,
        description: 'Show pi-zerg-swarm command-surface status and help.',
        handler,
      });

      if (commandDisposer) {
        commandDisposers.push(commandDisposer);
      }
    }

    patch.emit({
      type: 'hook',
      message: patch.installed
        ? 'pi-zerg-swarm v1.0.0-rc.4 internal patch path active'
        : 'pi-zerg-swarm v1.0.0-rc.4 internal patch unavailable; command surface registered',
      status: patch.installed ? 'running' : 'done',
    });
  } catch (error) {
    disposeStartupResources(commandDisposers, patch);
    throw error;
  }

  const installedPatch = patch;
  let disposed = false;

  return {
    commands: [...ZERG_COMMANDS],
    get state() {
      return stateContainer.snapshot();
    },
    patchInstalled: installedPatch.installed,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      let firstError: unknown;

      for (const commandDisposer of commandDisposers.splice(0)) {
        try {
          commandDisposer.dispose();
        } catch (error) {
          firstError ??= error;
        } finally {
          clearRegisteredCommand(commandDisposer.target, commandDisposer.name);
        }
      }

      try {
        installedPatch.dispose();
      } catch (error) {
        firstError ??= error;
      }

      try {
        subagentAdapter.dispose?.();
      } catch (error) {
        firstError ??= error;
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}

function disposeStartupResources(
  commandDisposers: RegisteredCommandDisposer[],
  patch: ZergInternalPatchController | undefined,
): void {
  for (const commandDisposer of commandDisposers.splice(0)) {
    try {
      commandDisposer.dispose();
    } catch {
      // Preserve the original startup error while still clearing local registration bookkeeping.
    } finally {
      clearRegisteredCommand(commandDisposer.target, commandDisposer.name);
    }
  }

  try {
    patch?.dispose();
  } catch {
    // Preserve the original startup error; normal dispose() still surfaces cleanup failures.
  }
}

const PI_COMMAND_OUTPUT_WIDTH = 240;

export function createZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): (input?: string) => ZergCommandResult {
  const dispatchers: Record<ZergCommandTopic, ZergCommandDispatcher> = {
    help: () => ({ ok: true, output: renderHelp(resolveZergStateSnapshot(stateOrReader)) }),
    status: () => ({ ok: true, output: renderStatusLine(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }) }),
    tree: () => ({ ok: true, output: renderAgentTree(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }) }),
    steps: (payload: string) => {
      const steps = deriveThinkingSteps(payload);
      const output = steps.length
        ? steps.map((step) => `${step.sourceLine}. [${step.status}] ${step.title}`).join('\n')
        : 'No thinking steps detected.';
      return { ok: true, output };
    },
    agents: (payload: string) => dispatchAgentDefinitionsCommand(stateOrReader, payload),
    agent: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'agent', payload, options),
    team: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'team', payload, options),
    mode: (payload: string) => dispatchModeCommand(stateOrReader, payload, options),
    intervene: (payload: string) => dispatchInterventionCommand(stateOrReader, payload, options),
    monitor: (payload: string) => dispatchMonitorCommand(stateOrReader, payload, options),
    control: (payload: string) => dispatchControlCommand(stateOrReader, payload, options),
    config: () => ({ ok: true, output: renderZergConfigOverlay(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH, activeTab: 'config', selectedIndex: 0 }) }),
    run: (payload: string) => dispatchRunCommand(stateOrReader, payload, options),
    runs: (payload: string) => dispatchRunsCommand(stateOrReader, payload, options),
    interrupt: (payload: string) => dispatchInterruptCommand(payload, options),
  };

  return (input?: string): ZergCommandResult => {
    const normalized = normalizeZergCommandInput(input);

    if (isZergCommandTopic(normalized.topic)) {
      return dispatchers[normalized.topic](normalized.payload);
    }

    return {
      ok: false,
      output: `Unknown zerg command: ${normalized.topic}\n\n${renderHelp(resolveZergStateSnapshot(stateOrReader))}`,
    };
  };
}

function normalizeZergCommandInput(input?: string): NormalizedZergCommandInput {
  const commandText = (input ?? '').trim();

  if (!commandText) {
    return { topic: 'help', payload: '' };
  }

  const routedText = stripOptionalZergInvocation(commandText);
  const topicMatch = routedText.match(/^(\S+)/);

  if (!topicMatch) {
    return { topic: 'help', payload: '' };
  }

  return {
    topic: topicMatch[1].toLowerCase(),
    payload: routedText.slice(topicMatch[0].length).trimStart(),
  };
}

function stripOptionalZergInvocation(input: string): string {
  const tokenMatch = input.match(/^(\S+)/);

  if (!tokenMatch) {
    return '';
  }

  const token = tokenMatch[1];
  const slashlessToken = token.startsWith('/') ? token.slice(1) : token;

  if (!isZergInvocationToken(slashlessToken.toLowerCase())) {
    return input;
  }

  return input.slice(token.length).trimStart();
}

function isZergInvocationToken(value: string): value is ZergCommandName {
  return (ZERG_COMMANDS as readonly string[]).includes(value);
}

function isZergCommandTopic(value: string): value is ZergCommandTopic {
  return value === 'help' || value === 'status' || value === 'tree' || value === 'steps' || value === 'agents' || value === 'agent' || value === 'team' || value === 'mode' || value === 'intervene' || value === 'monitor' || value === 'control' || value === 'config' || value === 'run' || value === 'runs' || value === 'interrupt';
}

function dispatchAgentDefinitionsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
): ZergCommandResult {
  const snapshot = resolveZergStateSnapshot(stateOrReader);
  const definitions = getAgentDefinitions(snapshot);
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase();

  if (!action || action === 'list' || action === 'ls') {
    if (definitions.length === 0) {
      return { ok: true, output: 'No agent definitions are currently registered.' };
    }

    return {
      ok: true,
      output: renderAgentDefinitionsList(definitions, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (action === 'show') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg agents show <id>' };
    }

    const definition = getAgentDefinition(snapshot, id);
    if (!definition) {
      return { ok: false, output: `Unknown agent definition: ${id}` };
    }

    return {
      ok: true,
      output: renderAgentDefinitionSummary(definition, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  return {
    ok: false,
    output: `Unknown agents action: ${action}. Available: /zerg agents list, /zerg agents show <id>`,
  };
}

function dispatchRuntimeCommand(
  stateOrReader: ZergStateSource,
  entity: ZergRuntimeEntity,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const parsed = parseRuntimeTransition(entity, payload);

  if (!parsed.ok) {
    return parsed;
  }

  const nextState = applyRuntimeTransition(container.read(), parsed.transition, {
    now: options.now ?? (() => new Date()),
  });
  const snapshot = container.replace(nextState);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return {
    ok: true,
    output: `${parsed.transition.entity} ${parsed.transition.id} ${parsed.transition.action} applied.\n${renderStatusLine(snapshot, { width: PI_COMMAND_OUTPUT_WIDTH })}`,
  };
}


function dispatchModeCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const parsed = parseModeCommand(payload);

  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.action === 'status') {
    return {
      ok: true,
      output: renderStatusLine(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (parsed.action === 'revert') {
    const current = container.read();
    const previousMode = current.mode.previousMode;

    if (!previousMode) {
      return { ok: false, output: 'No prior mode snapshot to revert to.' };
    }

    const nextState = applyModeTransition(
      current,
      {
        automation: previousMode.automation,
        controller: previousMode.controller,
        interventionEnabled: previousMode.interventionEnabled,
        contextId: previousMode.contextId,
        reason: parsed.reason,
        clearActiveIntervention: true,
      },
      {
        now: options.now ?? (() => new Date()),
      },
    );
    const snapshot = container.replace(nextState);
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }

    return { ok: true, output: renderModeTransitionStatus(snapshot, 'mode reverted') };
  }

  const transition: PermissionModeTransitionInput = {
    automation: parsed.action,
    controller: parsed.action === 'automatic' ? 'automation' : 'operator',
    interventionEnabled: true,
    reason: parsed.reason,
    clearActiveIntervention: true,
  };
  const nextState = applyModeTransition(container.read(), transition, {
    now: options.now ?? (() => new Date()),
  });
  const snapshot = container.replace(nextState);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return { ok: true, output: renderModeTransitionStatus(snapshot, `mode set to ${parsed.action}`) };
}

function dispatchInterventionCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const parsed = parseInterventionCommand(container.read(), payload);

  if (!parsed.ok) {
    return parsed;
  }

  const nextState = applyInterventionRecord(
    container.read(),
    {
      kind: parsed.kind,
      targetId: parsed.targetId,
      targetLabel: parsed.targetLabel,
      teamId: parsed.teamId,
      leaderAgentId: parsed.leaderAgentId,
      message: parsed.message,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );

  const snapshot = container.replace(nextState);

  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }

  return {
    ok: true,
    output: parsed.kind === 'leader'
      ? `intervention recorded against leader ${parsed.targetId} (team ${parsed.teamId}): ${parsed.message}`
      : `intervention recorded against ${parsed.kind} ${parsed.targetId}: ${parsed.message}`,
  };
}

function dispatchMonitorCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const normalizedPayload = tokenizeRuntimePayload(payload);
  const normalizedTopic = normalizedPayload[0]?.toLowerCase();
  const argument = normalizedPayload[1]?.toLowerCase();
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (!normalizedTopic || normalizedTopic === 'status') {
    return {
      ok: true,
      output: renderMonitor(snapshot, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (isReadOnlyTopic(normalizedTopic)) {
    const container = getWritableStateContainer(stateOrReader);

    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }

    if (!argument || argument === 'status') {
      const currentValue = Boolean(container.read().mode.readOnly);
      return {
        ok: true,
        output: `monitor read-only is currently ${currentValue ? 'enabled' : 'disabled'}`,
      };
    }

    const snapshotWithReadOnly = setReadOnlyMode(container, argument, options, 'monitor');

    if (typeof snapshotWithReadOnly === 'string') {
      return { ok: false, output: snapshotWithReadOnly };
    }

    return {
      ok: true,
      output: renderMonitor(snapshotWithReadOnly, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  return { ok: false, output: `Unknown monitor action: ${normalizedPayload[0] ?? ''}` };
}

function dispatchRunCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const current = resolveZergStateSnapshot(stateOrReader);
  if (current.mode.readOnly) {
    return { ok: false, output: 'zerg run is blocked while read-only is enabled. Use /zerg control readonly off to allow subagent control.' };
  }

  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable') {
    return { ok: false, output: 'No Pi subagent adapter is available. Load pi-subagents or provide a ZergSubagentControlAdapter.' };
  }

  const parsed = parseRunCommand(payload);
  if (!parsed.ok) {
    return parsed;
  }

  const result = adapter.launch(parsed.request);
  return { ok: result.ok, output: result.message };
}

function dispatchRunsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const adapter = options.subagentAdapter;
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase();
  const runId = tokens[1];
  const runs = resolveAvailableRuns(stateOrReader, adapter);

  if (!action || action === 'list' || action === 'ls') {
    return {
      ok: true,
      output: renderZergSubagentRunList(runs, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  if (action === 'show') {
    if (!runId) {
      return { ok: false, output: 'Usage: /zerg runs show <run-id>' };
    }

    const match = adapter?.getRun?.(runId) ?? getSubagentRunSnapshot(resolveZergStateSnapshot(stateOrReader), runId);
    if (!match) {
      return { ok: false, output: `Unknown run: ${runId}` };
    }

    return {
      ok: true,
      output: renderZergSubagentRunSummary(match, { width: PI_COMMAND_OUTPUT_WIDTH }),
    };
  }

  return {
    ok: false,
    output: `Unknown runs action: ${action}. Available: /zerg runs list | /zerg runs show <run-id>`,
  };
}

function dispatchInterruptCommand(payload: string, options: RuntimeCommandOptions): ZergCommandResult {
  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable' || typeof adapter.interrupt !== 'function') {
    return { ok: false, output: 'No interrupt-capable Pi subagent adapter is available.' };
  }

  const [runId] = tokenizeRuntimePayload(payload);
  const result = adapter.interrupt(runId);
  return { ok: result.ok, output: result.message };
}

function dispatchControlCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const topic = tokens[0]?.toLowerCase() ?? 'status';
  const argument = tokens[1]?.toLowerCase();

  if (topic === 'status') {
    return { ok: true, output: renderZergControlStatus(resolveZergStateSnapshot(stateOrReader), PI_COMMAND_OUTPUT_WIDTH) };
  }

  const container = getWritableStateContainer(stateOrReader);

  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (isReadOnlyTopic(topic)) {
    if (!argument || argument === 'status') {
      return { ok: true, output: `control read-only is currently ${container.read().mode.readOnly ? 'enabled' : 'disabled'}` };
    }

    const snapshot = setReadOnlyMode(container, argument, options, 'control');
    if (typeof snapshot === 'string') {
      return { ok: false, output: snapshot };
    }
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  if (topic === 'controller') {
    if (!argument || argument === 'status') {
      return { ok: true, output: `zerg controller is ${getZergControlState(container.read()).controller}` };
    }

    if (!isZergControlController(argument)) {
      return { ok: false, output: `Unknown control controller: ${argument}` };
    }

    const snapshot = updateZergControlState(container, { controller: argument }, `controller set to ${argument}`, options);
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  if (topic === 'mode') {
    if (!argument || !isAutomationMode(argument)) {
      return { ok: false, output: `Unknown control mode: ${argument ?? ''}` };
    }

    const snapshot = setAutomationMode(container, argument, options);
    return { ok: true, output: renderZergControlStatus(snapshot, PI_COMMAND_OUTPUT_WIDTH) };
  }

  return { ok: false, output: `Unknown control action: ${tokens[0] ?? ''}` };
}


function parseRunCommand(payload: string): { ok: false; output: string } | { ok: true; request: ZergSubagentLaunchRequest } {
  const tokens = tokenizeRuntimePayload(payload);
  let background = false;
  let fork = false;
  const filtered: string[] = [];
  for (const token of tokens) {
    if (token === '--bg' || token === '--background') {
      background = true;
    } else if (token === '--fork') {
      fork = true;
    } else {
      filtered.push(token);
    }
  }

  const [agent, ...taskTokens] = filtered;
  if (!agent) {
    return { ok: false, output: 'Usage: /zerg run <agent> <task> [--bg] [--fork]' };
  }

  const task = taskTokens.join(' ').trim();
  if (!task) {
    return { ok: false, output: 'zerg run requires a non-empty task.' };
  }

  return { ok: true, request: { agent, task, background, fork } };
}

function parseModeCommand(payload: string): ModeParseResult {
  const [actionToken, ...rest] = tokenizeRuntimePayload(payload);
  const normalizedAction = actionToken?.toLowerCase() ?? 'status';

  if (normalizedAction === 'status' || normalizedAction === '') {
    return { ok: true, action: 'status' };
  }

  if (!isModeTransitionAction(normalizedAction)) {
    return { ok: false, output: `Unknown mode action: ${actionToken ?? ''}` };
  }

  const reason = normalizeInterventionText(rest.join(' '), MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);

  if (rest.length > 0 && !reason) {
    return { ok: false, output: `mode reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
  }

  return { ok: true, action: normalizedAction, reason: reason || undefined };
}

function parseInterventionCommand(state: ZergState, payload: string): InterveneParseResult {
  const [targetKindToken, id, ...messageTokens] = tokenizeRuntimePayload(payload);
  const normalizedKind = targetKindToken?.toLowerCase();

  if (!isInterventionKind(normalizedKind)) {
    return { ok: false, output: `Unknown intervention target: ${targetKindToken ?? ''}` };
  }

  if (!id) {
    return { ok: false, output: `intervene ${normalizedKind} requires an id.` };
  }

  const messageText = messageTokens.join(' ');
  const message = normalizeInterventionText(messageText);
  if (!messageText.trim()) {
    return { ok: false, output: 'intervene requires a non-empty message.' };
  }

  if (!message) {
    return { ok: false, output: `intervention message exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH} characters or contains only control characters.` };
  }

  if (normalizedKind === 'leader') {
    const team = state.teams[id];
    if (!team) {
      return { ok: false, output: `Cannot intervene leader for unknown team: ${id}` };
    }

    if (!team.leaderAgentId) {
      return { ok: false, output: `Team ${id} has no leader to intervene.` };
    }

    const leader = state.agents[team.leaderAgentId];
    if (!leader) {
      return { ok: false, output: `Team ${id} leader ${team.leaderAgentId} is missing.` };
    }

    return {
      ok: true,
      kind: normalizedKind,
      targetId: leader.id,
      targetLabel: leader.label,
      teamId: team.id,
      leaderAgentId: leader.id,
      message,
    };
  }

  const agent = state.agents[id];
  if (!agent) {
    return { ok: false, output: `Cannot intervene ${normalizedKind} for unknown agent: ${id}` };
  }

  if (normalizedKind === 'subagent' && agent.kind !== 'subagent') {
    return { ok: false, output: `intervene subagent requires target agent to be subagent: ${id}` };
  }

  return {
    ok: true,
    kind: normalizedKind,
    targetId: id,
    targetLabel: agent.label,
    message,
  };
}

function isModeTransitionAction(value: string): value is ModeTransitionAction {
  return value === 'status' || value === 'manual' || value === 'assisted' || value === 'automatic' || value === 'revert';
}

function isInterventionKind(value: string | undefined): value is InterveneKind {
  return value === 'agent' || value === 'subagent' || value === 'leader';
}

function renderModeTransitionStatus(state: ZergState, message: string): string {
  return `${message}
${renderStatusLine(state, { width: PI_COMMAND_OUTPUT_WIDTH })}`;
}

function normalizeInterventionText(input: string, maxLength = MAX_INTERVENTION_MESSAGE_LENGTH): string {
  const sanitized = input
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized || sanitized.length === 0) {
    return '';
  }

  if (sanitized.length > maxLength) {
    return '';
  }

  return sanitized;
}


function parseRuntimeTransition(entity: ZergRuntimeEntity, payload: string): RuntimeParseResult {
  const [actionToken, id, ...rest] = tokenizeRuntimePayload(payload);
  const action = actionToken?.toLowerCase();

  if (!isRuntimeAction(action)) {
    return { ok: false, output: `Unknown ${entity} runtime action: ${actionToken ?? ''}` };
  }

  if (!id) {
    return { ok: false, output: `${entity} ${action} requires an id.` };
  }

  const text = rest.join(' ').trim();
  const common = {
    action,
    id,
    ...(action === 'create' && text ? { label: text } : {}),
    ...((action === 'progress' || action === 'fail') && text ? { activity: text } : {}),
  } as const;

  if (entity === 'agent') {
    return { ok: true, transition: { entity: 'agent', ...common } };
  }

  return { ok: true, transition: { entity: 'team', ...common } };
}

function tokenizeRuntimePayload(payload: string): string[] {
  const tokens: string[] = [];
  const matcher = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(payload)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  return tokens;
}

function isRuntimeAction(value: string | undefined): value is ZergRuntimeTransitionAction {
  return value === 'create' || value === 'start' || value === 'progress' || value === 'stop' || value === 'fail' || value === 'reset';
}

function resolveAvailableRuns(
  stateOrReader: ZergStateSource,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergSubagentRunSnapshot[] {
  const stateRuns = getSubagentRunSnapshots(resolveZergStateSnapshot(stateOrReader));
  const runsById = new Map(stateRuns.map((run) => [run.runId, run]));
  const adapterRuns = typeof adapter?.listRuns === 'function' ? adapter.listRuns() : undefined;

  if (adapterRuns) {
    for (const run of adapterRuns) {
      const snapshot = createZergSubagentRunSnapshot(run);
      const existing = runsById.get(snapshot.runId);
      runsById.set(snapshot.runId, existing ? createZergSubagentRunSnapshot({ ...existing, ...snapshot }) : snapshot);
    }
  }

  return [...runsById.values()]
    .map((run) => createZergSubagentRunSnapshot(run))
    .sort((left, right) => {
      const leftTimestamp = left.startedAt ?? left.updatedAt ?? '';
      const rightTimestamp = right.startedAt ?? right.updatedAt ?? '';
      return rightTimestamp.localeCompare(leftTimestamp) || left.runId.localeCompare(right.runId);
    });
}

function getWritableStateContainer(stateOrReader: ZergStateSource): ZergStateContainer | undefined {
  return isZergStateContainer(stateOrReader) ? stateOrReader : undefined;
}

function isZergStateContainer(value: ZergStateSource): value is ZergStateContainer {
  return typeof value === 'object'
    && value !== null
    && typeof (value as Partial<ZergStateContainer>).read === 'function'
    && typeof (value as Partial<ZergStateContainer>).snapshot === 'function'
    && typeof (value as Partial<ZergStateContainer>).replace === 'function'
    && typeof (value as Partial<ZergStateContainer>).update === 'function';
}

function subscribeToZergState(stateOrReader: ZergStateSource, listener: () => void): () => void {
  if (isZergStateContainer(stateOrReader) && typeof stateOrReader.subscribe === 'function') {
    return stateOrReader.subscribe(listener);
  }

  return () => undefined;
}

function isReadOnlyTopic(value: string): boolean {
  return value === 'readonly' || value === 'read-only' || value === 'ro';
}

function parseReadOnlyValue(value: string, currentValue: boolean): boolean | undefined {
  return value === 'on'
    ? true
    : value === 'off'
      ? false
      : value === 'enable'
        ? true
        : value === 'disable'
          ? false
          : value === 'true'
            ? true
            : value === 'false'
              ? false
              : value === 'toggle'
                ? !currentValue
                : undefined;
}

function setReadOnlyMode(
  container: ZergStateContainer,
  value: string,
  options: RuntimeCommandOptions,
  source: string,
): ZergState | string {
  const current = container.read();
  const targetValue = parseReadOnlyValue(value, Boolean(current.mode.readOnly));

  if (targetValue === undefined) {
    return `Unknown ${source} readonly value: ${value}`;
  }

  const nextState = applyModeTransition(
    current,
    {
      automation: current.mode.automation,
      controller: current.mode.controller,
      interventionEnabled: current.mode.interventionEnabled,
      readOnly: targetValue,
      reason: `${source} read-only ${targetValue ? 'enabled' : 'disabled'}`,
      clearActiveIntervention: false,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );

  const snapshot = container.replace(nextState);
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  return snapshot;
}

function setAutomationMode(container: ZergStateContainer, automation: AutomationMode, options: RuntimeCommandOptions): ZergState {
  const current = container.read();
  const nextState = applyModeTransition(
    current,
    {
      automation,
      controller: automation === 'automatic' ? 'automation' : 'operator',
      interventionEnabled: current.mode.interventionEnabled,
      readOnly: current.mode.readOnly,
      reason: `overlay mode set to ${automation}`,
      clearActiveIntervention: false,
    },
    {
      now: options.now ?? (() => new Date()),
    },
  );
  const snapshot = container.replace(nextState);
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  return snapshot;
}

function getZergControlState(state: ZergState): ZergControlState {
  const candidate = state.extensions[ZERG_CONTROL_EXTENSION_KEY] as Partial<ZergControlState> | undefined;
  const controller = isZergControlController(candidate?.controller) ? candidate.controller : 'operator';
  return {
    controller,
    selectedTargetId: typeof candidate?.selectedTargetId === 'string' ? candidate.selectedTargetId : undefined,
    activeRunId: typeof candidate?.activeRunId === 'string' ? candidate.activeRunId : undefined,
    auditLog: Array.isArray(candidate?.auditLog) ? candidate.auditLog.slice(-20) : [],
  };
}

function updateZergControlState(
  container: ZergStateContainer,
  patch: Partial<ZergControlState>,
  message: string,
  options: RuntimeCommandOptions,
): ZergState {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const current = container.read();
  const control = getZergControlState(current);
  const nextControl: ZergControlState = {
    ...control,
    ...patch,
    auditLog: [
      ...(control.auditLog ?? []),
      { id: `control-${current.revision + 1}`, action: 'control', message, createdAt: now },
    ].slice(-20),
  };
  const snapshot = container.update((state) => ({
    extensions: {
      ...state.extensions,
      [ZERG_CONTROL_EXTENSION_KEY]: nextControl,
    },
  }), { updatedAt: now });
  if (options.syncSharedState) {
    replaceSharedZergState(snapshot);
  }
  return snapshot;
}

function isZergControlController(value: unknown): value is ZergControlController {
  return value === 'operator' || value === 'pi' || value === 'zerg';
}

function isAutomationMode(value: string): value is AutomationMode {
  return value === 'manual' || value === 'assisted' || value === 'automatic';
}

function getConfigTargets(state: ZergState): Array<{ id: string; label: string; kind: string; status: string }> {
  return [
    ...Object.values(state.agents).map((agent) => ({ id: agent.id, label: agent.label, kind: agent.kind, status: agent.status })),
    ...Object.values(state.teams).map((team) => ({ id: team.id, label: team.label, kind: team.kind, status: team.status })),
    ...Object.values(state.tasks).map((task) => ({ id: task.id, label: task.title, kind: 'task', status: task.status })),
  ].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function renderZergControlStatus(state: ZergState, width: number): string {
  const control = getZergControlState(state);
  const readOnly = state.mode.readOnly ? 'enabled' : 'disabled';
  const latestAudit = control.auditLog?.at(-1)?.message ?? 'none';
  return [
    'zerg control',
    `controller: ${control.controller}`,
    `mode: ${state.mode.automation}`,
    `read-only: ${readOnly}`,
    `selected target: ${control.selectedTargetId ?? 'none'}`,
    `active run: ${control.activeRunId ?? 'none'}`,
    `adapter: Pi slash bridge when available; commands /zerg run and /zerg interrupt`,
    `latest audit: ${latestAudit}`,
  ].map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line).join('\n');
}

function createPiSlashBridgeAdapter(
  context: StructuralPiExtensionContext,
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
): ZergSubagentControlAdapter {
  const events = context.events;
  if (!events || typeof events.emit !== 'function' || typeof events.on !== 'function') {
    return {
      kind: 'unavailable',
      launch: () => ({ ok: false, message: 'Pi event bus is unavailable for subagent control.' }),
      listAgentDefinitions: () => [],
      getAgentDefinition: () => undefined,
      listRuns: () => [],
      getRun: () => undefined,
    };
  }

  type PendingRun = ZergSubagentRunSnapshot & { launched: boolean; started: boolean; completed: boolean };
  const runsById = new Map<string, PendingRun>();
  const resolveTimestamp = () => (options.now ?? (() => new Date()))().toISOString();

  const refreshRun = (runId: string): ZergSubagentRunSnapshot | undefined => {
    const stateRun = getSubagentRunSnapshot(container.read(), runId);
    const pending = runsById.get(runId);

    if (!stateRun) {
      return pending ? createZergSubagentRunSnapshot(pending) : undefined;
    }

    return createZergSubagentRunSnapshot({
      ...stateRun,
      ...pending,
      task: pending?.task ?? stateRun.task,
      agentId: pending?.agentId ?? stateRun.agentId,
      agentLabel: pending?.agentLabel ?? stateRun.agentLabel,
    });
  };

  const resolveRuns = (): ZergSubagentRunSnapshot[] => {
    const stateRuns = getSubagentRunSnapshots(container.read());
    const merged = new Map<string, ZergSubagentRunSnapshot>();

    for (const stateRun of stateRuns) {
      merged.set(stateRun.runId, createZergSubagentRunSnapshot(stateRun));
    }

    for (const [runId, pending] of runsById) {
      const existing = merged.get(runId);
      if (existing) {
        merged.set(runId, createZergSubagentRunSnapshot({
          ...existing,
          ...pending,
          status: existing.status ?? pending.status,
          task: pending.task ?? existing.task,
          agentId: pending.agentId ?? existing.agentId,
          agentLabel: pending.agentLabel ?? existing.agentLabel,
          updatedAt: existing.updatedAt ?? pending.updatedAt,
          startedAt: existing.startedAt ?? pending.startedAt,
        }));
      } else {
        merged.set(runId, createZergSubagentRunSnapshot(pending));
      }
    }

    return [...merged.values()].sort((left, right) => {
      const leftTimestamp = left.updatedAt ?? left.startedAt ?? '';
      const rightTimestamp = right.updatedAt ?? right.startedAt ?? '';
      return rightTimestamp.localeCompare(leftTimestamp) || left.runId.localeCompare(right.runId);
    });
  };

  const updatePendingRun = (runId: string, status?: AgentStatus, eventTimestamp = resolveTimestamp(), activity?: string): void => {
    const pending = runsById.get(runId);
    if (!pending) {
      return;
    }

    pending.updatedAt = eventTimestamp;
    if (status) {
      pending.status = status;
    }

    if (status === 'running' && !pending.startedAt) {
      pending.startedAt = eventTimestamp;
    }

    if (activity) {
      pending.task ||= activity;
    }
  };

  const disposers = [
    subscribePiEvent(events, SLASH_SUBAGENT_STARTED_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const pending = runsById.get(requestId);
      if (pending) {
        pending.started = true;
      }

      updatePendingRun(requestId, 'running', resolveTimestamp(), getSubagentRunSnapshot(container.read(), requestId)?.task);
      const snapshot = updateZergControlState(container, { activeRunId: requestId }, `subagent ${requestId} started`, options);
      container.replace(applyRuntimeTransition(snapshot, {
        entity: 'agent',
        action: 'start',
        id: requestId,
        label: pending?.agentLabel ?? pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: pending?.task,
      }, { now: options.now ?? (() => new Date()) }));
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_UPDATE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const currentTool = data && typeof data === 'object' && typeof (data as { currentTool?: unknown }).currentTool === 'string'
        ? (data as { currentTool: string }).currentTool
        : 'progress';
      updatePendingRun(requestId, 'running', resolveTimestamp(), currentTool);
      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: requestId,
        kind: 'subagent',
        activity: currentTool,
      }, { now: options.now ?? (() => new Date()) });
      container.replace(snapshot);
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_RESPONSE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const isError = data && typeof data === 'object' && (data as { isError?: unknown }).isError === true;
      const status: AgentStatus = isError ? 'failed' : 'done';
      const pending = runsById.get(requestId);
      if (pending) {
        pending.completed = true;
        updatePendingRun(requestId, status, resolveTimestamp(), isError ? 'subagent failed' : 'subagent complete');
      }

      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: isError ? 'fail' : 'stop',
        id: requestId,
        label: pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: isError ? 'subagent failed' : 'subagent complete',
      }, { now: options.now ?? (() => new Date()) });
      container.replace(snapshot);
      if (pending?.launched) {
        runsById.delete(requestId);
      }
    }),
  ];

  return {
    kind: 'pi-slash-bridge',
    listAgentDefinitions() {
      return getAgentDefinitions(container.read());
    },
    getAgentDefinition(id) {
      return getAgentDefinition(container.read(), id);
    },
    listRuns() {
      return resolveRuns().map((run) => createZergSubagentRunSnapshot(run));
    },
    getRun(runId) {
      return refreshRun(runId);
    },
    launch(request) {
      const requestId = `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const now = resolveTimestamp();
      const selectedDefinition = getAgentDefinition(container.read(), request.agent);
      const agentLabel = selectedDefinition?.label;

      runsById.set(requestId, {
        runId: requestId,
        agentId: request.agent,
        agentLabel,
        task: request.task,
        status: 'idle',
        updatedAt: now,
        startedAt: undefined,
        launched: false,
        started: false,
        completed: false,
      });

      const before = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'create',
        id: requestId,
        label: agentLabel ?? request.agent,
        kind: 'subagent',
        activity: request.task,
      }, { now: options.now ?? (() => new Date()) });
      container.replace(before);

      events.emit!(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId,
        params: {
          agent: request.agent,
          task: request.task,
          clarify: false,
          agentScope: 'both',
          ...(request.background ? { async: true } : {}),
          ...(request.fork ? { context: 'fork' as const } : {}),
        },
      });

      const run = runsById.get(requestId);
      if (!run) {
        return { ok: false, runId: requestId, message: `failed to initialize zerg run ${requestId}` };
      }

      if (!run.started) {
        runsById.delete(requestId);
        const failed = applyRuntimeTransition(container.read(), {
          entity: 'agent',
          action: 'fail',
          id: requestId,
          label: request.agent,
          kind: 'subagent',
          activity: 'No pi-subagents slash bridge responded.',
        }, { now: options.now ?? (() => new Date()) });
        container.replace(failed);
        return { ok: false, runId: requestId, message: 'No pi-subagents slash bridge responded. Ensure pi-subagents is loaded.' };
      }

      run.launched = true;
      updateZergControlState(container, { activeRunId: requestId }, `launched ${request.agent}`, options);
      return { ok: true, runId: requestId, message: `zerg launched ${request.agent} as ${requestId}` };
    },
    interrupt(runId) {
      const target = runId || getZergControlState(container.read()).activeRunId;
      if (!target) {
        return { ok: false, message: 'No active zerg subagent run to interrupt.' };
      }
      events.emit!(SLASH_SUBAGENT_CANCEL_EVENT, { requestId: target });
      updateZergControlState(container, { activeRunId: target }, `interrupt requested for ${target}`, options);
      return { ok: true, runId: target, message: `interrupt requested for ${target}` };
    },
    dispose() {
      for (const dispose of disposers) dispose();
      runsById.clear();
    },
  };
}

function subscribePiEvent(
  events: NonNullable<StructuralPiExtensionContext['events']>,
  eventName: string,
  handler: (data: unknown) => void,
): () => void {
  const registration = events.on?.(eventName, handler);
  if (typeof registration === 'function') {
    return () => { (registration as () => void)(); };
  }
  if (registration && typeof registration === 'object' && typeof (registration as { dispose?: unknown }).dispose === 'function') {
    return () => (registration as { dispose(): void }).dispose();
  }
  return () => undefined;
}

function getEventRequestId(data: unknown): string | undefined {
  return data && typeof data === 'object' && typeof (data as { requestId?: unknown }).requestId === 'string'
    ? (data as { requestId: string }).requestId
    : undefined;
}

function renderZergConfigOverlay(
  state: ZergState,
  options: { width: number; activeTab: ZergConfigOverlayTab; selectedIndex: number },
): string {
  const width = options.width;
  const selectedTab = options.activeTab;
  const tabLine = CONFIG_OVERLAY_TABS.map((tab) => tab === selectedTab ? `[${tab}]` : ` ${tab} `).join(' ');
  const lines = [
    'zerg config',
    tabLine,
    'keys: tab/shift-tab switch tabs | ↑/↓ select target | r read-only | m/a/u mode | q/esc close',
    '',
  ];

  if (selectedTab === 'monitor') {
    lines.push(...renderMonitor(state, { width }).split('\n'));
  } else if (selectedTab === 'control') {
    lines.push(...renderZergControlStatus(state, width).split('\n'));
  } else if (selectedTab === 'targets') {
    const targets = getConfigTargets(state);
    lines.push('targets:');
    if (targets.length === 0) {
      lines.push('  none');
    } else {
      targets.slice(0, 20).forEach((target, index) => {
        const marker = index === options.selectedIndex ? '>' : ' ';
        lines.push(`${marker} ${target.kind} ${target.id} ${target.label} [${target.status}]`);
      });
    }
  } else {
    const control = getZergControlState(state);
    lines.push('configuration:');
    lines.push(`  controller: ${control.controller} (command: /zerg control controller pi|zerg|operator)`);
    lines.push(`  automation: ${state.mode.automation} (keys: m manual, a assisted, u automatic)`);
    lines.push(`  read-only: ${state.mode.readOnly ? 'enabled' : 'disabled'} (key: r)`);
    lines.push('  Pi adapter: /zerg run emits pi-subagents slash bridge events when available');
    lines.push('  zerg adapter: command and overlay controls share the same adapter boundary');
  }

  return lines.map((line) => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line).join('\n');
}

export function createPiZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(stateOrReader, options);

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const normalized = normalizeZergCommandInput(input);
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;

    if ((normalized.topic === 'monitor' || normalized.topic === 'config') && context.ui?.custom) {
      const overlayTopic = normalized.topic as 'monitor' | 'config';
      let activeTab: ZergConfigOverlayTab = overlayTopic === 'monitor' ? 'monitor' : 'config';
      let selectedIndex = 0;
      const renderOverlayOutput = (width?: number) => {
        const outputWidth = typeof width === 'number' ? width : PI_COMMAND_OUTPUT_WIDTH;
        if (!result.ok) {
          return output;
        }

        const snapshot = resolveZergStateSnapshot(stateOrReader);
        return overlayTopic === 'monitor'
          ? renderMonitor(snapshot, { width: outputWidth })
          : renderZergConfigOverlay(snapshot, { width: outputWidth, activeTab, selectedIndex });
      };

      try {
        context.ui.custom(
          (tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: () => void) => {
            let closed = false;
            let invalidated = false;
            const requestRender = () => {
              invalidated = true;
              tui?.requestRender?.();
            };
            const unsubscribe = subscribeToZergState(stateOrReader, requestRender);
            const close = () => {
              if (closed) {
                return;
              }

              closed = true;
              unsubscribe();
              done?.();
            };
            const switchTab = (direction: 1 | -1) => {
              const currentIndex = CONFIG_OVERLAY_TABS.indexOf(activeTab);
              activeTab = CONFIG_OVERLAY_TABS[(currentIndex + direction + CONFIG_OVERLAY_TABS.length) % CONFIG_OVERLAY_TABS.length]!;
              requestRender();
            };
            const updateSelectedTarget = (direction: 1 | -1) => {
              const targets = getConfigTargets(resolveZergStateSnapshot(stateOrReader));
              if (targets.length === 0) {
                selectedIndex = 0;
                return;
              }
              selectedIndex = (selectedIndex + direction + targets.length) % targets.length;
              const container = getWritableStateContainer(stateOrReader);
              if (container) {
                updateZergControlState(container, { selectedTargetId: targets[selectedIndex]?.id }, `selected target ${targets[selectedIndex]?.id}`, { ...options, syncSharedState: (options as RuntimeCommandOptions).syncSharedState });
              }
              requestRender();
            };
            const applyOverlayMutation = (mutate: () => void) => {
              mutate();
              requestRender();
            };

            return {
              render: (width?: number, _height?: number) => {
                invalidated = false;
                return renderOverlayOutput(width).split('\n');
              },
              invalidate: () => {
                invalidated = true;
              },
              handleInput: (data: string) => {
                if (data === 'q' || data === 'Q' || data === '\u001b') {
                  close();
                } else if (overlayTopic === 'config' && (data === '\t' || data === 'tab')) {
                  switchTab(1);
                } else if (overlayTopic === 'config' && (data === '\u001b[Z' || data === 'shift-tab')) {
                  switchTab(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[A' || data === 'up')) {
                  updateSelectedTarget(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[B' || data === 'down')) {
                  updateSelectedTarget(1);
                } else if (overlayTopic === 'config' && (data === 'r' || data === 'R')) {
                  applyOverlayMutation(() => {
                    const container = getWritableStateContainer(stateOrReader);
                    if (container) {
                      setReadOnlyMode(container, 'toggle', { ...options, syncSharedState: (options as RuntimeCommandOptions).syncSharedState }, 'overlay');
                    }
                  });
                } else if (overlayTopic === 'config' && (data === 'm' || data === 'M' || data === 'a' || data === 'A' || data === 'u' || data === 'U')) {
                  applyOverlayMutation(() => {
                    const container = getWritableStateContainer(stateOrReader);
                    if (container) {
                      const mode = data.toLowerCase() === 'm' ? 'manual' : data.toLowerCase() === 'a' ? 'assisted' : 'automatic';
                      setAutomationMode(container, mode, { ...options, syncSharedState: (options as RuntimeCommandOptions).syncSharedState });
                    }
                  });
                } else if (invalidated) {
                  tui?.requestRender?.();
                }
              },
            };
          },
          {
            overlay: true,
            overlayOptions: {
              title: overlayTopic === 'monitor' ? 'zerg monitor' : 'zerg config',
            },
          },
        );
        return;
      } catch {
        try {
          context.ui.custom((width: number) => renderOverlayOutput(width), {
            mode: 'overlay',
            title: overlayTopic === 'monitor' ? 'zerg monitor' : 'zerg config',
          });
          return;
        } catch {
          // Fall back to textual output when custom overlay hooks are unavailable.
        }
      }
    }

    context.ui?.notify?.(output, 'info');
  };
}

function resolveZergStateSnapshot(stateOrReader: ZergStateSource): ZergState {
  if (isZergStateContainer(stateOrReader)) {
    return stateOrReader.snapshot();
  }

  const state = typeof stateOrReader === 'function' ? stateOrReader() : stateOrReader;
  return snapshotZergState(state);
}

function registerCommand(context: StructuralPiExtensionContext, command: StructuralPiCommand): RegisteredCommandDisposer | undefined {
  const registrar = selectCommandRegistrar(context);

  if (!registrar) {
    return undefined;
  }

  const registeredNames = registeredCommandsByTarget.get(registrar.target) ?? new Set<ZergCommandName>();

  if (registeredNames.has(command.name)) {
    return undefined;
  }

  const options: StructuralPiCommandOptions = {
    description: command.description,
    handler: command.handler,
  };

  const registration = registrar.registerCommand(command.name, options);
  registeredNames.add(command.name);
  registeredCommandsByTarget.set(registrar.target, registeredNames);

  if (!isDisposableRegistration(registration)) {
    return undefined;
  }

  return {
    target: registrar.target,
    name: command.name,
    dispose: registration.dispose.bind(registration),
  };
}

function clearRegisteredCommand(target: object, name: ZergCommandName): void {
  const registeredNames = registeredCommandsByTarget.get(target);

  if (!registeredNames) {
    return;
  }

  registeredNames.delete(name);

  if (registeredNames.size === 0) {
    registeredCommandsByTarget.delete(target);
  }
}

function isDisposableRegistration(value: unknown): value is DisposableRegistration {
  return typeof value === 'object' && value !== null && typeof (value as { dispose?: unknown }).dispose === 'function';
}

function selectCommandRegistrar(context: StructuralPiExtensionContext): SelectedCommandRegistrar | undefined {
  if (context.registerCommand) {
    return { target: context, registerCommand: context.registerCommand.bind(context) };
  }

  if (context.commands?.registerCommand) {
    return { target: context.commands, registerCommand: context.commands.registerCommand.bind(context.commands) };
  }

  if (context.commands?.register) {
    return { target: context.commands, registerCommand: context.commands.register.bind(context.commands) };
  }

  if (context.commandRegistrar?.registerCommand) {
    return {
      target: context.commandRegistrar,
      registerCommand: context.commandRegistrar.registerCommand.bind(context.commandRegistrar),
    };
  }

  return undefined;
}

export default registerZergSwarmExtension;
