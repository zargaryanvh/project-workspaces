import type { GroupColor } from './types.js';

/**
 * Requests the extension's pages send to the background worker. All changes to
 * tabs, groups and the project list go through the worker, one at a time.
 */
export type Message =
  | { type: 'switch'; windowId: number; groupId: number }
  | { type: 'command'; windowId: number; command: string }
  | { type: 'create'; windowId: number; title: string; color: GroupColor }
  | { type: 'rename'; groupId: number; title: string }
  | { type: 'recolor'; groupId: number; color: GroupColor }
  /** Moves a group in the tab bar: right before another group, or after all of them (null). */
  | { type: 'move'; windowId: number; groupId: number; beforeGroupId: number | null }
  | { type: 'delete'; groupId: number; removeRules: boolean }
  /** From the "already open" page: go to a tab you have, and close the new one. */
  | { type: 'goToTab'; tabId: number; closeTabId?: number }
  /** From the "already open" page: load the address after all, in this tab. */
  | { type: 'openAnyway'; tabId: number; url: string };

export type Reply = { ok: true; result: unknown } | { ok: false; error: string };

const TYPES = new Set(['switch', 'command', 'create', 'rename', 'recolor', 'move', 'delete', 'goToTab', 'openAnyway']);

export function isMessage(value: unknown): value is Message {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && TYPES.has(type);
}

/** Sends a request to the background worker and throws its error, if any. */
export async function send(message: Message): Promise<unknown> {
  const reply = (await chrome.runtime.sendMessage(message)) as Reply | undefined;
  if (!reply) throw new Error('The extension did not answer. Try again.');
  if (!reply.ok) throw new Error(reply.error);
  return reply.result;
}
