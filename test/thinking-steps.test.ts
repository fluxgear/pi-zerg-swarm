import assert from 'node:assert/strict';
import test from 'node:test';

import { createZergCommandHandler, registerZergSwarmExtension, type ZergExtensionRegistration } from '../index.js';
import { installInternalPatch } from '../internal-patch.js';
import { deriveThinkingSteps } from '../parse.js';
import { renderAgentTree } from '../render.js';
import { appendHookEvent, createZergState, createZergStateContainer, getCurrentAgents, getCurrentMode, getCurrentTasks, getCurrentTeams, getCurrentTree, getSelectedTreeNode, readSharedZergState, replaceSharedZergState, resetZergState, selectNode, setMode, snapshotZergState, updateSharedZergState, updateZergState, upsertAgent, upsertTeam, upsertTreeNode } from '../state.js';
import { ZERG_STATE_SCHEMA_VERSION, type HookLifecycleEvent, type StructuralPiCommandOptions, type TeamIdentity, type ZergState, type ZergStateContainer, type ZergTreeNode } from '../types.js';

type AssertAssignable<T extends true> = T;
type ContainerReadReturnsState = AssertAssignable<ReturnType<ZergStateContainer['read']> extends ZergState ? true : false>;
type RegistrationStateExposesSnapshot = AssertAssignable<ZergExtensionRegistration['state'] extends ZergState ? true : false>;

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
  assert.deepEqual(state.mode, { automation: 'manual', interventionEnabled: true });
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

test('installInternalPatch emits through state API compatibility and truncates events', () => {
  const state = createZergState();
  const patch = installInternalPatch({}, state, {
    maxEvents: 2,
    now: () => new Date('2026-04-30T00:00:00.000Z'),
  });

  patch.emit({ type: 'hook', message: 'one' });
  patch.emit({ type: 'hook', message: 'two' });
  patch.emit({ type: 'hook', message: 'three' });

  assert.deepEqual(state.events.map((event) => event.message), ['two', 'three']);
  assert.deepEqual(state.events.map((event) => event.createdAt), ['2026-04-30T00:00:00.000Z', '2026-04-30T00:00:00.000Z']);
  assert.equal(state.revision, 3);

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
    assert.equal(firstSnapshot.events[0]?.message, 'pi-zerg-swarm v0.2.0 command surface registered');

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
    assert.equal(secondSnapshot.events[0]?.message, 'pi-zerg-swarm v0.2.0 command surface registered');
    assert.equal(secondSnapshot.mode.automation, 'manual');

    secondSnapshot.events[0]!.message = 'mutated second snapshot';
    assert.equal(registration.state.events[0]?.message, 'pi-zerg-swarm v0.2.0 command surface registered');
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
      mode: { automation: 'assisted', interventionEnabled: false },
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

test('deriveThinkingSteps parses numbered reasoning steps', () => {
  const steps = deriveThinkingSteps('1. inspect context\n2) implement scaffold');

  assert.deepEqual(steps.map((step) => step.title), ['inspect context', 'implement scaffold']);
  assert.deepEqual(steps.map((step) => step.status), ['unknown', 'unknown']);
  assert.equal(steps[0]?.sourceLine, 1);
});

test('deriveThinkingSteps parses bullets and checkboxes', () => {
  const steps = deriveThinkingSteps('- [ ] write types\n- [x] build passes\n- [-] blocked follow-up');

  assert.deepEqual(steps.map((step) => step.status), ['todo', 'done', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['write types', 'build passes', 'blocked follow-up']);
});

test('deriveThinkingSteps ignores empty and unmarked noise lines', () => {
  const steps = deriveThinkingSteps('\nplain prose\n- useful item\n   \nnotes only');

  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.title, 'useful item');
});

test('deriveThinkingSteps infers status prefixes', () => {
  const steps = deriveThinkingSteps(['done: context loaded', 'running - validate scaffold', 'blocked: waiting on lock']);

  assert.deepEqual(steps.map((step) => step.status), ['done', 'running', 'blocked']);
  assert.deepEqual(steps.map((step) => step.title), ['context loaded', 'validate scaffold', 'waiting on lock']);
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
  assert.ok(notifications[0]?.message.includes('zerg v0.2.0 command surface'));
  assert.equal(notifications[0]?.type, 'info');
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
  assert.equal(handler(' STATUS ').output, statusOutput);
  assert.equal(handler('  /swarm   status ').output, statusOutput);
  assert.equal(handler('zerg status').output, statusOutput);
});

test('createZergCommandHandler preserves multiline steps payload', () => {
  const handler = createZergCommandHandler(createCommandSurfaceState());
  const result = handler('/zerg steps - [ ] first step\n- [x] second step');

  assert.equal(result.output, '1. [todo] first step\n2. [done] second step');
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
