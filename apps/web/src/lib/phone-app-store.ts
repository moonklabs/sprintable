// story 4654 (AC2): where a customer gets the phone app — one place for both stores. The values are the app's own (mobile app.json:20 ·
// eas.json submit.production.ios ascAppId · eas.json applicationId for the dev package). The Android track is internal today: the
// address is kept anyway (it does not change when the track opens). The test pins the values.
//
// Dev web (dev-app.sprintable.ai) shows the dev package on Android — the address the invited testers install from. The production web
// shows nothing until the PO opens the track (the public addresses stay in the code, switched off). iOS is off in both (TestFlight is separate).
//
// [SID:4671] (UX-1 · U3 · PO 07:13Z · 07:29Z): «is the store open» and «the link a customer gets» are two different things. A store that is
// not open still has a way in, in two steps: ① join the testers' Google Group (anyone may join · one link for both packages) ② the Play
// internal-test opt-in page of the package («Become a tester» → install). Both addresses are settings below — public links, not
// secrets, so plain constants like the store addresses (the PO fills them in one line once the console gives them: Google Groups
// «join» page · Play Console → Testing → Internal testing → Testers → «Copy link»). Either one empty = no way in yet → nothing is
// drawn (never a dead link, never half a path). iOS has no such page: the line says «준비 중».

export const PHONE_APP_STORE_ANDROID = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable';
export const PHONE_APP_STORE_ANDROID_DEV = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable.dev';
export const PHONE_APP_STORE_IOS = 'https://apps.apple.com/app/id6804625710';

/** [SID:4671] ① the testers' Google Group — its join page · '' until the PO sets it (one group serves both packages) */
export const PHONE_APP_TEST_GROUP = '';
/** [SID:4671] ② the Play internal-test opt-in page of each package — '' until the PO sets it */
export const PHONE_APP_INVITE_ANDROID = ''; // com.moonklabs.sprintable (the production web)
export const PHONE_APP_INVITE_ANDROID_DEV = ''; // com.moonklabs.sprintable.dev (the dev web)

const DEV_WEB_HOST = 'dev-app.sprintable.ai';
const PROD_WEB_HOST = 'app.sprintable.ai';
/** the only shape Play gives for an internal-test opt-in page — anything else is not drawn (a typo must fail here, not on a phone) */
const INVITE_RE = /^https:\/\/play\.google\.com\/apps\/internaltest\/\d{10,25}$/;
/** a Google Group's page (groups.google.com/g/<name> · or a Workspace group groups.google.com/a/<domain>/g/<name>) */
const GROUP_RE = /^https:\/\/groups\.google\.com\/(a\/[a-z0-9.-]+\/)?g\/[a-z0-9._-]+$/i;

export type PhoneAppPublished = { android: boolean; ios: boolean };
export type PhoneAppTarget = { published: PhoneAppPublished; android: string; invite: string | null; group: string | null };
/** [SID:4671] the three way-in settings as phoneAppTarget reads them — the constants by default; a test hands in filled values (Kadir 5060 m8) */
export type PhoneAppWayIn = { group: string; inviteProd: string; inviteDev: string };
export const PHONE_APP_WAY_IN: PhoneAppWayIn = { group: PHONE_APP_TEST_GROUP, inviteProd: PHONE_APP_INVITE_ANDROID, inviteDev: PHONE_APP_INVITE_ANDROID_DEV };

/** [SID:4671] the opt-in address if it has Play's shape — else null (empty · a typo · another site) */
export function inviteLink(url: string | undefined | null): string | null {
  const u = (url ?? '').trim();
  return INVITE_RE.test(u) ? u : null;
}

/** [SID:4671] the group's page if it has Google Groups' shape — else null */
export function groupLink(url: string | undefined | null): string | null {
  const u = (url ?? '').trim();
  return GROUP_RE.test(u) ? u : null;
}

/**
 * what this web build shows, from its own public app address (dev → the dev package; anything else → nothing published).
 * [SID:4671] `wayIn` = the three settings (the constants by default); each host reads its own package's opt-in page and the one group —
 * any other host (localhost · a test build) reads none, even when the settings are filled.
 */
