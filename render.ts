import { ZERG_COMMAND_INVOCATIONS, type AgentIdentity, type TaskRecord, type TeamIdentity, type ZergState, type ZergTreeNode } from './types.js';

export interface RenderOptions {
  width?: number;
}

const DEFAULT_WIDTH = 88;
const MAX_RENDER_LINES = 400;

export function renderStatusLine(state: ZergState, options: RenderOptions = {}): string {
  const snapshot = state ?? ({} as ZergState);
  const agents = recordValues(snapshot.agents);
  const tasks = recordValues(snapshot.tasks);
  const running = agents.filter((agent) => agent.status === 'running').length;
  const blocked = [...agents, ...tasks].filter((item) => item.status === 'blocked' || item.status === 'needs-attention').length;
  return fit(`zerg v0.5.0 command surface | agents ${agents.length} (${running} running) | tasks ${tasks.length} | blocked ${blocked} | mode ${snapshot.mode?.automation ?? 'manual'}`, options.width);
}

export function renderAgentTree(state: ZergState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const snapshot = state ?? ({} as ZergState);
  const agents = recordValues(snapshot.agents).sort(byLabel);
  const tasks = recordValues(snapshot.tasks).sort(byTitle);
  const teams = recordValues(snapshot.teams).sort(byLabel);
  const treeNodes = recordValues(snapshot.tree).sort(byLabel);
  const selectedNodeId = snapshot.selectedNodeId;

  if (treeNodes.length > 0) {
    return renderExplicitTree(treeNodes, width, selectedNodeId);
  }

  if (agents.length === 0 && tasks.length === 0 && teams.length === 0) {
    return fit('zerg tree: scaffold ready; no agents, teams, or tasks are running yet.', width);
  }

  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const agentIds = new Set(agentById.keys());
  const teamIds = new Set(teamById.keys());
  const childrenByParent = new Map<string, AgentIdentity[]>();
  const tasksByOwner = new Map<string, TaskRecord[]>();
  const teamsByParent = new Map<string, TeamIdentity[]>();
  const agentsByTeam = new Map<string, AgentIdentity[]>();
  const tasksByTeam = new Map<string, TaskRecord[]>();
  const renderedTeams = new Set<string>();
  const renderedAgents = new Set<string>();
  const renderedTasks = new Set<string>();
  const lines = ['zerg tree'];

  for (const agent of agents) {
    if (agent.parentId && agentIds.has(agent.parentId)) {
      addToMap(childrenByParent, agent.parentId, agent);
    }

    if (agent.teamId && teamIds.has(agent.teamId)) {
      addToMap(agentsByTeam, agent.teamId, agent);
    }
  }

  for (const task of tasks) {
    if (task.ownerAgentId && agentIds.has(task.ownerAgentId)) {
      addToMap(tasksByOwner, task.ownerAgentId, task);
    }

    if (task.teamId && teamIds.has(task.teamId)) {
      addToMap(tasksByTeam, task.teamId, task);
    }
  }

  for (const team of teams) {
    if (team.parentTeamId && teamIds.has(team.parentTeamId)) {
      addToMap(teamsByParent, team.parentTeamId, team);
    }
  }

  const renderAgent = (agent: AgentIdentity, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(agent.id)) {
      pushRenderLine(lines, renderCycleLine('agent', agent.label, width, `${indent}└─`), width);
      return;
    }

    if (renderedAgents.has(agent.id)) {
      return;
    }

    if (!pushRenderLine(lines, renderAgentLine(agent, width, `${indent}├─`, selectedNodeId), width)) {
      return;
    }

    renderedAgents.add(agent.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(agent.id);

    for (const child of (childrenByParent.get(agent.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderAgent(child, depth + 1, nextAncestry);
    }

    for (const task of (tasksByOwner.get(agent.id) ?? []).sort(byTitle)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (renderedTasks.has(task.id)) {
        continue;
      }
      if (!pushRenderLine(lines, renderTaskLine(task, width, `${'│  '.repeat(depth + 1)}└─`, selectedNodeId), width)) {
        return;
      }
      renderedTasks.add(task.id);
    }
  };

  const renderTeam = (team: TeamIdentity, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(team.id)) {
      pushRenderLine(lines, renderCycleLine('team', team.label, width, `${indent}└─`), width);
      return;
    }

    if (renderedTeams.has(team.id)) {
      return;
    }

    if (!pushRenderLine(lines, renderTeamLine(team, width, `${indent}├─`, selectedNodeId), width)) {
      return;
    }

    renderedTeams.add(team.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(team.id);

    for (const childTeam of (teamsByParent.get(team.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderTeam(childTeam, depth + 1, nextAncestry);
    }

    for (const agent of collectTeamAgents(team, agentById, agentsByTeam).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderAgent(agent, depth + 1);
    }

    for (const task of collectTeamTasks(team, taskById, tasksByTeam).sort(byTitle)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (renderedTasks.has(task.id)) {
        continue;
      }
      if (!pushRenderLine(lines, renderTaskLine(task, width, `${'│  '.repeat(depth + 1)}└─`, selectedNodeId), width)) {
        return;
      }
      renderedTasks.add(task.id);
    }
  };

  for (const team of teams.filter((candidate) => !candidate.parentTeamId || !teamIds.has(candidate.parentTeamId))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderTeam(team, 0);
  }

  for (const team of teams) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderTeam(team, 0);
  }

  for (const agent of agents.filter((candidate) => !candidate.parentId || !agentIds.has(candidate.parentId))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderAgent(agent, 0);
  }

  for (const agent of agents) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderAgent(agent, 0);
  }

  for (const task of tasks.filter((candidate) => !renderedTasks.has(candidate.id) && (!candidate.ownerAgentId || !agentIds.has(candidate.ownerAgentId)))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    if (!pushRenderLine(lines, renderTaskLine(task, width, '└─', selectedNodeId), width)) {
      break;
    }
    renderedTasks.add(task.id);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

export function renderHelp(state: ZergState, options: RenderOptions = {}): string {
  return [
    'pi-zerg-swarm v0.5.0 command-surface scaffold',
    `Commands: ${ZERG_COMMAND_INVOCATIONS.join(', ')}`,
    renderStatusLine(state, options),
    '',
    'Available now: slash-free Pi command registration, aliases, scaffold status/tree output, thinking-step parsing, text rendering, and safe Pi event-bus emit/subscription observation.',
    'Not implemented yet: real subagent spawning, team runtime, task queues, live TUI overlays, or manual/automation intervention controls.',
  ].join('\n');
}

function renderAgentLine(agent: AgentIdentity, width: number, prefix: string, selectedNodeId?: string): string {
  const kind = agent.kind ?? 'agent';
  const status = agent.status ?? 'unknown';
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, agent.id))} ${safeLabel(agent.label, agent.id)} [${kind}/${status}]`, width);
}

function renderTeamLine(team: TeamIdentity, width: number, prefix: string, selectedNodeId?: string): string {
  const kind = team.kind ?? 'team';
  const status = team.status ?? 'unknown';
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, team.id))} team ${safeLabel(team.label, team.id)} [${kind}/${status}]`, width);
}

