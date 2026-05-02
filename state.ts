import { ZERG_STATE_SCHEMA_VERSION, type AgentIdentity, type AgentKind, type AgentStatus, type HookLifecycleEvent, type PermissionModeState, type TaskRecord, type TeamIdentity, type TeamKind, type ZergContext, type ZergExtensionFields, type ZergRuntimeHealth, type ZergRuntimeModeContext, type ZergRuntimeState, type ZergRuntimeTransition, type ZergState, type ZergStateContainer, type ZergStatePatch, type ZergStateUpdateOptions, type ZergTreeNode } from './types.js';

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';

const DEFAULT_MODE: PermissionModeState = {
  automation: 'manual',
  interventionEnabled: true,
};

export function createZergState(seed: Partial<ZergState> = {}): ZergState {
  return {
    schemaVersion: ZERG_STATE_SCHEMA_VERSION,
    lifecycle: seed.lifecycle ?? 'ready',
    revision: seed.revision ?? 0,
    metadata: cloneMetadata(seed.metadata),
    agents: cloneAgents(seed.agents),
    tasks: cloneTasks(seed.tasks),
    teams: cloneTeams(seed.teams),
    tree: cloneTree(seed.tree),
    events: cloneEvents(seed.events),
    selectedNodeId: seed.selectedNodeId,
    mode: cloneMode(seed.mode),
    context: cloneContext(seed.context),
    extensions: cloneExtensionFields(seed.extensions),
  };
}

export function snapshotZergState(state: ZergState): ZergState {
  return createZergState(state);
}

export function updateZergState(state: ZergState, patch: ZergStatePatch, options: ZergStateUpdateOptions = {}): ZergState {
  const base = snapshotZergState(state);
  const resolvedPatch = typeof patch === 'function' ? patch(base) : patch;
  const mergedMetadata = cloneMetadata({
    ...base.metadata,
    ...(resolvedPatch.metadata ?? {}),
    updatedAt: options.updatedAt ?? resolvedPatch.metadata?.updatedAt ?? base.metadata.updatedAt,
  });

  return createZergState({
    ...base,
    ...resolvedPatch,
    metadata: mergedMetadata,
    lifecycle: options.lifecycle ?? resolvedPatch.lifecycle ?? base.lifecycle,
    revision: options.preserveRevision ? (resolvedPatch.revision ?? base.revision) : base.revision + 1,
  });
}

export function getCurrentAgents(state: ZergState): AgentIdentity[] {
  return Object.keys(state.agents).sort().map((id) => cloneAgent(state.agents[id]!));
}

export function getCurrentTasks(state: ZergState): TaskRecord[] {
  return Object.keys(state.tasks).sort().map((id) => cloneTask(state.tasks[id]!));
}

export function getCurrentTeams(state: ZergState): TeamIdentity[] {
  return Object.keys(state.teams).sort().map((id) => cloneTeam(state.teams[id]!));
}

export function getCurrentTree(state: ZergState): Record<string, ZergTreeNode> {
  return cloneTree(state.tree);
}

export function getCurrentMode(state: ZergState): PermissionModeState {
  return cloneMode(state.mode);
}

export function getSelectedNodeId(state: ZergState): string | undefined {
  return state.selectedNodeId;
}

export function getSelectedTreeNode(state: ZergState): ZergTreeNode | undefined {
  return state.selectedNodeId ? cloneOptional(state.tree[state.selectedNodeId], cloneTreeNode) : undefined;
}

export function upsertAgent(state: ZergState, agent: AgentIdentity): ZergState {
  return updateZergState(state, {
    agents: {
      ...state.agents,
      [agent.id]: cloneAgent(agent),
    },
  });
}

export function upsertTask(state: ZergState, task: TaskRecord): ZergState {
  return updateZergState(state, {
    tasks: {
      ...state.tasks,
      [task.id]: cloneTask(task),
    },
  });
}

export function upsertTeam(state: ZergState, team: TeamIdentity): ZergState {
  return updateZergState(state, {
    teams: {
      ...state.teams,
      [team.id]: cloneTeam(team),
    },
  });
}

export function upsertTreeNode(state: ZergState, node: ZergTreeNode): ZergState {
  return updateZergState(state, {
    tree: {
      ...state.tree,
      [node.id]: cloneTreeNode(node),
    },
  });
}

