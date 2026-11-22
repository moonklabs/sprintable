// story 4994 (P4-d · D-3) — what kind of device the shell's web view runs on: a PHONE (the phone app's WebView) or a COMPUTER (the guest desktop app — an Electron window, its user agent says `Electron/…`).
// The phone's screens and words are shared with the guest desktop app (one shell logic, one web); a few lines name the device («이 폰은 …») — on a computer they must not call it a phone, and the computer's list must not show it with a phone's name.
export type DeviceKind = 'phone' | 'computer';

/** the guest desktop app is an Electron window; every other user agent here (the phone apps' WebViews) is a phone */
export function deviceKindOf(userAgent: string | undefined): DeviceKind {
  return typeof userAgent === 'string' && /\bElectron\//.test(userAgent) ? 'computer' : 'phone';
}

/** a computer's name for the host's list (≤ 64): its OS — the web cannot know the person's own name for it */
export function computerLabel(userAgent: string): string {
  if (/Windows/.test(userAgent)) return 'Windows PC';
  if (/Macintosh|Mac OS X/.test(userAgent)) return 'Mac';
  return 'Linux PC';
}

/** whether a host-list row's label is one of `computerLabel`'s names — the server keeps no kind for a device, the label the guest registered with is the only hint (a phone's label is its own model name) */
export function isComputerLabel(label: string | undefined): boolean {
  return label === 'Mac' || label === 'Windows PC' || label === 'Linux PC';
}