function renderTaskLine(task: TaskRecord, width: number, prefix: string, selectedNodeId?: string): string {
  const status = task.status ?? 'unknown';
  const blockers = task.blockedBy?.length ? ` blocked-by:${task.blockedBy.join(',')}` : '';
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, task.id))} task ${safeLabel(task.title, task.id)} [${status}]${blockers}`, width);
}

function renderExplicitTree(nodes: ZergTreeNode[], width: number, selectedNodeId?: string): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, ZergTreeNode[]>();
  const referenced = new Set<string>();
  const visited = new Set<string>();
  const lines = ['zerg tree'];

  for (const node of nodes) {
    for (const childId of uniqueStrings(node.childIds)) {
      const child = nodeById.get(childId);
      if (!child) {
        continue;
      }
      addToMap(childrenByParent, node.id, child);
      referenced.add(child.id);
    }
  }

  for (const node of nodes) {
    if (node.parentId && nodeById.has(node.parentId)) {
      addToMap(childrenByParent, node.parentId, node);
      referenced.add(node.id);
    }
  }

  const renderNode = (node: ZergTreeNode, depth: number, ancestry = new Set<string>()): void => {
    const indent = '│  '.repeat(depth);

    if (ancestry.has(node.id)) {
      pushRenderLine(lines, renderCycleLine(node.kind, node.label, width, `${indent}└─`), width);
      return;
    }

    if (visited.has(node.id)) {
      return;
    }

    if (!pushRenderLine(lines, renderTreeNodeLine(node, width, `${indent}├─`, selectedNodeId, node.parentId && !nodeById.has(node.parentId) ? node.parentId : undefined), width)) {
      return;
    }

    visited.add(node.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(node.id);

    for (const child of uniqueById(childrenByParent.get(node.id) ?? []).sort(byLabel)) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      renderNode(child, depth + 1, nextAncestry);
    }
  };

  for (const node of nodes.filter((candidate) => (!candidate.parentId || !nodeById.has(candidate.parentId)) && !referenced.has(candidate.id))) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderNode(node, 0);
  }

  for (const node of nodes) {
    if (isRenderLineLimitReached(lines)) {
      break;
    }
    renderNode(node, 0);
  }

  return lines.map((line) => fit(line, width)).join('\n');
}

function renderTreeNodeLine(node: ZergTreeNode, width: number, prefix: string, selectedNodeId?: string, orphanParent?: string): string {
  const status = node.status ?? 'unknown';
  const marker = statusMarker(status, isSelected(selectedNodeId, node.id, node.refId));
  const orphan = orphanParent ? ` orphan-parent:${orphanParent}` : '';
  return fit(`${prefix}${marker} ${node.kind} ${safeLabel(node.label, node.id)} [${status}]${orphan}`, width);
}

function renderCycleLine(kind: string, label: string | undefined, width: number, prefix: string): string {
  return fit(`${prefix}↻ ${kind} ${safeLabel(label, 'unknown')} [cycle]`, width);
}

function pushRenderLine(lines: string[], line: string, width: number): boolean {
  if (lines.length < MAX_RENDER_LINES - 1) {
    lines.push(line);
    return true;
  }

  if (lines.length < MAX_RENDER_LINES) {
    lines.push(renderTruncationLine(width));
  }

  return false;
}

function isRenderLineLimitReached(lines: string[]): boolean {
  return lines.length >= MAX_RENDER_LINES;
}

function renderTruncationLine(width: number): string {
  return fit(`└─… render output truncated at ${MAX_RENDER_LINES} lines`, width);
}

function fit(value: string, width = DEFAULT_WIDTH): string {
  if (width <= 3 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, width - 1)}…`;
}

