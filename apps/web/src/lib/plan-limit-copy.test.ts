// [SID:4680] limitCopy (Yuna §N · §N-2): what a plan-limit banner says and whether it draws the way to billing — one decision, table-driven.
import { describe, expect, it } from 'vitest';
import koMessages from '../../messages/ko.json';
import enMessages from '../../messages/en.json';
import { limitCopy, type LimitResource } from './plan-limit-copy';

const RES: LimitResource[] = ['org', 'project', 'agent'];

describe('[4680] billing open (the way is drawn)', () => {
  const o = (resource: LimitResource, limit: number | null, free: boolean) => limitCopy({ resource, limit, free, billingOpen: true });
  it('free with a number: title «업그레이드가 필요해요» key · the «…Error» reason with the limit · the way', () => {
    expect(o('org', 1, true)).toEqual({ title: 'orgLimitBannerTitle', reason: { ns: 'onboarding', key: 'orgLimitExceededError', withLimit: true }, link: true });
    expect(o('project', 3, true).reason).toEqual({ ns: 'onboarding', key: 'projectLimitExceededError', withLimit: true });
    expect(o('agent', 3, true).reason).toEqual({ ns: 'recruiter', key: 'agentLimitExceededError', withLimit: true });
  });
  it('another tier with a number: the paid line (project · agent)', () => {
    expect(o('project', 5, false).reason).toEqual({ ns: 'onboarding', key: 'projectLimitExceededPaid', withLimit: true });
    expect(o('agent', 5, false).reason).toEqual({ ns: 'recruiter', key: 'agentLimitExceededPaid', withLimit: true });
  });
  it('agent without a number: free → the number-less line · another tier → no reason line (no word was given, no number made up)', () => {
    expect(o('agent', null, true).reason).toEqual({ ns: 'recruiter', key: 'agentLimitExceededNoCount', withLimit: false });
    expect(o('agent', null, false).reason).toBeNull();
    expect(o('agent', null, false).link).toBe(true);
  });
  it('a limit of 0 (free): its own sentence — never «0개까지», never «모두 만들었어요»', () => {
    expect(o('agent', 0, true).reason).toEqual({ ns: 'recruiter', key: 'agentLimitZero', withLimit: false });
    expect(o('org', 0, true).reason).toEqual({ ns: 'onboarding', key: 'orgLimitZero', withLimit: false });
    expect(o('project', 0, true).reason).toEqual({ ns: 'onboarding', key: 'projectLimitZero', withLimit: false });
  });
});

describe('[4680] billing closed (prod today): the fact — no way, no «upgrade»', () => {
  const c = (resource: LimitResource, limit: number | null, free = true) => limitCopy({ resource, limit, free, billingOpen: false });
  it('every case: title «Closed» · link false', () => {
    for (const r of RES) for (const limit of [0, 1, 3, 9999, null]) for (const free of [true, false]) {
      const x = c(r, limit, free);
      expect(x.title, `${r} ${limit} ${free}`).toBe('orgLimitBannerTitleClosed');
      expect(x.link, `${r} ${limit} ${free}`).toBe(false);
    }
  });
  it('the limit sentence only (the «…Closed» key) with the number · 0 → the «ZeroClosed» sentence · agent no number → the number-less closed sentence', () => {
    expect(c('org', 1).reason).toEqual({ ns: 'onboarding', key: 'orgLimitExceededClosed', withLimit: true });
    expect(c('project', 3).reason).toEqual({ ns: 'onboarding', key: 'projectLimitExceededClosed', withLimit: true });
    expect(c('agent', 3).reason).toEqual({ ns: 'recruiter', key: 'agentLimitExceededClosed', withLimit: true });
    expect(c('agent', 0).reason).toEqual({ ns: 'recruiter', key: 'agentLimitZeroClosed', withLimit: false });
    expect(c('project', 0).reason?.key).toBe('projectLimitZeroClosed');
    expect(c('org', 0).reason?.key).toBe('orgLimitZeroClosed');
    expect(c('agent', null).reason).toEqual({ ns: 'recruiter', key: 'agentLimitExceededNoCountClosed', withLimit: false });
  });
  it('no paid branch where billing is closed (a paid tier gets the same fact)', () => {
    for (const r of RES) expect(c(r, 3, false)).toEqual(c(r, 3, true));
  });
});

