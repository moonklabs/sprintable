// story 4654 (AC2): where a customer gets the phone app — one place for both stores. The values are the app's own (mobile app.json:20 ·
// eas.json submit.production.ios ascAppId · eas.json applicationId for the dev package). The Android track is internal today: the
// address is kept anyway (it does not change when the track opens). The test pins the values.
//
// Dev web (dev-app.sprintable.ai) shows the dev package on Android — the address the invited testers install from. The production web
// shows nothing until the PO opens the track (the public addresses stay in the code, switched off). iOS is off in both (TestFlight is separate).

export const PHONE_APP_STORE_ANDROID = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable';
export const PHONE_APP_STORE_ANDROID_DEV = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable.dev';
export const PHONE_APP_STORE_IOS = 'https://apps.apple.com/app/id6804625710';

const DEV_WEB_HOST = 'dev-app.sprintable.ai';

export type PhoneAppPublished = { android: boolean; ios: boolean };
export type PhoneAppTarget = { published: PhoneAppPublished; android: string };

/** what this web build shows, from its own public app address (dev → the dev package; anything else → nothing published) */
export function phoneAppTarget(appUrl: string | undefined): PhoneAppTarget {
  let host = '';
  try { host = appUrl ? new URL(appUrl).hostname : ''; } catch { host = ''; }
  if (host === DEV_WEB_HOST) return { published: { android: true, ios: false }, android: PHONE_APP_STORE_ANDROID_DEV };
  return { published: { android: false, ios: false }, android: PHONE_APP_STORE_ANDROID };
}

export const PHONE_APP_STORE_ANDROID_TARGET = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).android;

/** per store: is it open to customers now? Both false until the PO opens the track (a link to a closed store is a dead end for a customer) */
export const PHONE_APP_PUBLISHED: PhoneAppPublished = phoneAppTarget(process.env.NEXT_PUBLIC_APP_URL).published;

/** the store links a customer can open, in the page's order (Android first) — only the published stores; each QR encodes its address */
export function phoneAppStoreLinks(published: PhoneAppPublished = PHONE_APP_PUBLISHED, android: string = PHONE_APP_STORE_ANDROID_TARGET): { store: 'android' | 'ios'; url: string }[] {
  const all = [
    { store: 'android' as const, url: android },
    { store: 'ios' as const, url: PHONE_APP_STORE_IOS },
  ];
  return all.filter((l) => published[l.store]);
}
