import { installInternalPatch } from './internal-patch.js';
import { deriveThinkingSteps } from './parse.js';
import { openZergManagementOverlay } from './ui/management-overlay.js';
import { renderAgentDefinitionSummary, renderAgentDefinitionsList, renderAgentTree, renderHelp, renderMonitor, renderPermissionQueueList, renderPermissionQueueStatus, renderStatusLine, renderZergLogList, renderZergLogStatus, renderZergLogSummary, renderZergManagementOverlay, renderZergSubagentRunList, renderZergSubagentRunSummary, type ZergManagementOverlayRow } from './render.js';
import { appendZergLogRecord, applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createZergStateContainer, createZergSubagentRunSnapshot, enqueuePermissionRequest, getAgentDefinition, getAgentDefinitions, getPendingPermissionRequests, getPermissionQueueState, getSubagentRunSnapshot, getSubagentRunSnapshots, getZergLogs, getZergLogState, readSharedZergState, removeAgentDefinition, replaceSharedZergState, resolvePermissionRequest, seedBuiltinAgentDefinitions, snapshotZergState, upsertAgentDefinition, upsertTask, type ZergLogFilter } from './state.js';
import { ZERG_COMMANDS, type AgentKind, type AgentStatus, type AutomationMode, type PermissionModeTransitionInput, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type StructuralPiTuiHandle, type TeamKind, type ZergAgentDefinition, type ZergCommandName, type ZergCommandResult, type ZergConfigOverlayTab, type ZergControlState, type ZergControlController, type ZergInternalPatchController, type ZergLifecycleSubstate, type ZergManagementTargetKind, type ZergOperatorMessageDeliveryStatus, type ZergPermissionDecision, type ZergPermissionRequestKind, type ZergPiCommandHandler, type ZergRuntimeEntity, type ZergRuntimeTransition, type ZergRuntimeTransitionAction, type ZergState, type ZergStateContainer, type ZergSubagentControlAdapter, type ZergSubagentLaunchMode, type ZergSubagentLaunchRequest, type ZergSubagentRunSnapshot } from './types.js';

type ZergIdFactory = {
  runId?: () => string;
  taskId?: () => string;
};

export interface ZergCommandHandlerOptions {
  now?: () => Date;
  subagentAdapter?: ZergSubagentControlAdapter;
  idFactory?: ZergIdFactory;
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

type ZergCommandTopic = 'help' | 'status' | 'tree' | 'steps' | 'agent' | 'team' | 'mode' | 'intervene' | 'monitor' | 'control' | 'config' | 'run' | 'interrupt' | 'agents' | 'runs' | 'permission' | 'logs';
type ZergCommandDispatcher = (payload: string) => ZergCommandResult;
type RuntimeParseResult = { ok: false; output: string } | { ok: true; transition: ZergRuntimeTransition };
type LogsParseResult = { ok: false; output: string } | { ok: true; filter: ZergLogFilter; json: boolean };

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
const CONFIG_OVERLAY_TABS: ZergConfigOverlayTab[] = ['monitor', 'control', 'targets', 'permissions', 'lifecycle', 'logs', 'intervene', 'config'];
const SLASH_SUBAGENT_REQUEST_EVENT = 'subagent:slash:request';
const SLASH_SUBAGENT_STARTED_EVENT = 'subagent:slash:started';
const SLASH_SUBAGENT_RESPONSE_EVENT = 'subagent:slash:response';
const SLASH_SUBAGENT_UPDATE_EVENT = 'subagent:slash:update';
const SLASH_SUBAGENT_CANCEL_EVENT = 'subagent:slash:cancel';
const DEFAULT_RUN_ID_PREFIX = 'zerg-';
const DEFAULT_TASK_ID_PREFIX = 'task-';
const OVERLAY_VISIBLE_ROWS = 14;
const DEFAULT_OVERLAY_INTERVENTION_DRAFT = 'operator intervention requested from overlay';
const OVERLAY_FILTER_DEFERRED_MESSAGE = 'text filter entry is deferred; use /zerg permission, /zerg logs, or /zerg runs command filters.';

const defaultIdFactory: Required<ZergIdFactory> = {
  runId: () => `${DEFAULT_RUN_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  taskId: () => `${DEFAULT_TASK_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
};


interface NormalizedZergCommandInput {
  topic: string;
  payload: string;
}

interface OverlayConfirmationState {
  action: 'approve' | 'deny';
  rowId: string;
  requestId: string;
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
        ? 'pi-zerg-swarm v1.0.0 internal patch path active'
        : 'pi-zerg-swarm v1.0.0 internal patch unavailable; command surface registered',
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
    agents: (payload: string) => dispatchAgentDefinitionsCommand(stateOrReader, payload, options),
    agent: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'agent', payload, options),
    team: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'team', payload, options),
    mode: (payload: string) => dispatchModeCommand(stateOrReader, payload, options),
    intervene: (payload: string) => dispatchInterventionCommand(stateOrReader, payload, options),
    monitor: (payload: string) => dispatchMonitorCommand(stateOrReader, payload, options),
    control: (payload: string) => dispatchControlCommand(stateOrReader, payload, options),
    permission: (payload: string) => dispatchPermissionCommand(stateOrReader, payload, options),
    logs: (payload: string) => dispatchLogsCommand(stateOrReader, payload),
    config: () => ({ ok: true, output: renderZergConfigOverlay(resolveZergStateSnapshot(stateOrReader), { width: PI_COMMAND_OUTPUT_WIDTH, activeTab: 'config', selectedIndex: 0 }) }),
    run: (payload: string) => dispatchRunCommand(stateOrReader, payload, options),
    runs: (payload: string) => dispatchRunsCommand(stateOrReader, payload, options),
    interrupt: (payload: string) => dispatchInterruptCommand(stateOrReader, payload, options),
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
  return value === 'help' || value === 'status' || value === 'tree' || value === 'steps' || value === 'agents' || value === 'agent' || value === 'team' || value === 'mode' || value === 'intervene' || value === 'monitor' || value === 'control' || value === 'permission' || value === 'logs' || value === 'config' || value === 'run' || value === 'runs' || value === 'interrupt';
}

function dispatchAgentDefinitionsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
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

  if (action === 'create' || action === 'update' || action === 'upsert') {
    const container = getWritableStateContainer(stateOrReader);
    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }

    const existing = action === 'create' ? undefined : getAgentDefinition(container.read(), tokens[1] ?? '');
    const parsed = parseAgentDefinitionMutation(action, tokens.slice(1), existing);
    if (!parsed.ok) {
      return parsed;
    }

    const nextState = appendLogToState(upsertAgentDefinition(container.read(), parsed.definition), options, {
      source: 'command',
      level: 'info',
      kind: 'text',
      message: `agent definition ${parsed.definition.id} saved`,
      agentId: parsed.definition.id,
      data: { model: parsed.definition.model, fallbackModels: parsed.definition.fallbackModels, maxTurns: parsed.definition.maxTurns },
    });
    const updated = container.replace(nextState);
    if (options.syncSharedState) {
      replaceSharedZergState(updated);
    }
    return { ok: true, output: `agent definition ${parsed.definition.id} saved.\n${renderAgentDefinitionSummary(parsed.definition, { width: PI_COMMAND_OUTPUT_WIDTH })}` };
  }

  if (action === 'delete' || action === 'remove' || action === 'rm' || action === 'del') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg agents delete <id>' };
    }
    const container = getWritableStateContainer(stateOrReader);
    if (!container) {
      return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
    }
    const existing = getAgentDefinition(container.read(), id);
    if (!existing) {
      return { ok: false, output: `Unknown agent definition: ${id}` };
    }
    const updated = container.replace(removeAgentDefinition(container.read(), id));
    if (options.syncSharedState) {
      replaceSharedZergState(updated);
    }
    return { ok: true, output: `agent definition ${existing.id} deleted.` };
  }

  return {
    ok: false,
    output: `Unknown agents action: ${action}. Available: /zerg agents list, show <id>, create|update <id> --prompt <text> [--model <model>] [--tools a,b], delete <id>`,
  };
}

function parseAgentDefinitionMutation(
  action: string,
  tokens: string[],
  existing?: ZergAgentDefinition,
): { ok: false; output: string } | { ok: true; definition: ZergAgentDefinition } {
  const id = tokens[0];
  if (!id) {
    return { ok: false, output: 'Usage: /zerg agents create <id> --prompt <text> [--label <label>] [--model <model>] [--tools a,b]' };
  }

  if (action === 'update' && !existing) {
    return { ok: false, output: `Unknown agent definition: ${id}` };
  }

  const prompt = getOptionValue(tokens, '--prompt') ?? existing?.prompt;
  if (!prompt?.trim()) {
    return { ok: false, output: 'agent definition create/update requires --prompt <text>.' };
  }

  const permissionModeInput = getOptionValue(tokens, '--permission-mode') ?? getOptionValue(tokens, '--permission') ?? existing?.permissionMode;
  if (permissionModeInput && !isAgentDefinitionPermissionMode(permissionModeInput)) {
    return { ok: false, output: `Unknown permission mode: ${permissionModeInput}` };
  }
  const permissionMode = permissionModeInput && isAgentDefinitionPermissionMode(permissionModeInput) ? permissionModeInput : undefined;

  const maxTurnsText = getOptionValue(tokens, '--max-turns') ?? getOptionValue(tokens, '--maxTurns');
  const maxTurns = maxTurnsText ? Number(maxTurnsText) : existing?.maxTurns;
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns <= 0)) {
    return { ok: false, output: '--max-turns must be a positive integer.' };
  }

  return {
    ok: true,
    definition: {
      id,
      label: getOptionValue(tokens, '--label') ?? existing?.label ?? id,
      description: getOptionValue(tokens, '--description') ?? existing?.description,
      prompt,
      source: existing?.source ?? 'runtime',
      model: getOptionValue(tokens, '--model') ?? existing?.model,
      fallbackModels: parseCsvOption(getOptionValue(tokens, '--fallback-models') ?? getOptionValue(tokens, '--fallback')) ?? existing?.fallbackModels,
      maxTurns,
      tools: parseCsvOption(getOptionValue(tokens, '--tools') ?? getOptionValue(tokens, '--tool')) ?? existing?.tools,
      disallowedTools: parseCsvOption(getOptionValue(tokens, '--disallowed-tools') ?? getOptionValue(tokens, '--disallow')) ?? existing?.disallowedTools,
      permissionMode,
      metadata: existing?.metadata,
      extensions: existing?.extensions,
    },
  };
}

function getOptionValue(tokens: string[], name: string): string | undefined {
  const equalsPrefix = `${name}=`;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === name) {
      return tokens[index + 1];
    }
    if (token.startsWith(equalsPrefix)) {
      return token.slice(equalsPrefix.length);
    }
  }
  return undefined;
}

