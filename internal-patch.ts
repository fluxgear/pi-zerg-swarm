import type { HookLifecycleEvent, StructuralPiExtensionContext, ZergInternalPatchController, ZergState } from './types.js';

export interface InternalPatchOptions {
  maxEvents?: number;
  now?: () => Date;
}

const installedContexts = new WeakSet<object>();

export function installInternalPatch(
  context: StructuralPiExtensionContext | undefined,
  state: ZergState,
  options: InternalPatchOptions = {},
): ZergInternalPatchController {
  const target = typeof context === 'object' && context !== null ? context : undefined;
  const alreadyInstalled = target ? installedContexts.has(target) : false;

  if (target && !alreadyInstalled) {
    installedContexts.add(target);
  }

  let disposed = false;
  const maxEvents = options.maxEvents ?? 100;
  const now = options.now ?? (() => new Date());

  return {
    installed: Boolean(target && !alreadyInstalled),
    emit(event) {
      if (disposed) {
        throw new Error('Cannot emit zerg internal patch events after dispose().');
      }

      const next: HookLifecycleEvent = {
        id: event.id ?? `event-${state.events.length + 1}`,
        createdAt: event.createdAt ?? now().toISOString(),
        type: event.type,
        message: event.message,
        status: event.status,
        agentId: event.agentId,
        taskId: event.taskId,
      };
      state.events.push(next);
      if (state.events.length > maxEvents) {
        state.events.splice(0, state.events.length - maxEvents);
      }
      return next;
    },
    dispose() {
      disposed = true;
    },
  };
}
