import type { ZergManagementUiState, ZergState } from '../types.js';
import { fitLine } from './components.js';

export function renderManagementFooter(state: ZergState, uiState: ZergManagementUiState, adapterKind: string, width: number): string[] {
  const mode = `${state.mode.automation}${state.mode.readOnly ? '/read-only' : ''}`;
  const selected = uiState.selectedTargetId ? `${uiState.selectedTargetKind}:${uiState.selectedTargetId}` : 'none';
  const zergControl = state.extensions.zergControl as { controller?: unknown } | undefined;
  const controller = zergControl?.controller === 'pi' || zergControl?.controller === 'zerg' || zergControl?.controller === 'operator'
    ? zergControl.controller
    : state.mode.controller;
  return [
    fitLine(`focus ${uiState.focusedPane} | selected ${selected} | controller ${controller} | mode ${mode} | adapter ${adapterKind} | rev ${state.revision} | updated ${state.metadata.updatedAt}`, width),
    fitLine('keys: tab/shift-tab focus | ↑↓ navigate | ←/→ tree | enter select/send | r read-only | m/a/u modes | c controller | p/d permissions | i interrupt | x cancel chat | q/esc close', width),
    ...(uiState.statusMessage ? [fitLine(`status: ${uiState.statusMessage}`, width)] : []),
  ];
}