export function appendHookEvent(state: ZergState, event: HookLifecycleEvent, maxEvents = 100): ZergState {
  const events = [...cloneEvents(state.events), cloneEvent(event)].slice(-Math.max(1, maxEvents));
  return updateZergState(state, { events });
}

export function selectNode(state: ZergState, selectedNodeId: string | undefined): ZergState {
  return updateZergState(state, { selectedNodeId });
}

export function setMode(state: ZergState, mode: Partial<PermissionModeState>): ZergState {
  return updateZergState(state, {
    mode: {
      ...state.mode,
      ...mode,
    },
  });
}

export function resetZergState(seed?: Partial<ZergState>): ZergState {
  return createZergState(seed);
}

export function createZergStateContainer(seed?: Partial<ZergState>): ZergStateContainer {
  let current = createZergState(seed);

  return {
    read() {
      return snapshotZergState(current);
    },
    snapshot() {
      return snapshotZergState(current);
    },
    replace(nextState: Partial<ZergState> = createZergState()) {
      current = createZergState(nextState);
      return snapshotZergState(current);
    },
    update(patch: ZergStatePatch, options?: ZergStateUpdateOptions) {
      current = updateZergState(current, patch, options);
      return snapshotZergState(current);
    },
  };
}

export let sharedZergState = createZergState();

export function readSharedZergState(): ZergState {
  return snapshotZergState(sharedZergState);
}

export function updateSharedZergState(patch: ZergStatePatch, options?: ZergStateUpdateOptions): ZergState {
  sharedZergState = updateZergState(sharedZergState, patch, options);
  return readSharedZergState();
}

export function replaceSharedZergState(nextState: Partial<ZergState> = createZergState()): ZergState {
  sharedZergState = createZergState(nextState);
  return readSharedZergState();
}


export interface ZergRuntimeTransitionOptions {
  now?: () => Date;
  maxEvents?: number;
}

export function applyRuntimeTransition(
  state: ZergState,
  transition: ZergRuntimeTransition,
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  const timestamp = resolveTransitionTimestamp(state, transition, options);

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const mode = resolveRuntimeMode(base.mode, transition);
    const status = resolveTransitionStatus(base, transition);
    const health = resolveTransitionHealth(base, transition);
    const activity = transition.activity?.trim() || defaultRuntimeActivity(transition.action);
    const runtime = buildRuntimeState(getExistingRuntime(base, transition), transition, timestamp, mode, health, activity);
    const event: HookLifecycleEvent = {
      id: `runtime-${revision}`,
      type: transition.entity,
      message: formatRuntimeEventMessage(transition, activity),
      status,
      action: transition.action,
      health,
      mode,
      sequence: revision,
      revision,
      createdAt: timestamp,
      ...(transition.entity === 'agent' ? { agentId: transition.id } : { teamId: transition.id }),
    };

    if (transition.entity === 'agent') {
      return {
        agents: {
          ...base.agents,
          [transition.id]: buildAgentIdentity(base.agents[transition.id], transition, status, runtime),
        },
        events: appendRuntimeEvent(base.events, event, options.maxEvents),
        mode,
      };
    }

    return {
      teams: {
        ...base.teams,
        [transition.id]: buildTeamIdentity(base.teams[transition.id], transition, status, runtime),
      },
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
      mode,
    };
  }, { updatedAt: timestamp });
}

export function replayRuntimeTransitions(
  seed: Partial<ZergState> | ZergState,
  transitions: readonly ZergRuntimeTransition[],
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  return transitions.reduce((current, transition) => applyRuntimeTransition(current, transition, options), createZergState(seed));
}


function resolveTransitionTimestamp(
  state: ZergState,
  transition: ZergRuntimeTransition,
  options: ZergRuntimeTransitionOptions,
): string {
  return transition.at ?? options.now?.().toISOString() ?? state.metadata.updatedAt;
}

function resolveRuntimeMode(stateMode: PermissionModeState, transition: ZergRuntimeTransition): ZergRuntimeModeContext {
  return {
    automation: transition.mode?.automation ?? stateMode.automation,
    interventionEnabled: transition.mode?.interventionEnabled ?? stateMode.interventionEnabled,
    contextId: transition.contextId ?? transition.mode?.contextId ?? stateMode.contextId,
  };
}

function getExistingRuntime(state: ZergState, transition: ZergRuntimeTransition): ZergRuntimeState | undefined {
  return transition.entity === 'agent' ? state.agents[transition.id]?.runtime : state.teams[transition.id]?.runtime;
}

