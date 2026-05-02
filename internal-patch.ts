import { appendHookEvent } from './state.js';
import type { HookLifecycleEvent, StructuralPiExtensionContext, ZergInternalPatchController, ZergState, ZergStateContainer } from './types.js';

export interface InternalPatchOptions {
  maxEvents?: number;
  now?: () => Date;
}

type InternalPatchStateTarget = ZergState | ZergStateContainer;

interface PatchRecord {
  disposed: boolean;
  restore(): void;
}

type EventBusMethodName = 'emit' | 'on';
type EventBusMethod = (this: unknown, ...args: unknown[]) => unknown;
type EventBusPatchTarget = Record<EventBusMethodName, EventBusMethod>;

const activePatchesByContext = new WeakMap<object, PatchRecord>();
const activePatchesByEventBus = new WeakMap<EventBusPatchTarget, PatchRecord>();

export function installInternalPatch(
  context: StructuralPiExtensionContext | undefined,
  state: InternalPatchStateTarget,
  options: InternalPatchOptions = {},
): ZergInternalPatchController {
  const target = typeof context === 'object' && context !== null ? context : undefined;
  const alreadyInstalled = target ? activePatchesByContext.has(target) : false;

  let disposed = false;
  let generatedEventSequence = 0;
  const maxEvents = options.maxEvents ?? 100;
  const now = options.now ?? (() => new Date());

  const getHighestGeneratedEventSequence = (events: readonly HookLifecycleEvent[]): number => {
    return events.reduce((highest, event) => {
      const match = /^event-(\d+)$/.exec(event.id);
      if (!match) {
        return highest;
      }

      const sequence = Number.parseInt(match[1]!, 10);
      return Number.isSafeInteger(sequence) ? Math.max(highest, sequence) : highest;
    }, 0);
  };

  const nextGeneratedEventId = (current: ZergState): string => {
    generatedEventSequence = Math.max(
      generatedEventSequence,
      current.revision,
      current.events.length,
      getHighestGeneratedEventSequence(current.events),
    ) + 1;
    return `event-${generatedEventSequence}`;
  };

  const emitLifecycleEvent: ZergInternalPatchController['emit'] = (event) => {
    if (disposed) {
      throw new Error('Cannot emit zerg internal patch events after dispose().');
    }

    const current = readPatchState(state);
    const next: HookLifecycleEvent = {
      id: event.id ?? nextGeneratedEventId(current),
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
  };

  if (!target || alreadyInstalled) {
    return {
      installed: false,
      emit: emitLifecycleEvent,
      dispose() {
        disposed = true;
      },
    };
  }

  const eventBus = findEventBusPatchTarget(target);

  if (!eventBus || activePatchesByEventBus.has(eventBus)) {
    return {
      installed: false,
      emit: emitLifecycleEvent,
      dispose() {
        disposed = true;
      },
    };
  }

  const restoreStack: Array<() => void> = [];
  const record: PatchRecord = {
    disposed: false,
    restore() {
      for (const restore of [...restoreStack].reverse()) {
        restore();
      }
    },
  };

  try {
    restoreStack.push(replaceEventBusMethod(eventBus, 'emit', (original) => function zergPatchedPiEventEmit(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);

      safelyEmitPatchObservation(record, emitLifecycleEvent, `pi-zerg-swarm observed Pi event bus emit: ${formatObservedPiEventName(args[0])}`);
      return result;
    }));

    restoreStack.push(replaceEventBusMethod(eventBus, 'on', (original) => function zergPatchedPiEventOn(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);

      safelyEmitPatchObservation(record, emitLifecycleEvent, `pi-zerg-swarm observed Pi event bus subscription: ${formatObservedPiEventName(args[0])}`);
      return result;
    }));
  } catch (error) {
    for (const restore of [...restoreStack].reverse()) {
      restore();
    }
    throw error;
  }
  activePatchesByEventBus.set(eventBus, record);

  activePatchesByContext.set(target, record);

  return {
    installed: true,
    emit: emitLifecycleEvent,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      activePatchesByEventBus.delete(eventBus);
      record.disposed = true;
      activePatchesByContext.delete(target);
      record.restore();
    },
  };
}

function findEventBusPatchTarget(target: object): EventBusPatchTarget | undefined {
  const events = (target as { events?: unknown }).events;

  if (isEventBusPatchTarget(events)) {
    return events;
  }

  return undefined;
}

function isEventBusPatchTarget(value: unknown): value is EventBusPatchTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { emit?: unknown; on?: unknown };
  return typeof candidate.emit === 'function' && typeof candidate.on === 'function';
}

function replaceEventBusMethod(
  target: EventBusPatchTarget,
  methodName: EventBusMethodName,
  createReplacement: (original: EventBusMethod) => EventBusMethod,
): () => void {
  const original = target[methodName];
  const replacement = createReplacement(original);

  target[methodName] = replacement;

  if (target[methodName] !== replacement) {
    throw new Error(`Unable to replace Pi event bus ${methodName} hook.`);
  }

  return () => {
    if (target[methodName] === replacement) {
      target[methodName] = original;
    }
  };
}

function safelyEmitPatchObservation(
  record: PatchRecord,
  emit: ZergInternalPatchController['emit'],
  message: string,
): void {
  if (record.disposed) {
    return;
  }

  try {
    emit({ type: 'hook', message, status: 'done' });
  } catch {
    // Pi runtime hooks must preserve original event-bus behavior even if zerg telemetry fails.
  }
}

function formatObservedPiEventName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '<unknown>';
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
