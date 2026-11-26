// story 5036 (C6 · the straight line in the Mac app): the project step ① made is carried to the app's own start screen (/desktop/setup), which is a different page of the
// same tab. That screen makes a NEW project from the folder's name unless it is told otherwise — a second project, which is what the line must never do. The one thing it
// is told is this mark: «the project the person's first-run line made» (the organization it belongs to and its id). It is the tab's own (sessionStorage — not shared with
// another window, gone with the tab) and has a life of an hour; a screen that reads it checks it against what the organization really has before it uses it.

const KEY = 'sprintable:onboarding-line-project';
/** a first run is minutes; a mark older than this is a leftover and is not used */
const LIFE_MS = 60 * 60 * 1000;

export interface LineProject { orgId: string; projectId: string }

interface Stored extends LineProject { at: number }

export function writeLineProject(p: LineProject, now: number = Date.now()): void {
  try {
    const stored: Stored = { orgId: p.orgId, projectId: p.projectId, at: now };
    window.sessionStorage.setItem(KEY, JSON.stringify(stored));
  } catch { /* storage refused: the start screen then behaves as it always did */ }
}

export function readLineProject(now: number = Date.now()): LineProject | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<Stored> | null;
    if (!s || typeof s.orgId !== 'string' || !s.orgId || typeof s.projectId !== 'string' || !s.projectId || typeof s.at !== 'number') return null;
    if (now - s.at > LIFE_MS || now < s.at) return null;
    return { orgId: s.orgId, projectId: s.projectId };
  } catch {
    return null;
  }
}

export function clearLineProject(): void {
  try { window.sessionStorage.removeItem(KEY); } catch { /* nothing to clear */ }
}