function resolveTransitionStatus(state: ZergState, transition: ZergRuntimeTransition): AgentStatus {
  if (transition.status) {
    return transition.status;
  }

  switch (transition.action) {
    case 'start':
    case 'progress':
      return 'running';
    case 'stop':
      return 'done';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'idle';
    case 'create':
      return getExistingStatus(state, transition) ?? 'idle';
  }
}

function getExistingStatus(state: ZergState, transition: ZergRuntimeTransition): AgentStatus | undefined {
  return transition.entity === 'agent' ? state.agents[transition.id]?.status : state.teams[transition.id]?.status;
}

function resolveTransitionHealth(state: ZergState, transition: ZergRuntimeTransition): ZergRuntimeHealth {
  if (transition.health) {
    return transition.health;
  }

  switch (transition.action) {
    case 'start':
    case 'progress':
      return 'healthy';
    case 'stop':
      return 'stopped';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'unknown';
    case 'create':
      return getExistingRuntime(state, transition)?.health ?? 'unknown';
  }
}

function buildRuntimeState(
  existing: ZergRuntimeState | undefined,
  transition: ZergRuntimeTransition,
  timestamp: string,
  mode: ZergRuntimeModeContext,
  health: ZergRuntimeHealth,
  activity: string,
): ZergRuntimeState {
  const createdAt = existing?.createdAt ?? timestamp;

  if (transition.action === 'reset') {
    return {
      createdAt,
      updatedAt: timestamp,
      health,
      mode,
      lastActivity: activity,
      lastActivityAt: timestamp,
    };
  }

  return {
    createdAt,
    updatedAt: timestamp,
    startedAt: transition.action === 'start' ? timestamp : existing?.startedAt,
    stoppedAt: transition.action === 'stop' || transition.action === 'fail' ? timestamp : existing?.stoppedAt,
    lastActivity: activity,
    lastActivityAt: timestamp,
    health,
    mode,
  };
}

function buildAgentIdentity(
  existing: AgentIdentity | undefined,
  transition: ZergRuntimeTransition,
  status: AgentStatus,
  runtime: ZergRuntimeState,
): AgentIdentity {
  return {
    ...(existing ?? {}),
    id: transition.id,
    label: transition.label?.trim() || existing?.label || transition.id,
    kind: isAgentKind(transition.kind) ? transition.kind : existing?.kind ?? 'subagent',
    status,
    parentId: transition.parentId ?? existing?.parentId,
    teamId: transition.teamId ?? existing?.teamId,
    childIds: mergeStrings(existing?.childIds, transition.childIds),
    contextId: transition.contextId ?? existing?.contextId,
    runtime,
  };
}

function buildTeamIdentity(
  existing: TeamIdentity | undefined,
  transition: ZergRuntimeTransition,
  status: AgentStatus,
  runtime: ZergRuntimeState,
): TeamIdentity {
  return {
    ...(existing ?? {}),
    id: transition.id,
    label: transition.label?.trim() || existing?.label || transition.id,
    kind: isTeamKind(transition.kind) ? transition.kind : existing?.kind ?? 'team',
    status,
    leaderAgentId: transition.leaderAgentId ?? existing?.leaderAgentId,
    memberAgentIds: mergeStrings(existing?.memberAgentIds, transition.memberAgentIds) ?? [],
    parentTeamId: transition.parentTeamId ?? existing?.parentTeamId,
    taskIds: mergeStrings(existing?.taskIds, transition.taskIds),
    runtime,
  };
}

function appendRuntimeEvent(events: readonly HookLifecycleEvent[], event: HookLifecycleEvent, maxEvents = 100): HookLifecycleEvent[] {
  return [...cloneEvents(events), cloneEvent(event)].slice(-Math.max(1, maxEvents));
}

function formatRuntimeEventMessage(transition: ZergRuntimeTransition, activity: string): string {
  return `${transition.entity} ${transition.id} ${transition.action}: ${activity}`;
}

function defaultRuntimeActivity(action: ZergRuntimeTransition['action']): string {
  switch (action) {
    case 'create':
      return 'created';
    case 'start':
      return 'started';
    case 'progress':
      return 'progress updated';
    case 'stop':
      return 'stopped';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'reset';
  }
}

function isAgentKind(value: ZergRuntimeTransition['kind']): value is AgentKind {
  return value === 'subagent' || value === 'teammate' || value === 'team-leader';
}

