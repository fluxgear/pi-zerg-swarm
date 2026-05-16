import type { ZergManagementUiState, ZergState } from '../types.js';
import { fitRawLine, styleText, type UiThemeLike } from './components.js';

export function renderManagementFooter(state: ZergState, uiState: ZergManagementUiState, adapterKind: string, width: number, theme?: UiThemeLike): string[] {
  const mode = `${state.mode.automation}${state.mode.readOnly ? '/read-only' : ''}`;
  const selected = uiState.selectedTargetId ? `${uiState.selectedTargetKind}:${uiState.selectedTargetId}` : 'none';
  const zergControl = state.extensions.zergControl as { controller?: unknown } | undefined;
  const controller = zergControl?.controller === 'pi' || zergControl?.controller === 'zerg' || zergControl?.controller === 'operator'
    ? zergControl.controller
    : state.mode.controller;
  return [
    fitRawLine(`${styleText(theme, 'muted', 'Focus')} ${styleText(theme, 'accent', uiState.focusedPane)}  ${styleText(theme, 'muted', 'Selected')} ${selected}  ${styleText(theme, 'muted', 'Controller')} ${controller}  ${styleText(theme, 'muted', 'Mode')} ${mode}  ${styleText(theme, 'muted', 'Adapter')} ${adapterKind}  ${styleText(theme, 'muted', 'Rev')} ${state.revision}`, width),
    fitRawLine(`${styleText(theme, 'dim', 'Keys')} Tab focus · ↑↓ move · Enter select/send · r read-only · m/a/u mode · c controller · p/d approve/deny · i interrupt · Ctrl+X clear · q/Esc close`, width),
    ...(uiState.statusMessage ? [fitRawLine(`${styleText(theme, 'accent', 'Status')} ${uiState.statusMessage}`, width)] : []),
  ];
}
