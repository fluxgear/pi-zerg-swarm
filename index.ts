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

export function registerZergSwarmExtension(context: StructuralPiExtensionContext = {}): ZergExtensionRegistration {
  const state = createZergState(sharedZergState);
  const patch = installInternalPatch(context, state);
  const handler = createPiZergCommandHandler(state);

  for (const name of ZERG_COMMANDS) {
    registerCommand(context, {
      name,
      description: 'Show pi-zerg-swarm scaffold status and help.',
      handler,
    });
  }

  patch.emit({
    type: 'hook',
    message: 'pi-zerg-swarm v0.0.0 scaffold registered',
    status: 'done',
  });

  return {
    commands: [...ZERG_COMMANDS],
    state,
    patchInstalled: patch.installed,
  };
}

export function createZergCommandHandler(state: ZergState): (input?: string) => ZergCommandResult {
  return (input?: string): ZergCommandResult => {
    const trimmed = input?.trim() ?? '';
    const args = trimmed.split(/\s+/).filter(Boolean);
    const topic = args[0] ?? 'help';

    if (topic === 'status') {
      return { ok: true, output: renderStatusLine(state) };
    }

    if (topic === 'tree') {
      return { ok: true, output: renderAgentTree(state) };
    }

    if (topic === 'steps') {
      const steps = deriveThinkingSteps(args.slice(1).join(' '));
      const output = steps.length
        ? steps.map((step) => `${step.sourceLine}. [${step.status}] ${step.title}`).join('\n')
        : 'No thinking steps detected.';
      return { ok: true, output };
    }

    return { ok: true, output: renderHelp(state) };
  };
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
  const options: StructuralPiCommandOptions = {
    description: command.description,
    handler: command.handler,
  };

  if (context.registerCommand) {
    context.registerCommand(command.name, options);
    return;
  }

  if (context.commands?.registerCommand) {
    context.commands.registerCommand(command.name, options);
    return;
  }

  if (context.commands?.register) {
    context.commands.register(command.name, options);
    return;
  }

  context.commandRegistrar?.registerCommand?.(command.name, options);
}

export default registerZergSwarmExtension;
