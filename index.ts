import { installInternalPatch } from './internal-patch.js';
import { deriveThinkingSteps } from './parse.js';
import { renderAgentTree, renderHelp, renderStatusLine } from './render.js';
import { createZergState, sharedZergState } from './state.js';
import { ZERG_COMMANDS, type StructuralPiCommand, type StructuralPiCommandContext, type StructuralPiCommandOptions, type StructuralPiExtensionContext, type ZergCommandName, type ZergCommandResult, type ZergPiCommandHandler, type ZergState } from './types.js';

export interface ZergExtensionRegistration {
  commands: ZergCommandName[];
  state: ZergState;
  patchInstalled: boolean;
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

const registeredCommandsByTarget = new WeakMap<object, Set<ZergCommandName>>();

export function registerZergSwarmExtension(context: StructuralPiExtensionContext = {}): ZergExtensionRegistration {
  const state = createZergState(sharedZergState);
  const patch = installInternalPatch(context, state);
  const handler = createPiZergCommandHandler(state);

  for (const name of ZERG_COMMANDS) {
    registerCommand(context, {
      name,
      description: 'Show pi-zerg-swarm command-surface status and help.',
      handler,
    });
  }

  patch.emit({
    type: 'hook',
    message: 'pi-zerg-swarm v0.1.0 command surface registered',
    status: 'done',
  });

  return {
    commands: [...ZERG_COMMANDS],
    state,
    patchInstalled: patch.installed,
  };
}

export function createZergCommandHandler(state: ZergState): (input?: string) => ZergCommandResult {
  const dispatchers: Record<ZergCommandTopic, ZergCommandDispatcher> = {
    help: () => ({ ok: true, output: renderHelp(state) }),
    status: () => ({ ok: true, output: renderStatusLine(state) }),
    tree: () => ({ ok: true, output: renderAgentTree(state) }),
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
      output: `Unknown zerg command: ${normalized.topic}\n\n${renderHelp(state)}`,
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

export function createPiZergCommandHandler(state: ZergState): ZergPiCommandHandler {
  const scaffoldHandler = createZergCommandHandler(state);

  return async (input: string, context: StructuralPiCommandContext): Promise<void> => {
    const result = await scaffoldHandler(input);
    const output = typeof result === 'string' ? result : result.output;
    context.ui?.notify?.(output, 'info');
  };
}

function registerCommand(context: StructuralPiExtensionContext, command: StructuralPiCommand): void {
  const registrar = selectCommandRegistrar(context);

  if (!registrar) {
    return;
  }

  const registeredNames = registeredCommandsByTarget.get(registrar.target) ?? new Set<ZergCommandName>();

  if (registeredNames.has(command.name)) {
    return;
  }

  const options: StructuralPiCommandOptions = {
    description: command.description,
    handler: command.handler,
  };

  registrar.registerCommand(command.name, options);
  registeredNames.add(command.name);
  registeredCommandsByTarget.set(registrar.target, registeredNames);
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
