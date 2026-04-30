import type { ThinkingStep, ThinkingStepStatus } from './types.js';

const NUMBERED_STEP = /^\s*\d+[.)]\s+(.+)$/;
const BULLET_STEP = /^\s*[-*]\s+(?:\[( |x|X|-|!)\]\s*)?(.+)$/;
const STATUS_PREFIX = /^(todo|running|blocked|done|failed|needs-attention|needs attention)\s*[:：-]\s*(.+)$/i;

export function deriveThinkingSteps(input: string | readonly string[] | null | undefined): ThinkingStep[] {
  const lines = Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);

  return lines.flatMap((line, index) => {
    const parsed = parseThinkingLine(line);
    if (!parsed) {
      return [];
    }

    return [{
      id: `step-${index + 1}`,
      title: parsed.title,
      status: parsed.status,
      sourceLine: index + 1,
    }];
  });
}

export function parseThinkingLine(line: string): { title: string; status: ThinkingStepStatus } | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const numbered = trimmed.match(NUMBERED_STEP);
  if (numbered?.[1]) {
    return withStatus(numbered[1]);
  }

  const bullet = trimmed.match(BULLET_STEP);
  if (bullet?.[2]) {
    const checkboxStatus = statusFromCheckbox(bullet[1]);
    const parsed = withStatus(bullet[2]);
    return {
      title: parsed.title,
      status: checkboxStatus ?? parsed.status,
    };
  }

  return withExplicitPrefix(trimmed);
}

function withStatus(value: string): { title: string; status: ThinkingStepStatus } {
  return withExplicitPrefix(value) ?? { title: value.trim(), status: 'unknown' };
}

function withExplicitPrefix(value: string): { title: string; status: ThinkingStepStatus } | null {
  const match = value.trim().match(STATUS_PREFIX);
  if (!match?.[1] || !match[2]?.trim()) {
    return null;
  }

  return {
    title: match[2].trim(),
    status: normalizeStatus(match[1]),
  };
}

function statusFromCheckbox(value: string | undefined): ThinkingStepStatus | undefined {
  switch (value) {
    case 'x':
    case 'X':
      return 'done';
    case '-':
    case '!':
      return 'blocked';
    case ' ':
      return 'todo';
    default:
      return undefined;
  }
}

function normalizeStatus(value: string): ThinkingStepStatus {
  const status = value.toLowerCase().replace(' ', '-');
  if (status === 'needs-attention') {
    return 'blocked';
  }
  if (status === 'todo' || status === 'running' || status === 'blocked' || status === 'done' || status === 'failed') {
    return status;
  }
  return 'unknown';
}
