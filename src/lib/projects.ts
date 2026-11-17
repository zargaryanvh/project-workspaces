import { cleanTitle, projectKey } from './titles.js';
import type { GroupColor, StoredProject } from './types.js';

/**
 * Pure helpers for the remembered project list (order and colours).
 * Each returns the same array when nothing changed, so callers can skip a save.
 */

export interface SeenGroup {
  title: string;
  color: GroupColor;
}

export function findProject(projects: readonly StoredProject[], title: string): StoredProject | undefined {
  const key = projectKey(title);
  return key ? projects.find((p) => projectKey(p.title) === key) : undefined;
}

/** Adds named groups the list does not know yet, at the end, in the order given. */
export function addMissingProjects(projects: StoredProject[], seen: readonly SeenGroup[]): StoredProject[] {
  const known = new Set(projects.map((p) => projectKey(p.title)));
  let out: StoredProject[] | null = null;
  for (const group of seen) {
    const key = projectKey(group.title);
    if (!key || known.has(key)) continue;
    known.add(key);
    (out ??= [...projects]).push({ title: cleanTitle(group.title), color: group.color });
  }
  return out ?? projects;
}

/** Remembers a known project's colour. Unknown titles are left alone. */
export function setProjectColor(projects: StoredProject[], title: string, color: GroupColor): StoredProject[] {
  const key = projectKey(title);
  const at = key ? projects.findIndex((p) => projectKey(p.title) === key) : -1;
  const current = projects[at];
  if (!current || current.color === color) return projects;
  const out = [...projects];
  out[at] = { ...current, color };
  return out;
}

/**
 * A group's name changed from oldTitle to newTitle. The project keeps its place:
 * the new name takes the old name's slot. When the new name already has a slot,
 * that slot wins and the old one is dropped. When another open group still uses
 * the old name, the old slot stays and the new name goes right after it.
 */
export function renameProject(
  projects: StoredProject[],
  oldTitle: string,
  newTitle: string,
  color: GroupColor,
  oldStillOpen: boolean,
): StoredProject[] {
  const oldKey = projectKey(oldTitle);
  const newKey = projectKey(newTitle);
  if (!newKey) return projects;
  const title = cleanTitle(newTitle);
  const oldAt = oldKey ? projects.findIndex((p) => projectKey(p.title) === oldKey) : -1;
  const newAt = projects.findIndex((p) => projectKey(p.title) === newKey);

  if (oldKey === newKey || newAt !== -1) {
    // Same project (spelling or case changed), or the new name already has a slot.
    const at = newAt;
    let out = projects;
    const current = projects[at];
    if (!current) return [...projects, { title, color }];
    if (current.title !== title || current.color !== color) {
      out = [...projects];
      out[at] = { title, color };
    }
    if (oldKey !== newKey && oldAt !== -1 && !oldStillOpen) out = out.filter((_, i) => i !== oldAt);
    return out;
  }

  if (oldAt === -1) return [...projects, { title, color }];
  const out = [...projects];
  if (oldStillOpen) out.splice(oldAt + 1, 0, { title, color });
  else out[oldAt] = { title, color };
  return out;
}

export function removeProject(projects: StoredProject[], title: string): StoredProject[] {
  const key = projectKey(title);
  const out = projects.filter((p) => projectKey(p.title) !== key);
  return out.length === projects.length ? projects : out;
}
