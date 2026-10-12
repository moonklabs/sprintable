// story 4654 (AC2): where a customer gets the phone app — one place for both stores. The values are the app's own (mobile app.json:20 ·
// eas.json submit.production.ios ascAppId). The Android track is internal today: the address is kept anyway (it does not change when
// the track opens). The test pins the values.

export const PHONE_APP_STORE_ANDROID = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable';
export const PHONE_APP_STORE_IOS = 'https://apps.apple.com/app/id6804625710';

/** per store: is it open to customers now? Both false until the PO opens the track (a link to a closed store is a dead end for a customer) */
export const PHONE_APP_PUBLISHED: { android: boolean; ios: boolean } = { android: false, ios: false };

/** the store links a customer can open, in the page's order (Android first) — only the published stores; each QR encodes its address */
export function phoneAppStoreLinks(published: { android: boolean; ios: boolean } = PHONE_APP_PUBLISHED): { store: 'android' | 'ios'; url: string }[] {
  const all = [
    { store: 'android' as const, url: PHONE_APP_STORE_ANDROID },
    { store: 'ios' as const, url: PHONE_APP_STORE_IOS },
  ];
  return all.filter((l) => published[l.store]);
}
