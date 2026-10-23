// story 4714 (AC3 · AC4) — the addresses of the phone app's landing. No imports: the proxy (edge) and the screens both read them.
//
// The shell starts every top-frame load with `X-Sprintable-Nav` (a number that rises per load · lib/initialSource.js of the mobile shell) — it is the
// one thing a load the SHELL made carries and a browser's never does. Until now the server ignored it; the proxy reads it for one thing: the shell's
// own `/glance` (its home address) — once resolved to the person's home — is sent through `/phone-landing?next=<that home>` first.
export const SHELL_NAV_HEADER = 'x-sprintable-nav';
export const PHONE_LANDING_PATH = '/phone-landing';
export const PHONE_START_PATH = '/phone-start';
export const PHONE_LANDING_NEXT_PARAM = 'next';

/**
 * The home the landing goes to when there is nothing to open instead: the address the proxy resolved (`next`). Only an address of this app — one path,
 * no host, no `//`, no backslash (an open redirect must never come out of a link someone sends) — and never the landing itself (`/phone-landing?next=/phone-landing`
 * would send the person round and round); anything else is the site root, which the session sends on to the person's own home.
 */
export function landingHome(next: string | null | undefined): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//') || next.includes('\\') || /[\u0000-\u001f]/.test(next)) return '/';
  let path: string;
  try { path = decodeURIComponent(new URL(next, 'http://app.invalid').pathname); } catch { return '/'; }
  if (path.replace(/\/+$/, '').toLowerCase() === PHONE_LANDING_PATH) return '/';
  return next;
}
