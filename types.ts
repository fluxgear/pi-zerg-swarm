export const ZERG_COMMANDS = ['zerg', 'zerg-swarm', 'swarm'] as const;
export type ZergCommandName = (typeof ZERG_COMMANDS)[number];
export const ZERG_COMMAND_INVOCATIONS = ['/zerg', '/zerg-swarm', '/swarm'] as const;
export type ZergCommandInvocation = (typeof ZERG_COMMAND_INVOCATIONS)[number];
export type AgentKind = 'subagent' | 'teammate' | 'team-leader';
export type AgentStatus = 'idle' | 'running' | 'blocked' | 'needs-attention' | 'done' | 'failed';
export type TaskStatus = AgentStatus;
export type AutomationMode = 'manual' | 'assisted' | 'automatic';
export type ThinkingStepStatus = 'todo' | 'running' | 'blocked' | 'done' | 'failed' | 'unknown';

export interface AgentIdentity {
  id: string;
  label: string;
  kind: AgentKind;
  status: AgentStatus;
  parentId?: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  ownerAgentId?: string;
  blockedBy?: string[];
  updatedAt: string;
}

export interface HookLifecycleEvent {
  id: string;
  type: 'agent' | 'task' | 'hook' | 'permission' | 'mode';
  message: string;
  status?: AgentStatus | TaskStatus | ThinkingStepStatus;
  agentId?: string;
  taskId?: string;
  createdAt: string;
}

export interface PermissionModeState {
  automation: AutomationMode;
  interventionEnabled: boolean;
}

export interface ZergState {
  agents: Record<string, AgentIdentity>;
  tasks: Record<string, TaskRecord>;
  events: HookLifecycleEvent[];
  selectedNodeId?: string;
  mode: PermissionModeState;
}

export interface ThinkingStep {
  id: string;
  title: string;
  status: ThinkingStepStatus;
  sourceLine: number;
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
  commands?: {
    register?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
  commandRegistrar?: {
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
}
