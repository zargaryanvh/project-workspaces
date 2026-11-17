import type { GroupColor } from './types.js';

/** Staging projects start with this mark and use the orange group colour. */
export const STAGING_MARK = '\u{1F7E0}'; // 🟠

/** Tidies a title the way it is stored and shown: single spaces, none at the ends. */
export function cleanTitle(title: string): string {
  return title.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Two titles name the same project when their keys match: case and spacing do not matter. */
export function projectKey(title: string): string {
  return cleanTitle(title).toLowerCase();
}

export function isStagingTitle(title: string): boolean {
  return cleanTitle(title).startsWith(STAGING_MARK);
}

/** One emoji at the start of a name, with any skin tone, variation selector or joined parts, then spaces. */
const LEADING_EMOJI = /^(\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?(?:‍\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|️)?)*)\s*/u;

/**
 * A name that starts with an emoji ("🔵 Admin", "🟠 App staging") uses it as
 * its icon: lists show the emoji in place of the colour dot, and the rest as
 * the name, so the circle is not shown twice. Null when there is no leading
 * emoji, or when the emoji is the whole name.
 */
export function leadingEmoji(title: string): { icon: string; rest: string } | null {
  const clean = cleanTitle(title);
  const match = LEADING_EMOJI.exec(clean);
  if (!match?.[1]) return null;
  const rest = clean.slice(match[0].length);
  return rest ? { icon: match[1], rest } : null;
}

/** Adds or removes the staging mark: "App staging" <-> "🟠 App staging". */
export function withStagingMark(title: string, staging: boolean): string {
  const bare = cleanTitle(title).replace(/^\u{1F7E0}\s*/u, '');
  return staging ? `${STAGING_MARK} ${bare}`.trim() : bare;
}

/** Colours a new project may get on its own. Orange is kept for staging, grey is too quiet. */
const AUTO_COLORS: readonly GroupColor[] = ['blue', 'green', 'purple', 'cyan', 'pink', 'red', 'yellow'];

/** A colour for a project that has none yet: orange for staging, else a steady pick from its name. */
export function defaultColorFor(title: string): GroupColor {
  if (isStagingTitle(title)) return 'orange';
  let hash = 0;
  for (const ch of projectKey(title)) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return AUTO_COLORS[hash % AUTO_COLORS.length] ?? 'blue';
}
