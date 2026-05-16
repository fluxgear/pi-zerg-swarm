import assert from 'node:assert/strict';
import test from 'node:test';

import { createZergState, createZergStateContainer } from '../../state.js';
import type { StructuralPiCommandContext, ZergManagementTargetKind } from '../../types.js';
import { openZergManagementOverlay, type ZergManagementOverlayActions } from '../../ui/management-overlay.js';

test('M9 management overlay uses ctx.ui.custom component path and disposes subscription exactly once', () => {
  const container = createZergStateContainer();
  let requestRenderCount = 0;
  let doneCount = 0;
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void; invalidate(): void } | undefined;
  let optionsSeen: Record<string, unknown> | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  const context: StructuralPiCommandContext = {
    ui: {
      custom(factory, options) {
        optionsSeen = options as Record<string, unknown>;
        assert.equal(optionsSeen.overlay, true);
        component = (factory as (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: () => void) => typeof component)(
          { requestRender: () => { requestRenderCount += 1; } },
          undefined,
          undefined,
          () => { doneCount += 1; },
        );
        return { close: () => component?.dispose?.() };
      },
    },
  };

  openZergManagementOverlay(context, {
    getSnapshot: () => container.snapshot(),
    subscribe: (listener) => container.subscribe?.(listener) ?? (() => undefined),
    adapterKind: 'unavailable',
    actions,
  });

  assert.equal((optionsSeen?.overlayOptions as { title?: string } | undefined)?.title, 'zerg config');
  const initialRender = component?.render(100, 24).join('\n') ?? '';
  assert.ok(initialRender.includes('zerg config'));
  assert.ok(initialRender.includes('Use three steps'));
  assert.ok(initialRender.includes('1 Select'));
  assert.ok(initialRender.includes('2 Settings'));
  assert.ok(initialRender.includes('3 Message'));
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:01.000Z' } });
  assert.equal(requestRenderCount, 1);
  component?.handleInput?.('q');
  component?.dispose?.();
  assert.equal(doneCount, 1);
  const afterDispose = requestRenderCount;
  container.update({ metadata: { ...container.snapshot().metadata, updatedAt: '2026-05-01T00:00:02.000Z' } });
  assert.equal(requestRenderCount, afterDispose);
});

test('M9 management overlay preserves existing selected target and shows zerg control controller', async () => {
  const container = createZergStateContainer(createZergState({
    selectedNodeId: 'node-b',
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'running' },
    },
    tree: {
      'node-b': { id: 'node-b', label: 'Beta', kind: 'agent', refId: 'b', childIds: [] },
    },
    extensions: {
      zergControl: { controller: 'pi' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };

  await openZergManagementOverlay({
    ui: {
      custom(factory) {
        component = (factory as () => typeof component)();
        return undefined;
      },
    },
  }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Controller pi'));
  assert.ok(rendered.includes('Selected: agent b'));
  assert.ok(rendered.includes('agent: Beta (b)'));
  assert.equal(rendered.includes('Selected: agent a'), false);
  component?.dispose?.();
});

test('M9 management overlay keeps tree navigation usable after default selection render', async () => {
  const container = createZergStateContainer(createZergState({
    agents: {
      a: { id: 'a', label: 'Alpha', kind: 'subagent', status: 'idle' },
      b: { id: 'b', label: 'Beta', kind: 'subagent', status: 'idle' },
    },
  }));
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: (target: { id: string; kind: ZergManagementTargetKind }) => `selected ${target.kind} ${target.id}`,
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'transport unavailable' }),
  };
  await openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.render(110, 24);
  component?.handleInput?.('down');
  component?.render(110, 24);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 24).join('\n') ?? '';
  assert.ok(rendered.includes('Selected: agent b'));
  component?.dispose?.();
});

test('M9 management overlay routes focus and chat keys through focused pane', () => {
  const container = createZergStateContainer({
    agents: { worker: { id: 'worker', label: 'Worker', kind: 'subagent', status: 'running' } },
  });
  let component: { render(width?: number, height?: number): string[]; handleInput?(data: string): void; dispose?(): void } | undefined;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    toggleReadOnly: () => 'readonly toggled',
    setAutomation: (mode) => `mode ${mode}`,
    setController: (controller) => `controller ${controller}`,
    approvePermission: (requestId) => `approved ${requestId}`,
    denyPermission: (requestId) => `denied ${requestId}`,
    selectTarget: () => 'selected target',
    interruptSelected: () => 'interrupt unavailable',
    sendOperatorMessage: (_target, body) => ({ status: 'intervention-recorded', statusDetail: `intervention recorded: ${body}`, routedTargetId: 'worker' }),
  };
  openZergManagementOverlay({ ui: { custom(factory) { component = (factory as () => typeof component)(); return undefined; } } }, {
    getSnapshot: () => container.snapshot(),
    subscribe: () => () => undefined,
    adapterKind: 'fake',
    actions,
  });

  component?.handleInput?.('down');
  component?.handleInput?.('down');
  component?.handleInput?.('enter');
  component?.handleInput?.('tab');
  component?.handleInput?.('tab');
  for (const char of 'remote rapid quorum') component?.handleInput?.(char);
  component?.handleInput?.('enter');
  const rendered = component?.render(110, 30).join('\n') ?? '';
  assert.ok(rendered.includes('intervention-recorded'));
  assert.ok(rendered.includes('remote rapid quorum'));
  assert.ok((component?.render(110) ?? []).length <= 32);
});
