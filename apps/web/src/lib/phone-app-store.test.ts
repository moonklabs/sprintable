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

// [SID:4671] (UX-1 · U3 · PO 07:13Z): the link a customer gets is apart from «is the store open» — the internal-test opt-in page is the
// way in while the store is closed; iOS says «준비 중»; nothing at all → nothing drawn
import { PHONE_APP_INVITE_ANDROID, PHONE_APP_INVITE_ANDROID_DEV, PHONE_APP_INVITE_ANDROID_TARGET, PHONE_APP_TEST_GROUP, PHONE_APP_TEST_GROUP_TARGET, groupLink, inviteLink, phoneAppLinks } from './phone-app-store';

describe('[SID:4671] the opt-in page and the group page: settings with one shape each', () => {
  const OPTIN = 'https://play.google.com/apps/internaltest/4701234567890123456';
  const GROUP = 'https://groups.google.com/g/sprintable-phone-testers';
  it('the three settings are empty until the PO sets them (then: their shape, or the test fails here)', () => {
    for (const v of [PHONE_APP_INVITE_ANDROID, PHONE_APP_INVITE_ANDROID_DEV]) expect(v === '' || inviteLink(v) === v).toBe(true);
    expect(PHONE_APP_TEST_GROUP === '' || groupLink(PHONE_APP_TEST_GROUP) === PHONE_APP_TEST_GROUP).toBe(true);
    expect(PHONE_APP_INVITE_ANDROID_TARGET).toBeNull(); // this test build has no public address → no page
    expect(PHONE_APP_TEST_GROUP_TARGET).toBeNull();
  });
  it('groupLink: groups.google.com/g/<name> or groups.google.com/a/<domain>/g/<name> — else null', () => {
    expect(groupLink(GROUP)).toBe(GROUP);
    expect(groupLink('https://groups.google.com/a/moonklabs.com/g/phone-testers')).toBe('https://groups.google.com/a/moonklabs.com/g/phone-testers');
    for (const bad of ['', null, 'https://groups.google.com/', 'https://groups.google.com/g/', 'http://groups.google.com/g/x', 'https://example.com/g/x', `${GROUP}/about?x=1`]) {
      expect(groupLink(bad)).toBeNull();
    }
  });
  it('inviteLink: only https://play.google.com/apps/internaltest/<id> — empty · a typo · a store page · another site → null', () => {
    expect(inviteLink(OPTIN)).toBe(OPTIN);
    expect(inviteLink(` ${OPTIN} `)).toBe(OPTIN);
    for (const bad of ['', undefined, null, 'play.google.com/apps/internaltest/1', 'http://play.google.com/apps/internaltest/4701234567890123456',
      'https://play.google.com/store/apps/details?id=com.moonklabs.sprintable', 'https://example.com/apps/internaltest/4701234567890123456',
      'https://play.google.com/apps/internaltest/4701234567890123456/extra', 'https://play.google.com/apps/internaltest/abc']) {
      expect(inviteLink(bad)).toBeNull();
    }
  });
  it('each web reads its own package\'s page (dev → dev · app → prod · anything else → none) and the one group', () => {
    expect(phoneAppTarget('https://dev-app.sprintable.ai').invite).toBe(inviteLink(PHONE_APP_INVITE_ANDROID_DEV));
    expect(phoneAppTarget('https://app.sprintable.ai').invite).toBe(inviteLink(PHONE_APP_INVITE_ANDROID));
    expect(phoneAppTarget('https://app.sprintable.ai').group).toBe(groupLink(PHONE_APP_TEST_GROUP));
    expect(phoneAppTarget('http://localhost:3108').invite).toBeNull();
    expect(phoneAppTarget('http://localhost:3108').group).toBeNull();
    expect(phoneAppTarget(undefined).invite).toBeNull();
  });
});

describe('[SID:4671] phoneAppLinks: what the block draws', () => {
  const OPTIN = 'https://play.google.com/apps/internaltest/4701234567890123456';
  const GROUP = 'https://groups.google.com/g/sprintable-phone-testers';
  const none = { android: false, ios: false };
  it('store closed, group + opt-in page set: Android = the two-step way in (invite · group first) · iOS = 준비 중 (no link)', () => {
    expect(phoneAppLinks(none, PHONE_APP_STORE_ANDROID, OPTIN, GROUP)).toEqual([
      { store: 'android', kind: 'invite', url: OPTIN, group: GROUP },
      { store: 'ios', kind: 'soon', url: null },
    ]);
  });
  it('half a path (a page without the group · the group without a page) is no path: nothing', () => {
    expect(phoneAppLinks(none, PHONE_APP_STORE_ANDROID, OPTIN, null)).toEqual([]);
    expect(phoneAppLinks(none, PHONE_APP_STORE_ANDROID, null, GROUP)).toEqual([]);
  });
  it('store open: Android = the store even when the way in is set (the store wins) · iOS as it is', () => {
    expect(phoneAppLinks({ android: true, ios: false }, PHONE_APP_STORE_ANDROID_DEV, OPTIN, GROUP)).toEqual([
      { store: 'android', kind: 'store', url: PHONE_APP_STORE_ANDROID_DEV },
      { store: 'ios', kind: 'soon', url: null },
    ]);
    expect(phoneAppLinks({ android: true, ios: true }, PHONE_APP_STORE_ANDROID, null, null)).toEqual([
      { store: 'android', kind: 'store', url: PHONE_APP_STORE_ANDROID },
      { store: 'ios', kind: 'store', url: PHONE_APP_STORE_IOS },
    ]);
  });
  it('nothing to get (store closed · no way in · iOS closed): [] — the «준비 중» line is never drawn alone', () => {
    expect(phoneAppLinks(none, PHONE_APP_STORE_ANDROID, null, null)).toEqual([]);
    expect(phoneAppLinks(none, PHONE_APP_STORE_ANDROID, '', '')).toEqual([]);
  });
  it('iOS open, Android closed and no way in: the iOS store only', () => {
    expect(phoneAppLinks({ android: false, ios: true }, PHONE_APP_STORE_ANDROID, null, null)).toEqual([{ store: 'ios', kind: 'store', url: PHONE_APP_STORE_IOS }]);
  });
  it('this test build (no public address · nothing set): nothing', () => {
    expect(phoneAppLinks()).toEqual([]);
  });
});
