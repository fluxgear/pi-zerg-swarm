import { installInternalPatch } from './internal-patch.js';
import { deriveThinkingSteps } from './parse.js';
import { renderAgentTree, renderHelp, renderStatusLine } from './render.js';
import { applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createZergStateContainer, readSharedZergState, replaceSharedZergState, snapshotZergState } from './state.js';
import { ZERG_COMMANDS, type PermissionModeTransitionInput, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type ZergCommandName, type ZergCommandResult, type ZergInternalPatchController, type ZergPiCommandHandler, type ZergRuntimeEntity, type ZergRuntimeTransition, type ZergRuntimeTransitionAction, type ZergState, type ZergStateContainer } from './types.js';

export interface ZergCommandHandlerOptions {
  now?: () => Date;
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

type ZergCommandTopic = 'help' | 'status' | 'tree' | 'steps' | 'agent' | 'team' | 'mode' | 'intervene';
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
  const stateContainer = createZergStateContainer(readSharedZergState());
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
  };

  try {
    const installedPatch = installInternalPatch(context, syncedStateContainer);
    patch = installedPatch;
    const handler = createPiZergCommandHandler(syncedStateContainer, { ...options, syncSharedState: true } as RuntimeCommandOptions);

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
        ? 'pi-zerg-swarm v0.8.1 internal patch path active'
        : 'pi-zerg-swarm v0.8.1 internal patch unavailable; command surface registered',
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
    agent: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'agent', payload, options),
    team: (payload: string) => dispatchRuntimeCommand(stateOrReader, 'team', payload, options),
    mode: (payload: string) => dispatchModeCommand(stateOrReader, payload, options),
    intervene: (payload: string) => dispatchInterventionCommand(stateOrReader, payload, options),
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
  return value === 'help' || value === 'status' || value === 'tree' || value === 'steps' || value === 'agent' || value === 'team' || value === 'mode' || value === 'intervene';
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
        now: options.now,
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
    now: options.now,
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
      now: options.now,
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

export function createPiZergCommandHandler(
  stateOrReader: ZergStateSource,
  options: ZergCommandHandlerOptions = {},
): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(stateOrReader, options);

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;
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