function recordValues<T>(values: Record<string, T> | undefined): T[] {
  if (!values) {
    return [];
  }

  return Object.values(values).filter((value): value is T => value !== undefined && value !== null);
}

function addToMap<T>(map: Map<string, T[]>, key: string | undefined, item: T): void {
  if (!key) {
    return;
  }

  const values = map.get(key) ?? [];
  values.push(item);
  map.set(key, values);
}

function collectTeamAgents(team: TeamIdentity, agentById: Map<string, AgentIdentity>, agentsByTeam: Map<string, AgentIdentity[]>): AgentIdentity[] {
  const collected: AgentIdentity[] = [];

  pushExistingAgent(collected, agentById, team.leaderAgentId);
  for (const memberId of uniqueStrings(team.memberAgentIds)) {
    pushExistingAgent(collected, agentById, memberId);
  }
  for (const agent of agentsByTeam.get(team.id) ?? []) {
    pushUniqueById(collected, agent);
  }

  return collected;
}

function collectTeamTasks(team: TeamIdentity, taskById: Map<string, TaskRecord>, tasksByTeam: Map<string, TaskRecord[]>): TaskRecord[] {
  const collected: TaskRecord[] = [];

  for (const taskId of uniqueStrings(team.taskIds)) {
    const task = taskById.get(taskId);
    if (task) {
      pushUniqueById(collected, task);
    }
  }

  for (const task of tasksByTeam.get(team.id) ?? []) {
    pushUniqueById(collected, task);
  }

  return collected;
}

function pushExistingAgent(collected: AgentIdentity[], agentById: Map<string, AgentIdentity>, agentId: string | undefined): void {
  const agent = agentId ? agentById.get(agentId) : undefined;
  if (agent) {
    pushUniqueById(collected, agent);
  }
}

function pushUniqueById<T extends { id: string }>(collected: T[], item: T): void {
  if (!collected.some((candidate) => candidate.id === item.id)) {
    collected.push(item);
  }
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const collected: T[] = [];
  for (const item of items) {
    pushUniqueById(collected, item);
  }
  return collected;
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

function statusMarker(status: string | undefined, selected: boolean): string {
  if (selected) {
    return '▶';
  }

  return status === 'running' ? '●' : ' ';
}

function isSelected(selectedNodeId: string | undefined, ...candidateIds: Array<string | undefined>): boolean {
  return Boolean(selectedNodeId && candidateIds.includes(selectedNodeId));
}

function safeLabel(label: string | undefined, fallback: string): string {
  return label?.trim() || fallback;
}

function byLabel<T extends { label: string }>(left: T, right: T): number {
  return safeLabel(left.label, '').localeCompare(safeLabel(right.label, ''));
}

function byTitle(left: TaskRecord, right: TaskRecord): number {
  return safeLabel(left.title, '').localeCompare(safeLabel(right.title, ''));
}