export function phoneAppTarget(appUrl: string | undefined, wayIn: PhoneAppWayIn = PHONE_APP_WAY_IN): PhoneAppTarget {
  let host = '';
  try { host = appUrl ? new URL(appUrl).hostname : ''; } catch { host = ''; }
  const group = groupLink(wayIn.group);
  if (host === DEV_WEB_HOST) return { published: { android: true, ios: false }, android: PHONE_APP_STORE_ANDROID_DEV, invite: inviteLink(wayIn.inviteDev), group };
  // the production web: the store stays closed until the PO opens the track; the two-step way in (when set) is the way meanwhile
  if (host === PROD_WEB_HOST) return { published: { android: false, ios: false }, android: PHONE_APP_STORE_ANDROID, invite: inviteLink(wayIn.inviteProd), group };
  return { published: { android: false, ios: false }, android: PHONE_APP_STORE_ANDROID, invite: null, group: null };
}

export const PHONE_APP_STORE_ANDROID_TARGET = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).android;

/** per store: is it open to customers now? Both false until the PO opens the track (a link to a closed store is a dead end for a customer) */
export const PHONE_APP_PUBLISHED: PhoneAppPublished = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).published;

/** [SID:4671] this web build's Android opt-in page — null when none is set (then only an open store gives a link) */
export const PHONE_APP_INVITE_ANDROID_TARGET: string | null = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).invite;
/** [SID:4671] the testers' group page — null when none is set */
export const PHONE_APP_TEST_GROUP_TARGET: string | null = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).group;

/** the store links a customer can open, in the page's order (Android first) — only the published stores; each QR encodes its address */
export function phoneAppStoreLinks(published: PhoneAppPublished = PHONE_APP_PUBLISHED, android: string = PHONE_APP_STORE_ANDROID_TARGET): { store: 'android' | 'ios'; url: string }[] {
  const all = [
    { store: 'android' as const, url: android },
    { store: 'ios' as const, url: PHONE_APP_STORE_IOS },
  ];
  return all.filter((l) => published[l.store]);
}

/**
 * [SID:4671] one row of «get the phone app»: a store link · the two-step way in while the store is closed (the group's page, then the
 * opt-in page — both drawn, in that order) · or «준비 중» (iOS · no link)
 */
export type PhoneAppLink =
  | { store: 'android' | 'ios'; kind: 'store'; url: string }
  | { store: 'android'; kind: 'invite'; url: string; group: string }
  | { store: 'ios'; kind: 'soon'; url: null };

/**
 * [SID:4671] what the «get the phone app» block draws, in the page's order (Android first), on any device (a Mac too — the QR is for
 * the phone's camera). Android: the two-step way in FIRST, when BOTH its addresses are set (a group with no opt-in page, or the
 * reverse, is half a path → not that); else the store when `published` says it is on a track; else nothing. The way in goes first
 * (PO 5060 review): «published» on the dev web means «on the internal-test track», not a store anyone can open — a new account that
 * is not a tester gets «not found» from that store link, while the group + opt-in page take it in. With the settings empty nothing
 * changes (the store link as before). iOS: the store when open, else the one «준비 중» line.
 * Nothing at all to get (no Android way in · iOS not open) → [] — the block is not drawn (an «iPhone 준비 중» line alone would be a dead end).
 */
export function phoneAppLinks(
  published: PhoneAppPublished = PHONE_APP_PUBLISHED,
  android: string = PHONE_APP_STORE_ANDROID_TARGET,
  invite: string | null = PHONE_APP_INVITE_ANDROID_TARGET,
  group: string | null = PHONE_APP_TEST_GROUP_TARGET,
): PhoneAppLink[] {
  const a: PhoneAppLink | null = invite && group ? { store: 'android', kind: 'invite', url: invite, group }
    : published.android ? { store: 'android', kind: 'store', url: android }
    : null;
  const i: PhoneAppLink = published.ios ? { store: 'ios', kind: 'store', url: PHONE_APP_STORE_IOS } : { store: 'ios', kind: 'soon', url: null };
  if (!a && i.kind === 'soon') return [];
  return a ? [a, i] : [i];
}