function parseCsvOption(value: string | undefined): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : undefined;
}

function isAgentDefinitionPermissionMode(value: string): value is AutomationMode | 'inherit' {
  return value === 'manual' || value === 'assisted' || value === 'automatic' || value === 'inherit';
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
  const withLog = appendLogToState(nextState, options, {
    source: 'lifecycle',
    level: parsed.transition.action === 'fail' ? 'error' : 'info',
    kind: parsed.transition.action === 'fail' ? 'error' : 'text',
    message: `${parsed.transition.entity} ${parsed.transition.id} ${parsed.transition.action}`,
    agentId: parsed.transition.entity === 'agent' ? parsed.transition.id : undefined,
    teamId: parsed.transition.entity === 'team' ? parsed.transition.id : undefined,
    data: { action: parsed.transition.action },
  });
  const snapshot = container.replace(withLog);

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

function dispatchPermissionCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase() ?? 'status';
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (action === 'status') {
    return { ok: true, output: renderPermissionQueueStatus(getPermissionQueueState(snapshot), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'list' || action === 'ls') {
    const filterToken = tokens[1]?.toLowerCase() ?? 'pending';
    if (!isPermissionListFilter(filterToken)) {
      return { ok: false, output: `Unknown permission list filter: ${tokens[1] ?? ''}` };
    }

    return { ok: true, output: renderPermissionQueueList(getPermissionQueueState(snapshot), filterToken, { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  const container = getWritableStateContainer(stateOrReader);
  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  if (action === 'request') {
    const kind = tokens[1]?.toLowerCase();
    const target = tokens[2];
    const summary = tokens.slice(3).join(' ');
    if (!isPermissionRequestKind(kind)) {
      return { ok: false, output: `Unknown permission request kind: ${tokens[1] ?? ''}` };
    }
    const sanitizedSummary = normalizePermissionCommandText(summary);
    if (!target || !sanitizedSummary) {
      return { ok: false, output: 'Usage: /zerg permission request <kind> <target> <summary...>' };
    }

    const queued = enqueuePermissionRequest(container.read(), {
      kind,
      targetId: target,
      requester: 'operator',
      summary: sanitizedSummary,
    }, { now: options.now ?? (() => new Date()) });
    const logged = appendLogToState(queued, options, {
      source: 'permission',
      level: 'info',
      kind: 'text',
      message: `permission request queued for ${kind} ${target}`,
      agentId: kind === 'run' || kind === 'interrupt' ? target : undefined,
      runId: kind === 'interrupt' ? target : undefined,
      data: { permissionKind: kind },
    });
    const next = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(next);
    }
    const requestId = getPermissionQueueState(next).lastRequestId;
    return { ok: true, output: `permission request queued: ${requestId}` };
  }

  if (action === 'approve' || action === 'deny' || action === 'cancel') {
    const requestId = tokens[1];
    const reason = tokens.slice(2).join(' ');
    if (!requestId) {
      return { ok: false, output: `Usage: /zerg permission ${action} <id> [reason...]` };
    }

    const current = container.read();
    const request = getPermissionQueueState(current).requests.find((candidate) => candidate.id === requestId);
    if (!request) {
      return { ok: false, output: `Unknown permission request: ${requestId}` };
    }
    if (request.status !== 'pending') {
      return { ok: false, output: `Permission request ${requestId} is already ${request.status}.` };
    }

    const decision = permissionDecisionForAction(action);
    const resolved = resolvePermissionRequest(current, requestId, decision, {
      now: options.now ?? (() => new Date()),
      reason,
      resolvedBy: 'operator',
    });
    const withLifecycle = decision === 'deny' || decision === 'cancel'
      ? markPermissionRequestTerminalLifecycle(resolved, request.runId, decision, options)
      : resolved;
    const logged = appendLogToState(withLifecycle, options, {
      source: 'permission',
      level: decision === 'approve' ? 'info' : 'warn',
      kind: decision === 'approve' ? 'text' : 'error',
      message: `permission ${decision}: ${requestId}`,
      runId: request.runId,
      agentId: request.agentId,
      data: { permissionKind: request.kind, decision },
    });
    const next = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(next);
    }
    return { ok: true, output: `permission request ${requestId} ${permissionPastTense(decision)}` };
  }

  return { ok: false, output: `Unknown permission action: ${tokens[0] ?? ''}` };
}

function dispatchLogsCommand(
  stateOrReader: ZergStateSource,
  payload: string,
): ZergCommandResult {
  const tokens = tokenizeRuntimePayload(payload);
  const action = tokens[0]?.toLowerCase() ?? 'status';
  const snapshot = resolveZergStateSnapshot(stateOrReader);

  if (action === 'status') {
    return { ok: true, output: renderZergLogStatus(getZergLogState(snapshot), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'list' || action === 'ls') {
    const parsed = parseLogFilters(tokens.slice(1));
    if (!parsed.ok) {
      return parsed;
    }

    return { ok: true, output: renderZergLogList(getZergLogs(snapshot, parsed.filter), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  if (action === 'json') {
    const parsed = parseLogFilters(tokens.slice(1));
    if (!parsed.ok) {
      return parsed;
    }

    const records = getZergLogs(snapshot, parsed.filter);
    return { ok: true, output: JSON.stringify({ count: records.length, records }, null, 2) };
  }

  if (action === 'show') {
    const id = tokens[1];
    if (!id) {
      return { ok: false, output: 'Usage: /zerg logs show <id|run-id> [--json]' };
    }

    const parsed = parseLogFilters(tokens.slice(2));
    if (!parsed.ok) {
      return parsed;
    }

    const records = getZergLogState(snapshot).records;
    const exact = records.find((record) => record.id === id);
    const matches = exact ? [exact] : records.filter((record) => record.runId === id);
    if (matches.length === 0) {
      return { ok: false, output: `Unknown log or run: ${id}` };
    }

    if (parsed.json) {
      return { ok: true, output: JSON.stringify({ count: matches.length, records: matches }, null, 2) };
    }

    return exact
      ? { ok: true, output: renderZergLogSummary(exact, { width: PI_COMMAND_OUTPUT_WIDTH }) }
      : { ok: true, output: renderZergLogList(matches.slice(-(parsed.filter.limit ?? 20)), { width: PI_COMMAND_OUTPUT_WIDTH }) };
  }

  return { ok: false, output: `Unknown logs action: ${tokens[0] ?? ''}` };
}

function dispatchRunCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const container = getWritableStateContainer(stateOrReader);
  if (!container) {
    return { ok: false, output: RUNTIME_WRITABLE_STATE_ERROR };
  }

  const current = container.read();
  const parsed = parseRunCommand(payload);
  if (!parsed.ok) {
    return parsed;
  }

  const launchMode = resolveLaunchMode(parsed.request);
  const definitions = getAgentDefinitions(current);
  const resolvedDefinition = definitions.length > 0 ? getAgentDefinition(current, parsed.request.agent) : undefined;
  if (definitions.length > 0 && !resolvedDefinition) {
    return { ok: false, output: `Unknown agent definition: ${parsed.request.agent}` };
  }

  if (current.mode.readOnly) {
    const queued = enqueuePermissionRequest(current, {
      kind: 'run',
      targetId: resolvedDefinition?.id ?? parsed.request.agent,
      agentId: resolvedDefinition?.id ?? parsed.request.agent,
      requester: 'operator',
      summary: `Run ${resolvedDefinition?.id ?? parsed.request.agent}: ${parsed.request.task}`,
      details: `read-only blocked /zerg run (${launchMode})`,
      metadata: {
        agent: resolvedDefinition?.id ?? parsed.request.agent,
        task: parsed.request.task,
        launchMode,
        background: parsed.request.background,
        model: parsed.request.model ?? resolvedDefinition?.model,
        fallbackModels: parsed.request.fallbackModels ?? resolvedDefinition?.fallbackModels,
        maxTurns: parsed.request.maxTurns ?? resolvedDefinition?.maxTurns,
      },
    }, { now: options.now ?? (() => new Date()) });
    const logged = appendLogToState(queued, options, {
      source: 'permission',
      level: 'warn',
      kind: 'text',
      message: `read-only blocked zerg run for ${resolvedDefinition?.id ?? parsed.request.agent}`,
      agentId: resolvedDefinition?.id ?? parsed.request.agent,
      data: { launchMode, background: parsed.request.background },
    });
    const snapshot = container.replace(logged);
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }
    const requestId = getPermissionQueueState(snapshot).lastRequestId;
    return {
      ok: false,
      output: `zerg run is blocked while read-only is enabled; queued for permission as ${requestId}. Use /zerg permission approve ${requestId} or /zerg permission deny ${requestId}.`,
    };
  }

  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable') {
    return { ok: false, output: 'No Pi subagent adapter is available. Load pi-subagents or provide a ZergSubagentControlAdapter.' };
  }

  const now = options.now ?? (() => new Date());
  const nowTimestamp = now().toISOString();
  const runId = resolveRunId(options.idFactory);
  const taskId = resolveTaskId(options.idFactory);
  const resolvedAgentId = resolvedDefinition?.id ?? parsed.request.agent;
  const resolvedAgentLabel = resolvedDefinition?.label ?? parsed.request.agent;

  const requestedModel = parsed.request.model ?? resolvedDefinition?.model;
  const requestedFallbackModels = parsed.request.fallbackModels ?? resolvedDefinition?.fallbackModels;
  const requestedMaxTurns = parsed.request.maxTurns ?? resolvedDefinition?.maxTurns;
  const request: ZergSubagentLaunchRequest = {
    ...parsed.request,
    agent: resolvedAgentId,
    fork: launchMode === 'fork',
    launchMode,
    runId,
    taskId,
    agentDefinitionId: resolvedDefinition?.id,
    description: parsed.request.task,
    ...(requestedModel ? { model: requestedModel } : {}),
    ...(requestedFallbackModels?.length ? { fallbackModels: requestedFallbackModels } : {}),
    ...(requestedMaxTurns ? { maxTurns: requestedMaxTurns } : {}),
  };

  const launchMetadata = {
    taskId,
    runId,
    launchMode,
    ...(resolvedDefinition ? { agentDefinitionId: resolvedDefinition.id } : {}),
    agentDefinitionLabel: resolvedDefinition?.label,
    ...(request.model ? { model: request.model } : {}),
    ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
    ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
  } as const;

  const taskRecord = {
    id: taskId,
    title: parsed.request.task,
    status: 'running' as const,
    ownerAgentId: runId,
    updatedAt: nowTimestamp,
    substate: 'queued' as const,
    substateReason: 'waiting for adapter launch',
    substateUpdatedAt: nowTimestamp,
    metadata: launchMetadata,
  };

  const withTask = upsertTask(current, taskRecord);
  const withRun = applyRuntimeTransition(withTask, {
    entity: 'agent',
    action: 'create',
    id: runId,
    label: resolvedAgentLabel,
    kind: 'subagent',
    activity: parsed.request.task,
    substate: 'spawning',
    substateReason: 'adapter launch requested',
  }, { now: () => new Date(nowTimestamp) });

  const withAgentMetadata = {
    ...withRun,
    agents: {
      ...withRun.agents,
      [runId]: {
        ...(withRun.agents[runId] ?? {}),
        metadata: {
          ...withRun.agents[runId]?.metadata,
          ...launchMetadata,
        },
      },
    },
  };

  const withLaunchLog = appendLogToState(withAgentMetadata, options, {
    source: 'command',
    level: 'info',
    kind: 'text',
    message: `zerg run queued for ${resolvedAgentId}`,
    runId,
    agentId: resolvedAgentId,
    taskId,
    data: { launchMode, background: parsed.request.background, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
  });

  const launchReadyState = container.replace(withLaunchLog);
  if (options.syncSharedState) {
    replaceSharedZergState(launchReadyState);
  }

  const result = adapter.launch(request);

  if (result.ok) {
    const logged = appendLogToContainer(container, options, {
      source: 'adapter',
      level: 'info',
      kind: 'text',
      message: result.message || `adapter launch accepted ${runId}`,
      runId,
      agentId: resolvedAgentId,
      taskId,
      data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
    });
    if (options.syncSharedState) {
      replaceSharedZergState(logged);
    }
    return {
      ok: true,
      runId,
      taskId,
      output: appendSpawnIdentifiers(appendSpawnLaunchMode(result.message, launchMode), runId, taskId),
    };
  }

  const withFailure = upsertTask(
    applyRuntimeTransition(container.read(), {
      entity: 'agent',
      action: 'fail',
      id: runId,
      label: resolvedAgentLabel,
      kind: 'subagent',
      activity: result.message || 'adapter launch failed',
      substate: 'failed',
      substateReason: result.message || 'adapter launch failed',
    }, { now: () => new Date(nowTimestamp) }),
    {
      id: taskId,
      title: parsed.request.task,
      status: 'failed',
      ownerAgentId: runId,
      updatedAt: nowTimestamp,
      substate: 'failed',
      substateReason: result.message || 'adapter launch failed',
      substateUpdatedAt: nowTimestamp,
      metadata: launchMetadata,
    },
  );

  const failedState = container.replace(appendLogToState(withFailure, options, {
    source: 'adapter',
    level: 'error',
    kind: 'error',
    message: result.message || 'adapter launch failed',
    runId,
    agentId: resolvedAgentId,
    taskId,
    data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
  }));
  if (options.syncSharedState) {
    replaceSharedZergState(failedState);
  }

  return {
    ok: false,
    runId,
    taskId,
    output: appendSpawnIdentifiers(appendSpawnLaunchMode(result.message, launchMode), runId, taskId),
  };
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

function dispatchInterruptCommand(
  stateOrReader: ZergStateSource,
  payload: string,
  options: RuntimeCommandOptions,
): ZergCommandResult {
  const [runId] = tokenizeRuntimePayload(payload);
  const container = getWritableStateContainer(stateOrReader);
  const currentSnapshot = container?.read() ?? resolveZergStateSnapshot(stateOrReader);

  if (currentSnapshot.mode.readOnly) {
    if (!container) {
      return { ok: false, output: 'zerg interrupt is blocked while read-only is enabled and requires writable zerg state to queue permission.' };
    }

    const current = currentSnapshot;
    const targetRunId = runId || getZergControlState(current).activeRunId;
    const queued = enqueuePermissionRequest(current, {
      kind: 'interrupt',
      targetId: targetRunId,
      runId: targetRunId,
      requester: 'operator',
      summary: `Interrupt ${targetRunId ?? 'active run'}`,
      details: 'read-only blocked /zerg interrupt',
    }, { now: options.now ?? (() => new Date()) });
    const requestId = getPermissionQueueState(queued).lastRequestId;
    const waiting = targetRunId && queued.agents[targetRunId]
      ? markRunWaitingForPermission(queued, targetRunId, requestId, options)
      : queued;
    const snapshot = container.replace(appendLogToState(waiting, options, {
      source: 'permission',
      level: 'warn',
      kind: 'text',
      message: `read-only blocked zerg interrupt for ${targetRunId ?? 'active run'}`,
      runId: targetRunId,
    }));
    if (options.syncSharedState) {
      replaceSharedZergState(snapshot);
    }
    return {
      ok: false,
      output: `zerg interrupt is blocked while read-only is enabled; queued for permission as ${requestId}. Use /zerg permission approve ${requestId} or /zerg permission deny ${requestId}.`,
    };
  }

  const adapter = options.subagentAdapter;
  if (!adapter || adapter.kind === 'unavailable' || typeof adapter.interrupt !== 'function') {
    return { ok: false, output: 'No interrupt-capable Pi subagent adapter is available.' };
  }

  const result = adapter.interrupt(runId);
  if (result.ok && container) {
    const targetRunId = result.runId || runId || getZergControlState(container.read()).activeRunId;
    if (targetRunId) {
      const interrupted = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: targetRunId,
        kind: 'subagent',
        status: 'running',
        activity: 'interrupt requested',
        substate: 'cancelling',
        substateReason: result.message,
      }, { now: options.now ?? (() => new Date()) });
      const snapshot = container.replace(appendLogToState(interrupted, options, {
        source: 'command',
        level: result.ok ? 'warn' : 'error',
        kind: result.ok ? 'text' : 'error',
        message: result.message,
        runId: targetRunId,
      }));
      if (options.syncSharedState) {
        replaceSharedZergState(snapshot);
      }
    }
  }
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
  let launchMode: ZergSubagentLaunchMode = 'fresh';
  let sawFresh = false;
  let sawFork = false;
  let model: string | undefined;
  let fallbackModels: string[] | undefined;
  let maxTurns: number | undefined;
  const filtered: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const modelValue = readOptionValue(tokens, index, '--model');
    const fallbackValue = readOptionValue(tokens, index, '--fallback-models') ?? readOptionValue(tokens, index, '--fallback');
    const maxTurnsValue = readOptionValue(tokens, index, '--max-turns') ?? readOptionValue(tokens, index, '--maxTurns');

    if (token === '--bg' || token === '--background') {
      background = true;
    } else if (token === '--fresh') {
      sawFresh = true;
      launchMode = 'fresh';
    } else if (token === '--fork') {
      sawFork = true;
      launchMode = 'fork';
    } else if (modelValue !== undefined) {
      model = modelValue;
      if (token === '--model') index += 1;
    } else if (fallbackValue !== undefined) {
      fallbackModels = parseCsvOption(fallbackValue);
      if (token === '--fallback-models' || token === '--fallback') index += 1;
    } else if (maxTurnsValue !== undefined) {
      const parsed = Number(maxTurnsValue);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        return { ok: false, output: '--max-turns must be a positive integer.' };
      }
      maxTurns = parsed;
      if (token === '--max-turns' || token === '--maxTurns') index += 1;
    } else {
      filtered.push(token);
    }
  }

  if (sawFresh && sawFork) {
    return { ok: false, output: 'Conflicting launch modes: use either --fresh or --fork, not both.' };
  }

  const [agent, ...taskTokens] = filtered;
  if (!agent) {
    return { ok: false, output: 'Usage: /zerg run <agent> <task> [--bg] [--fresh|--fork] [--model <model>]' };
  }

  const task = taskTokens.join(' ').trim();
  if (!task) {
    return { ok: false, output: 'zerg run requires a non-empty task.' };
  }

  return {
    ok: true,
    request: {
      agent,
      task,
      background,
      fork: launchMode === 'fork',
      launchMode,
      ...(model ? { model } : {}),
      ...(fallbackModels?.length ? { fallbackModels } : {}),
      ...(maxTurns ? { maxTurns } : {}),
    },
  };
}

function readOptionValue(tokens: string[], index: number, name: string): string | undefined {
  const token = tokens[index]!;
  if (token === name) {
    return tokens[index + 1];
  }
  const prefix = `${name}=`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : undefined;
}

function parseLogFilters(tokens: string[]): LogsParseResult {
  const filter: ZergLogFilter = {};
  let json = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();

    if (lower === '--json') {
      json = true;
    } else if (lower === '--run') {
      const value = tokens[index + 1];
      if (!value) {
        return { ok: false, output: 'Usage: --run <id>' };
      }
      filter.runId = normalizeLogFilterText(value);
      index += 1;
    } else if (lower.startsWith('--run=')) {
      const value = token.slice('--run='.length);
      if (!value) {
        return { ok: false, output: 'Usage: --run <id>' };
      }
      filter.runId = normalizeLogFilterText(value);
    } else if (lower === '--level') {
      const value = tokens[index + 1]?.toLowerCase();
      if (!isZergLogLevel(value)) {
        return { ok: false, output: `Unknown log level: ${tokens[index + 1] ?? ''}` };
      }
      filter.level = value;
      index += 1;
    } else if (lower.startsWith('--level=')) {
      const value = token.slice('--level='.length).toLowerCase();
      if (!isZergLogLevel(value)) {
        return { ok: false, output: `Unknown log level: ${token.slice('--level='.length)}` };
      }
      filter.level = value;
    } else if (lower === '--limit') {
      const value = tokens[index + 1];
      const limit = parseLogLimit(value);
      if (limit === undefined) {
        return { ok: false, output: `Invalid log limit: ${value ?? ''}` };
      }
      filter.limit = limit;
      index += 1;
    } else if (lower.startsWith('--limit=')) {
      const value = token.slice('--limit='.length);
      const limit = parseLogLimit(value);
      if (limit === undefined) {
        return { ok: false, output: `Invalid log limit: ${value}` };
      }
      filter.limit = limit;
    } else {
      return { ok: false, output: `Unknown logs filter: ${token}` };
    }
  }

  return { ok: true, filter, json };
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


function resolveRunId(idFactory?: ZergIdFactory): string {
  const generator = idFactory?.runId ?? defaultIdFactory.runId;
  const candidate = generator();
  return sanitizeSpawnId(candidate, DEFAULT_RUN_ID_PREFIX);
}

function resolveTaskId(idFactory?: ZergIdFactory): string {
  const generator = idFactory?.taskId ?? defaultIdFactory.taskId;
  const candidate = generator();
  return sanitizeSpawnId(candidate, DEFAULT_TASK_ID_PREFIX);
}

function resolveLaunchMode(request: Pick<ZergSubagentLaunchRequest, 'fork' | 'launchMode'>): ZergSubagentLaunchMode {
  if (request.launchMode === 'fork' || request.fork === true) {
    return 'fork';
  }

  return 'fresh';
}

function sanitizeSpawnId(value: string, prefix: string): string {
  const safe = value.trim().replace(/\s+/g, '-');
  const base = safe.replace(/[^a-zA-Z0-9._-]/g, '-');
  const normalized = `${base}`.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  if (normalized.length === 0) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
  return normalized.startsWith(prefix) ? normalized : `${prefix}-${normalized}`;
}

function appendSpawnIdentifiers(message: string, runId: string, taskId: string): string {
  const includesRun = message.includes(runId);
  const includesTask = message.includes(taskId);
  if (includesRun && includesTask) {
    return message;
  }

  const suffix = `${includesRun ? '' : ` (${runId})`} ${includesTask ? '' : `task:${taskId}`}`.trim();
  return `${message}${suffix ? ` ${suffix}` : ''}`;
}

function appendSpawnLaunchMode(message: string, launchMode: ZergSubagentLaunchMode): string {
  const suffix = `(${launchMode})`;
  return message.includes(suffix) ? message : `${message} ${suffix}`;
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

  const parsedSubstate = parseLifecycleSubstateOptions(rest);
  if (!parsedSubstate.ok) {
    return parsedSubstate;
  }

  const parsedOptions = parseRuntimeEntityOptions(entity, parsedSubstate.tokens);
  if (!parsedOptions.ok) {
    return parsedOptions;
  }

  const text = parsedOptions.tokens.join(' ').trim();
  const metadata = buildRuntimeConfigMetadata(parsedOptions);
  const common = {
    action,
    id,
    ...(action === 'create' && text ? { label: text } : {}),
    ...((action === 'progress' || action === 'fail') && text ? { activity: text } : {}),
    ...(parsedSubstate.substate ? { substate: parsedSubstate.substate } : {}),
    ...(parsedSubstate.substateReason ? { substateReason: parsedSubstate.substateReason } : {}),
    ...(metadata ? { metadata } : {}),
  } as const;

  if (entity === 'agent') {
    return {
      ok: true,
      transition: {
        entity: 'agent',
        ...common,
        ...(parsedOptions.kind && isRuntimeAgentKind(parsedOptions.kind) ? { kind: parsedOptions.kind } : {}),
        ...(parsedOptions.team ? { teamId: parsedOptions.team } : {}),
        ...(parsedOptions.parent ? { parentId: parsedOptions.parent } : {}),
        ...(parsedOptions.children ? { childIds: parsedOptions.children } : {}),
      },
    };
  }

  return {
    ok: true,
    transition: {
      entity: 'team',
      ...common,
      ...(parsedOptions.kind && isRuntimeTeamKind(parsedOptions.kind) ? { kind: parsedOptions.kind } : {}),
      ...(parsedOptions.leader ? { leaderAgentId: parsedOptions.leader } : {}),
      ...(parsedOptions.members ? { memberAgentIds: parsedOptions.members } : {}),
      ...(parsedOptions.parentTeam ? { parentTeamId: parsedOptions.parentTeam } : {}),
      ...(parsedOptions.tasks ? { taskIds: parsedOptions.tasks } : {}),
    },
  };
}

interface RuntimeEntityOptions {
  ok: true;
  tokens: string[];
  kind?: string;
  leader?: string;
  members?: string[];
  parentTeam?: string;
  tasks?: string[];
  parent?: string;
  team?: string;
  children?: string[];
  model?: string;
  fallbackModels?: string[];
  maxTurns?: number;
  agentDefinitionId?: string;
}

type RuntimeEntityOptionsParseResult = RuntimeEntityOptions | { ok: false; output: string };

function parseRuntimeEntityOptions(entity: ZergRuntimeEntity, tokens: string[]): RuntimeEntityOptionsParseResult {
  const remaining: string[] = [];
  const options: RuntimeEntityOptions = { ok: true, tokens: remaining };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const kind = readOptionValue(tokens, index, '--kind');
    const leader = readOptionValue(tokens, index, '--leader');
    const members = readOptionValue(tokens, index, '--members') ?? readOptionValue(tokens, index, '--member');
    const parentTeam = readOptionValue(tokens, index, '--parent-team');
    const tasks = readOptionValue(tokens, index, '--tasks') ?? readOptionValue(tokens, index, '--task');
    const parent = readOptionValue(tokens, index, '--parent');
    const team = readOptionValue(tokens, index, '--team');
    const children = readOptionValue(tokens, index, '--children') ?? readOptionValue(tokens, index, '--child');
    const model = readOptionValue(tokens, index, '--model');
    const fallbackModels = readOptionValue(tokens, index, '--fallback-models') ?? readOptionValue(tokens, index, '--fallback');
    const maxTurns = readOptionValue(tokens, index, '--max-turns') ?? readOptionValue(tokens, index, '--maxTurns');
    const agentDefinitionId = readOptionValue(tokens, index, '--agent-definition') ?? readOptionValue(tokens, index, '--agent-def');

    if (kind !== undefined) {
      if (entity === 'agent' && !isRuntimeAgentKind(kind)) return { ok: false, output: `Unknown agent kind: ${kind}` };
      if (entity === 'team' && !isRuntimeTeamKind(kind)) return { ok: false, output: `Unknown team kind: ${kind}` };
      options.kind = kind;
      if (token === '--kind') index += 1;
    } else if (leader !== undefined) {
      if (!leader || leader.startsWith('--')) return { ok: false, output: 'Usage: --leader <agent-id>' };
      options.leader = leader;
      if (token === '--leader') index += 1;
    } else if (members !== undefined) {
      const parsed = parseCsvOption(members);
      if (!parsed) return { ok: false, output: 'Usage: --members <agent-id>[,<agent-id>...]' };
      options.members = [...new Set([...(options.members ?? []), ...parsed])];
      if (token === '--members' || token === '--member') index += 1;
    } else if (parentTeam !== undefined) {
      options.parentTeam = parentTeam;
      if (token === '--parent-team') index += 1;
    } else if (tasks !== undefined) {
      options.tasks = [...new Set([...(options.tasks ?? []), ...(parseCsvOption(tasks) ?? [])])];
      if (token === '--tasks' || token === '--task') index += 1;
    } else if (parent !== undefined) {
      options.parent = parent;
      if (token === '--parent') index += 1;
    } else if (team !== undefined) {
      options.team = team;
      if (token === '--team') index += 1;
    } else if (children !== undefined) {
      options.children = [...new Set([...(options.children ?? []), ...(parseCsvOption(children) ?? [])])];
      if (token === '--children' || token === '--child') index += 1;
    } else if (model !== undefined) {
      options.model = model;
      if (token === '--model') index += 1;
    } else if (fallbackModels !== undefined) {
      options.fallbackModels = parseCsvOption(fallbackModels);
      if (token === '--fallback-models' || token === '--fallback') index += 1;
    } else if (maxTurns !== undefined) {
      const parsed = Number(maxTurns);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return { ok: false, output: '--max-turns must be a positive integer.' };
      options.maxTurns = parsed;
      if (token === '--max-turns' || token === '--maxTurns') index += 1;
    } else if (agentDefinitionId !== undefined) {
      options.agentDefinitionId = agentDefinitionId;
      if (token === '--agent-definition' || token === '--agent-def') index += 1;
    } else {
      remaining.push(token);
    }
  }

  return options;
}

function buildRuntimeConfigMetadata(options: RuntimeEntityOptions): Record<string, unknown> | undefined {
  const metadata = {
    ...(options.model ? { model: options.model } : {}),
    ...(options.fallbackModels?.length ? { fallbackModels: options.fallbackModels } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.agentDefinitionId ? { agentDefinitionId: options.agentDefinitionId } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function isRuntimeAgentKind(value: string): value is AgentKind {
  return value === 'subagent' || value === 'teammate' || value === 'team-leader';
}

function isRuntimeTeamKind(value: string): value is TeamKind {
  return value === 'team' || value === 'squad' || value === 'worktree';
}

function parseLifecycleSubstateOptions(tokens: string[]): { ok: true; tokens: string[]; substate?: ZergLifecycleSubstate; substateReason?: string } | { ok: false; output: string } {
  const remaining: string[] = [];
  let substate: ZergLifecycleSubstate | undefined;
  let substateReason: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === '--substate') {
      const value = tokens[index + 1];
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value ?? ''}` };
      }
      substate = value;
      index += 1;
    } else if (lower.startsWith('--substate=')) {
      const value = token.slice('--substate='.length);
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value}` };
      }
      substate = value;
    } else if (lower.startsWith('substate=')) {
      const value = token.slice('substate='.length);
      if (!isLifecycleSubstate(value)) {
        return { ok: false, output: `Unknown lifecycle substate: ${value}` };
      }
      substate = value;
    } else if (lower === '--substate-reason') {
      const value = tokens[index + 1] ?? '';
      const normalized = normalizeInterventionText(value, MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);
      if (value && !normalized) {
        return { ok: false, output: `lifecycle substate reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
      }
      substateReason = normalized || undefined;
      index += 1;
    } else if (lower.startsWith('substatereason=') || lower.startsWith('substate-reason=')) {
      const separator = token.indexOf('=');
      const value = separator >= 0 ? token.slice(separator + 1) : '';
      const normalized = normalizeInterventionText(value, MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS);
      if (value && !normalized) {
        return { ok: false, output: `lifecycle substate reason exceeds ${MAX_INTERVENTION_MESSAGE_LENGTH_FOR_REASONS} characters or contains only control characters.` };
      }
      substateReason = normalized || undefined;
    } else {
      remaining.push(token);
    }
  }

  return { ok: true, tokens: remaining, substate, substateReason };
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

function normalizePermissionCommandText(input: string): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLogFilterText(input: string): string {
  return normalizePermissionCommandText(input).slice(0, 160);
}

function parseLogLimit(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 ? limit : undefined;
}

function isZergLogLevel(value: string | undefined): value is NonNullable<ZergLogFilter['level']> {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isRuntimeAction(value: string | undefined): value is ZergRuntimeTransitionAction {
  return value === 'create' || value === 'start' || value === 'progress' || value === 'stop' || value === 'fail' || value === 'reset';
}

function isLifecycleSubstate(value: string | undefined): value is ZergLifecycleSubstate {
  return value === 'queued'
    || value === 'spawning'
    || value === 'starting'
    || value === 'planning'
    || value === 'waiting-permission'
    || value === 'waiting-input'
    || value === 'executing'
    || value === 'tool-running'
    || value === 'streaming-output'
    || value === 'compacting'
    || value === 'idle'
    || value === 'stopping'
    || value === 'cancelling'
    || value === 'completed'
    || value === 'failed'
    || value === 'reset';
}

function isPermissionRequestKind(value: string | undefined): value is ZergPermissionRequestKind {
  return value === 'run' || value === 'interrupt' || value === 'tool' || value === 'mode' || value === 'intervention' || value === 'adapter';
}

function isPermissionListFilter(value: string): value is 'all' | 'pending' | 'resolved' {
  return value === 'all' || value === 'pending' || value === 'resolved';
}

function permissionDecisionForAction(action: 'approve' | 'deny' | 'cancel'): ZergPermissionDecision {
  return action === 'approve' ? 'approve' : action === 'deny' ? 'deny' : 'cancel';
}

function permissionPastTense(decision: ZergPermissionDecision): string {
  return decision === 'approve'
    ? 'approved'
    : decision === 'deny'
      ? 'denied'
      : decision === 'cancel'
        ? 'cancelled'
        : 'expired';
}

function appendLogToState(
  state: ZergState,
  _options: RuntimeCommandOptions,
  input: Parameters<typeof appendZergLogRecord>[1],
): ZergState {
  return appendZergLogRecord(state, input);
}

function appendLogToContainer(
  container: ZergStateContainer,
  options: RuntimeCommandOptions,
  input: Parameters<typeof appendZergLogRecord>[1],
): ZergState {
  return container.replace(appendLogToState(container.read(), options, input));
}

function updateRunTaskLifecycle(
  state: ZergState,
  taskId: string | undefined,
  status: AgentStatus,
  substate: ZergLifecycleSubstate,
  substateReason: string | undefined,
  updatedAt: string,
): ZergState {
  if (!taskId || !state.tasks[taskId]) {
    return state;
  }

  const task = state.tasks[taskId];
  return upsertTask(state, {
    ...task,
    status,
    substate,
    substateReason,
    substateUpdatedAt: updatedAt,
    updatedAt,
  });
}

function markPermissionRequestTerminalLifecycle(
  state: ZergState,
  runId: string | undefined,
  decision: ZergPermissionDecision,
  options: RuntimeCommandOptions,
): ZergState {
  if (!runId || !state.agents[runId]) {
    return state;
  }

  const reason = decision === 'deny' ? 'permission denied' : 'permission cancelled';
  return applyRuntimeTransition(state, {
    entity: 'agent',
    action: 'fail',
    id: runId,
    kind: 'subagent',
    activity: reason,
    substate: 'failed',
    substateReason: reason,
  }, { now: options.now ?? (() => new Date()) });
}

function markRunWaitingForPermission(
  state: ZergState,
  runId: string,
  permissionRequestId: string | undefined,
  options: RuntimeCommandOptions,
): ZergState {
  const waiting = applyRuntimeTransition(state, {
    entity: 'agent',
    action: 'progress',
    id: runId,
    kind: 'subagent',
    status: 'blocked',
    activity: 'waiting for permission',
    substate: 'waiting-permission',
    substateReason: permissionRequestId ? `permission ${permissionRequestId}` : 'permission required',
  }, { now: options.now ?? (() => new Date()) });
  const agent = waiting.agents[runId];
  if (!agent || !permissionRequestId) {
    return waiting;
  }

  return {
    ...waiting,
    agents: {
      ...waiting.agents,
      [runId]: {
        ...agent,
        metadata: {
          ...agent.metadata,
          permissionRequestId,
        },
      },
    },
  };
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
    ...Object.values(state.agents).map((agent) => ({ id: agent.id, label: agent.label, kind: agent.kind, status: formatConfigStatus(agent.status, agent.runtime?.substate) })),
    ...Object.values(state.teams).map((team) => ({ id: team.id, label: team.label, kind: team.kind, status: formatConfigStatus(team.status, team.runtime?.substate) })),
    ...Object.values(state.tasks).map((task) => ({ id: task.id, label: task.title, kind: 'task', status: formatConfigStatus(task.status, task.substate) })),
  ].sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
}

function formatConfigStatus(status: string, substate?: string): string {
  return substate ? `${status}/${substate}` : status;
}

function renderZergControlStatus(state: ZergState, width: number): string {
  const control = getZergControlState(state);
  const readOnly = state.mode.readOnly ? 'enabled' : 'disabled';
  const latestAudit = control.auditLog?.at(-1)?.message ?? 'none';
  const permissionQueue = getPermissionQueueState(state);
  const latestPermission = getPendingPermissionRequests(state).at(-1);
  const logState = getZergLogState(state);
  const latestLogWarning = logState.records.filter((record) => record.level === 'warn' || record.level === 'error').at(-1);
  const activeRun = control.activeRunId ? state.agents[control.activeRunId] : undefined;
  const activeRunSubstate = activeRun?.runtime?.substate ? ` [${activeRun.status}/${activeRun.runtime.substate}]` : '';
  const activeRunReason = activeRun?.runtime?.substateReason ? ` ${activeRun.runtime.substateReason}` : '';
  return [
    'zerg control',
    `controller: ${control.controller}`,
    `mode: ${state.mode.automation}`,
    `read-only: ${readOnly}`,
    `permissions: ${permissionQueue.pendingCount} pending${latestPermission ? ` latest:${latestPermission.id} ${latestPermission.kind} ${latestPermission.summary}` : ''}`,
    `logs: ${logState.records.length}/${logState.maxRecords}${latestLogWarning ? ` latest:${latestLogWarning.id} ${latestLogWarning.level} ${latestLogWarning.message}` : ''}`,
    `selected target: ${control.selectedTargetId ?? 'none'}`,
    `active run: ${control.activeRunId ?? 'none'}${activeRunSubstate}${activeRunReason}`,
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

  const resolveTaskIdFromRun = (request: ZergSubagentLaunchRequest): string | undefined => {
    return typeof request.taskId === 'string' && request.taskId.length > 0 ? request.taskId : undefined;
  };

  const resolveLaunchMetadata = (request: ZergSubagentLaunchRequest, taskId: string | undefined, launchMode: ZergSubagentLaunchMode) => {
    const metadata = {
      ...(taskId ? { taskId } : {}),
      launchMode,
      ...(request.agentDefinitionId ? { agentDefinitionId: request.agentDefinitionId } : {}),
      ...(request.description ? { description: request.description } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
      ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
    };

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  };

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
          metadata: {
            ...existing.metadata,
            ...pending.metadata,
          },
          taskId: pending.taskId ?? existing.taskId,
          launchMode: pending.launchMode ?? existing.launchMode,
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

  const updatePendingRun = (runId: string, status?: AgentStatus, eventTimestamp = resolveTimestamp(), activity?: string, substate?: ZergLifecycleSubstate, substateReason?: string): void => {
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

    if (substate) {
      pending.substate = substate;
      pending.substateUpdatedAt = eventTimestamp;
    }

    if (substateReason) {
      pending.substateReason = substateReason;
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

      updatePendingRun(requestId, 'running', resolveTimestamp(), getSubagentRunSnapshot(container.read(), requestId)?.task, 'starting', 'bridge started');
      const snapshot = updateZergControlState(container, { activeRunId: requestId }, `subagent ${requestId} started`, options);
      const started = applyRuntimeTransition(snapshot, {
        entity: 'agent',
        action: 'start',
        id: requestId,
        label: pending?.agentLabel ?? pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: pending?.task,
        substate: 'starting',
        substateReason: 'bridge started',
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(started, pending?.taskId, 'running', 'starting', 'bridge started', resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge started ${requestId}`,
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
      });
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_UPDATE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const hasCurrentTool = data && typeof data === 'object' && typeof (data as { currentTool?: unknown }).currentTool === 'string';
      const currentTool = hasCurrentTool
        ? (data as { currentTool: string }).currentTool
        : 'progress';
      const substate: ZergLifecycleSubstate = hasCurrentTool ? 'tool-running' : 'executing';
      const bridgeLog = parseBridgeUpdateLog(data, hasCurrentTool ? currentTool : undefined);
      const pending = runsById.get(requestId);
      updatePendingRun(requestId, 'running', resolveTimestamp(), currentTool, substate, hasCurrentTool ? currentTool : undefined);
      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: 'progress',
        id: requestId,
        kind: 'subagent',
        activity: currentTool,
        substate,
        substateReason: hasCurrentTool ? currentTool : undefined,
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(snapshot, pending?.taskId, 'running', substate, hasCurrentTool ? currentTool : undefined, resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: bridgeLog.level,
        kind: bridgeLog.kind,
        message: bridgeLog.message,
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
        data: bridgeLog.data,
      });
    }),
    subscribePiEvent(events, SLASH_SUBAGENT_RESPONSE_EVENT, (data) => {
      const requestId = getEventRequestId(data);
      if (!requestId) return;

      const isError = data && typeof data === 'object' && (data as { isError?: unknown }).isError === true;
      const status: AgentStatus = isError ? 'failed' : 'done';
      const pending = runsById.get(requestId);
      if (pending) {
        pending.completed = true;
        updatePendingRun(requestId, status, resolveTimestamp(), isError ? 'subagent failed' : 'subagent complete', isError ? 'failed' : 'completed', isError ? 'subagent failed' : 'subagent complete');
      }

      const snapshot = applyRuntimeTransition(container.read(), {
        entity: 'agent',
        action: isError ? 'fail' : 'stop',
        id: requestId,
        label: pending?.agentId ?? requestId,
        kind: 'subagent',
        activity: isError ? 'subagent failed' : 'subagent complete',
        substate: isError ? 'failed' : 'completed',
        substateReason: isError ? 'subagent failed' : 'subagent complete',
      }, { now: options.now ?? (() => new Date()) });
      container.replace(updateRunTaskLifecycle(snapshot, pending?.taskId, isError ? 'failed' : 'done', isError ? 'failed' : 'completed', isError ? 'subagent failed' : 'subagent complete', resolveTimestamp()));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: isError ? 'error' : 'info',
        kind: isError ? 'error' : 'result',
        message: isError ? 'subagent failed' : 'subagent complete',
        runId: requestId,
        agentId: pending?.agentId,
        taskId: pending?.taskId,
      });
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
      const requestId = request.runId
        ?? `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const now = resolveTimestamp();
      const selectedDefinition = getAgentDefinition(container.read(), request.agent);
      const agentLabel = selectedDefinition?.label;
      const taskId = resolveTaskIdFromRun(request);
      const launchMode = resolveLaunchMode(request);
      const launchMetadata = resolveLaunchMetadata(request, taskId, launchMode);
      const hasExistingRun = container.read().agents[requestId] !== undefined;

      runsById.set(requestId, {
        runId: requestId,
        agentId: request.agent,
        agentLabel,
        task: request.task,
        status: 'idle',
        taskId,
        launchMode,
        substate: 'spawning',
        substateReason: 'bridge request emitted',
        substateUpdatedAt: now,
        updatedAt: now,
        startedAt: undefined,
        metadata: launchMetadata,
        launched: false,
        started: false,
        completed: false,
      });

      if (!hasExistingRun) {
        const before = applyRuntimeTransition(container.read(), {
          entity: 'agent',
          action: 'create',
          id: requestId,
          label: agentLabel ?? request.agent,
          kind: 'subagent',
          activity: request.task,
          substate: 'spawning',
          substateReason: 'bridge request emitted',
        }, { now: options.now ?? (() => new Date()) });

        const created = before.agents[requestId];
        if (created && launchMetadata) {
          container.replace({
            ...before,
            agents: {
              ...before.agents,
              [requestId]: {
                ...created,
                metadata: {
                  ...created.metadata,
                  ...launchMetadata,
                },
              },
            },
          });
        } else {
          container.replace(before);
        }
      } else {
        const existing = container.read().agents[requestId];
        if (existing) {
          container.replace({
            ...container.read(),
            agents: {
              ...container.read().agents,
              [requestId]: {
                ...existing,
                metadata: {
                  ...existing.metadata,
                  ...launchMetadata,
                },
              },
            },
          });
        }
      }

      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge request emitted for ${requestId}`,
        runId: requestId,
        agentId: request.agent,
        taskId,
        data: { launchMode, background: request.background === true, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
      });

      events.emit!(SLASH_SUBAGENT_REQUEST_EVENT, {
        requestId,
        params: {
          agent: request.agent,
          task: request.task,
          taskId,
          agentDefinitionId: request.agentDefinitionId,
          description: request.description,
          ...(request.model ? { model: request.model } : {}),
          ...(request.fallbackModels?.length ? { fallbackModels: request.fallbackModels } : {}),
          ...(request.maxTurns ? { maxTurns: request.maxTurns } : {}),
          clarify: false,
          agentScope: 'both',
          ...(request.background ? { async: true } : {}),
          ...(launchMode === 'fork' ? { context: 'fork' as const } : {}),
        },
      });

      const run = runsById.get(requestId);
      if (!run) {
        return { ok: false, runId: requestId, taskId, message: `failed to initialize zerg run ${requestId}` };
      }

      if (!run.started) {
        runsById.delete(requestId);
        if (!hasExistingRun) {
          const failed = applyRuntimeTransition(container.read(), {
            entity: 'agent',
            action: 'fail',
            id: requestId,
            label: request.agent,
            kind: 'subagent',
            activity: 'No pi-subagents slash bridge responded.',
            substate: 'failed',
            substateReason: 'No pi-subagents slash bridge responded.',
          }, { now: options.now ?? (() => new Date()) });
          container.replace(appendLogToState(failed, options, {
            source: 'adapter',
            level: 'error',
            kind: 'error',
            message: 'No pi-subagents slash bridge responded.',
            runId: requestId,
            agentId: request.agent,
            taskId,
            data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
          }));
        }
        return {
          ok: false,
          runId: requestId,
          taskId,
          message: 'No pi-subagents slash bridge responded. Ensure pi-subagents is loaded.',
        };
      }

      run.launched = true;
      updateZergControlState(container, { activeRunId: requestId }, `launched ${request.agent}`, options);
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'info',
        kind: 'text',
        message: `bridge launch confirmed ${requestId}`,
        runId: requestId,
        agentId: request.agent,
        taskId,
        data: { launchMode, model: request.model, fallbackModels: request.fallbackModels, maxTurns: request.maxTurns },
      });
      return { ok: true, runId: requestId, taskId, message: `zerg launched ${request.agent} as ${requestId} (${launchMode})` };
    },
    interrupt(runId) {
      const target = runId || getZergControlState(container.read()).activeRunId;
      if (!target) {
        return { ok: false, message: 'No active zerg subagent run to interrupt.' };
      }
      events.emit!(SLASH_SUBAGENT_CANCEL_EVENT, { requestId: target });
      const snapshot = updateZergControlState(container, { activeRunId: target }, `interrupt requested for ${target}`, options);
      container.replace(applyRuntimeTransition(snapshot, {
        entity: 'agent',
        action: 'progress',
        id: target,
        kind: 'subagent',
        status: 'running',
        activity: 'interrupt requested',
        substate: 'cancelling',
        substateReason: 'interrupt requested',
      }, { now: options.now ?? (() => new Date()) }));
      appendLogToContainer(container, options, {
        source: 'adapter',
        level: 'warn',
        kind: 'text',
        message: `interrupt requested for ${target}`,
        runId: target,
      });
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

function parseBridgeUpdateLog(data: unknown, currentTool: string | undefined): { level: 'info' | 'error'; kind: 'text' | 'tool' | 'error'; message: string; data?: Record<string, unknown> } {
  if (!data || typeof data !== 'object') {
    return { level: 'info', kind: 'text', message: 'bridge progress update' };
  }

  const payload = data as { isError?: unknown; currentTool?: unknown; output?: unknown; message?: unknown; progress?: unknown };
  if (payload.isError === true) {
    return {
      level: 'error',
      kind: 'error',
      message: firstString(payload.message, payload.output, payload.progress) ?? 'bridge update error',
      data: currentTool ? { currentTool } : undefined,
    };
  }

  if (currentTool) {
    return {
      level: 'info',
      kind: 'tool',
      message: `tool running: ${currentTool}`,
      data: { currentTool },
    };
  }

  const text = firstString(payload.output, payload.message, payload.progress);
  if (text) {
    return { level: 'info', kind: 'text', message: text };
  }

  return { level: 'info', kind: 'text', message: 'bridge progress update' };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }

  return undefined;
}

