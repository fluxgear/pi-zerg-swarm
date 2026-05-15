import type { ZergManagementPaneId, ZergManagementTargetKind, ZergManagementUiState, ZergOperatorMessageDeliveryStatus, ZergOperatorMessageRecord } from '../types.js';

export const MANAGEMENT_PANES: ZergManagementPaneId[] = ['tree', 'detail', 'settings', 'chat'];

export function createManagementUiState(): ZergManagementUiState {
  return {
    focusedPane: 'tree',
    expandedNodeIds: ['root:teams', 'root:agents', 'root:tasks'],
    chatDraft: '',
    messages: [],
  };
}

export function movePaneFocus(state: ZergManagementUiState, direction: 1 | -1): void {
  const current = MANAGEMENT_PANES.indexOf(state.focusedPane);
  const next = (current + direction + MANAGEMENT_PANES.length) % MANAGEMENT_PANES.length;
  state.focusedPane = MANAGEMENT_PANES[next]!;
}

export function setSelectedTarget(state: ZergManagementUiState, targetId: string | undefined, targetKind: ZergManagementTargetKind | undefined): void {
  state.selectedTargetId = targetId;
  state.selectedTargetKind = targetKind;
}

export function isExpanded(state: ZergManagementUiState, nodeId: string): boolean {
  return state.expandedNodeIds.includes(nodeId);
}

export function setExpanded(state: ZergManagementUiState, nodeId: string, expanded: boolean): void {
  if (expanded) {
    if (!state.expandedNodeIds.includes(nodeId)) {
      state.expandedNodeIds = [...state.expandedNodeIds, nodeId].sort();
    }
    return;
  }
  state.expandedNodeIds = state.expandedNodeIds.filter((candidate) => candidate !== nodeId);
}

export function toggleExpanded(state: ZergManagementUiState, nodeId: string): void {
  setExpanded(state, nodeId, !isExpanded(state, nodeId));
}

export function appendDraftText(state: ZergManagementUiState, input: string): void {
  state.chatDraft = `${state.chatDraft}${input}`.slice(0, 500);
}

export function backspaceDraft(state: ZergManagementUiState): void {
  state.chatDraft = state.chatDraft.slice(0, -1);
}

export function clearDraft(state: ZergManagementUiState): void {
  state.chatDraft = '';
}

export function addOperatorMessage(
  state: ZergManagementUiState,
  input: {
    targetId: string;
    targetKind: ZergManagementTargetKind;
    routedTargetId?: string;
    body: string;
    status: ZergOperatorMessageDeliveryStatus;
    statusDetail: string;
    now: Date;
  },
): ZergOperatorMessageRecord {
  const message: ZergOperatorMessageRecord = {
    id: `ui-msg-${input.now.getTime().toString(36)}-${state.messages.length + 1}`,
    targetId: input.targetId,
    targetKind: input.targetKind,
    routedTargetId: input.routedTargetId,
    body: input.body,
    status: input.status,
    statusDetail: input.statusDetail,
    createdAt: input.now.toISOString(),
  };
  state.messages = [...state.messages, message].slice(-50);
  return message;
}

export function matchesKey(data: string, ...keys: string[]): boolean {
  return keys.some((key) => {
    if (data === key) {
      return true;
    }
    if (key === 'up') return data === '\u001b[A';
    if (key === 'down') return data === '\u001b[B';
    if (key === 'right') return data === '\u001b[C';
    if (key === 'left') return data === '\u001b[D';
    if (key === 'escape') return data === '\u001b';
    if (key === 'tab') return data === '\t';
    if (key === 'shift-tab') return data === '\u001b[Z';
    if (key === 'enter') return data === '\r' || data === '\n';
    if (key === 'backspace') return data === '\u007f' || data === '\b';
    return false;
  });
}

export function printableInput(data: string): string | undefined {
  if (data.length === 1 && data >= ' ' && data !== '\u007f') {
    return data;
  }
  return undefined;
}
