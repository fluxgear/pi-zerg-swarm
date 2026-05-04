import assert from 'node:assert/strict';
import test from 'node:test';

import { createZergCommandHandler, registerZergSwarmExtension, type ZergExtensionRegistration } from '../index.js';
import { installInternalPatch } from '../internal-patch.js';
import { deriveThinkingSteps } from '../parse.js';
import { renderAgentTree, renderHelp, renderStatusLine } from '../render.js';
import { appendHookEvent, applyInterventionRecord, applyModeTransition, applyRuntimeTransition, createZergState, createZergStateContainer, getCurrentAgents, getCurrentMode, getCurrentTasks, getCurrentTeams, getCurrentTree, getSelectedTreeNode, readSharedZergState, replaceSharedZergState, replayRuntimeTransitions, resetZergState, selectNode, setMode, snapshotZergState, updateSharedZergState, updateZergState, upsertAgent, upsertTeam, upsertTreeNode } from '../state.js';
import { ZERG_STATE_SCHEMA_VERSION, type HookLifecycleEvent, type StructuralPiCommandOptions, type TeamIdentity, type ZergRuntimeTransition, type ZergState, type ZergStateContainer, type ZergTreeNode } from '../types.js';

type AssertAssignable<T extends true> = T;
type ContainerReadReturnsState = AssertAssignable<ReturnType<ZergStateContainer['read']> extends ZergState ? true : false>;
type RegistrationStateExposesSnapshot = AssertAssignable<ZergExtensionRegistration['state'] extends ZergState ? true : false>;

const VALID_AGENT_RUNTIME_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-valid',
  kind: 'subagent',
  parentId: 'root',
} satisfies ZergRuntimeTransition;

const VALID_TEAM_RUNTIME_TRANSITION = {
  entity: 'team',
  action: 'create',
  id: 'team-valid',
  kind: 'team',
  memberAgentIds: ['agent-valid'],
} satisfies ZergRuntimeTransition;

const INVALID_AGENT_TEAM_KIND_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-invalid-kind',
  kind: 'team',
} as const;

const INVALID_AGENT_TEAM_FIELDS_TRANSITION = {
  entity: 'agent',
  action: 'create',
  id: 'agent-invalid-fields',
  leaderAgentId: 'lead-1',
} as const;

const INVALID_TEAM_AGENT_FIELDS_TRANSITION = {
  entity: 'team',
  action: 'create',
  id: 'team-invalid-fields',
  parentId: 'parent-1',
} as const;

type _assertInvalidAgentTeamKindTransition = AssertAssignable<typeof INVALID_AGENT_TEAM_KIND_TRANSITION extends ZergRuntimeTransition ? false : true>;
type _assertInvalidAgentTeamFieldsTransition = AssertAssignable<typeof INVALID_AGENT_TEAM_FIELDS_TRANSITION extends ZergRuntimeTransition ? false : true>;
type _assertInvalidTeamAgentFieldsTransition = AssertAssignable<typeof INVALID_TEAM_AGENT_FIELDS_TRANSITION extends ZergRuntimeTransition ? false : true>;

void VALID_AGENT_RUNTIME_TRANSITION;
void VALID_TEAM_RUNTIME_TRANSITION;

function createCommandSurfaceState(): ZergState {
  return createZergState({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
    },
    tasks: {
      task: { id: 'task', title: 'Implement command surface', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });
}

interface FakePiSubscription {
  disposed: boolean;
  disposeCount: number;
  dispose(): void;
}

interface FakePiEventBus {
  emit(eventName: unknown, ...args: unknown[]): number;
  on(eventName: unknown, handler: (...args: unknown[]) => unknown): FakePiSubscription;
  emitted: Array<{ eventName: unknown; args: unknown[] }>;
  subscriptions: Array<{ eventName: unknown; handler: (...args: unknown[]) => unknown; disposable: FakePiSubscription }>;
}

function createNowSequence(...timestamps: string[]): () => Date {
  const queue = [...timestamps];

  return () => {
    const next = queue.shift();
    assert.ok(next, 'expected another queued timestamp');
    return new Date(next);
  };
}

function createFakePiEventBus(): FakePiEventBus {
  const eventBus: FakePiEventBus = {
    emitted: [],
    subscriptions: [],
    emit(eventName, ...args) {
      eventBus.emitted.push({ eventName, args });
      return eventBus.emitted.length;
    },
    on(eventName, handler) {
      const disposable: FakePiSubscription = {
        disposed: false,
        disposeCount: 0,
        dispose() {
          disposable.disposed = true;
          disposable.disposeCount += 1;
        },
      };

      eventBus.subscriptions.push({ eventName, handler, disposable });
      return disposable;
    },
  };

  return eventBus;
}

test('createZergState provides deterministic v0.2.0 defaults', () => {
  const state = createZergState();

  assert.equal(state.schemaVersion, ZERG_STATE_SCHEMA_VERSION);
  assert.equal(state.lifecycle, 'ready');
  assert.equal(state.revision, 0);
  assert.deepEqual(state.agents, {});
  assert.deepEqual(state.tasks, {});
  assert.deepEqual(state.teams, {});
  assert.deepEqual(state.tree, {});
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.mode, { automation: 'manual', interventionEnabled: true, controller: 'operator' });
  assert.deepEqual(state.metadata, { createdAt: '1970-01-01T00:00:00.000Z', updatedAt: '1970-01-01T00:00:00.000Z', resetCount: 0, source: undefined, labels: undefined, extensions: undefined });
  assert.deepEqual(resetZergState(), state);
});