describe('[4680] the words (Yuna §N-2 — copied as literals from the copy file)', () => {
  const m = (loc: typeof koMessages | typeof enMessages, n: string, k: string) => ((loc as unknown as Record<string, Record<string, string>>)[n] ?? {})[k];
  it('every key limitCopy can name exists in ko and en, and a key that takes {limit} has it', () => {
    for (const r of RES) {
      for (const limit of [0, 3, null]) for (const free of [true, false]) for (const billingOpen of [true, false]) {
        const x = limitCopy({ resource: r, limit, free, billingOpen });
        expect(m(koMessages, 'nav', x.title), x.title).toBeTruthy();
        expect(m(enMessages, 'nav', x.title), x.title).toBeTruthy();
        if (x.reason) {
          for (const loc of [koMessages, enMessages]) {
            const text = m(loc, x.reason.ns, x.reason.key);
            expect(text, `${x.reason.ns}.${x.reason.key}`).toBeTruthy();
            expect(text.includes('{limit}'), `${x.reason.ns}.${x.reason.key}`).toBe(x.reason.withLimit);
          }
        }
      }
    }
  });
  it('closed: title and sentences as the copy file has them', () => {
    expect(m(koMessages, 'nav', 'orgLimitBannerTitleClosed')).toBe('한도에 도달했어요');
    expect(m(enMessages, 'nav', 'orgLimitBannerTitleClosed')).toBe('Limit reached');
    expect(m(koMessages, 'nav', 'orgLimitBannerTitleClosed')).toBe(m(koMessages, 'usage', 'limitReached')); // the same word as the existing usage.limitReached
    expect(m(koMessages, 'onboarding', 'orgLimitExceededClosed')).toBe('무료 플랜은 조직을 {limit}개까지 만들 수 있어요.');
    expect(m(koMessages, 'onboarding', 'projectLimitExceededClosed')).toBe('무료 플랜은 프로젝트를 {limit}개까지 만들 수 있어요.');
    expect(m(koMessages, 'recruiter', 'agentLimitExceededClosed')).toBe('무료 플랜은 에이전트를 {limit}개까지 만들 수 있어요.');
    expect(m(enMessages, 'onboarding', 'orgLimitExceededClosed')).toBe('The free plan allows up to {limit} organization(s).');
    expect(m(enMessages, 'onboarding', 'projectLimitExceededClosed')).toBe('The free plan allows up to {limit} project(s).');
    expect(m(enMessages, 'recruiter', 'agentLimitExceededClosed')).toBe('The free plan allows up to {limit} agent(s).');
    expect(m(koMessages, 'recruiter', 'agentLimitExceededNoCountClosed')).toBe('무료 플랜에서 만들 수 있는 에이전트를 모두 만들었어요.');
    expect(m(enMessages, 'recruiter', 'agentLimitExceededNoCountClosed')).toBe("You've reached the free plan's agent limit.");
  });
  it('closed texts never ask for an upgrade or a contact; open texts keep the second sentence', () => {
    const closedKeys: Array<[string, string]> = [['onboarding', 'orgLimitExceededClosed'], ['onboarding', 'projectLimitExceededClosed'], ['recruiter', 'agentLimitExceededClosed'],
      ['recruiter', 'agentLimitExceededNoCountClosed'], ['onboarding', 'orgLimitZeroClosed'], ['onboarding', 'projectLimitZeroClosed'], ['recruiter', 'agentLimitZeroClosed']];
    for (const [n, k] of closedKeys) {
      for (const loc of [koMessages, enMessages]) {
        const t = m(loc, n, k);
        expect(t, `${n}.${k}`).not.toMatch(/업그레이드|문의|Upgrade|Contact|요금제를 바꿔/);
      }
    }
    expect(m(koMessages, 'recruiter', 'agentLimitZero')).toBe('무료 플랜에서는 에이전트를 만들 수 없어요. 계속하려면 요금제를 업그레이드해 주세요.');
    expect(m(enMessages, 'recruiter', 'agentLimitZero')).toBe("The free plan doesn't include agents. Upgrade your plan to continue.");
    expect(m(koMessages, 'recruiter', 'agentLimitZeroClosed')).toBe('무료 플랜에서는 에이전트를 만들 수 없어요.');
    expect(m(enMessages, 'recruiter', 'agentLimitZeroClosed')).toBe("The free plan doesn't include agents.");
    expect(m(koMessages, 'onboarding', 'orgLimitZeroClosed')).toBe('무료 플랜에서는 조직을 만들 수 없어요.');
    expect(m(koMessages, 'onboarding', 'projectLimitZeroClosed')).toBe('무료 플랜에서는 프로젝트를 만들 수 없어요.');
  });
});
