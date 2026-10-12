// story 4654 (AC2): the phone app's store addresses — one place, the values pinned (a changed address must fail here, not on a customer's phone)
import { describe, expect, it } from 'vitest';
import { PHONE_APP_PUBLISHED, PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS, phoneAppStoreLinks } from './phone-app-store';

describe('[SID:4654] phone app store addresses', () => {
  it('the Android package and the iOS App Store id are the app\'s own (mobile app.json · eas.json)', () => {
    expect(PHONE_APP_STORE_ANDROID).toBe('https://play.google.com/store/apps/details?id=com.moonklabs.sprintable');
    expect(PHONE_APP_STORE_IOS).toBe('https://apps.apple.com/app/id6804625710');
  });

  it('nothing is published yet: no link at all (a store the customer cannot open is not shown)', () => {
    expect(PHONE_APP_PUBLISHED).toEqual({ android: false, ios: false });
    expect(phoneAppStoreLinks()).toEqual([]);
    expect(phoneAppStoreLinks({ android: false, ios: false })).toEqual([]);
  });

  it('a published store shows its link (Android first); an unpublished one stays hidden', () => {
    expect(phoneAppStoreLinks({ android: true, ios: true }).map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID, PHONE_APP_STORE_IOS]);
    expect(phoneAppStoreLinks({ android: false, ios: true }).map((l) => l.store)).toEqual(['ios']);
    expect(phoneAppStoreLinks({ android: true, ios: false }).map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID]);
    for (const l of phoneAppStoreLinks({ android: true, ios: true })) expect(l.url.startsWith('https://')).toBe(true);
  });
});

// story 4654 — the web build decides by its own public address: dev shows the dev package, production shows nothing
import { phoneAppTarget, PHONE_APP_STORE_ANDROID_DEV } from './phone-app-store';

describe('[SID:4654] the store the web build shows, by its address', () => {
  it('the dev web (dev-app) shows the dev Android package only; iOS stays off', () => {
    const t = phoneAppTarget('https://dev-app.sprintable.ai');
    expect(t.published).toEqual({ android: true, ios: false });
    expect(t.android).toBe('https://play.google.com/store/apps/details?id=com.moonklabs.sprintable.dev');
    expect(phoneAppStoreLinks(t.published, t.android).map((l) => l.url)).toEqual([PHONE_APP_STORE_ANDROID_DEV]);
  });

  it('the production web (app) shows nothing: no card, no link', () => {
    const t = phoneAppTarget('https://app.sprintable.ai');
    expect(t.published).toEqual({ android: false, ios: false });
    expect(phoneAppStoreLinks(t.published, t.android)).toEqual([]);
  });

  it('no address or a broken one shows nothing (fail closed)', () => {
    expect(phoneAppTarget(undefined).published).toEqual({ android: false, ios: false });
    expect(phoneAppTarget('not a url').published).toEqual({ android: false, ios: false });
  });
});
