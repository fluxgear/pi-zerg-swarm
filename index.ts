import { installInternalPatch } from './internal-patch.js';
import { deriveThinkingSteps } from './parse.js';
import { renderAgentTree, renderHelp, renderStatusLine } from './render.js';
import { createZergStateContainer, readSharedZergState, snapshotZergState } from './state.js';
import { ZERG_COMMANDS, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type ZergCommandName, type ZergCommandResult, type ZergPiCommandHandler, type ZergState } from './types.js';

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

type ZergCommandTopic = 'help' | 'status' | 'tree' | 'steps';
type ZergCommandDispatcher = (payload: string) => ZergCommandResult;

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

export function registerZergSwarmExtension(context: StructuralPiExtensionContext = {}): ZergExtensionRegistration {
  const stateContainer = createZergStateContainer(readSharedZergState());
  const patch = installInternalPatch(context, stateContainer);
  const handler = createPiZergCommandHandler(() => stateContainer.snapshot());
  const commandDisposers: RegisteredCommandDisposer[] = [];

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
    message: 'pi-zerg-swarm v0.3.0 command surface registered',
    status: 'done',
  });

  let disposed = false;

  return {
    commands: [...ZERG_COMMANDS],
    get state() {
      return stateContainer.snapshot();
    },
    patchInstalled: patch.installed,
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
        patch.dispose();
      } catch (error) {
        firstError ??= error;
      }

      if (firstError) {
        throw firstError;
      }
    },
  };
}

export function createZergCommandHandler(stateOrReader: ZergState | (() => ZergState)): (input?: string) => ZergCommandResult {
  const dispatchers: Record<ZergCommandTopic, ZergCommandDispatcher> = {
    help: () => ({ ok: true, output: renderHelp(resolveZergStateSnapshot(stateOrReader)) }),
    status: () => ({ ok: true, output: renderStatusLine(resolveZergStateSnapshot(stateOrReader)) }),
    tree: () => ({ ok: true, output: renderAgentTree(resolveZergStateSnapshot(stateOrReader)) }),
    steps: (payload: string) => {
      const steps = deriveThinkingSteps(payload);
      const output = steps.length
        ? steps.map((step) => `${step.sourceLine}. [${step.status}] ${step.title}`).join('\n')
        : 'No thinking steps detected.';
      return { ok: true, output };
    },
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
  return value === 'help' || value === 'status' || value === 'tree' || value === 'steps';
}

export function createPiZergCommandHandler(stateOrReader: ZergState | (() => ZergState)): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(stateOrReader);

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;
    context.ui?.notify?.(output, 'info');
  };
}

function resolveZergStateSnapshot(stateOrReader: ZergState | (() => ZergState)): ZergState {
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
