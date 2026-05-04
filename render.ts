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
  const teams = recordValues(snapshot.teams);
  const intervention = snapshot.mode?.activeIntervention;
  const controller = snapshot.mode?.controller ?? 'operator';
  const runningAgents = agents.filter((agent) => agent.status === 'running').length;
  const runningTeams = teams.filter((team) => team.status === 'running').length;
  const unhealthy = [...agents, ...teams].filter(hasUnhealthyRuntime).length;
  const blocked = [...agents, ...tasks, ...teams].filter((item) => item.status === 'blocked' || item.status === 'needs-attention').length;
  const latestActivity = renderLatestRuntimeActivity([...agents, ...teams]);
  const activity = latestActivity ? ` | last ${latestActivity}` : '';
  const control = `control ${controller}`;
  const mode = `mode ${snapshot.mode?.automation ?? 'manual'}`;
  const activeIntervention = intervention
    ? ` | intervention ${intervention.kind} ${intervention.targetId} (${renderInterventionMessagePreview(intervention.message)})`
    : ' | no active intervention';

  return fit(
    `zerg v0.8.0 command surface | agents ${agents.length} (${runningAgents} running) | teams ${teams.length} (${runningTeams} running) | tasks ${tasks.length} | blocked ${blocked} | unhealthy ${unhealthy}${activity} | ${control} | ${mode}${activeIntervention}`,
    options.width,
  );
}


function getInterventionTargetIds(mode: ZergState['mode'] = { automation: 'manual', interventionEnabled: true, controller: 'operator' } as ZergState['mode']): Set<string> {
  const targetIds = new Set<string>();
  const targetId = mode.activeIntervention?.targetId;

  if (targetId) {
    targetIds.add(targetId);
  }

  return targetIds;
}

function renderInterventionMessagePreview(message: string, maxLength = 48): string {
  if (message.length <= maxLength) {
    return message;
  }

  return `${message.slice(0, maxLength - 1)}…`;
}

export function renderAgentTree(state: ZergState, options: RenderOptions = {}): string {
  const width = options.width ?? DEFAULT_WIDTH;
  const snapshot = state ?? ({} as ZergState);
  const agents = recordValues(snapshot.agents).sort(byLabel);
  const tasks = recordValues(snapshot.tasks).sort(byTitle);
  const teams = recordValues(snapshot.teams).sort(byLabel);
  const treeNodes = recordValues(snapshot.tree).sort(byLabel);
  const selectedNodeId = snapshot.selectedNodeId;
  const interventionTargetIds = getInterventionTargetIds(snapshot.mode);

  if (treeNodes.length > 0) {
    return renderExplicitTree(treeNodes, width, selectedNodeId, agents, teams, interventionTargetIds);
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
  const childReferencedAgentIds = new Set<string>();
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

    for (const childId of uniqueStrings(agent.childIds)) {
      const child = agentById.get(childId);
      if (child) {
        addToMap(childrenByParent, agent.id, child);
        childReferencedAgentIds.add(child.id);
      }
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

    if (!pushRenderLine(lines, renderAgentLine(agent, width, `${indent}├─`, selectedNodeId, interventionTargetIds), width)) {
      return;
    }

    renderedAgents.add(agent.id);
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(agent.id);

    for (const child of uniqueById(childrenByParent.get(agent.id) ?? []).sort(byLabel)) {
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

    if (!pushRenderLine(lines, renderTeamLine(team, width, `${indent}├─`, selectedNodeId, interventionTargetIds), width)) {
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

  for (const agent of agents.filter((candidate) => (!candidate.parentId || !agentIds.has(candidate.parentId)) && !childReferencedAgentIds.has(candidate.id))) {
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
    'pi-zerg-swarm v0.8.0 command-surface scaffold',
    `Commands: ${ZERG_COMMAND_INVOCATIONS.join(', ')}`,
    renderStatusLine(state, options),
    '',
    'Lifecycle syntax: /zerg agent create|start|progress|stop|fail|reset <agent-id> [label|activity]',
    'Lifecycle syntax: /zerg team create|start|progress|stop|fail|reset <team-id> [label|activity]',
    'Control syntax: /zerg mode status|manual|assisted|automatic|revert [reason]',
    'Intervention syntax: /zerg intervene agent <agent-id> <message> | /zerg intervene subagent <agent-id> <message> | /zerg intervene leader <team-id> <message>',
    'Available now: slash-free Pi command registration, aliases, lifecycle state updates, mode/intervention control commands, runtime health/activity summaries, scaffold status/tree output, thinking-step parsing, text rendering, and Pi event-bus observation.',
    'Live TUI overlays and external process/network transport remain out of scope for this release.',
  ].join('\n');
}

function renderAgentLine(agent: AgentIdentity, width: number, prefix: string, selectedNodeId: string | undefined, interventionTargetIds: Set<string> = new Set()): string {
  const kind = agent.kind ?? 'agent';
  const status = agent.status ?? 'unknown';
  const runtime = renderRuntimeHint(agent.runtime);
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, agent.id), interventionTargetIds.has(agent.id))} ${safeLabel(agent.label, agent.id)} [${kind}/${status}]${runtime}`, width);
}

function renderTeamLine(team: TeamIdentity, width: number, prefix: string, selectedNodeId: string | undefined, interventionTargetIds: Set<string> = new Set()): string {
  const kind = team.kind ?? 'team';
  const status = team.status ?? 'unknown';
  const runtime = renderRuntimeHint(team.runtime);
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, team.id), interventionTargetIds.has(team.id))} team ${safeLabel(team.label, team.id)} [${kind}/${status}]${runtime}`, width);
}

