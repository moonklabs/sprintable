import { afterEach, describe, expect, it } from 'vitest';
import { getPublicAppHost } from './public-app-host';

const ENV_KEY = 'NEXT_PUBLIC_APP_URL';
const originalEnvValue = process.env[ENV_KEY];
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalEnvValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnvValue;
  process.env.NODE_ENV = originalNodeEnv;
});

describe('getPublicAppHost — story #3947(dev-app localhost 노출 재발방지)', () => {
  it('env가 있으면 프로토콜만 벗겨 반환', () => {
    process.env[ENV_KEY] = 'https://dev-app.sprintable.ai';
    expect(getPublicAppHost()).toBe('dev-app.sprintable.ai');
  });

  it('trailing slash도 제거', () => {
    process.env[ENV_KEY] = 'https://app.sprintable.ai/';
    expect(getPublicAppHost()).toBe('app.sprintable.ai');
  });

  it('로컬 dev(NODE_ENV=development)에서 env 부재면 조용히 localhost fallback', () => {
    process.env.NODE_ENV = 'development';
    delete process.env[ENV_KEY];
    expect(getPublicAppHost()).toBe('localhost:3108');
  });

  it('배포 빌드(NODE_ENV=production)에서 env 부재면 조용히 넘어가지 않고 던진다', () => {
    process.env.NODE_ENV = 'production';
    delete process.env[ENV_KEY];
    expect(() => getPublicAppHost()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('배포 빌드에서 env가 빈 문자열(공백)이어도 부재 취급 — 던진다', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENV_KEY] = '   ';
    expect(() => getPublicAppHost()).toThrow(/NEXT_PUBLIC_APP_URL/);
  });

  it('배포 빌드에서 env가 정상 배선돼 있으면 정상 통과(회귀 없음)', () => {
    process.env.NODE_ENV = 'production';
    process.env[ENV_KEY] = 'https://app.sprintable.ai';
    expect(getPublicAppHost()).toBe('app.sprintable.ai');
  });
});
