import type { AutomationMode, StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergControlController, ZergManagementTargetKind, ZergManagementUiState, ZergOperatorMessageDeliveryStatus, ZergState } from '../types.js';
import { columns, fitLine } from './components.js';
import { ChatPaneActions, cancelChatDraft, handleChatBackspace, renderChatPane, sendChatDraft, updateChatDraftFromInput } from './chat-pane.js';
import { renderDetailPane } from './detail-pane.js';
import { renderManagementFooter } from './footer.js';
import { SettingsPaneActions, applyPermissionFromSettings, createSettingsPaneState, cycleController, movePendingPermissionCursor, renderSettingsPane } from './settings-pane.js';
import { MANAGEMENT_PANES, createManagementUiState, matchesKey, movePaneFocus, printableInput } from './state.js';
import { activateTreeSelection, buildManagementTreeRows, collapseTreeSelection, createTreePaneState, expandTreeSelection, moveTreeCursor, renderTreePane } from './tree-pane.js';

export interface ZergManagementOverlayActions extends SettingsPaneActions, ChatPaneActions {
  selectTarget(target: { id: string; kind: ZergManagementTargetKind }): string;
  interruptSelected(target: { id: string; kind: ZergManagementTargetKind } | undefined): string;
}

export interface ZergManagementOverlayOptions {
  getSnapshot(): ZergState;
  subscribe(listener: () => void): () => void;
  adapterKind: string;
  actions: ZergManagementOverlayActions;
}

export function openZergManagementOverlay(context: StructuralPiCommandContext, options: ZergManagementOverlayOptions): void {
  context.ui?.custom?.(
    (tui?: StructuralPiTuiHandle, _theme?: unknown, _keybindings?: unknown, done?: () => void) => new ZergManagementOverlayComponent(tui, done, options),
    {
      overlay: true,
      overlayOptions: {
        title: 'zerg config',
        anchor: 'center',
        width: '92%',
        maxHeight: '88%',
        minWidth: 72,
      },
    },
  );
}

