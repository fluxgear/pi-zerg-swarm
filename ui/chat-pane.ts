import type { ZergManagementTargetKind, ZergManagementUiState, ZergOperatorMessageDeliveryStatus, ZergState } from '../types.js';
import { renderPane } from './components.js';
import { addOperatorMessage, backspaceDraft, clearDraft } from './state.js';
import { resolveSelectedTarget } from './detail-pane.js';

export interface ChatSendResult {
  status: ZergOperatorMessageDeliveryStatus;
  statusDetail: string;
  routedTargetId?: string;
}

export interface ChatPaneActions {
  now(): Date;
  sendOperatorMessage(target: { id: string; kind: ZergManagementTargetKind }, body: string): ChatSendResult;
}

export function updateChatDraftFromInput(uiState: ZergManagementUiState, input: string): void {
  uiState.chatDraft = `${uiState.chatDraft}${input}`.slice(0, 500);
}

export function cancelChatDraft(uiState: ZergManagementUiState): string {
  clearDraft(uiState);
  return 'chat draft cancelled';
}

export function sendChatDraft(state: ZergState, uiState: ZergManagementUiState, actions: ChatPaneActions): string {
  const body = uiState.chatDraft.trim();
  if (!body) {
    return 'chat draft is empty';
  }
  const target = resolveSelectedTarget(state, uiState);
  if (!target) {
    addOperatorMessage(uiState, {
      targetId: 'none',
      targetKind: 'agent',
      body,
      status: 'queued-local',
      statusDetail: 'No selected target; message retained locally and not delivered.',
      now: actions.now(),
    });
    clearDraft(uiState);
    return 'no selected target; message retained locally';
  }
  const result = actions.sendOperatorMessage(target, body);
  addOperatorMessage(uiState, {
    targetId: target.id,
    targetKind: target.kind,
    routedTargetId: result.routedTargetId,
    body,
    status: result.status,
    statusDetail: result.statusDetail,
    now: actions.now(),
  });
  clearDraft(uiState);
  return result.statusDetail;
}

export function handleChatBackspace(uiState: ZergManagementUiState): void {
  backspaceDraft(uiState);
}

export function renderChatPane(state: ZergState, uiState: ZergManagementUiState, width: number, height: number, composerLines?: readonly string[]): string[] {
  const selected = resolveSelectedTarget(state, uiState);
  const targetLabel = selected ? `${selected.kind} ${selected.id}` : 'none';
  const lines = [
    `target: ${targetLabel}`,
    'delivery: intervention path only; never shown as delivered chat without verified transport',
    '',
  ];
  const thread = uiState.messages.filter((message) => !selected || message.targetId === selected.id || message.routedTargetId === selected.id).slice(-Math.max(1, height - 9));
  if (thread.length === 0) {
    lines.push('thread: no local operator messages for target');
  } else {
    for (const message of thread) {
      const routed = message.routedTargetId ? ` -> ${message.routedTargetId}` : '';
      lines.push(`${message.createdAt} ${message.targetKind}:${message.targetId}${routed}`);
      lines.push(`  [${message.status}] ${message.body}`);
      lines.push(`  ${message.statusDetail}`);
    }
  }
  lines.push('');
  if (composerLines && composerLines.length > 0) {
    lines.push(...composerLines.map((line) => `draft: ${line}`));
  } else {
    lines.push(`draft: ${uiState.chatDraft || '(empty)'}`);
  }
  lines.push('type in chat focus | enter send | ctrl+x cancel | esc close');
  return renderPane(lines, { title: 'Conversation / operator message', focused: uiState.focusedPane === 'chat', width, height });
}