function toOverlayTextRows(text: string, kind: ZergManagementOverlayRow['kind'] = 'text'): ZergManagementOverlayRow[] {
  return text.split('\n').map((line, index) => ({
    id: `${kind}-${index}`,
    kind,
    label: line,
    selectable: false,
  }));
}

function buildTargetDetailLines(
  state: ZergState,
  target: ReturnType<typeof getConfigTargets>[number],
): string[] {
  const agent = state.agents[target.id];
  if (agent) {
    return [
      `id: ${agent.id}`,
      `kind: ${agent.kind}`,
      `status: ${formatConfigStatus(agent.status, agent.runtime?.substate)}`,
      `health: ${agent.runtime?.health ?? 'unknown'}`,
      `last activity: ${agent.runtime?.lastActivity ?? 'none'}`,
      `reason: ${agent.runtime?.substateReason ?? 'none'}`,
    ];
  }

  const team = state.teams[target.id];
  if (team) {
    return [
      `id: ${team.id}`,
      `kind: ${team.kind}`,
      `status: ${formatConfigStatus(team.status, team.runtime?.substate)}`,
      `leader: ${team.leaderAgentId ?? 'none'}`,
      `members: ${(team.memberAgentIds ?? []).join(', ') || 'none'}`,
      `reason: ${team.runtime?.substateReason ?? 'none'}`,
    ];
  }

  const task = state.tasks[target.id];
  if (task) {
    return [
      `id: ${task.id}`,
      `status: ${formatConfigStatus(task.status, task.substate)}`,
      `owner: ${task.ownerAgentId ?? 'none'}`,
      `team: ${task.teamId ?? 'none'}`,
      `updated: ${task.updatedAt}`,
      `reason: ${task.substateReason ?? 'none'}`,
    ];
  }

  return [`id: ${target.id}`, `status: ${target.status}`];
}

