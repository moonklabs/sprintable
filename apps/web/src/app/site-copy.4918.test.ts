// 4918 — 로그인 부제 · 사이트 설명(링크 미리보기) · 앱 설치(매니페스트) 설명이 선생님이 정한 문구다. 옛 문구(«열린 루프를 닫는 조직 OS»)가 웹 앱 사용자에게 닿는 곳은 0.
// 되돌리면 아래가 빨갛게 된다. 문구가 또 바뀌면 이 시험의 기대값과 세 곳(messages login.subtitle · layout.tsx · manifest.ts)을 같이 고친다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';
import manifest from './manifest';

const SUBTITLE_KO = '책상을 떠나도, 일은 이어진다';
const SUBTITLE_EN = 'Leave your desk. Your work keeps going.';
const DESCRIPTION_KO = '에이전트가 맥에서 일하는 동안, 대화와 승인은 폰에서. 혼자 또는 작은 팀으로 일하는 사람을 위한 작업 공간.';
const DESCRIPTION_EN = 'While your agents work on your Mac, chat and approve from your phone. A workspace for people who work solo or in small teams.';

const OLD_PHRASES = ['열린 루프를 닫는 조직 OS', 'organization OS that closes open loops'];

const webRoot = join(__dirname, '..', '..'); // apps/web
const read = (p: string) => readFileSync(join(webRoot, p), 'utf8');

// 웹 앱 사용자에게 닿는 글 = messages 두 파일 + src의 시험 아닌 소스(.ts · .tsx). 시험 · 주석의 옛 문구 이력은 이 목록 밖(아래 표에서 따로 적는다).
function userFacingFiles(): string[] {
  const out: string[] = [join(webRoot, 'messages/ko.json'), join(webRoot, 'messages/en.json')];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== 'node_modules' && name !== '.next') walk(full); continue; }
      if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) && !/\.spec\.(ts|tsx)$/.test(name)) out.push(full);
    }
  };
  walk(join(webRoot, 'src'));
  return out;
}

describe('로그인 부제 · 사이트 설명 리브랜딩 (4918)', () => {
  it('⭐로그인 부제: ko · en이 정한 글자', () => {
    expect((ko as { login: { subtitle: string } }).login.subtitle).toBe(SUBTITLE_KO);
    expect((en as { login: { subtitle: string } }).login.subtitle).toBe(SUBTITLE_EN);
  });

  it('⭐앱 설치(매니페스트) 설명이 정한 영어 한 줄 — 단일 로케일 정적 메타', () => {
    expect(manifest().description).toBe(DESCRIPTION_EN);
  });

  it('⭐링크 미리보기 설명(messages siteMeta.description): ko · en 한 줄이 정한 글자', () => {
    expect((ko as { siteMeta: { description: string } }).siteMeta.description).toBe(DESCRIPTION_KO);
    expect((en as { siteMeta: { description: string } }).siteMeta.description).toBe(DESCRIPTION_EN);
  });

  it('⭐링크 미리보기(layout.tsx)는 그 키를 로케일로 읽고 설명 · OG 설명 · 트위터 설명 세 곳이 모두 같은 값 — 옛 상수 · 한글 상수로 돌아가면 빨강', () => {
    const src = read('src/app/layout.tsx');
    expect(src).toContain("const tMeta = await getTranslations('siteMeta');");
    expect(src).toContain("const siteDescription = tMeta('description');");
    expect(src.match(/description: siteDescription,/g)?.length).toBe(3);
    expect(src).not.toMatch(/SITE_DESCRIPTION/);
  });

  it('⭐매니페스트 설명은 messages(en) siteMeta.description과 같은 글자(두 곳이 어긋나지 않는다)', () => {
    expect(manifest().description).toBe((en as { siteMeta: { description: string } }).siteMeta.description);
  });

  it('⭐옛 문구 0: 웹 앱 사용자에게 닿는 글(messages · 시험 아닌 src 소스)에 «열린 루프를 닫는 조직 OS» · «organization OS that closes open loops»가 없다', () => {
    const hits: string[] = [];
    for (const file of userFacingFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const phrase of OLD_PHRASES) if (text.includes(phrase)) hits.push(`${relative(webRoot, file)}: ${phrase}`);
    }
    expect(hits).toEqual([]);
  });

  it('하드코딩 영어 가드 기준선도 새 매니페스트 글자를 가리킨다(옛 글자로 남으면 가드가 «고치면 빼야 초록»으로 빨갛다)', () => {
    const guard = read('scripts/verify-no-hardcoded-english-ui-message.ts');
    expect(guard).toContain(`'app/manifest.ts::${DESCRIPTION_EN}'`);
    for (const phrase of OLD_PHRASES) expect(guard).not.toContain(phrase);
  });
});