test('createZergState clones seeded nested state', () => {
  const seed = {
    revision: 4,
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader' as const, status: 'running' as const, childIds: ['child'] },
    },
    tasks: {
      task: { id: 'task', title: 'Seed task', status: 'blocked' as const, blockedBy: ['dep'], updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    teams: {
      team: { id: 'team', label: 'Team', kind: 'team' as const, status: 'running' as const, memberAgentIds: ['root'], taskIds: ['task'] },
    },
    tree: {
      node: { id: 'node', kind: 'agent' as const, label: 'Root', childIds: ['task-node'], refId: 'root' },
    },
  };

  const state = createZergState(seed);
  seed.agents.root.childIds.push('later');
  seed.tasks.task.blockedBy.push('later');
  seed.teams.team.memberAgentIds.push('later');
  seed.tree.node.childIds.push('later');

  assert.deepEqual(state.agents.root?.childIds, ['child']);
  assert.deepEqual(state.tasks.task?.blockedBy, ['dep']);
  assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
  assert.deepEqual(state.tree.node?.childIds, ['task-node']);
  assert.equal(state.revision, 4);
});

test('snapshotZergState returns independent copies', () => {
  const state = createZergState({
    agents: { root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running', childIds: ['child'] } },
    teams: { team: { id: 'team', label: 'Team', kind: 'team', status: 'running', memberAgentIds: ['root'] } },
  });

  const snapshot = snapshotZergState(state);
  snapshot.agents.root?.childIds?.push('mutated');
  snapshot.teams.team?.memberAgentIds.push('mutated');

  assert.deepEqual(state.agents.root?.childIds, ['child']);
  assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
});

test('snapshot and read helpers deep clone nested metadata and extensions', () => {
  const state = createZergState({
    metadata: {
      createdAt: '1970-01-01T00:00:00.000Z',
      updatedAt: '1970-01-01T00:00:00.000Z',
      resetCount: 0,
      extensions: {
        preferences: { flags: ['state-original'] },
      },
    },
    extensions: {
      runtime: { labels: ['extension-original'] },
    },
    agents: {
      root: {
        id: 'root',
        label: 'Root',
        kind: 'team-leader',
        status: 'running',
        metadata: {
          profile: { tags: ['metadata-original'] },
        },
        extensions: {
          config: { modes: ['extension-original'] },
        },
      },
    },
  });

  const snapshot = snapshotZergState(state);
  (snapshot.metadata.extensions?.preferences as { flags: string[] }).flags.push('state-mutated');
  (snapshot.extensions?.runtime as { labels: string[] }).labels.push('extension-mutated');
  (snapshot.agents.root?.metadata?.profile as { tags: string[] }).tags.push('metadata-mutated');
  (snapshot.agents.root?.extensions?.config as { modes: string[] }).modes.push('extension-mutated');

  assert.deepEqual((state.metadata.extensions?.preferences as { flags: string[] }).flags, ['state-original']);
  assert.deepEqual((state.extensions?.runtime as { labels: string[] }).labels, ['extension-original']);
  assert.deepEqual((state.agents.root?.metadata?.profile as { tags: string[] }).tags, ['metadata-original']);
  assert.deepEqual((state.agents.root?.extensions?.config as { modes: string[] }).modes, ['extension-original']);

  const container = createZergStateContainer(state);
  const readState = container.read();
  (readState.metadata.extensions?.preferences as { flags: string[] }).flags.push('read-mutated');
  (readState.extensions?.runtime as { labels: string[] }).labels.push('read-mutated');
  (readState.agents.root?.metadata?.profile as { tags: string[] }).tags.push('read-mutated');
  (readState.agents.root?.extensions?.config as { modes: string[] }).modes.push('read-mutated');

  const rereadState = container.read();
  assert.deepEqual((rereadState.metadata.extensions?.preferences as { flags: string[] }).flags, ['state-original']);
  assert.deepEqual((rereadState.extensions?.runtime as { labels: string[] }).labels, ['extension-original']);
  assert.deepEqual((rereadState.agents.root?.metadata?.profile as { tags: string[] }).tags, ['metadata-original']);
  assert.deepEqual((rereadState.agents.root?.extensions?.config as { modes: string[] }).modes, ['extension-original']);
});

test('state update helpers are immutable and deterministic', () => {
  const initial = createZergState();
  const withAgent = upsertAgent(initial, { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' });
  const selected = selectNode(withAgent, 'root');
  const assisted = setMode(selected, { automation: 'assisted' });
  const preserved = updateZergState(assisted, { lifecycle: 'ready' }, { preserveRevision: true });

  assert.notEqual(withAgent, initial);
  assert.deepEqual(initial.agents, {});
  assert.equal(withAgent.revision, 1);
  assert.equal(selected.revision, 2);
  assert.equal(assisted.revision, 3);
  assert.equal(preserved.revision, 3);
  assert.equal(assisted.mode.automation, 'assisted');
  assert.deepEqual(getCurrentAgents(assisted).map((agent) => agent.id), ['root']);
});

test('appendHookEvent truncates events and leaves the original state unchanged', () => {
  const event = (id: string): HookLifecycleEvent => ({ id, type: 'hook', message: id, createdAt: '2026-04-30T00:00:00.000Z' });
  const initial = createZergState();
  const first = appendHookEvent(initial, event('one'), 2);
  const second = appendHookEvent(first, event('two'), 2);
  const third = appendHookEvent(second, event('three'), 2);

  assert.deepEqual(initial.events, []);
  assert.deepEqual(third.events.map((item) => item.id), ['two', 'three']);
  assert.equal(third.revision, 3);
});

test('shared state replacement and reads are snapshot isolated', () => {
  replaceSharedZergState(createZergState({
    agents: { root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' } },
  }));

  const first = readSharedZergState();
  first.agents.root!.label = 'Mutated';
  const second = readSharedZergState();

  assert.equal(second.agents.root?.label, 'Root');
  assert.equal(second.revision, 0);

  replaceSharedZergState();
});

test('installInternalPatch emits monotonic IDs through truncation', () => {
  const state = createZergState();
  const patch = installInternalPatch({}, state, {
    maxEvents: 2,
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  const emitted = [
    patch.emit({ type: 'hook', message: 'one' }),
    patch.emit({ type: 'hook', message: 'two' }),
    patch.emit({ type: 'hook', message: 'three' }),
    patch.emit({ type: 'hook', message: 'four' }),
  ];

  assert.equal(patch.installed, false);
  assert.deepEqual(emitted.map((event) => event.id), ['event-1', 'event-2', 'event-3', 'event-4']);
  assert.deepEqual(state.events.map((event) => event.id), ['event-3', 'event-4']);
  assert.deepEqual(state.events.map((event) => event.message), ['three', 'four']);
  assert.deepEqual(state.events.map((event) => event.createdAt), ['2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z']);
  assert.equal(state.revision, 4);

  patch.dispose();
  assert.throws(() => patch.emit({ type: 'hook', message: 'after dispose' }), /Cannot emit/);
});

test('installInternalPatch wraps Pi event bus once and restores on dispose', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  const originalOn = eventBus.on;
  const patch = installInternalPatch({ events: eventBus }, state, {
    maxEvents: 2,
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  assert.equal(patch.installed, true);
  assert.notEqual(eventBus.emit, originalEmit);
  assert.notEqual(eventBus.on, originalOn);

  assert.equal(eventBus.emit('agent:started', { id: 'root' }), 1);
  assert.deepEqual(state.events.map((event) => event.message), ['pi-zerg-swarm observed Pi event bus emit: agent:started']);

  eventBus.emit('agent:continued');
  eventBus.emit('agent:finished');

  assert.deepEqual(state.events.map((event) => event.id), ['event-2', 'event-3']);
  assert.deepEqual(state.events.map((event) => event.message), [
    'pi-zerg-swarm observed Pi event bus emit: agent:continued',
    'pi-zerg-swarm observed Pi event bus emit: agent:finished',
  ]);

  patch.dispose();
  assert.equal(eventBus.emit, originalEmit);
  assert.equal(eventBus.on, originalOn);

  const reinstalled = installInternalPatch({ events: eventBus }, state);
  assert.equal(reinstalled.installed, true);
  reinstalled.dispose();
});

test('installInternalPatch observes event-bus subscriptions once and preserves disposables', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalOn = eventBus.on;
  const first = installInternalPatch({ events: eventBus }, state, {
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });
  const wrappedOn = eventBus.on;
  const duplicate = installInternalPatch({ events: eventBus }, state);

  assert.equal(first.installed, true);
  assert.equal(duplicate.installed, false);

  const handler = () => 'handled';
  const subscription = eventBus.on('agent:started', handler);

  assert.equal(eventBus.subscriptions.length, 1);
  assert.equal(eventBus.subscriptions[0]?.eventName, 'agent:started');
  assert.equal(eventBus.subscriptions[0]?.handler, handler);
  assert.equal(subscription, eventBus.subscriptions[0]?.disposable);

  subscription.dispose();
  assert.equal(subscription.disposed, true);
  assert.equal(subscription.disposeCount, 1);

  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:started')).length, 1);

  duplicate.dispose();
  assert.equal(eventBus.on, wrappedOn);

  eventBus.on('agent:continued', () => undefined);
  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:continued')).length, 1);

  first.dispose();
  assert.equal(eventBus.on, originalOn);

  const eventCountAfterDispose = state.events.length;
  eventBus.on('agent:stopped', () => undefined);

  assert.equal(eventBus.subscriptions.length, 3);
  assert.equal(state.events.length, eventCountAfterDispose);
  assert.equal(state.events.filter((event) => event.message.includes('event bus subscription: agent:stopped')).length, 0);
});

test('installInternalPatch duplicate controllers do not double-wrap or restore active patch', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  const first = installInternalPatch({ events: eventBus }, state);
  const wrappedEmit = eventBus.emit;
  const duplicate = installInternalPatch({ events: eventBus }, state);

  assert.equal(first.installed, true);
  assert.equal(duplicate.installed, false);
  assert.equal(eventBus.emit, wrappedEmit);

  eventBus.emit('tick');
  assert.equal(state.events.filter((event) => event.message.includes('event bus emit: tick')).length, 1);

  duplicate.dispose();
  assert.equal(eventBus.emit, wrappedEmit);

  eventBus.emit('tock');
  assert.equal(state.events.filter((event) => event.message.includes('event bus emit: tock')).length, 1);

  first.dispose();
  assert.equal(eventBus.emit, originalEmit);
});

test('installInternalPatch rolls back partial event-bus patch failure', () => {
  const state = createZergState();
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;

  Object.defineProperty(eventBus, 'on', {
    configurable: true,
    get() {
      return () => ({ dispose() {} });
    },
    set() {
      throw new Error('cannot patch on');
    },
  });

  assert.throws(() => installInternalPatch({ events: eventBus }, state), /cannot patch on/);
  assert.equal(eventBus.emit, originalEmit);

  const reusableBus = createFakePiEventBus();
  const patch = installInternalPatch({ events: reusableBus }, state);
  assert.equal(patch.installed, true);
  patch.dispose();
});

test('installInternalPatch unsupported contexts use fallback lifecycle emission', () => {
  const state = createZergState();
  const patch = installInternalPatch({}, state, {
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  assert.equal(patch.installed, false);
  const emitted = patch.emit({ type: 'hook', message: 'fallback explicit lifecycle' });

  assert.equal(emitted.id, 'event-1');
  assert.equal(emitted.createdAt, '2026-04-30T00:00:00.000Z');
  assert.deepEqual(state.events.map((event) => event.message), ['fallback explicit lifecycle']);

  patch.dispose();
  assert.throws(() => patch.emit({ type: 'hook', message: 'after dispose' }), /Cannot emit/);
});

test('createZergStateContainer read snapshot replace and update return isolated state', () => {
  const container = createZergStateContainer({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running', childIds: ['child'] },
    },
  });

  const readState = container.read();
  const snapshotState = container.snapshot();
  readState.agents.root!.label = 'Mutated read';
  snapshotState.agents.root!.childIds!.push('mutated-snapshot');

  assert.equal(container.read().agents.root?.label, 'Root');
  assert.deepEqual(container.snapshot().agents.root?.childIds, ['child']);

  const replaced = container.replace({
    tasks: {
      task: { id: 'task', title: 'Container task', status: 'running', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });
  replaced.tasks.task!.title = 'Mutated replace result';

  assert.deepEqual(container.read().agents, {});
  assert.equal(container.read().tasks.task?.title, 'Container task');

  const updated = container.update((state) => ({
    tasks: {
      ...state.tasks,
      second: { id: 'second', title: 'Second task', status: 'done', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    mode: { ...state.mode, automation: 'automatic' },
  }), { updatedAt: '2026-04-30T01:00:00.000Z' });
  updated.tasks.second!.title = 'Mutated update result';
  updated.mode.automation = 'manual';

  const afterUpdate = container.snapshot();
  assert.equal(afterUpdate.revision, 1);
  assert.equal(afterUpdate.metadata.updatedAt, '2026-04-30T01:00:00.000Z');
  assert.equal(afterUpdate.tasks.second?.title, 'Second task');
  assert.equal(afterUpdate.mode.automation, 'automatic');
});

test('registration.state exposes event snapshots, not a write channel', () => {
  const registration = registerZergSwarmExtension({});

  try {
    const firstSnapshot = registration.state;
    assert.equal(firstSnapshot.events.length, 1);
    assert.equal(firstSnapshot.events[0]?.message, 'pi-zerg-swarm v0.8.0 internal patch unavailable; command surface registered');

    firstSnapshot.events[0]!.message = 'mutated registration event';
    firstSnapshot.events.push({
      id: 'external',
      type: 'state',
      message: 'external mutation',
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    firstSnapshot.mode.automation = 'automatic';

    const secondSnapshot = registration.state;
    assert.equal(secondSnapshot.events.length, 1);
    assert.equal(secondSnapshot.events[0]?.message, 'pi-zerg-swarm v0.8.0 internal patch unavailable; command surface registered');
    assert.equal(secondSnapshot.mode.automation, 'manual');

    secondSnapshot.events[0]!.message = 'mutated second snapshot';
    assert.equal(registration.state.events[0]?.message, 'pi-zerg-swarm v0.8.0 internal patch unavailable; command surface registered');
  } finally {
    registration.dispose();
  }
});

test('shared team tree helpers and readers return clones', () => {
  replaceSharedZergState();

  try {
    const shared = updateSharedZergState((state) => ({
      agents: {
        ...state.agents,
        root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
      },
      tasks: {
        ...state.tasks,
        task: { id: 'task', title: 'Shared task', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z', blockedBy: ['dep'] },
      },
    }), { updatedAt: '2026-04-30T02:00:00.000Z' });
    shared.agents.root!.label = 'Mutated shared snapshot';

    const rereadShared = readSharedZergState();
    assert.equal(rereadShared.revision, 1);
    assert.equal(rereadShared.metadata.updatedAt, '2026-04-30T02:00:00.000Z');
    assert.equal(rereadShared.agents.root?.label, 'Root');

    const team: TeamIdentity = {
      id: 'team',
      label: 'Team',
      kind: 'team',
      status: 'running',
      leaderAgentId: 'root',
      memberAgentIds: ['root'],
      taskIds: ['task'],
    };
    const node: ZergTreeNode = {
      id: 'root-node',
      kind: 'agent',
      label: 'Root node',
      status: 'running',
      refId: 'root',
      childIds: ['task-node'],
    };

    let state = createZergState({
      tasks: { task: rereadShared.tasks.task! },
      mode: { automation: 'assisted', interventionEnabled: false, controller: 'operator' },
    });
    state = upsertTeam(state, team);
    state = upsertTreeNode(state, node);
    state = selectNode(state, 'root-node');
    team.memberAgentIds.push('mutated-after-upsert');
    node.childIds.push('mutated-after-upsert');

    const tasks = getCurrentTasks(state);
    const teams = getCurrentTeams(state);
    const tree = getCurrentTree(state);
    const mode = getCurrentMode(state);
    const selected = getSelectedTreeNode(state);

    tasks[0]!.title = 'Mutated task reader';
    tasks[0]!.blockedBy!.push('mutated-reader');
    teams[0]!.memberAgentIds.push('mutated-reader');
    tree['root-node']!.childIds.push('mutated-reader');
    mode.automation = 'automatic';
    selected!.childIds.push('mutated-selected-reader');

    assert.equal(state.tasks.task?.title, 'Shared task');
    assert.deepEqual(state.tasks.task?.blockedBy, ['dep']);
    assert.deepEqual(state.teams.team?.memberAgentIds, ['root']);
    assert.deepEqual(state.tree['root-node']?.childIds, ['task-node']);
    assert.equal(state.mode.automation, 'assisted');
    assert.deepEqual(getSelectedTreeNode(state)?.childIds, ['task-node']);
  } finally {
    replaceSharedZergState();
  }
});


test('applyRuntimeTransition records deterministic agent and team lifecycle state', () => {
  const initial = createZergState({
    metadata: { createdAt: '2026-05-02T20:00:00.000Z', updatedAt: '2026-05-02T20:00:00.000Z', resetCount: 0 },
  });

  let state = applyRuntimeTransition(initial, {
    entity: 'agent',
    action: 'create',
    id: 'worker',
    label: 'Worker',
    at: '2026-05-02T20:01:00.000Z',
    mode: { automation: 'assisted', interventionEnabled: false, contextId: 'ctx-runtime' },
  });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T20:02:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T20:03:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'stop', id: 'worker', at: '2026-05-02T20:04:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Ops', memberAgentIds: ['worker', 'worker'], at: '2026-05-02T20:05:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', activity: 'blocked on review', at: '2026-05-02T20:06:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'reset', id: 'ops', at: '2026-05-02T20:07:00.000Z' });

  assert.deepEqual(initial.agents, {});
  assert.equal(state.revision, 7);
  assert.equal(state.metadata.updatedAt, '2026-05-02T20:07:00.000Z');
  assert.equal(state.agents.worker?.status, 'done');
  assert.equal(state.agents.worker?.runtime?.health, 'stopped');
  assert.equal(state.agents.worker?.runtime?.createdAt, '2026-05-02T20:01:00.000Z');
  assert.equal(state.agents.worker?.runtime?.startedAt, '2026-05-02T20:02:00.000Z');
  assert.equal(state.agents.worker?.runtime?.stoppedAt, '2026-05-02T20:04:00.000Z');
  assert.equal(state.agents.worker?.runtime?.lastActivity, 'stopped');
  assert.equal(state.agents.worker?.runtime?.mode.automation, 'assisted');
  assert.equal(state.agents.worker?.runtime?.mode.interventionEnabled, false);
  assert.equal(state.agents.worker?.runtime?.mode.contextId, 'ctx-runtime');
  assert.equal(state.teams.ops?.status, 'idle');
  assert.deepEqual(state.teams.ops?.memberAgentIds, ['worker']);
  assert.equal(state.teams.ops?.runtime?.health, 'unknown');
  assert.equal(state.teams.ops?.runtime?.startedAt, undefined);
  assert.equal(state.teams.ops?.runtime?.stoppedAt, undefined);
  assert.deepEqual(state.events.map((event) => event.id), ['runtime-1', 'runtime-2', 'runtime-3', 'runtime-4', 'runtime-5', 'runtime-6', 'runtime-7']);
  assert.deepEqual(state.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.events.map((event) => event.revision), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(state.events.map((event) => event.action), ['create', 'start', 'progress', 'stop', 'create', 'fail', 'reset']);
  assert.equal(state.events[2]?.message, 'agent worker progress: editing state');
  assert.equal(state.events[5]?.health, 'failed');
});

test('replayRuntimeTransitions is deterministic and bounds transition events', () => {
  const transitions: ZergRuntimeTransition[] = [
    { entity: 'agent', action: 'create', id: 'worker', at: '2026-05-02T21:01:00.000Z' },
    { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T21:02:00.000Z' },
    { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T21:03:00.000Z' },
  ];
  const seed = createZergState({ metadata: { createdAt: '2026-05-02T21:00:00.000Z', updatedAt: '2026-05-02T21:00:00.000Z', resetCount: 0 } });

  const first = replayRuntimeTransitions(seed, transitions, { maxEvents: 2 });
  const second = replayRuntimeTransitions(seed, transitions, { maxEvents: 2 });

  assert.deepEqual(second, first);
  assert.equal(seed.revision, 0);
  assert.deepEqual(first.events.map((event) => event.id), ['runtime-2', 'runtime-3']);
  assert.equal(first.agents.worker?.runtime?.lastActivity, 'editing state');
  assert.equal(first.agents.worker?.runtime?.health, 'healthy');
});

test('applyModeTransition records audit snapshots and active intervention clearing deterministically', () => {
  const transitionAt = '2026-05-03T00:00:00.000Z';
  const activeIntervention = {
    kind: 'agent' as const,
    targetId: 'worker',
    targetLabel: 'Worker',
    message: 'operator is reviewing',
    createdAt: '2026-05-02T23:59:00.000Z',
  };
  const initial = createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: false,
      controller: 'operator',
      contextId: 'ctx-before',
      activeIntervention,
    },
  });

  const transitioned = applyModeTransition(
    initial,
    {
      automation: 'automatic',
      controller: 'automation',
      interventionEnabled: true,
      contextId: 'ctx-after',
      reason: 'handoff accepted',
      clearActiveIntervention: true,
    },
    { now: () => new Date(transitionAt) },
  );

  assert.equal(initial.mode.automation, 'assisted');
  assert.equal(transitioned.revision, 1);
  assert.equal(transitioned.metadata.updatedAt, transitionAt);
  assert.deepEqual(transitioned.mode.previousMode, {
    automation: 'assisted',
    interventionEnabled: false,
    controller: 'operator',
    contextId: 'ctx-before',
  });
  assert.equal(transitioned.mode.automation, 'automatic');
  assert.equal(transitioned.mode.controller, 'automation');
  assert.equal(transitioned.mode.interventionEnabled, true);
  assert.equal(transitioned.mode.contextId, 'ctx-after');
  assert.equal(Object.hasOwn(transitioned.mode, 'activeIntervention'), false);

  const event = transitioned.events[0]!;
  assert.equal(event.id, 'mode-1');
  assert.equal(event.type, 'mode');
  assert.equal(event.createdAt, transitionAt);
  assert.equal(event.message, 'mode transition assisted/operator -> automatic/automation: handoff accepted');
  assert.deepEqual(event.previousMode, transitioned.mode.previousMode);
  assert.equal(event.mode?.automation, 'automatic');
  assert.equal(event.mode?.controller, 'automation');

  const retained = applyModeTransition(
    initial,
    {
      automation: 'manual',
      controller: 'operator',
      interventionEnabled: true,
      clearActiveIntervention: false,
    },
    { now: () => new Date(transitionAt) },
  );
  assert.deepEqual(retained.mode.activeIntervention, activeIntervention);

  const revertInput = createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: true,
      controller: 'operator',
      contextId: 'ctx-revert-source',
      previousMode: {
        automation: 'automatic',
        interventionEnabled: true,
        controller: 'automation',
      },
    },
  });

  const clearedContext = applyModeTransition(
    revertInput,
    {
      automation: 'automatic',
      controller: 'automation',
      interventionEnabled: true,
      contextId: revertInput.mode.previousMode?.contextId,
      reason: 'revert without context',
      clearActiveIntervention: true,
    },
    { now: () => new Date(transitionAt) },
  );

  assert.equal(clearedContext.mode.contextId, undefined);
  assert.equal(clearedContext.events[0]?.mode?.contextId, undefined);
});

test('applyInterventionRecord sanitizes messages and forces operator intervention state with audit payload', () => {
  const interventionAt = '2026-05-03T00:05:00.000Z';
  const previousMode = { automation: 'manual' as const, interventionEnabled: true, controller: 'operator' as const, contextId: 'ctx-manual' };
  const initial = createZergState({
    mode: {
      automation: 'automatic',
      interventionEnabled: false,
      controller: 'automation',
      previousMode,
    },
  });

  const recorded = applyInterventionRecord(
    initial,
    {
      kind: 'subagent',
      targetId: 'worker',
      targetLabel: 'Worker',
      message: '  Needs\noperator\t\u0000 review  ',
    },
    { now: () => new Date(interventionAt) },
  );

  assert.equal(initial.mode.controller, 'automation');
  assert.equal(recorded.mode.automation, 'automatic');
  assert.equal(recorded.mode.controller, 'operator');
  assert.equal(recorded.mode.interventionEnabled, true);
  assert.deepEqual(recorded.mode.previousMode, previousMode);
  assert.deepEqual(recorded.mode.activeIntervention, {
    kind: 'subagent',
    targetId: 'worker',
    targetLabel: 'Worker',
    message: 'Needs operator review',
    createdAt: interventionAt,
  });

  const event = recorded.events[0]!;
  assert.equal(event.id, 'permission-1');
  assert.equal(event.type, 'permission');
  assert.equal(event.message, 'intervention recorded: subagent worker');
  assert.deepEqual(event.intervention, recorded.mode.activeIntervention);
  assert.deepEqual(event.previousMode, previousMode);
});

test('createZergCommandHandler applies v0.8 mode status transitions and revert', () => {
  const readOnlyHandler = createZergCommandHandler(createZergState());

  const readOnlyStatus = readOnlyHandler('/zerg mode status');
  assert.equal(readOnlyStatus.ok, true);
  assert.ok(readOnlyStatus.output.includes('zerg v0.8.0 command surface'));
  assert.ok(readOnlyStatus.output.includes('control operator'));
  assert.ok(readOnlyStatus.output.includes('mode manual'));
  assert.ok(readOnlyStatus.output.includes('no active intervention'));

  assert.equal(readOnlyHandler('/zerg mode manual').ok, false);
  assert.equal(readOnlyHandler('/zerg mode manual').output, 'Runtime lifecycle commands require writable zerg state.');

  const container = createZergStateContainer();
  const timestamps = createNowSequence(
    '2026-05-03T01:00:00.000Z',
    '2026-05-03T01:01:00.000Z',
    '2026-05-03T01:02:00.000Z',
    '2026-05-03T01:03:00.000Z',
  );
  const handler = createZergCommandHandler(container, { now: timestamps });

  const status = handler('/zerg mode status');
  assert.equal(status.ok, true);
  assert.ok(status.output.includes('control operator'));
  assert.ok(status.output.includes('mode manual'));
  assert.ok(status.output.includes('no active intervention'));

  const beforeInvalidMode = container.snapshot();
  const invalidMode = handler('/zerg mode wat');
  assert.equal(invalidMode.ok, false);
  assert.equal(invalidMode.output, 'Unknown mode action: wat');
  assert.deepEqual(container.snapshot(), beforeInvalidMode);

  const beforeControlOnlyReason = container.snapshot();
  const controlOnlyReasonText = String.fromCharCode(0);
  const controlOnlyReason = handler(`/zerg mode automatic "${controlOnlyReasonText}"`);
  assert.equal(controlOnlyReason.ok, false);
  assert.equal(controlOnlyReason.output, 'mode reason exceeds 140 characters or contains only control characters.');
  assert.deepEqual(container.snapshot(), beforeControlOnlyReason);

  const beforeLongReason = container.snapshot();
  const longReason = handler('/zerg mode automatic ' + 'x'.repeat(141));
  assert.equal(longReason.ok, false);
  assert.equal(longReason.output, 'mode reason exceeds 140 characters or contains only control characters.');
  assert.deepEqual(container.snapshot(), beforeLongReason);

  const rejectedRevert = handler('/zerg mode revert');
  assert.equal(rejectedRevert.ok, false);
  assert.equal(rejectedRevert.output, 'No prior mode snapshot to revert to.');

  const manual = handler('/zerg mode manual confirmed');
  assert.equal(manual.ok, true);
  assert.ok(manual.output.includes('mode set to manual'));
  assert.equal(container.snapshot().mode.controller, 'operator');

  const automatic = handler('/zerg mode automatic "hands off"');
  assert.equal(automatic.ok, true);
  assert.ok(automatic.output.includes('mode set to automatic'));
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.controller, 'automation');

  const assisted = handler('/zerg mode assisted operator-review');
  assert.equal(assisted.ok, true);
  assert.equal(container.snapshot().mode.automation, 'assisted');
  assert.equal(container.snapshot().mode.controller, 'operator');
  assert.deepEqual(container.snapshot().mode.previousMode, {
    automation: 'automatic',
    interventionEnabled: true,
    controller: 'automation',
    contextId: undefined,
  });

  const reverted = handler('/zerg mode revert rollback');
  assert.equal(reverted.ok, true);
  assert.ok(reverted.output.includes('mode reverted'));
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.controller, 'automation');
  assert.deepEqual(container.snapshot().events.map((event) => event.type), ['mode', 'mode', 'mode', 'mode']);
  assert.equal(container.snapshot().events.at(-1)?.message, 'mode transition assisted/operator -> automatic/automation: rollback');
});

test('createZergCommandHandler mode revert clears contextId when previous snapshot has no context', () => {
  const container = createZergStateContainer(createZergState({
    mode: {
      automation: 'assisted',
      interventionEnabled: true,
      controller: 'operator',
      contextId: 'ctx-current',
      previousMode: {
        automation: 'automatic',
        interventionEnabled: true,
        controller: 'automation',
      },
    },
  }));
  const handler = createZergCommandHandler(container, { now: () => new Date('2026-05-03T01:10:00.000Z') });

  const reverted = handler('/zerg mode revert rollback');
  assert.equal(reverted.ok, true);
  assert.equal(container.snapshot().mode.automation, 'automatic');
  assert.equal(container.snapshot().mode.contextId, undefined);
  assert.equal(container.snapshot().events.at(-1)?.mode?.contextId, undefined);
});

test('createZergCommandHandler applies v0.7 intervention APIs and rejects invalid targets', () => {
  const interventionAt = '2026-05-03T02:00:00.000Z';
  const container = createZergStateContainer(createZergState({
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
      teammate: { id: 'teammate', label: 'Teammate', kind: 'teammate', status: 'idle' },
    },
    teams: {
      ops: { id: 'ops', label: 'Ops', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['worker'] },
      leaderless: { id: 'leaderless', label: 'Leaderless', kind: 'team', status: 'idle', memberAgentIds: [] },
      missingLeader: { id: 'missingLeader', label: 'Missing leader', kind: 'team', status: 'idle', leaderAgentId: 'ghost', memberAgentIds: [] },
    },
  }));
  const handler = createZergCommandHandler(container, { now: () => new Date(interventionAt) });

  const agentIntervention = handler('/zerg intervene agent leader Please review');
  assert.equal(agentIntervention.ok, true);
  assert.equal(agentIntervention.output, 'intervention recorded against agent leader: Please review');
  assert.equal(container.snapshot().mode.activeIntervention?.targetId, 'leader');

  const subagentIntervention = handler('/zerg intervene subagent worker Take over');
  assert.equal(subagentIntervention.ok, true);
  assert.equal(subagentIntervention.output, 'intervention recorded against subagent worker: Take over');
  assert.equal(container.snapshot().mode.activeIntervention?.kind, 'subagent');
  assert.equal(container.snapshot().mode.controller, 'operator');

  const leaderIntervention = handler('/zerg intervene leader ops Lead please');
  assert.equal(leaderIntervention.ok, true);
  assert.equal(leaderIntervention.output, 'intervention recorded against leader leader (team ops): Lead please');
  assert.deepEqual(container.snapshot().mode.activeIntervention, {
    kind: 'leader',
    targetId: 'leader',
    targetLabel: 'Leader',
    teamId: 'ops',
    leaderAgentId: 'leader',
    message: 'Lead please',
    createdAt: interventionAt,
  });

  assert.deepEqual(container.snapshot().events.map((event) => event.type), ['permission', 'permission', 'permission']);
  assert.equal(handler('/zerg intervene banana worker msg').output, 'Unknown intervention target: banana');
  assert.equal(handler('/zerg intervene agent').output, 'intervene agent requires an id.');
  assert.equal(handler('/zerg intervene agent worker').output, 'intervene requires a non-empty message.');
  assert.equal(handler('/zerg intervene agent ghost msg').output, 'Cannot intervene agent for unknown agent: ghost');
  assert.equal(handler('/zerg intervene subagent leader msg').output, 'intervene subagent requires target agent to be subagent: leader');
  assert.equal(handler('/zerg intervene leader ghost msg').output, 'Cannot intervene leader for unknown team: ghost');
  assert.equal(handler('/zerg intervene leader leaderless msg').output, 'Team leaderless has no leader to intervene.');
  assert.equal(handler('/zerg intervene leader missingLeader msg').output, 'Team missingLeader leader ghost is missing.');
  assert.equal(handler(`/zerg intervene agent worker ${'x'.repeat(241)}`).output, 'intervention message exceeds 240 characters or contains only control characters.');
});

test('render surfaces expose v0.7 control intervention status tree markers and help syntax', () => {
  const idleState = createZergState();
  const idleStatus = renderStatusLine(idleState, { width: 240 });
  const idleHelp = renderHelp(idleState, { width: 240 });

  assert.ok(idleStatus.includes('control operator'));
  assert.ok(idleStatus.includes('mode manual'));
  assert.ok(idleStatus.includes('no active intervention'));
  assert.ok(idleHelp.includes('Control syntax: /zerg mode status|manual|assisted|automatic|revert [reason]'));
  assert.ok(idleHelp.includes('Intervention syntax: /zerg intervene agent <agent-id> <message>'));

  const activeState = createZergState({
    agents: {
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' },
    },
    mode: {
      automation: 'manual',
      interventionEnabled: true,
      controller: 'operator',
      activeIntervention: {
        kind: 'subagent',
        targetId: 'worker',
        targetLabel: 'Worker',
        message: 'Please review the worker handoff now',
        createdAt: '2026-05-03T02:30:00.000Z',
      },
    },
  });
  const activeStatus = renderStatusLine(activeState, { width: 240 });
  const fallbackTree = renderAgentTree(activeState, { width: 240 });
  const explicitTree = renderAgentTree(createZergState({
    agents: activeState.agents,
    mode: activeState.mode,
    tree: {
      workerNode: { id: 'workerNode', kind: 'agent', label: 'Worker node', status: 'running', refId: 'worker', childIds: [] },
    },
  }), { width: 240 });

  assert.ok(activeStatus.includes('intervention subagent worker (Please review the worker handoff now)'));
  assert.ok(fallbackTree.includes('◉ Worker [subagent/running]'));
  assert.ok(explicitTree.includes('◉ agent Worker node [running]'));
});

test('createZergCommandHandler applies lifecycle commands only with writable state and command timestamps', () => {
  const readOnlyHandler = createZergCommandHandler(createZergState());
  const readOnlyResult = readOnlyHandler('/zerg agent create worker Worker');

  assert.equal(readOnlyResult.ok, false);
  assert.equal(readOnlyResult.output, 'Runtime lifecycle commands require writable zerg state.');

  const commandAt = '2026-05-02T23:00:00.000Z';
  const container = createZergStateContainer();
  const handler = createZergCommandHandler(container, {
    now: () => new Date(commandAt),
  });

  assert.equal(handler('/zerg agent create worker Worker One').ok, true);
  assert.equal(handler('agent start worker').ok, true);
  assert.equal(handler('agent progress worker "editing state"').ok, true);
  assert.equal(handler('team create ops Operations').ok, true);
  assert.equal(handler('team start ops').ok, true);
  assert.equal(handler('team stop ops').ok, true);

  const snapshot = container.snapshot();
  assert.equal(snapshot.agents.worker?.label, 'Worker One');
  assert.equal(snapshot.agents.worker?.status, 'running');
  assert.equal(snapshot.agents.worker?.runtime?.createdAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.startedAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.lastActivityAt, commandAt);
  assert.equal(snapshot.agents.worker?.runtime?.lastActivity, 'editing state');
  assert.equal(snapshot.teams.ops?.label, 'Operations');
  assert.equal(snapshot.teams.ops?.status, 'done');
  assert.equal(snapshot.teams.ops?.runtime?.createdAt, commandAt);
  assert.equal(snapshot.teams.ops?.runtime?.startedAt, commandAt);
  assert.equal(snapshot.teams.ops?.runtime?.stoppedAt, commandAt);
  assert.equal(snapshot.metadata.updatedAt, commandAt);
  assert.notEqual(snapshot.metadata.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(snapshot.events.map((event) => event.action), ['create', 'start', 'progress', 'create', 'start', 'stop']);
  assert.deepEqual(snapshot.events.map((event) => event.createdAt), [commandAt, commandAt, commandAt, commandAt, commandAt, commandAt]);
});

test('registered Pi command handlers mutate extension and shared lifecycle state end to end', async () => {
  replaceSharedZergState();

  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const registration = registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  }, {
    now: createNowSequence(
      '2026-05-02T23:10:00.000Z',
      '2026-05-02T23:11:00.000Z',
      '2026-05-02T23:12:00.000Z',
      '2026-05-02T23:13:00.000Z',
      '2026-05-02T23:14:00.000Z',
      '2026-05-02T23:15:00.000Z',
      '2026-05-02T23:16:00.000Z',
      '2026-05-02T23:17:00.000Z',
    ),
  });
  const notifyContext = {
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  try {
    const handler = registrations[0]?.options.handler;
    assert.ok(handler);

    const commandOutput = async (input: string) => {
      const start = notifications.length;
      await handler(input, notifyContext);
      return notifications[start] as { message: string; type?: string };
    };

    const agentCreateNotification = await commandOutput('agent create worker Worker');
    const agentStartNotification = await commandOutput('agent start worker');
    const agentProgressNotification = await commandOutput('agent progress worker "editing state"');
    const agentStopNotification = await commandOutput('agent stop worker');
    const teamCreateNotification = await commandOutput('team create ops Operations');
    const teamStartNotification = await commandOutput('team start ops');
    const teamProgressNotification = await commandOutput('team progress ops "coordinating review"');
    const teamStopNotification = await commandOutput('team stop ops');
    const statusNotification = await commandOutput('status');
    const treeNotification = await commandOutput('tree');

    const extensionState = registration.state;
    const sharedState = readSharedZergState();
    const runtimeEvents = extensionState.events.slice(-8);
    const commandTimestamps = [
      '2026-05-02T23:10:00.000Z',
      '2026-05-02T23:11:00.000Z',
      '2026-05-02T23:12:00.000Z',
      '2026-05-02T23:13:00.000Z',
      '2026-05-02T23:14:00.000Z',
      '2026-05-02T23:15:00.000Z',
      '2026-05-02T23:16:00.000Z',
      '2026-05-02T23:17:00.000Z',
    ];

    assert.equal(extensionState.agents.worker?.label, 'Worker');
    assert.equal(extensionState.agents.worker?.status, 'done');
    assert.equal(extensionState.agents.worker?.runtime?.health, 'stopped');
    assert.equal(extensionState.agents.worker?.runtime?.createdAt, '2026-05-02T23:10:00.000Z');
    assert.equal(extensionState.agents.worker?.runtime?.startedAt, '2026-05-02T23:11:00.000Z');
    assert.equal(extensionState.agents.worker?.runtime?.lastActivityAt, '2026-05-02T23:13:00.000Z');
    assert.equal(extensionState.teams.ops?.label, 'Operations');
    assert.equal(extensionState.teams.ops?.status, 'done');
    assert.equal(extensionState.teams.ops?.runtime?.createdAt, '2026-05-02T23:14:00.000Z');
    assert.equal(extensionState.teams.ops?.runtime?.startedAt, '2026-05-02T23:15:00.000Z');
    assert.equal(extensionState.teams.ops?.runtime?.lastActivityAt, '2026-05-02T23:17:00.000Z');
    assert.equal(extensionState.metadata.updatedAt, '2026-05-02T23:17:00.000Z');
    assert.deepEqual(runtimeEvents.map((event) => event.type), ['agent', 'agent', 'agent', 'agent', 'team', 'team', 'team', 'team']);
    assert.deepEqual(runtimeEvents.map((event) => event.action), ['create', 'start', 'progress', 'stop', 'create', 'start', 'progress', 'stop']);
    assert.deepEqual(runtimeEvents.map((event) => event.createdAt), commandTimestamps);
    assert.deepEqual(runtimeEvents.map((event) => event.revision), [2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(runtimeEvents.every((event) => event.mode?.automation === 'manual'));
    assert.ok(runtimeEvents.every((event) => event.mode?.interventionEnabled === true));
    assert.notEqual(runtimeEvents[0]?.createdAt, '1970-01-01T00:00:00.000Z');
    assert.equal(sharedState.agents.worker?.label, extensionState.agents.worker?.label);
    assert.equal(sharedState.teams.ops?.label, extensionState.teams.ops?.label);
    assert.deepEqual(sharedState.events.slice(-8), runtimeEvents);

    assert.ok(agentCreateNotification.message.includes('Worker: created'));
    assert.ok(agentProgressNotification.message.includes('Worker: editing state'));
    assert.ok(agentStopNotification.message.includes('Worker: stopped'));
    assert.ok(teamProgressNotification.message.includes('Operations: coordinating review'));
    assert.ok(teamStopNotification.message.includes('Operations: stopped'));
    assert.ok(statusNotification?.message.includes('agents 1 (0 running)'));
    assert.ok(statusNotification?.message.includes('teams 1 (0 running)'));
    assert.ok(statusNotification?.message.includes('last Operations: stopped'));
    assert.ok(treeNotification?.message.includes('Worker [subagent/done] {health:stopped last:stopped}'));
    assert.ok(treeNotification?.message.includes('team Operations [team/done] {health:stopped last:stopped}'));
    assert.ok(agentStartNotification.message.includes('agent worker start applied.'));
    assert.ok(teamCreateNotification.message.includes('team ops create applied.'));
    assert.ok(teamStartNotification.message.includes('team ops start applied.'));
    assert.ok(notifications.every((notification) => notification.type === 'info'));
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('registered Pi mode and intervention commands sync extension and shared state end to end', async () => {
  replaceSharedZergState(createZergState({
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running', teamId: 'ops' },
    },
    teams: {
      ops: { id: 'ops', label: 'Operations', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['leader', 'worker'] },
    },
  }));

  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const registration = registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  }, {
    now: createNowSequence(
      '2026-05-03T03:00:00.000Z',
      '2026-05-03T03:01:00.000Z',
      '2026-05-03T03:02:00.000Z',
    ),
  });
  const notifyContext = {
    hasUI: true,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  };

  try {
    const handler = registrations[0]?.options.handler;
    assert.ok(handler);

    const commandOutput = async (input: string) => {
      const start = notifications.length;
      await handler(input, notifyContext);
      return notifications[start] as { message: string; type?: string };
    };

    const automaticNotification = await commandOutput('/zerg mode automatic "hands off"');
    const automaticState = registration.state;
    const automaticSharedState = readSharedZergState();

    assert.equal(automaticState.mode.automation, 'automatic');
    assert.equal(automaticState.mode.controller, 'automation');
    assert.equal(automaticSharedState.mode.automation, 'automatic');
    assert.equal(automaticSharedState.mode.controller, 'automation');
    assert.equal(automaticSharedState.events.at(-1)?.message, automaticState.events.at(-1)?.message);

    const leaderNotification = await commandOutput('/zerg intervene leader ops "review worker handoff"');
    const intervenedState = registration.state;
    const intervenedSharedState = readSharedZergState();

    assert.deepEqual(intervenedState.mode.activeIntervention, {
      kind: 'leader',
      targetId: 'leader',
      targetLabel: 'Leader',
      teamId: 'ops',
      leaderAgentId: 'leader',
      message: 'review worker handoff',
      createdAt: '2026-05-03T03:01:00.000Z',
    });
    assert.equal(intervenedState.mode.automation, 'automatic');
    assert.equal(intervenedState.mode.controller, 'operator');
    assert.deepEqual(intervenedSharedState.mode, intervenedState.mode);
    assert.equal(intervenedSharedState.events.at(-1)?.message, 'intervention recorded: leader leader');

    const assistedNotification = await commandOutput('/zerg mode assisted operator-review');
    const finalState = registration.state;
    const finalSharedState = readSharedZergState();
    const finalEvents = finalState.events.slice(-3);

    assert.equal(finalState.mode.automation, 'assisted');
    assert.equal(finalState.mode.controller, 'operator');
    assert.equal(Object.hasOwn(finalState.mode, 'activeIntervention'), false);
    assert.deepEqual(finalSharedState.mode, finalState.mode);
    assert.deepEqual(finalSharedState.events.slice(-3), finalEvents);
    assert.deepEqual(finalEvents.map((event) => event.type), ['mode', 'permission', 'mode']);
    assert.deepEqual(finalEvents.map((event) => event.createdAt), [
      '2026-05-03T03:00:00.000Z',
      '2026-05-03T03:01:00.000Z',
      '2026-05-03T03:02:00.000Z',
    ]);
    assert.deepEqual(finalEvents.map((event) => event.message), [
      'mode transition manual/operator -> automatic/automation: hands off',
      'intervention recorded: leader leader',
      'mode transition automatic/operator -> assisted/operator: operator-review',
    ]);
    assert.ok(automaticNotification.message.includes('mode set to automatic'));
    assert.ok(leaderNotification.message.includes('intervention recorded against leader leader (team ops): review worker handoff'));
    assert.ok(assistedNotification.message.includes('mode set to assisted'));
    assert.ok(notifications.every((notification) => notification.type === 'info'));
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('render monitoring summarizes runtime health activity without mutation', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T22:01:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T22:02:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', label: 'Ops', activity: 'blocked on review', at: '2026-05-02T22:03:00.000Z' });
  const before = JSON.stringify(state);

  const status = renderStatusLine(state, { width: 240 });
  const tree = renderAgentTree(state, { width: 240 });

  assert.ok(status.includes('zerg v0.8.0 command surface'));
  assert.ok(status.includes('agents 1 (1 running)'));
  assert.ok(status.includes('teams 1 (0 running)'));
  assert.ok(status.includes('unhealthy 1'));
  assert.ok(status.includes('last Ops: blocked on review'));
  assert.ok(tree.includes('Worker [subagent/running] {health:healthy last:editing state}'));
  assert.ok(tree.includes('team Ops [team/failed] {health:failed last:blocked on review}'));
  assert.equal(JSON.stringify(state), before);
});

test('renderStatusLine uses deterministic latest runtime ordering when timestamps tie', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Operations', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'agent progress', at: '2026-05-02T23:20:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'progress', id: 'ops', activity: 'team review', at: '2026-05-02T23:20:00.000Z' });

  const status = renderStatusLine(state, { width: 240 });

  assert.equal(state.agents.worker?.runtime?.lastActivitySequence, 3);
  assert.equal(state.teams.ops?.runtime?.lastActivitySequence, 4);
  assert.ok(status.includes('last Operations: team review'));
});

test('renderStatusLine falls back to newest displayable runtime activity when latest sanitizes to empty', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:22:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Ops', at: '2026-05-02T23:22:30.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T23:23:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'progress', id: 'ops', activity: String.fromCharCode(0), at: '2026-05-02T23:24:00.000Z' });

  const status = renderStatusLine(state, { width: 240 });

  assert.ok(status.includes('last Worker: editing state'));
  assert.ok(!status.includes('last Ops:'));
});

test('explicit-tree rendering resolves referenced live agent and team runtimes', () => {
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:21:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'start', id: 'worker', at: '2026-05-02T23:21:30.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: 'editing state', at: '2026-05-02T23:22:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'create', id: 'ops', label: 'Operations', memberAgentIds: ['worker'], at: '2026-05-02T23:23:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'team', action: 'fail', id: 'ops', activity: 'blocked on review', at: '2026-05-02T23:24:00.000Z' });

  state = upsertTreeNode(state, {
    id: 'ref-worker',
    kind: 'agent',
    label: 'Worker node',
    status: 'running',
    refId: 'worker',
    childIds: [],
  });
  state = upsertTreeNode(state, {
    id: 'ops',
    kind: 'team',
    label: 'Operations node',
    status: 'running',
    childIds: [],
  });

  const tree = renderAgentTree(state, { width: 240 });

  assert.ok(tree.includes('agent Worker node [running] {health:healthy last:editing state}'));
  assert.ok(tree.includes('team Operations node [running] {health:failed last:blocked on review}'));
});

test('runtime activity sanitizes control whitespace to keep status and tree output one line each', () => {
  const multilineActivity = 'line one\nline two\tline three';
  let state = createZergState();
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'create', id: 'worker', label: 'Worker', at: '2026-05-02T23:25:00.000Z' });
  state = applyRuntimeTransition(state, { entity: 'agent', action: 'progress', id: 'worker', activity: multilineActivity, at: '2026-05-02T23:25:30.000Z' });
  state = upsertTreeNode(state, {
    id: 'worker-runtime',
    kind: 'agent',
    label: 'Worker node',
    status: 'running',
    refId: 'worker',
    childIds: [],
  });

  const status = renderStatusLine(state, { width: 160 });
  const tree = renderAgentTree(state, { width: 160 });
  const narrowStatus = renderStatusLine(state, { width: 60 });
  const narrowTree = renderAgentTree(state, { width: 60 });

  assert.equal(status.split('\n').length, 1);
  assert.equal(tree.split('\n').length, 2);
  assert.ok(status.includes('last Worker: line one line two line three'));
  assert.ok(tree.includes('line one line two line three'));
  assert.equal(narrowStatus.split('\n').length, 1);
  assert.equal(narrowTree.split('\n').length, 2);
  assert.ok(narrowStatus.length <= 60);
  assert.ok(Math.max(...narrowTree.split('\n').map((line) => line.length)) <= 60);
});

test('deriveThinkingSteps parses numbered reasoning steps with source-line IDs', () => {
  const steps = deriveThinkingSteps('1. inspect context\n2) implement scaffold');

  assert.deepEqual(steps.map((step) => step.title), ['inspect context', 'implement scaffold']);
  assert.deepEqual(steps.map((step) => step.status), ['unknown', 'unknown']);
  assert.deepEqual(steps.map((step) => step.id), ['step-1', 'step-2']);
  assert.deepEqual(steps.map((step) => step.sourceLine), [1, 2]);
});

test('deriveThinkingSteps output is deterministic for repeated identical input', () => {
  const input = 'plain prose\n1. inspect context\n- [x] done item\nneeds attention: blocked item';
  const first = deriveThinkingSteps(input);
  const second = deriveThinkingSteps(input);
  const third = deriveThinkingSteps(input);

  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.deepEqual(first.map((step) => step.id), ['step-2', 'step-3', 'step-4']);
});

test('deriveThinkingSteps preserves source-line gaps after skipped lines', () => {
  const steps = deriveThinkingSteps('intro only\n1. first parsed\n\nqueued: unsupported prefix\n- second parsed');

  assert.deepEqual(steps, [
    { id: 'step-2', title: 'first parsed', status: 'unknown', sourceLine: 2 },
    { id: 'step-5', title: 'second parsed', status: 'unknown', sourceLine: 5 },
  ]);
});

test('deriveThinkingSteps treats arrays strings LF and CRLF consistently', () => {
  const lines = ['1. first step', '- [x] second step', 'needs-attention: third step'];
  const fromArray = deriveThinkingSteps(lines);

  assert.deepEqual(deriveThinkingSteps(lines.join('\n')), fromArray);
  assert.deepEqual(deriveThinkingSteps(lines.join('\r\n')), fromArray);
  assert.deepEqual(fromArray.map((step) => step.status), ['unknown', 'done', 'blocked']);
});

test('deriveThinkingSteps parses prefixed numbered and bullet items', () => {
  const steps = deriveThinkingSteps('1. todo: inspect context\n2) running - implement parser\n- done: write tests\n* failed: document bug');

  assert.deepEqual(steps.map((step) => step.title), ['inspect context', 'implement parser', 'write tests', 'document bug']);
  assert.deepEqual(steps.map((step) => step.status), ['todo', 'running', 'done', 'failed']);
});

test('deriveThinkingSteps normalizes uppercase status aliases', () => {
  const steps = deriveThinkingSteps(['DONE: context loaded', 'Needs Attention: reviewer blocked', 'NEEDS-ATTENTION - audit blocked']);

  assert.deepEqual(steps.map((step) => step.status), ['done', 'blocked', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['context loaded', 'reviewer blocked', 'audit blocked']);
});

test('deriveThinkingSteps gives checkbox status precedence over embedded prefixes', () => {
  const steps = deriveThinkingSteps('- [ ] done: still todo\n- [x] blocked: already done\n- [!] running: still blocked\n- [-] failed: also blocked');

  assert.deepEqual(steps.map((step) => step.status), ['todo', 'done', 'blocked', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['still todo', 'already done', 'still blocked', 'also blocked']);
});

test('deriveThinkingSteps preserves ordinary hyphenated marked titles', () => {
  const steps = deriveThinkingSteps([
    '- re-run tests',
    '- done-task cleanup',
    '1. follow-up audit',
    '1. failed-first attempt',
    '* command-surface check',
    '* todo-list cleanup',
    '- [ ] follow-up checkbox',
    '- [ ] done-task checkbox',
    '- [x] command-surface checkbox',
    '- [-] re-run blocked checkbox',
    '- [!] needs-attention checkbox title',
    '2) parse - render handoff',
    '3. needs-attention-task follow-up',
  ]);

  assert.deepEqual(steps.map((step) => step.title), [
    're-run tests',
    'done-task cleanup',
    'follow-up audit',
    'failed-first attempt',
    'command-surface check',
    'todo-list cleanup',
    'follow-up checkbox',
    'done-task checkbox',
    'command-surface checkbox',
    're-run blocked checkbox',
    'needs-attention checkbox title',
    'parse - render handoff',
    'needs-attention-task follow-up',
  ]);
  assert.deepEqual(steps.map((step) => step.status), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown', 'todo', 'todo', 'done', 'blocked', 'blocked', 'unknown', 'unknown']);
  assert.deepEqual(steps.map((step) => step.id), ['step-1', 'step-2', 'step-3', 'step-4', 'step-5', 'step-6', 'step-7', 'step-8', 'step-9', 'step-10', 'step-11', 'step-12', 'step-13']);
  assert.deepEqual(steps.map((step) => step.sourceLine), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

test('deriveThinkingSteps skips malformed and ambiguous input deterministically', () => {
  const input = [
    '',
    'plain prose',
    '- ',
    '+ unsupported bullet',
    '- [y] unsupported checkbox',
    '- [] empty checkbox',
    'queued: unsupported status prefix',
    'done => unsupported separator',
    '1. queued: unsupported numbered prefix',
    'needs-attention-task',
    '* useful item',
  ];

  assert.deepEqual(deriveThinkingSteps(input), [
    { id: 'step-11', title: 'useful item', status: 'unknown', sourceLine: 11 },
  ]);
});

test('registerZergSwarmExtension uses Pi command registration and notifies command output', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
  assert.ok(registrations.every((registration) => typeof registration.options.handler === 'function'));

  const firstHandler = registrations[0]?.options.handler;
  assert.ok(firstHandler);
  assert.ok(registrations.every((registration) => registration.options.handler === firstHandler));

  await firstHandler('status', {
    hasUI: true,
    ui: {
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });

  assert.equal(notifications.length, 1);
  assert.ok(notifications[0]?.message.includes('zerg v0.8.0 command surface'));
  assert.equal(notifications[0]?.type, 'info');
});

test('registerZergSwarmExtension activates Pi event-bus patch once with command flow', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const eventBus = createFakePiEventBus();

  replaceSharedZergState();
  const registration = registerZergSwarmExtension({
    events: eventBus,
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  try {
    assert.equal(registration.patchInstalled, true);
    assert.deepEqual(registrations.map((registered) => registered.name), ['zerg', 'zerg-swarm', 'swarm']);
    assert.deepEqual(registration.state.events.map((event) => event.message), ['pi-zerg-swarm v0.8.0 internal patch path active']);
    assert.deepEqual(readSharedZergState().events.map((event) => event.message), ['pi-zerg-swarm v0.8.0 internal patch path active']);

    eventBus.emit('zerg:smoke');

    const observedEvents = registration.state.events.filter((event) => event.message.includes('event bus emit: zerg:smoke'));
    const observedSharedEvents = readSharedZergState().events.filter((event) => event.message.includes('event bus emit: zerg:smoke'));

    assert.equal(observedEvents.length, 1);
    assert.equal(observedSharedEvents.length, 1);
    assert.equal(observedSharedEvents[0]?.message, observedEvents[0]?.message);

    const firstHandler = registrations[0]?.options.handler;
    assert.ok(firstHandler);

    await firstHandler('status', {
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });

    assert.equal(notifications.length, 1);
    assert.ok(notifications[0]?.message.includes('zerg v0.8.0 command surface'));
    assert.equal(notifications[0]?.type, 'info');
  } finally {
    registration.dispose();
    replaceSharedZergState();
  }
});

test('registerZergSwarmExtension restores patch and commands when startup fails', () => {
  const registrations: string[] = [];
  const disposedNames: string[] = [];
  const eventBus = createFakePiEventBus();
  const originalEmit = eventBus.emit;
  let fail = true;

  const context = {
    events: eventBus,
    registerCommand(name: string, _options: StructuralPiCommandOptions) {
      if (fail && name === 'zerg-swarm') {
        throw new Error('register failed');
      }

      registrations.push(name);
      return {
        dispose() {
          disposedNames.push(name);
        },
      };
    },
  };

  assert.throws(() => registerZergSwarmExtension(context), /register failed/);
  assert.equal(eventBus.emit, originalEmit);
  assert.deepEqual(disposedNames, ['zerg']);

  fail = false;
  const registration = registerZergSwarmExtension(context);

  try {
    assert.equal(registration.patchInstalled, true);
    assert.deepEqual(registrations, ['zerg', 'zerg', 'zerg-swarm', 'swarm']);
  } finally {
    registration.dispose();
  }
});

test('registered aliases dispatch status through equivalent handlers', async () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];

  registerZergSwarmExtension({
    registerCommand(name, options) {
      registrations.push({ name, options });
    },
  });

  for (const registration of registrations) {
    await registration.options.handler('status', {
      hasUI: true,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
    });
  }

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
  assert.equal(notifications.length, 3);
  assert.equal(new Set(notifications.map((notification) => notification.message)).size, 1);
  assert.deepEqual(notifications.map((notification) => notification.type), ['info', 'info', 'info']);
});

test('createZergCommandHandler normalizes help, status, whitespace, case, and aliases', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const helpOutput = handler('').output;
  const statusOutput = handler('status').output;

  assert.equal(handler('  help  ').output, helpOutput);
  assert.ok(helpOutput.includes('Commands: /zerg, /zerg-swarm, /swarm'));
  assert.ok(helpOutput.includes('/zerg agent create|start|progress|stop|fail|reset <agent-id> [label|activity]'));
  assert.ok(helpOutput.includes('/zerg team create|start|progress|stop|fail|reset <team-id> [label|activity]'));
  assert.equal(handler(' STATUS ').output, statusOutput);
  assert.equal(handler('  /swarm   status ').output, statusOutput);
  assert.equal(handler('zerg status').output, statusOutput);
});

test('createZergCommandHandler preserves multiline steps payload and skipped source lines', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const result = handler('/zerg steps plain prose\n- [ ] first step\nqueued: unsupported prefix\n- [x] second step');

  assert.equal(result.output, '2. [todo] first step\n4. [done] second step');
});

test('unknown zerg command returns consistent usage for every invocation', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const outputs = ['wat', '/zerg wat', '/zerg-swarm wat', '/swarm wat'].map((input) => handler(input).output);

  assert.equal(new Set(outputs).size, 1);

  for (const output of outputs) {
    assert.ok(output.startsWith('Unknown zerg command: wat\n\n'));
    assert.ok(output.includes('/zerg'));
    assert.ok(output.includes('/zerg-swarm'));
    assert.ok(output.includes('/swarm'));
  }
});

test('registerZergSwarmExtension does not duplicate registrations for the same context', () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const context = {
    registerCommand(name: string, options: StructuralPiCommandOptions) {
      registrations.push({ name, options });
    },
  };

  const registration = registerZergSwarmExtension(context);
  registerZergSwarmExtension(context);
  registration.dispose();
  registerZergSwarmExtension(context);

  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);
});

test('registerZergSwarmExtension dispose unregisters disposable commands once and permits clean re-registration', () => {
  const registrations: Array<{ name: string; options: StructuralPiCommandOptions }> = [];
  const disposedNames: string[] = [];
  const context = {
    events: createFakePiEventBus(),
    registerCommand(name: string, options: StructuralPiCommandOptions) {
      registrations.push({ name, options });
      let disposed = false;

      return {
        dispose() {
          assert.equal(disposed, false);
          disposed = true;
          disposedNames.push(name);
        },
      };
    },
  };

  const firstRegistration = registerZergSwarmExtension(context);
  const duplicateRegistration = registerZergSwarmExtension(context);

  assert.equal(firstRegistration.patchInstalled, true);
  assert.equal(duplicateRegistration.patchInstalled, false);
  assert.deepEqual(registrations.map((registration) => registration.name), ['zerg', 'zerg-swarm', 'swarm']);

  duplicateRegistration.dispose();
  firstRegistration.dispose();
  firstRegistration.dispose();

  assert.deepEqual(disposedNames, ['zerg', 'zerg-swarm', 'swarm']);

  const secondRegistration = registerZergSwarmExtension(context);

  assert.equal(secondRegistration.patchInstalled, true);
  assert.deepEqual(registrations.map((registration) => registration.name), [
    'zerg',
    'zerg-swarm',
    'swarm',
    'zerg',
    'zerg-swarm',
    'swarm',
  ]);

  secondRegistration.dispose();
});

test('renderAgentTree includes nested agents and their tasks', () => {
  const state = createZergState({
    agents: {
      root: { id: 'root', label: 'Root', kind: 'team-leader', status: 'running' },
      child: { id: 'child', label: 'Child', kind: 'subagent', status: 'idle', parentId: 'root' },
      grandchild: { id: 'grandchild', label: 'Grandchild', kind: 'teammate', status: 'blocked', parentId: 'child' },
    },
    tasks: {
      rootTask: { id: 'rootTask', title: 'Root task', status: 'running', ownerAgentId: 'root', updatedAt: '2026-04-30T00:00:00.000Z' },
      childTask: { id: 'childTask', title: 'Child task', status: 'done', ownerAgentId: 'child', updatedAt: '2026-04-30T00:00:00.000Z' },
      grandchildTask: { id: 'grandchildTask', title: 'Grandchild task', status: 'blocked', ownerAgentId: 'grandchild', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('Root [team-leader/running]'));
  assert.ok(tree.includes('Child [subagent/idle]'));
  assert.ok(tree.includes('Grandchild [teammate/blocked]'));
  assert.ok(tree.includes('task Root task [running]'));
  assert.ok(tree.includes('task Child task [done]'));
  assert.ok(tree.includes('task Grandchild task [blocked]'));
});


test('renderAgentTree nests fallback childIds-only agents without duplicate roots', () => {
  const state = createZergState({
    selectedNodeId: 'parent',
    agents: {
      parent: { id: 'parent', label: 'Z Parent', kind: 'team-leader', status: 'running', childIds: ['child', 'child'] },
      child: { id: 'child', label: 'A Child', kind: 'subagent', status: 'idle' },
    },
  });

  const tree = renderAgentTree(state);
  const lines = tree.split('\n');
  const parentLine = lines.findIndex((line) => line.includes('Z Parent [team-leader/running]'));
  const childLine = lines.findIndex((line) => line.includes('A Child [subagent/idle]'));

  assert.ok(parentLine > -1);
  assert.ok(childLine > parentLine);
  assert.ok(lines[childLine]?.startsWith('│  ├─'));
  assert.equal(lines.filter((line) => line.includes('A Child [subagent/idle]')).length, 1);
  assert.ok(lines[parentLine]?.includes('├─▶ Z Parent [team-leader/running]'));
});

test('renderAgentTree shows explicit tree childIds parentId selected orphan missing and duplicate state', () => {
  const state = createZergState({
    selectedNodeId: 'child-ref',
    tree: {
      parent: { id: 'parent', kind: 'team', label: 'Z Parent', status: 'running', childIds: ['child', 'missing', 'child', 'missing'] },
      child: { id: 'child', kind: 'agent', label: 'A Child', status: 'idle', parentId: 'parent', refId: 'child-ref', childIds: [] },
      orphan: { id: 'orphan', kind: 'task', label: 'Orphan task', status: 'blocked', parentId: 'missing-parent', childIds: [] },
    },
  });

  const tree = renderAgentTree(state);
  const lines = tree.split('\n');
  const parentLine = lines.findIndex((line) => line.includes('team Z Parent [running]'));
  const childLines = lines.filter((line) => line.includes('agent A Child [idle]'));
  const missingLines = lines.filter((line) => line.includes('missing-child:missing [missing]'));
  const orphanLine = lines.find((line) => line.includes('task Orphan task [blocked]'));

  assert.ok(parentLine > -1);
  assert.equal(childLines.length, 1);
  assert.ok(childLines[0]?.startsWith('│  ├─▶ agent A Child [idle]'));
  assert.equal(missingLines.length, 1);
  assert.ok(missingLines[0]?.startsWith('│  └─⚠ missing-child:missing [missing]'));
  assert.ok(orphanLine?.includes('orphan-parent:missing-parent'));
});

test('renderAgentTree marks explicit cycles instead of recursing forever', () => {
  const state = createZergState({
    tree: {
      alpha: { id: 'alpha', kind: 'agent', label: 'Alpha', status: 'running', childIds: ['beta'] },
      beta: { id: 'beta', kind: 'agent', label: 'Beta', status: 'idle', childIds: ['alpha'] },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('agent Alpha [running]'));
  assert.ok(tree.includes('agent Beta [idle]'));
  assert.ok(tree.includes('↻ agent Alpha [cycle]'));
});

test('renderAgentTree renders fallback teams members selected marker and team tasks', () => {
  const state = createZergState({
    selectedNodeId: 'worker',
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running', teamId: 'team' },
      worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'idle' },
    },
    teams: {
      team: { id: 'team', label: 'Ops', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['worker', 'worker'], taskIds: ['team-task'] },
    },
    tasks: {
      teamTask: { id: 'team-task', title: 'Coordinate release', status: 'running', teamId: 'team', updatedAt: '2026-04-30T00:00:00.000Z' },
    },
  });

  const tree = renderAgentTree(state);

  assert.ok(tree.includes('team Ops [team/running]'));
  assert.equal(tree.split('\n').filter((line) => line.includes('Worker [subagent/idle]')).length, 1);
  assert.ok(tree.includes('│  ├─▶ Worker [subagent/idle]'));
  assert.ok(tree.includes('│  └─● task Coordinate release [running]'));
});

test('renderAgentTree truncates large render output at four hundred lines', () => {
  const agents = Object.fromEntries(Array.from({ length: 500 }, (_, index) => {
    const id = `agent-${String(index).padStart(3, '0')}`;
    return [id, { id, label: `Agent ${String(index).padStart(3, '0')}`, kind: 'subagent' as const, status: 'idle' as const }];
  }));
  const state = createZergState({ agents });

  const lines = renderAgentTree(state).split('\n');

  assert.equal(lines.length, 400);
  assert.ok(lines.at(-1)?.includes('render output truncated at 400 lines'));
});

test('renderAgentTree does not mutate render state input', () => {
  const state = createZergState({
    selectedNodeId: 'child-ref',
    agents: {
      parent: { id: 'parent', label: 'Parent', kind: 'team-leader', status: 'running', childIds: ['child'] },
      child: { id: 'child', label: 'Child', kind: 'subagent', status: 'idle' },
    },
    teams: {
      team: { id: 'team', label: 'Team', kind: 'team', status: 'running', memberAgentIds: ['parent'] },
    },
    tasks: {
      task: { id: 'task', title: 'Task', status: 'blocked', ownerAgentId: 'child', blockedBy: ['dep'], updatedAt: '2026-04-30T00:00:00.000Z' },
    },
    tree: {
      parentNode: { id: 'parentNode', kind: 'agent', label: 'Parent', status: 'running', refId: 'parent', childIds: ['childNode', 'missing'] },
      childNode: { id: 'childNode', kind: 'agent', label: 'Child', status: 'idle', refId: 'child-ref', parentId: 'parentNode', childIds: [] },
    },
  });
  const before = JSON.stringify(state);

  renderAgentTree(state);

  assert.equal(JSON.stringify(state), before);
});
