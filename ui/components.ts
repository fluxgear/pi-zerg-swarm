import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { AgentStatus, ZergRuntimeHealth } from '../types.js';

export interface RenderPaneOptions {
  title: string;
  focused?: boolean;
  width: number;
  height?: number;
}

export function sanitizeUiText(value: unknown): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fitLine(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const clean = sanitizeUiText(value);
  if (clean.length <= safeWidth) {
    return clean.padEnd(safeWidth, ' ');
  }
  return `${clean.slice(0, Math.max(0, safeWidth - 1))}…`;
}

export function fitRawLine(value: string, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width));
  return truncateToWidth(value, safeWidth, '', true);
}

export function renderPane(lines: readonly string[], options: RenderPaneOptions): string[] {
  const width = Math.max(8, Math.floor(options.width));
  const title = `${options.focused ? '◆' : '◇'} ${options.title}`;
  const border = `${options.focused ? '╔' : '┌'}${'═'.repeat(Math.max(0, width - 2))}${options.focused ? '╗' : '┐'}`;
  const bottom = `${options.focused ? '╚' : '└'}${'═'.repeat(Math.max(0, width - 2))}${options.focused ? '╝' : '┘'}`;
  const bodyHeight = options.height === undefined ? lines.length : Math.max(0, options.height - 3);
  const body = lines.slice(0, bodyHeight).map((line) => `│${fitRawLine(line, width - 2)}│`);
  while (body.length < bodyHeight) {
    body.push(`│${' '.repeat(Math.max(0, width - 2))}│`);
  }
  return [border, `│${fitLine(title, width - 2)}│`, ...body, bottom];
}

export function columns(left: readonly string[], right: readonly string[], width: number): string[] {
  const safeWidth = Math.max(20, Math.floor(width));
  const gap = '  ';
  const leftWidth = Math.max(10, Math.floor((safeWidth - gap.length) * 0.42));
  const rightWidth = Math.max(10, safeWidth - gap.length - leftWidth);
  const rows = Math.max(left.length, right.length);
  const output: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    output.push(`${fitRawLine(left[index] ?? '', leftWidth)}${gap}${fitRawLine(right[index] ?? '', rightWidth)}`);
  }
  return output;
}

export function displayWidth(value: string): number {
  return visibleWidth(value);
}

export function statusGlyph(status?: AgentStatus | string): string {
  switch (status) {
    case 'running': return '▶';
    case 'blocked': return '■';
    case 'needs-attention': return '!';
    case 'done': return '✓';
    case 'failed': return '✗';
    case 'idle': return '○';
    default: return '·';
  }
}

export function healthGlyph(health?: ZergRuntimeHealth): string {
  switch (health) {
    case 'healthy': return 'healthy';
    case 'degraded': return 'degraded';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    default: return 'unknown';
  }
}

export function visibleSlice<T>(items: readonly T[], selectedIndex: number, height: number): { rows: T[]; offset: number; selectedIndex: number } {
  const clampedHeight = Math.max(1, Math.floor(height));
  const clampedSelected = items.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex, items.length - 1));
  const maxOffset = Math.max(0, items.length - clampedHeight);
  let offset = Math.max(0, Math.min(clampedSelected - Math.floor(clampedHeight / 2), maxOffset));
  if (clampedSelected < offset) {
    offset = clampedSelected;
  } else if (clampedSelected >= offset + clampedHeight) {
    offset = Math.max(0, clampedSelected - clampedHeight + 1);
  }
  return {
    rows: items.slice(offset, offset + clampedHeight),
    offset,
    selectedIndex: clampedSelected,
  };
}
