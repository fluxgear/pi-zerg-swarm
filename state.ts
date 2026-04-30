import type { AgentIdentity, HookLifecycleEvent, PermissionModeState, TaskRecord, ZergState } from './types.js';

const DEFAULT_MODE: PermissionModeState = {
  automation: 'manual',
  interventionEnabled: true,
};

export function createZergState(seed?: Partial<ZergState>): ZergState {
  return {
    agents: { ...(seed?.agents ?? {}) },
    tasks: { ...(seed?.tasks ?? {}) },
    events: [...(seed?.events ?? [])],
    selectedNodeId: seed?.selectedNodeId,
    mode: { ...DEFAULT_MODE, ...(seed?.mode ?? {}) },
  };
}

export function upsertAgent(state: ZergState, agent: AgentIdentity): ZergState {
  return {
    ...state,
    agents: {
      ...state.agents,
      [agent.id]: agent,
    },
  };
}

export function upsertTask(state: ZergState, task: TaskRecord): ZergState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [task.id]: task,
    },
  };
}

export function appendHookEvent(state: ZergState, event: HookLifecycleEvent, maxEvents = 100): ZergState {
  const events = [...state.events, event].slice(-Math.max(1, maxEvents));
  return { ...state, events };
}

export function selectNode(state: ZergState, selectedNodeId: string | undefined): ZergState {
  return { ...state, selectedNodeId };
}

export function setMode(state: ZergState, mode: Partial<PermissionModeState>): ZergState {
  return {
    ...state,
    mode: {
      ...state.mode,
      ...mode,
    },
  };
}

export function resetZergState(): ZergState {
  return createZergState();
}

export let sharedZergState = createZergState();

export function replaceSharedZergState(nextState = createZergState()): ZergState {
  sharedZergState = nextState;
  return sharedZergState;
}