export class ZergManagementOverlayComponent implements StructuralPiCustomComponent {
  private readonly uiState: ZergManagementUiState = createManagementUiState();
  private readonly treeState = createTreePaneState();
  private readonly settingsState = createSettingsPaneState();
  private disposed = false;
  private unsubscribe: () => void;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: StructuralPiTuiHandle | undefined,
    private readonly done: (() => void) | undefined,
    private readonly options: ZergManagementOverlayOptions,
  ) {
    this.unsubscribe = options.subscribe(() => this.requestRender());
  }

  render(width = 120, height = 32): string[] {
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
      return this.cachedLines;
    }
    const snapshot = this.options.getSnapshot();
    const safeWidth = Math.max(72, Math.floor(width));
    const safeHeight = Math.max(18, Math.floor(height));
    const footer = renderManagementFooter(snapshot, this.uiState, this.options.adapterKind, safeWidth);
    const header = [fitLine('zerg config — interactive management TUI', safeWidth)];
    const bodyHeight = Math.max(8, safeHeight - header.length - footer.length - 1);
    const topHeight = Math.max(4, Math.floor(bodyHeight * 0.58));
    const bottomHeight = Math.max(4, bodyHeight - topHeight);
    const leftWidth = Math.max(30, Math.floor((safeWidth - 2) * 0.42));
    const rightWidth = safeWidth - 2 - leftWidth;
    const tree = renderTreePane(snapshot, this.uiState, this.treeState, leftWidth, topHeight);
    const detail = renderDetailPane(snapshot, this.uiState, rightWidth, topHeight);
    const settings = renderSettingsPane(snapshot, this.uiState, this.settingsState, this.options.adapterKind, leftWidth, bottomHeight);
    const chat = renderChatPane(snapshot, this.uiState, rightWidth, bottomHeight);
    const body = [
      ...columns(tree, detail, safeWidth),
      ...columns(settings, chat, safeWidth),
    ];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = [...header, ...body, '', ...footer].map((line) => fitLine(line, safeWidth)).slice(0, safeHeight);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, 'escape') || ((data === 'q' || data === 'Q') && (this.uiState.focusedPane !== 'chat' || this.uiState.chatDraft.length === 0))) {
      this.dispose();
      return;
    }
    if (this.uiState.focusedPane === 'chat' && this.isChatTextInput(data)) {
      this.handleChatInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'tab')) {
      movePaneFocus(this.uiState, 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'shift-tab')) {
      movePaneFocus(this.uiState, -1);
      this.requestRender();
      return;
    }

    if (this.handleGlobalAction(data)) {
      this.requestRender();
      return;
    }

    switch (this.uiState.focusedPane) {
      case 'tree':
        this.handleTreeInput(data);
        break;
      case 'settings':
        this.handleSettingsInput(data);
        break;
      case 'chat':
        this.handleChatInput(data);
        break;
      case 'detail':
        if (matchesKey(data, 'enter')) {
          this.uiState.statusMessage = 'detail pane is read-only; use tree/settings/chat actions';
        }
        break;
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.done?.();
  }

  getStateForTests(): ZergManagementUiState {
    return {
      ...this.uiState,
      expandedNodeIds: [...this.uiState.expandedNodeIds],
      messages: this.uiState.messages.map((message) => ({ ...message })),
    };
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.invalidate();
    this.tui?.requestRender?.();
  }

  private isChatTextInput(data: string): boolean {
    return matchesKey(data, 'enter', 'backspace') || data === 'x' || data === 'X' || printableInput(data) !== undefined;
  }

  private handleGlobalAction(data: string): boolean {
    if (data === 'r' || data === 'R') {
      this.uiState.statusMessage = this.options.actions.toggleReadOnly();
      return true;
    }
    if (data === 'm' || data === 'M') {
      this.uiState.statusMessage = this.options.actions.setAutomation('manual');
      return true;
    }
    if (data === 'a' || data === 'A') {
      this.uiState.statusMessage = this.options.actions.setAutomation('assisted');
      return true;
    }
    if (data === 'u' || data === 'U') {
      this.uiState.statusMessage = this.options.actions.setAutomation('automatic');
      return true;
    }
    if (data === 'c' || data === 'C') {
      this.uiState.statusMessage = cycleController(this.options.getSnapshot(), this.options.actions);
      return true;
    }
    if (data === 'i' || data === 'I') {
      const selected = this.uiState.selectedTargetId && this.uiState.selectedTargetKind ? { id: this.uiState.selectedTargetId, kind: this.uiState.selectedTargetKind } : undefined;
      this.uiState.statusMessage = this.options.actions.interruptSelected(selected);
      return true;
    }
    if (data === 'p' || data === 'P') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'approve', this.options.actions);
      return true;
    }
    if (data === 'd' || data === 'D') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'deny', this.options.actions);
      return true;
    }
    return false;
  }

  private handleTreeInput(data: string): void {
    const rows = buildManagementTreeRows(this.options.getSnapshot(), this.uiState);
    if (matchesKey(data, 'up')) {
      moveTreeCursor(this.treeState, rows, -1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'down')) {
      moveTreeCursor(this.treeState, rows, 1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'left')) {
      collapseTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node collapsed';
    } else if (matchesKey(data, 'right')) {
      expandTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node expanded';
    } else if (matchesKey(data, 'enter')) {
      const row = activateTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = row?.targetId && row.targetKind
        ? this.options.actions.selectTarget({ id: row.targetId, kind: row.targetKind })
        : 'tree group toggled';
    }
  }

  private handleSettingsInput(data: string): void {
    if (matchesKey(data, 'up')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), -1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'down')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), 1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'enter')) {
      this.uiState.statusMessage = 'settings focused: use r/m/a/u/c/p/d action keys';
    }
  }

  private handleChatInput(data: string): void {
    if (matchesKey(data, 'enter')) {
      this.uiState.statusMessage = sendChatDraft(this.options.getSnapshot(), this.uiState, this.options.actions);
      return;
    }
    if (data === 'x' || data === 'X') {
      this.uiState.statusMessage = cancelChatDraft(this.uiState);
      return;
    }
    if (matchesKey(data, 'backspace')) {
      handleChatBackspace(this.uiState);
      return;
    }
    const printable = printableInput(data);
    if (printable) {
      updateChatDraftFromInput(this.uiState, printable);
      this.uiState.statusMessage = 'editing chat draft';
    }
  }
}

export function paneOrderForTests(): readonly string[] {
  return MANAGEMENT_PANES;
}