function isTeamKind(value: ZergRuntimeTransition['kind']): value is TeamKind {
  return value === 'team' || value === 'squad' || value === 'worktree';
}

function mergeStrings(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function cloneAgents(agents: Record<string, AgentIdentity> = {}): Record<string, AgentIdentity> {
  return Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, cloneAgent(agent)]));
}

function cloneTasks(tasks: Record<string, TaskRecord> = {}): Record<string, TaskRecord> {
  return Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, cloneTask(task)]));
}

function cloneTeams(teams: Record<string, TeamIdentity> = {}): Record<string, TeamIdentity> {
  return Object.fromEntries(Object.entries(teams).map(([id, team]) => [id, cloneTeam(team)]));
}

function cloneTree(tree: Record<string, ZergTreeNode> = {}): Record<string, ZergTreeNode> {
  return Object.fromEntries(Object.entries(tree).map(([id, node]) => [id, cloneTreeNode(node)]));
}

function cloneEvents(events: readonly HookLifecycleEvent[] = []): HookLifecycleEvent[] {
  return events.map(cloneEvent);
}

function cloneAgent(agent: AgentIdentity): AgentIdentity {
  return {
    ...agent,
    childIds: cloneArray(agent.childIds),
    runtime: cloneOptional(agent.runtime, cloneRuntimeState),
    metadata: cloneOptional(agent.metadata, cloneExtensionFields),
    extensions: cloneOptional(agent.extensions, cloneExtensionFields),
  };
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    blockedBy: cloneArray(task.blockedBy),
    metadata: cloneOptional(task.metadata, cloneExtensionFields),
    extensions: cloneOptional(task.extensions, cloneExtensionFields),
  };
}

function cloneTeam(team: TeamIdentity): TeamIdentity {
  return {
    ...team,
    memberAgentIds: [...team.memberAgentIds],
    taskIds: cloneArray(team.taskIds),
    runtime: cloneOptional(team.runtime, cloneRuntimeState),
    metadata: cloneOptional(team.metadata, cloneExtensionFields),
    extensions: cloneOptional(team.extensions, cloneExtensionFields),
  };
}

function cloneTreeNode(node: ZergTreeNode): ZergTreeNode {
  return {
    ...node,
    childIds: [...node.childIds],
    metadata: cloneOptional(node.metadata, cloneExtensionFields),
    extensions: cloneOptional(node.extensions, cloneExtensionFields),
  };
}

function cloneEvent(event: HookLifecycleEvent): HookLifecycleEvent {
  return {
    ...event,
    mode: cloneOptional(event.mode, cloneRuntimeMode),
  };
}

function cloneRuntimeState(runtime: ZergRuntimeState): ZergRuntimeState {
  return {
    ...runtime,
    mode: cloneRuntimeMode(runtime.mode),
  };
}

function cloneRuntimeMode(mode: ZergRuntimeModeContext): ZergRuntimeModeContext {
  return { ...mode };
}

function cloneMode(mode?: Partial<PermissionModeState>): PermissionModeState {
  return { ...DEFAULT_MODE, ...(mode ?? {}) };
}

function cloneContext(context?: ZergContext): ZergContext | undefined {
  if (!context) {
    return undefined;
  }

  return {
    ...context,
    metadata: cloneOptional(context.metadata, cloneExtensionFields),
  };
}

function cloneMetadata(metadata: Partial<ZergState['metadata']> = {}): ZergState['metadata'] {
  return {
    createdAt: metadata.createdAt ?? DEFAULT_TIMESTAMP,
    updatedAt: metadata.updatedAt ?? metadata.createdAt ?? DEFAULT_TIMESTAMP,
    resetCount: metadata.resetCount ?? 0,
    source: metadata.source,
    labels: metadata.labels ? { ...metadata.labels } : undefined,
    extensions: cloneOptional(metadata.extensions, cloneExtensionFields),
  };
}

function cloneExtensionFields(fields: ZergExtensionFields = {}): ZergExtensionFields {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, cloneExtensionValue(value)]));
}

function cloneExtensionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneExtensionValue);
  }

  if (isPlainRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneExtensionValue(nested)]));
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneArray(values: string[] | undefined): string[] | undefined {
  return values ? [...values] : undefined;
}

function cloneOptional<T>(value: T | undefined, clone: (input: T) => T): T | undefined {
  return value === undefined ? undefined : clone(value);
}
