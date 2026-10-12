// story 4654 (AC2): where a customer gets the phone app — one place for both stores. The values are the app's own (mobile app.json:20 ·
// eas.json submit.production.ios ascAppId). The Android track is internal today: the address is kept anyway (it does not change when
// the track opens). The test pins the values.

export const PHONE_APP_STORE_ANDROID = 'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable';
export const PHONE_APP_STORE_IOS = 'https://apps.apple.com/app/id6804625710';

/** the two store links in the order the page shows them (Android first); each address is also what its QR encodes */
export function phoneAppStoreLinks(): { store: 'android' | 'ios'; url: string }[] {
  return [
    { store: 'android', url: PHONE_APP_STORE_ANDROID },
    { store: 'ios', url: PHONE_APP_STORE_IOS },
  ];
}
