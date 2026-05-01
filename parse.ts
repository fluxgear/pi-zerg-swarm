import type { ThinkingStep, ThinkingStepStatus } from './types.js';

const NUMBERED_STEP = /^\s*\d+[.)]\s+(.+)$/;
const BULLET_STEP = /^\s*[-*]\s+(.+)$/;
const CHECKBOX_PREFIX = /^\[([^\]]*)\]\s*(.*)$/;
const STATUS_PREFIX = /^(todo|running|blocked|done|failed|needs[- ]attention)\s*[:：-]\s*(.+)$/i;
const PREFIX_LIKE = /^([a-z][a-z -]*)\s*(?:[:：]|=>|=)\s*(.*)$/i;

export function deriveThinkingSteps(input: string | readonly string[] | null | undefined): ThinkingStep[] {
  return normalizeThinkingInput(input).flatMap((line, index) => {
    const parsed = parseThinkingLine(line);
    if (!parsed) {
      return [];
    }

    const sourceLine = index + 1;
    return [{
      id: `step-${sourceLine}`,
      title: parsed.title,
      status: parsed.status,
      sourceLine,
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
    return parseMarkedValue(numbered[1]);
  }

  const bullet = trimmed.match(BULLET_STEP);
  if (bullet?.[1]) {
    return parseBulletValue(bullet[1]);
  }

  return withExplicitPrefix(trimmed);
}

function normalizeThinkingInput(input: string | readonly string[] | null | undefined): readonly string[] {
  return Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/);
}

function parseBulletValue(value: string): { title: string; status: ThinkingStepStatus } | null {
  const checkbox = value.match(CHECKBOX_PREFIX);
  if (!checkbox) {
    return parseMarkedValue(value);
  }

  const checkboxStatus = statusFromCheckbox(checkbox[1]);
  if (!checkboxStatus || !checkbox[2]?.trim()) {
    return null;
  }

  const parsed = parseMarkedValue(checkbox[2]);
  if (!parsed) {
    return null;
  }

  return {
    title: parsed.title,
    status: checkboxStatus,
  };
}

function parseMarkedValue(value: string): { title: string; status: ThinkingStepStatus } | null {
  const trimmed = value.trim();
  if (!trimmed || hasUnknownStatusPrefix(trimmed)) {
    return null;
  }

  return withExplicitPrefix(trimmed) ?? { title: trimmed, status: 'unknown' };
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

function hasUnknownStatusPrefix(value: string): boolean {
  const match = value.match(PREFIX_LIKE);
  return Boolean(match && !STATUS_PREFIX.test(value));
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
  const status = value.toLowerCase().trim().replace(/\s+/g, '-');
  if (status === 'needs-attention') {
    return 'blocked';
  }
  if (status === 'todo' || status === 'running' || status === 'blocked' || status === 'done' || status === 'failed') {
    return status;
  }
  return 'unknown';
}