function buildPermissionDetailLines(request: ReturnType<typeof getPermissionQueueState>['requests'][number]): string[] {
  return [
    `id: ${request.id}`,
    `kind: ${request.kind}`,
    `status: ${request.status}`,
    `requester: ${request.requester}`,
    `target: ${request.targetId ?? 'none'}`,
    `run: ${request.runId ?? 'none'}`,
    `created: ${request.createdAt}`,
    `resolved: ${request.resolvedAt ?? 'none'}`,
    `reason: ${request.decisionReason ?? 'none'}`,
    `details: ${request.details ?? 'none'}`,
  ];
}

function buildLifecycleRows(
  state: ZergState,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergManagementOverlayRow[] {
  const runs = resolveAvailableRuns(state, adapter);
  const runRows = runs.map((run) => ({
    id: `run-${run.runId}`,
    kind: 'run' as const,
    label: `${run.runId} [${run.status}${run.substate ? `/${run.substate}` : ''}] ${run.agentLabel ?? run.agentId}${run.task ? ` — ${run.task}` : ''}`,
    selectable: true,
    runId: run.runId,
    targetId: run.agentId,
    detailLines: [
      `agent: ${run.agentId}`,
      `label: ${run.agentLabel ?? 'none'}`,
      `task: ${run.task ?? 'none'}`,
      `task-id: ${run.taskId ?? 'none'}`,
      `launch-mode: ${run.launchMode ?? 'none'}`,
      `updated: ${run.updatedAt ?? 'unknown'}`,
      `reason: ${run.substateReason ?? 'none'}`,
    ],
  }));
  const eventRows = state.events
    .filter((event) => event.type === 'agent' || event.type === 'team' || event.type === 'permission' || event.type === 'mode')
    .slice(-8)
    .reverse()
    .map((event, index) => ({
      id: `event-${event.id}-${index}`,
      kind: 'event' as const,
      label: `${event.type}${event.action ? `/${event.action}` : ''}${event.substate ? `/${event.substate}` : ''} ${event.message}`,
      selectable: true,
      detailLines: [
        `created: ${event.createdAt}`,
        `revision: ${event.revision ?? 'none'}`,
        `reason: ${event.substateReason ?? 'none'}`,
      ],
    }));
  return [...runRows, ...eventRows];
}

function buildLogRows(state: ZergState): ZergManagementOverlayRow[] {
  const control = getZergControlState(state);
  const focusId = [control.selectedTargetId, control.activeRunId].find((candidate) => candidate && getZergLogState(state).records.some((record) => record.runId === candidate || record.agentId === candidate || record.taskId === candidate || record.teamId === candidate));
  const records = (focusId
    ? getZergLogState(state).records.filter((record) => record.runId === focusId || record.agentId === focusId || record.taskId === focusId || record.teamId === focusId)
    : getZergLogState(state).records)
    .slice(-20)
    .reverse();

  return records.map((record) => ({
    id: `log-${record.id}`,
    kind: 'log',
    label: `${record.id} [${record.level}/${record.source}/${record.kind}] ${record.message}`,
    selectable: true,
    runId: record.runId,
    targetId: record.agentId ?? record.runId,
    detailLines: [
      `created: ${record.createdAt}`,
      `run: ${record.runId ?? 'none'}`,
      `agent: ${record.agentId ?? 'none'}`,
      `task: ${record.taskId ?? 'none'}`,
      `team: ${record.teamId ?? 'none'}`,
      `data: ${record.data ? JSON.stringify(record.data) : 'none'}`,
    ],
  }));
}

function buildInterventionRows(state: ZergState, draft: string): ZergManagementOverlayRow[] {
  const rows: ZergManagementOverlayRow[] = [];
  const activeIntervention = state.mode.activeIntervention;

  if (activeIntervention) {
    rows.push({
      id: 'intervention-current',
      kind: 'intervention',
      label: `current ${activeIntervention.kind} ${activeIntervention.targetId}: ${activeIntervention.message}`,
      selectable: true,
      targetId: activeIntervention.targetId,
      detailLines: [
        `created: ${activeIntervention.createdAt}`,
        `target-label: ${activeIntervention.targetLabel ?? 'none'}`,
        `team: ${activeIntervention.teamId ?? 'none'}`,
      ],
    });
  }

  const targets = getConfigTargets(state)
    .filter((target) => state.agents[target.id] || state.teams[target.id])
    .slice(0, 20);

  if (targets.length === 0) {
    rows.push({
      id: 'intervention-empty',
      kind: 'intervention',
      label: 'select a target in the targets tab, then use enter here to record a canned intervention',
      selectable: false,
      detailLines: [`draft: ${draft}`],
    });
    return rows;
  }

  rows.push(...targets.map((target) => ({
    id: `intervention-${target.id}`,
    kind: 'intervention' as const,
    label: `${target.kind === 'team' ? 'leader' : target.kind === 'subagent' ? 'subagent' : 'agent'} ${target.id} ${target.label}`,
    selectable: true,
    targetId: target.id,
    detailLines: [
      `draft: ${draft}`,
      'enter records intervention through existing command semantics',
    ],
  })));

  return rows;
}

function buildConfigRows(
  state: ZergState,
  adapter: ZergSubagentControlAdapter | undefined,
): ZergManagementOverlayRow[] {
  const control = getZergControlState(state);
  const permissionQueue = getPermissionQueueState(state);
  const latestPermission = getPendingPermissionRequests(state).at(-1);
  const logState = getZergLogState(state);
  const latestLogWarning = logState.records.filter((record) => record.level === 'warn' || record.level === 'error').at(-1);
  const activeRun = control.activeRunId ? state.agents[control.activeRunId] : undefined;
  return [
    {
      id: 'config-controller',
      kind: 'config',
      label: `controller: ${control.controller}`,
      selectable: false,
      detailLines: ['command fallback: /zerg control controller pi|zerg|operator'],
    },
    {
      id: 'config-mode',
      kind: 'config',
      label: `automation: ${state.mode.automation}`,
      selectable: false,
      detailLines: ['keys: m manual | a assisted | u automatic'],
    },
    {
      id: 'config-readonly',
      kind: 'config',
      label: `read-only: ${state.mode.readOnly ? 'enabled' : 'disabled'}`,
      selectable: false,
      detailLines: ['key: r toggles read-only through existing audited state path'],
    },
    {
      id: 'config-active-run',
      kind: 'config',
      label: `active run: ${control.activeRunId ?? 'none'}${activeRun?.runtime?.substate ? ` [${activeRun.status}/${activeRun.runtime.substate}]` : ''}`,
      selectable: false,
      detailLines: [`reason: ${activeRun?.runtime?.substateReason ?? 'none'}`],
    },
    {
      id: 'config-permissions',
      kind: 'config',
      label: `permissions: ${permissionQueue.pendingCount} pending${latestPermission ? ` latest:${latestPermission.id} ${latestPermission.kind} ${latestPermission.summary}` : ''}`,
      selectable: false,
      detailLines: ['command fallback: /zerg permission status'],
    },
    {
      id: 'config-logs',
      kind: 'config',
      label: `logs: ${logState.records.length}/${logState.maxRecords}${latestLogWarning ? ` latest:${latestLogWarning.id} ${latestLogWarning.level} ${latestLogWarning.message}` : ''}`,
      selectable: false,
      detailLines: ['command fallback: /zerg logs status'],
    },
    {
      id: 'config-adapter',
      kind: 'config',
      label: `adapter: ${adapter?.kind ?? 'unavailable'}`,
      selectable: false,
      detailLines: ['commands /zerg run and /zerg interrupt share the same adapter boundary'],
    },
  ];
}

function buildZergConfigOverlayRows(
  state: ZergState,
  activeTab: ZergConfigOverlayTab,
  adapter: ZergSubagentControlAdapter | undefined,
  interventionDraft: string,
): ZergManagementOverlayRow[] {
  if (activeTab === 'monitor') {
    return toOverlayTextRows(renderMonitor(state, { width: PI_COMMAND_OUTPUT_WIDTH }), 'text');
  }
  if (activeTab === 'control') {
    return toOverlayTextRows(renderZergControlStatus(state, PI_COMMAND_OUTPUT_WIDTH), 'config');
  }
  if (activeTab === 'targets') {
    return getConfigTargets(state).map((target) => ({
      id: `target-${target.id}`,
      kind: 'target',
      label: `${target.kind} ${target.id} ${target.label} [${target.status}]`,
      selectable: true,
      targetId: target.id,
      runId: state.agents[target.id] ? target.id : undefined,
      detailLines: buildTargetDetailLines(state, target),
    }));
  }
  if (activeTab === 'permissions') {
    return getPermissionQueueState(state).requests.slice().reverse().map((request) => ({
      id: `permission-${request.id}`,
      kind: 'permission',
      label: `${request.id} [${request.status}/${request.kind}] ${request.summary}`,
      selectable: true,
      requestId: request.id,
      runId: request.runId,
      targetId: request.targetId,
      detailLines: buildPermissionDetailLines(request),
    }));
  }
  if (activeTab === 'lifecycle') {
    return buildLifecycleRows(state, adapter);
  }
  if (activeTab === 'logs') {
    return buildLogRows(state);
  }
  if (activeTab === 'intervene') {
    return buildInterventionRows(state, interventionDraft);
  }
  return buildConfigRows(state, adapter);
}

function renderZergConfigOverlay(
  state: ZergState,
  options: {
    width: number;
    height?: number;
    activeTab: ZergConfigOverlayTab;
    selectedIndex: number;
    scrollOffset?: number;
    detailRowId?: string;
    statusMessage?: string;
    confirmMessage?: string;
    interventionDraft?: string;
    adapter?: ZergSubagentControlAdapter;
  },
): string {
  const rows = buildZergConfigOverlayRows(state, options.activeTab, options.adapter, options.interventionDraft ?? DEFAULT_OVERLAY_INTERVENTION_DRAFT);
  return renderZergManagementOverlay(state, {
    width: options.width,
    height: options.height,
    activeTab: options.activeTab,
    tabs: CONFIG_OVERLAY_TABS,
    rows,
    selectedIndex: options.selectedIndex,
    scrollOffset: options.scrollOffset,
    detailRowId: options.detailRowId,
    statusMessage: options.statusMessage,
    confirmMessage: options.confirmMessage,
    adapterKind: options.adapter?.kind ?? 'unavailable',
  });
}

function createManagementOverlayActions(stateOrReader: ZergStateSource, runtimeOptions: RuntimeCommandOptions) {
  const mutateControl = (payload: string) => dispatchControlCommand(stateOrReader, payload, runtimeOptions).output;
  const mutatePermission = (payload: string) => dispatchPermissionCommand(stateOrReader, payload, runtimeOptions).output;

  return {
    now: () => (runtimeOptions.now ?? (() => new Date()))(),
    toggleReadOnly: () => mutateControl('readonly toggle'),
    setAutomation: (mode: AutomationMode) => mutateControl(`mode ${mode}`),
    setController: (controller: ZergControlController) => mutateControl(`controller ${controller}`),
    approvePermission: (requestId: string) => mutatePermission(`approve ${requestId}`),
    denyPermission: (requestId: string) => mutatePermission(`deny ${requestId}`),
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => {
      const container = getWritableStateContainer(stateOrReader);
      if (!container) {
        return RUNTIME_WRITABLE_STATE_ERROR;
      }
      updateZergControlState(container, { selectedTargetId: target.id }, `selected target ${target.id}`, runtimeOptions);
      return `selected ${target.kind} ${target.id}`;
    },
    interruptSelected: (target: { id: string; kind: ZergManagementTargetKind } | undefined) => {
      const snapshot = resolveZergStateSnapshot(stateOrReader);
      const runId = target?.kind === 'agent'
        ? target.id
        : getZergControlState(snapshot).activeRunId;
      if (!runId) {
        return 'no active run selected for interrupt';
      }
      return dispatchInterruptCommand(stateOrReader, runId, runtimeOptions).output;
    },
    sendOperatorMessage: (target: { id: string; kind: ZergManagementTargetKind }, body: string): { status: ZergOperatorMessageDeliveryStatus; statusDetail: string; routedTargetId?: string } => {
      const snapshot = resolveZergStateSnapshot(stateOrReader);
      if (target.kind === 'task') {
        return { status: 'transport-unavailable', statusDetail: 'Tasks have no verified live message transport; operator message retained locally.' };
      }
      if (target.kind === 'team') {
        const team = snapshot.teams[target.id];
        if (!team?.leaderAgentId) {
          return { status: 'transport-unavailable', statusDetail: `Team ${target.id} has no leader; operator message retained locally.` };
        }
        const result = dispatchInterventionCommand(stateOrReader, `leader ${target.id} ${body}`, runtimeOptions);
        return {
          status: result.ok ? 'intervention-recorded' : 'transport-unavailable',
          statusDetail: result.ok ? `${result.output}; not delivered as chat transport.` : result.output,
          routedTargetId: team.leaderAgentId,
        };
      }
      const agent = snapshot.agents[target.id];
      if (!agent) {
        return { status: 'transport-unavailable', statusDetail: `Agent ${target.id} is unavailable; operator message retained locally.` };
      }
      const kind = agent.kind === 'subagent' ? 'subagent' : 'agent';
      const result = dispatchInterventionCommand(stateOrReader, `${kind} ${target.id} ${body}`, runtimeOptions);
      return {
        status: result.ok ? 'intervention-recorded' : 'transport-unavailable',
        statusDetail: result.ok ? `${result.output}; not delivered as chat transport.` : result.output,
        routedTargetId: target.id,
      };
    },
  };
}

export function createPiZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(stateOrReader, options);
  const runtimeOptions = options as RuntimeCommandOptions;

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const normalized = normalizeZergCommandInput(input);
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;

    if ((normalized.topic === 'monitor' || normalized.topic === 'config') && context.ui?.custom) {
      if (normalized.topic === 'config') {
        try {
          await openZergManagementOverlay(context, {
            getSnapshot: () => resolveZergStateSnapshot(stateOrReader),
            subscribe: (listener) => subscribeToZergState(stateOrReader, listener),
            adapterKind: runtimeOptions.subagentAdapter?.kind ?? 'unavailable',
            actions: createManagementOverlayActions(stateOrReader, runtimeOptions),
          });
          return;
        } catch {
          // Fall back to the M8 text management overlay path below when the M9 component path is unavailable.
        }
      }

      const overlayTopic = normalized.topic as 'monitor' | 'config';
      let activeTab: ZergConfigOverlayTab = overlayTopic === 'monitor' ? 'monitor' : 'config';
      const selectedIndexByTab: Record<ZergConfigOverlayTab, number> = {
        monitor: 0,
        control: 0,
        targets: 0,
        permissions: 0,
        lifecycle: 0,
        logs: 0,
        intervene: 0,
        config: 0,
      };
      const scrollOffsetByTab: Record<ZergConfigOverlayTab, number> = {
        monitor: 0,
        control: 0,
        targets: 0,
        permissions: 0,
        lifecycle: 0,
        logs: 0,
        intervene: 0,
        config: 0,
      };
      const detailRowIdByTab: Partial<Record<ZergConfigOverlayTab, string | undefined>> = {};
      let confirmation: OverlayConfirmationState | undefined;
      let statusMessage: string | undefined;
      let interventionDraft = DEFAULT_OVERLAY_INTERVENTION_DRAFT;
      const clearConfirmation = () => {
        confirmation = undefined;
      };
      const getSnapshot = () => resolveZergStateSnapshot(stateOrReader);
      const getRows = (tab: ZergConfigOverlayTab = activeTab) => buildZergConfigOverlayRows(getSnapshot(), tab, runtimeOptions.subagentAdapter, interventionDraft);
      const clampOverlayState = (tab: ZergConfigOverlayTab = activeTab) => {
        const rows = getRows(tab);
        const currentIndex = selectedIndexByTab[tab] ?? 0;
        const nextIndex = rows.length === 0 ? 0 : Math.max(0, Math.min(currentIndex, rows.length - 1));
        selectedIndexByTab[tab] = nextIndex;
        const maxScrollOffset = Math.max(0, rows.length - OVERLAY_VISIBLE_ROWS);
        let nextScrollOffset = Math.max(0, Math.min(scrollOffsetByTab[tab] ?? 0, maxScrollOffset));
        if (rows.length > 0) {
          if (nextIndex < nextScrollOffset) {
            nextScrollOffset = nextIndex;
          } else if (nextIndex >= nextScrollOffset + OVERLAY_VISIBLE_ROWS) {
            nextScrollOffset = Math.max(0, nextIndex - OVERLAY_VISIBLE_ROWS + 1);
          }
        }
        scrollOffsetByTab[tab] = nextScrollOffset;
        if (detailRowIdByTab[tab] && !rows.some((row) => row.id === detailRowIdByTab[tab])) {
          detailRowIdByTab[tab] = undefined;
        }
        const currentConfirmation = confirmation;
        if (currentConfirmation && !rows.some((row) => row.id === currentConfirmation.rowId && row.requestId === currentConfirmation.requestId)) {
          confirmation = undefined;
        }
        return rows;
      };
      const getSelectedRow = (tab: ZergConfigOverlayTab = activeTab) => {
        const rows = clampOverlayState(tab);
        return rows[selectedIndexByTab[tab]];
      };
      const renderOverlayOutput = (width?: number, height?: number) => {
        const outputWidth = typeof width === 'number' ? width : PI_COMMAND_OUTPUT_WIDTH;
        if (!result.ok) {
          return output;
        }

        const snapshot = getSnapshot();
        if (overlayTopic === 'monitor') {
          return renderMonitor(snapshot, { width: outputWidth });
        }

        clampOverlayState(activeTab);
        return renderZergConfigOverlay(snapshot, {
          width: outputWidth,
          height,
          activeTab,
          selectedIndex: selectedIndexByTab[activeTab],
          scrollOffset: scrollOffsetByTab[activeTab],
          detailRowId: detailRowIdByTab[activeTab],
          statusMessage,
          confirmMessage: confirmation ? `press ${confirmation.action === 'approve' ? 'p' : 'd'} again for ${confirmation.requestId}` : undefined,
          interventionDraft,
          adapter: runtimeOptions.subagentAdapter,
        });
      };

      try {
        context.ui.custom(
          (tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: () => void) => {
            let closed = false;
            let invalidated = false;
            const requestRender = () => {
              if (closed) {
                return;
              }
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
              clearConfirmation();
              const currentIndex = CONFIG_OVERLAY_TABS.indexOf(activeTab);
              activeTab = CONFIG_OVERLAY_TABS[(currentIndex + direction + CONFIG_OVERLAY_TABS.length) % CONFIG_OVERLAY_TABS.length]!;
              clampOverlayState(activeTab);
              requestRender();
            };
            const moveSelection = (direction: 1 | -1) => {
              clearConfirmation();
              const rows = clampOverlayState(activeTab);
              if (rows.length === 0) {
                statusMessage = `${activeTab}: none`;
                requestRender();
                return;
              }
              selectedIndexByTab[activeTab] = Math.max(0, Math.min(selectedIndexByTab[activeTab] + direction, rows.length - 1));
              clampOverlayState(activeTab);
              requestRender();
            };
            const recordIntervention = (row: ZergManagementOverlayRow | undefined) => {
              if (!row?.targetId) {
                statusMessage = 'select an intervention target first';
                requestRender();
                return;
              }
              const snapshot = getSnapshot();
              const payload = snapshot.teams[row.targetId]
                ? `leader ${row.targetId} ${interventionDraft}`
                : `${snapshot.agents[row.targetId]?.kind === 'subagent' ? 'subagent' : 'agent'} ${row.targetId} ${interventionDraft}`;
              const interventionResult = dispatchInterventionCommand(stateOrReader, payload, runtimeOptions);
              statusMessage = interventionResult.output;
              requestRender();
            };
            const toggleDetail = () => {
              clearConfirmation();
              const row = getSelectedRow();
              if (!row) {
                statusMessage = `${activeTab}: none`;
                requestRender();
                return;
              }
              detailRowIdByTab[activeTab] = detailRowIdByTab[activeTab] === row.id ? undefined : row.id;
              if (activeTab === 'targets' && row.targetId) {
                const container = getWritableStateContainer(stateOrReader);
                if (!container) {
                  statusMessage = RUNTIME_WRITABLE_STATE_ERROR;
                } else {
                  updateZergControlState(container, { selectedTargetId: row.targetId }, `selected target ${row.targetId}`, runtimeOptions);
                  statusMessage = `selected target ${row.targetId}`;
                }
              } else if (activeTab === 'intervene') {
                recordIntervention(row);
              }
              requestRender();
            };
            const applyControlMutation = (payload: string) => {
              clearConfirmation();
              const controlResult = dispatchControlCommand(stateOrReader, payload, runtimeOptions);
              statusMessage = controlResult.output;
              requestRender();
            };
            const applyPermissionDecision = (action: 'approve' | 'deny') => {
              if (activeTab !== 'permissions') {
                statusMessage = 'switch to the permissions tab first';
                requestRender();
                return;
              }
              const row = getSelectedRow();
              if (!row?.requestId) {
                statusMessage = 'select a permission request first';
                requestRender();
                return;
              }
              const request = getPermissionQueueState(getSnapshot()).requests.find((candidate) => candidate.id === row.requestId);
              if (!request || request.status !== 'pending') {
                clearConfirmation();
                statusMessage = `permission request ${row.requestId} is not pending`;
                requestRender();
                return;
              }
              if (confirmation?.action === action && confirmation.rowId === row.id && confirmation.requestId === row.requestId) {
                clearConfirmation();
                const permissionResult = dispatchPermissionCommand(stateOrReader, `${action} ${row.requestId}`, runtimeOptions);
                statusMessage = permissionResult.output;
                requestRender();
                return;
              }
              confirmation = { action, rowId: row.id, requestId: row.requestId };
              statusMessage = `press ${action === 'approve' ? 'p' : 'd'} again to ${action} ${row.requestId}`;
              requestRender();
            };
            const applyInterrupt = () => {
              clearConfirmation();
              const row = getSelectedRow();
              const snapshot = getSnapshot();
              const runId = row?.runId
                ?? (row?.targetId && snapshot.agents[row.targetId] ? row.targetId : undefined)
                ?? getZergControlState(snapshot).activeRunId;
              if (!runId) {
                statusMessage = 'no active run selected for interrupt';
                requestRender();
                return;
              }
              const interruptResult = dispatchInterruptCommand(stateOrReader, runId, runtimeOptions);
              statusMessage = interruptResult.output;
              requestRender();
            };
            const deferFilter = () => {
              clearConfirmation();
              statusMessage = OVERLAY_FILTER_DEFERRED_MESSAGE;
              requestRender();
            };

            return {
              render: (width?: number) => {
                invalidated = false;
                return renderOverlayOutput(width).split('\n');
              },
              invalidate: () => {
                invalidated = true;
              },
              handleInput: (data: string) => {
                if (data === 'q' || data === 'Q' || data === '\u001b') {
                  close();
                } else if (overlayTopic === 'config' && (data === '\t' || data === 'tab' || data === '\u001b[C' || data === 'right')) {
                  switchTab(1);
                } else if (overlayTopic === 'config' && (data === '\u001b[Z' || data === 'shift-tab' || data === '\u001b[D' || data === 'left')) {
                  switchTab(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[A' || data === 'up')) {
                  moveSelection(-1);
                } else if (overlayTopic === 'config' && (data === '\u001b[B' || data === 'down')) {
                  moveSelection(1);
                } else if (overlayTopic === 'config' && (data === '\r' || data === '\n' || data === 'enter')) {
                  toggleDetail();
                } else if (overlayTopic === 'config' && (data === 'r' || data === 'R')) {
                  applyControlMutation('readonly toggle');
                } else if (overlayTopic === 'config' && (data === 'm' || data === 'M')) {
                  applyControlMutation('mode manual');
                } else if (overlayTopic === 'config' && (data === 'a' || data === 'A')) {
                  applyControlMutation('mode assisted');
                } else if (overlayTopic === 'config' && (data === 'u' || data === 'U')) {
                  applyControlMutation('mode automatic');
                } else if (overlayTopic === 'config' && (data === 'p' || data === 'P')) {
                  applyPermissionDecision('approve');
                } else if (overlayTopic === 'config' && (data === 'd' || data === 'D')) {
                  applyPermissionDecision('deny');
                } else if (overlayTopic === 'config' && (data === 'i' || data === 'I')) {
                  applyInterrupt();
                } else if (overlayTopic === 'config' && (data === '/' || data === 'f' || data === 'F')) {
                  deferFilter();
                } else if (invalidated) {
                  tui?.requestRender?.();
                }
              },
              dispose: close,
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
          await Promise.resolve(context.ui.custom(
            (_tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: (result?: void) => void) => ({
              render: (width?: number) => renderOverlayOutput(width).split('\n'),
              invalidate: () => undefined,
              handleInput: (data: string) => {
                if (data === 'q' || data === 'Q' || data === '\u001b') {
                  done?.(undefined);
                }
              },
            }),
            {
              overlay: true,
              overlayOptions: {
                title: overlayTopic === 'monitor' ? 'zerg monitor' : 'zerg config',
              },
            },
          ));
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
