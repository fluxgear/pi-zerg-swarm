import { appendHookEvent } from './state.js';
import type { HookLifecycleEvent, StructuralPiExtensionContext, ZergInternalPatchController, ZergState, ZergStateContainer } from './types.js';

export interface InternalPatchOptions {
  maxEvents?: number;
  now?: () => Date;
}

type InternalPatchStateTarget = ZergState | ZergStateContainer;

const installedContexts = new WeakSet<object>();

export function installInternalPatch(
  context: StructuralPiExtensionContext | undefined,
  state: InternalPatchStateTarget,
  options: InternalPatchOptions = {},
): ZergInternalPatchController {
  const target = typeof context === 'object' && context !== null ? context : undefined;
  const alreadyInstalled = target ? installedContexts.has(target) : false;
  const installed = Boolean(target && !alreadyInstalled);

  if (target && installed) {
    installedContexts.add(target);
  }

  let disposed = false;
  const maxEvents = options.maxEvents ?? 100;
  const now = options.now ?? (() => new Date());

  return {
    installed,
    emit(event) {
      if (disposed) {
        throw new Error('Cannot emit zerg internal patch events after dispose().');
      }

      const current = readPatchState(state);
      const next: HookLifecycleEvent = {
        id: event.id ?? `event-${current.events.length + 1}`,
        createdAt: event.createdAt ?? now().toISOString(),
        type: event.type,
        message: event.message,
        status: event.status,
        agentId: event.agentId,
        taskId: event.taskId,
        teamId: event.teamId,
        treeNodeId: event.treeNodeId,
        revision: event.revision,
      };

      writePatchState(state, appendHookEvent(current, next, maxEvents));
      return next;
    },
    dispose() {
      disposed = true;

      if (installed && target) {
        installedContexts.delete(target);
      }
    },
  };
}

function readPatchState(state: InternalPatchStateTarget): ZergState {
  return isZergStateContainer(state) ? state.snapshot() : state;
}

function writePatchState(target: InternalPatchStateTarget, nextState: ZergState): void {
  if (isZergStateContainer(target)) {
    target.replace(nextState);
    return;
  }

  Object.assign(target, nextState);
}

function isZergStateContainer(value: InternalPatchStateTarget): value is ZergStateContainer {
  return typeof (value as ZergStateContainer).snapshot === 'function'
    && typeof (value as ZergStateContainer).replace === 'function';
}
