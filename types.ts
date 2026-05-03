export const ZERG_COMMANDS = ['zerg', 'zerg-swarm', 'swarm'] as const;
export type ZergCommandName = (typeof ZERG_COMMANDS)[number];
export const ZERG_COMMAND_INVOCATIONS = ['/zerg', '/zerg-swarm', '/swarm'] as const;
export type ZergCommandInvocation = (typeof ZERG_COMMAND_INVOCATIONS)[number];
export type AgentKind = 'subagent' | 'teammate' | 'team-leader';
export type TeamKind = 'team' | 'squad' | 'worktree';
export type AgentStatus = 'idle' | 'running' | 'blocked' | 'needs-attention' | 'done' | 'failed';
export type TaskStatus = AgentStatus;
export type AutomationMode = 'manual' | 'assisted' | 'automatic';
export type ZergMode = AutomationMode;
export type ZergRuntimeTransitionAction = 'create' | 'start' | 'progress' | 'stop' | 'fail' | 'reset';
export type ZergRuntimeHealth = 'unknown' | 'healthy' | 'degraded' | 'blocked' | 'failed' | 'stopped';
export type ZergRuntimeEntity = 'agent' | 'team';
export type ThinkingStepStatus = 'todo' | 'running' | 'blocked' | 'done' | 'failed' | 'unknown';
export type ZergContextKind = 'command' | 'extension' | 'team' | 'agent' | 'task';
export type ZergTreeNodeKind = 'agent' | 'task' | 'team';
export type ZergLifecycleState = 'initializing' | 'ready' | 'resetting' | 'disposed';
export const ZERG_STATE_SCHEMA_VERSION = '0.2.0' as const;
export type ZergStateSchemaVersion = typeof ZERG_STATE_SCHEMA_VERSION;

export interface ZergExtensionFields {
  [key: string]: unknown;
}

export interface ZergContext {
  id: string;
  kind: ZergContextKind;
  title?: string;
  source?: string;
  metadata?: ZergExtensionFields;
}

export interface ZergRuntimeModeContext {
  automation: AutomationMode;
  interventionEnabled: boolean;
  contextId?: string;
}

export interface ZergRuntimeState {
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastActivityAt?: string;
  lastActivity?: string;
  lastActivitySequence?: number;
  lastActivityRevision?: number;
  health: ZergRuntimeHealth;
  mode: ZergRuntimeModeContext;
}

interface ZergRuntimeTransitionBase {
  action: ZergRuntimeTransitionAction;
  id: string;
  label?: string;
  status?: AgentStatus;
  health?: ZergRuntimeHealth;
  activity?: string;
  at?: string;
  mode?: Partial<ZergRuntimeModeContext>;
  contextId?: string;
}

export interface ZergAgentRuntimeTransition extends ZergRuntimeTransitionBase {
  entity: 'agent';
  kind?: AgentKind;
  parentId?: string;
  childIds?: string[];
  teamId?: string;
  leaderAgentId?: never;
  memberAgentIds?: never;
  parentTeamId?: never;
  taskIds?: never;
}

export interface ZergTeamRuntimeTransition extends ZergRuntimeTransitionBase {
  entity: 'team';
  kind?: TeamKind;
  leaderAgentId?: string;
  memberAgentIds?: string[];
  parentTeamId?: string;
  taskIds?: string[];
  parentId?: never;
  childIds?: never;
  teamId?: never;
}

export type ZergRuntimeTransition = ZergAgentRuntimeTransition | ZergTeamRuntimeTransition;

