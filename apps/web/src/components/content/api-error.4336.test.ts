// story #4336 PR2 — 새 코드 둘은 로케일 문장 키로 받는다(서버 원문 영어 기술 문장이 화면에 새지 않게).
import { describe, expect, it } from 'vitest';
import koMessages from '../../../messages/ko.json';
import { parseSitePostApiError } from './api-error';

const K = koMessages.content as Record<string, string>;

describe('parseSitePostApiError — story #4336 PR2 코드', () => {
  it.each([
    ['CHANNEL_ASSET_STORAGE_TIMEOUT', 'errorChannelAssetStorageTimeout'],
    ['BACKGROUND_JOB_FAILED', 'errorBackgroundJobFailed'],
  ])('%s → %s(ko 문장 있음)', (code, key) => {
    const info = parseSitePostApiError({ detail: { code, message: 'storage download exceeded 20s' } });
    expect(info.humanMessageKey).toBe(key);
    expect(K[key]).toBeTruthy();
  });
});