function renderTaskLine(task: TaskRecord, width: number, prefix: string, selectedNodeId?: string): string {
  const status = task.status ?? 'unknown';
  const blockers = task.blockedBy?.length ? ` blocked-by:${task.blockedBy.join(',')}` : '';
  return fit(`${prefix}${statusMarker(status, isSelected(selectedNodeId, task.id), false)} task ${safeLabel(task.title, task.id)} [${status}]${blockers}`, width);
}

function renderExplicitTree(
  nodes: ZergTreeNode[],
  width: number,
  selectedNodeId: string | undefined,
  agents: AgentIdentity[],
  teams: TeamIdentity[],
  interventionTargetIds: Set<string>,
): string {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, ZergTreeNode[]>();
  const missingChildrenByParent = new Map<string, string[]>();
  const referenced = new Set<string>();
  const visited = new Set<string>();
  const lines = ['zerg tree'];
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const teamById = new Map(teams.map((team) => [team.id, team]));

  for (const node of nodes) {
    for (const childId of uniqueStrings(node.childIds)) {
      const child = nodeById.get(childId);
      if (!child) {
        addToMap(missingChildrenByParent, node.id, childId);
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

    if (!pushRenderLine(
      lines,
      renderTreeNodeLine(
        node,
        width,
        `${indent}├─`,
        selectedNodeId,
        interventionTargetIds,
        node.parentId && !nodeById.has(node.parentId) ? node.parentId : undefined,
        findExplicitTreeRuntimeRef(node, agentById, teamById),
      ),
      width,
    )) {
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

    for (const missingChildId of uniqueStrings(missingChildrenByParent.get(node.id)).sort()) {
      if (isRenderLineLimitReached(lines)) {
        return;
      }
      if (!pushRenderLine(lines, renderMissingChildLine(missingChildId, width, `${'│  '.repeat(depth + 1)}└─`), width)) {
        return;
      }
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

function renderTreeNodeLine(
  node: ZergTreeNode,
  width: number,
  prefix: string,
  selectedNodeId: string | undefined,
  interventionTargetIds: Set<string>,
  orphanParent: string | undefined,
  runtime: AgentIdentity['runtime'] | TeamIdentity['runtime'] | undefined,
): string {
  const status = node.status ?? 'unknown';
  const marker = statusMarker(status, isSelected(selectedNodeId, node.id, node.refId), interventionTargetIds.has(node.id) || Boolean(node.refId && interventionTargetIds.has(node.refId)));
  const orphan = orphanParent ? ` orphan-parent:${orphanParent}` : '';
  const runtimeHint = renderRuntimeHint(runtime);
  return fit(`${prefix}${marker} ${node.kind} ${safeLabel(node.label, node.id)} [${status}]${orphan}${runtimeHint}`, width);
}

function findExplicitTreeRuntimeRef(
  node: ZergTreeNode,
  agentById: Map<string, AgentIdentity>,
  teamById: Map<string, TeamIdentity>,
): AgentIdentity['runtime'] | TeamIdentity['runtime'] | undefined {
  if (node.kind === 'agent') {
    const agentByRef = node.refId ? agentById.get(node.refId) : undefined;
    return (agentByRef ?? agentById.get(node.id))?.runtime;
  }

  if (node.kind === 'team') {
    const teamByRef = node.refId ? teamById.get(node.refId) : undefined;
    return (teamByRef ?? teamById.get(node.id))?.runtime;
  }

  return undefined;
}

function renderMissingChildLine(childId: string, width: number, prefix: string): string {
  return fit(`${prefix}⚠ missing-child:${safeLabel(childId, 'unknown')} [missing]`, width);
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


function renderRuntimeHint(runtime: AgentIdentity['runtime'] | TeamIdentity['runtime']): string {
  if (!runtime) {
    return '';
  }

  const parts = [`health:${runtime.health}`];
  const lastActivity = runtime.lastActivity ? sanitizeRuntimeActivity(runtime.lastActivity) : '';

  if (lastActivity) {
    parts.push(`last:${lastActivity}`);
  }

  return ` {${parts.join(' ')}}`;
}

function renderLatestRuntimeActivity(items: Array<AgentIdentity | TeamIdentity>): string | undefined {
  const latestDisplayable = items
    .map((item) => ({
      label: safeLabel(item.label, item.id),
      runtime: item.runtime,
    }))
    .filter((item): item is { label: string; runtime: NonNullable<AgentIdentity['runtime']> } => Boolean(item.runtime?.lastActivity))
    .map((item) => ({
      label: item.label,
      runtime: item.runtime,
      activity: sanitizeRuntimeActivity(item.runtime.lastActivity ?? ''),
    }))
    .filter((item): item is { label: string; runtime: NonNullable<AgentIdentity['runtime']>; activity: string } => Boolean(item.activity))
    .sort((left, right) => runtimeActivityCompare(left.runtime, right.runtime))[0];

  if (!latestDisplayable) {
    return undefined;
  }

  return `${latestDisplayable.label}: ${latestDisplayable.activity}`;
}

function runtimeActivityCompare(
  left: NonNullable<AgentIdentity['runtime']>,
  right: NonNullable<AgentIdentity['runtime']>,
): number {
  const timestampCompare = runtimeActivityTimestamp(right).localeCompare(runtimeActivityTimestamp(left));
  if (timestampCompare !== 0) {
    return timestampCompare;
  }

  const leftSequence = left.lastActivitySequence ?? left.lastActivityRevision ?? 0;
  const rightSequence = right.lastActivitySequence ?? right.lastActivityRevision ?? 0;
  const sequenceCompare = rightSequence - leftSequence;
  if (sequenceCompare !== 0) {
    return sequenceCompare;
  }

  return (right.lastActivity ?? '').localeCompare(left.lastActivity ?? '');
}

function runtimeActivityTimestamp(runtime: NonNullable<AgentIdentity['runtime']>): string {
  return runtime.lastActivityAt ?? runtime.updatedAt;
}

function hasUnhealthyRuntime(item: AgentIdentity | TeamIdentity): boolean {
  return item.runtime?.health === 'blocked'
    || item.runtime?.health === 'degraded'
    || item.runtime?.health === 'failed'
    || item.status === 'blocked'
    || item.status === 'needs-attention'
    || item.status === 'failed';
}

function fit(value: string, width = DEFAULT_WIDTH): string {
  if (width <= 3 || value.length <= width) {
    return value;
  }
  return `${value.slice(0, width - 1)}…`;
}

function sanitizeRuntimeActivity(activity: string): string {
  return activity
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function statusMarker(status: string | undefined, selected: boolean, interventionTarget: boolean): string {
  if (selected) {
    return '▶';
  }

  if (interventionTarget) {
    return '◉';
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