export interface AgentIdentity {
  id: string;
  label: string;
  kind: AgentKind;
  status: AgentStatus;
  parentId?: string;
  teamId?: string;
  childIds?: string[];
  contextId?: string;
  runtime?: ZergRuntimeState;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface TeamIdentity {
  id: string;
  label: string;
  kind: TeamKind;
  status: AgentStatus;
  leaderAgentId?: string;
  memberAgentIds: string[];
  parentTeamId?: string;
  taskIds?: string[];
  runtime?: ZergRuntimeState;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  ownerAgentId?: string;
  teamId?: string;
  parentId?: string;
  blockedBy?: string[];
  contextId?: string;
  updatedAt: string;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface HookLifecycleEvent {
  id: string;
  type: 'agent' | 'task' | 'team' | 'tree' | 'hook' | 'permission' | 'mode' | 'state';
  message: string;
  status?: AgentStatus | TaskStatus | ThinkingStepStatus;
  action?: ZergRuntimeTransitionAction;
  health?: ZergRuntimeHealth;
  mode?: ZergRuntimeModeContext;
  sequence?: number;
  agentId?: string;
  taskId?: string;
  teamId?: string;
  treeNodeId?: string;
  revision?: number;
  createdAt: string;
}

export interface PermissionModeState {
  automation: AutomationMode;
  interventionEnabled: boolean;
  contextId?: string;
}

export interface ZergTreeNode {
  id: string;
  kind: ZergTreeNodeKind;
  label: string;
  status?: AgentStatus | TaskStatus;
  refId?: string;
  parentId?: string;
  childIds: string[];
  ownerAgentId?: string;
  teamId?: string;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface ZergStateMetadata {
  createdAt: string;
  updatedAt: string;
  resetCount: number;
  source?: string;
  labels?: Record<string, string>;
  extensions?: ZergExtensionFields;
}

export interface ZergState {
  schemaVersion: ZergStateSchemaVersion;
  lifecycle: ZergLifecycleState;
  revision: number;
  metadata: ZergStateMetadata;
  agents: Record<string, AgentIdentity>;
  tasks: Record<string, TaskRecord>;
  teams: Record<string, TeamIdentity>;
  tree: Record<string, ZergTreeNode>;
  events: HookLifecycleEvent[];
  selectedNodeId?: string;
  mode: PermissionModeState;
  context?: ZergContext;
  extensions: ZergExtensionFields;
}

export interface ZergStateUpdateOptions {
  lifecycle?: ZergLifecycleState;
  updatedAt?: string;
  preserveRevision?: boolean;
}

export type ZergStatePatch = Partial<ZergState> | ((state: ZergState) => Partial<ZergState> | ZergState);

export interface ZergStateContainer {
  read(): ZergState;
  snapshot(): ZergState;
  replace(nextState?: Partial<ZergState>): ZergState;
  update(patch: ZergStatePatch, options?: ZergStateUpdateOptions): ZergState;
}

export interface ThinkingStep {
  id: string;
  title: string;
  status: ThinkingStepStatus;
  sourceLine: number;
}

export type ZergThinkingStep = ThinkingStep;

export interface ZergThinkingContext {
  mode: ZergMode;
  steps: ThinkingStep[];
  context?: ZergContext;
}

export interface ZergCommandResult {
  ok: boolean;
  output: string;
}

export interface ZergInternalPatchController {
  installed: boolean;
  emit(event: Omit<HookLifecycleEvent, 'id' | 'createdAt'> & Partial<Pick<HookLifecycleEvent, 'id' | 'createdAt'>>): HookLifecycleEvent;
  dispose(): void;
}

export type ZergCommandHandler = (input?: string) => ZergCommandResult | string | Promise<ZergCommandResult | string>;

export interface StructuralPiCommandContext {
  hasUI?: boolean;
  ui?: {
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

export type ZergPiCommandHandler = (args: string, ctx: StructuralPiCommandContext) => Promise<void> | void;

export interface StructuralPiCommandOptions {
  description?: string;
  handler: ZergPiCommandHandler;
}

export interface StructuralPiCommand extends StructuralPiCommandOptions {
  name: ZergCommandName;
}

export interface StructuralPiExtensionContext {
  registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  events?: {
    emit?(eventName: unknown, ...args: unknown[]): unknown;
    on?(eventName: unknown, handler: (...args: unknown[]) => unknown): unknown;
  };
  commands?: {
    register?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
  commandRegistrar?: {
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
}
