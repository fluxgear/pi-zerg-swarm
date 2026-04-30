import { ZERG_COMMAND_INVOCATIONS, type AgentIdentity, type TaskRecord, type ZergState } from './types.js';

export interface RenderOptions {
  width?: number;
}

const DEFAULT_WIDTH = 88;

export function renderStatusLine(state: ZergState, options: RenderOptions = {}): string {
  const agents = Object.values(state.agents);
  const tasks = Object.values(state.tasks);
  const running = agents.filter((agent) => agent.status === 'running').length;
  const blocked = [...agents, ...tasks].filter((item) => item.status === 'blocked' || item.status === 'needs-attention').length;
  return fit(`zerg v0.0.0 scaffold | agents ${agents.length} (${running} running) | tasks ${tasks.length} | blocked ${blocked} | mode ${state.mode.automation}`, options.width);
}

export function renderAgentTree(state: ZergState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const agents = Object.values(state.agents).sort(byLabel);
  const tasks = Object.values(state.tasks).sort(byTitle);

  if (agents.length === 0 && tasks.length === 0) {
    return 'zerg tree: scaffold ready; no agents or tasks are running yet.';
  }

  const agentIds = new Set(agents.map((agent) => agent.id));
  const childrenByParent = new Map<string, AgentIdentity[]>();
  const tasksByOwner = new Map<string, TaskRecord[]>();

  for (const agent of agents) {
    if (!agent.parentId || !agentIds.has(agent.parentId)) {
      continue;
    }
    const siblings = childrenByParent.get(agent.parentId) ?? [];
    siblings.push(agent);
    childrenByParent.set(agent.parentId, siblings);
  }

  for (const task of tasks) {
    if (!task.ownerAgentId || !agentIds.has(task.ownerAgentId)) {
      continue;
    }
    const ownedTasks = tasksByOwner.get(task.ownerAgentId) ?? [];
    ownedTasks.push(task);
    tasksByOwner.set(task.ownerAgentId, ownedTasks);
  }

  const roots = agents.filter((agent) => !agent.parentId || !agentIds.has(agent.parentId));
  const visited = new Set<string>();
  const lines = ['zerg tree'];

  const renderAgent = (agent: AgentIdentity, depth: number): void => {
    if (visited.has(agent.id)) {
      return;
    }

    visited.add(agent.id);
    const indent = '│  '.repeat(depth);
    lines.push(renderAgentLine(agent, width, `${indent}├─`));

    for (const child of childrenByParent.get(agent.id) ?? []) {
      renderAgent(child, depth + 1);
    }

    for (const task of tasksByOwner.get(agent.id) ?? []) {
      lines.push(renderTaskLine(task, width, `${'│  '.repeat(depth + 1)}└─`));
    }
  };

  for (const agent of roots) {
    renderAgent(agent, 0);
  }

  for (const agent of agents) {
    renderAgent(agent, 0);
  }

  for (const task of tasks.filter((candidate) => !candidate.ownerAgentId || !agentIds.has(candidate.ownerAgentId))) {
    lines.push(renderTaskLine(task, width, '└─'));
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderHelp(state: ZergState, options: RenderOptions = {}): string {
  return [
    'pi-zerg-swarm v0.0.0 bootstrap scaffold',
    `Commands: ${ZERG_COMMAND_INVOCATIONS.join(', ')}`,
    renderStatusLine(state, options),
    '',
    'Available now: command registration, structural state, thinking-step parsing, and text rendering.',
    'Not implemented yet: real subagent spawning, team runtime, Pi internal monkey patches, or live TUI overlays.',
  ].join('\n');
}

function renderAgentLine(agent: AgentIdentity, width: number, prefix: string): string {
  return fit(`${prefix} ${agent.label} [${agent.kind}/${agent.status}]`, width);
}

function renderTaskLine(task: TaskRecord, width: number, prefix: string): string {
  const blockers = task.blockedBy?.length ? ` blocked-by:${task.blockedBy.join(',')}` : '';
  return fit(`${prefix} task ${task.title} [${task.status}]${blockers}`, width);
}

function fit(value: string, width = DEFAULT_WIDTH): string {
  if (width <= 3 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, width - 1)}…`;
}

function byLabel(left: AgentIdentity, right: AgentIdentity): number {
  return left.label.localeCompare(right.label);
}

function byTitle(left: TaskRecord, right: TaskRecord): number {
  return left.title.localeCompare(right.title);
}
