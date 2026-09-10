import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanJsxFileContent, scanRepo } from './verify-no-raw-role-jsx-text';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

describe('scanJsxFileContent — story #3770 셀프테스트', () => {
  it('⭐bare identifier {role} → RED', () => {
    const src = `function C() { return <span>{role}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐property access {profile.role} → RED', () => {
    const src = `function C() { return <span>{profile.role}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  it('⭐중첩 property access {agent.role} → RED', () => {
    const src = `function C() { return <Badge variant="outline">{agent.role}</Badge>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toHaveLength(1);
  });

  // 뮤테이션 대조 — 정본 헬퍼로 감싸면(t()/orgRoleLabel()/resolveRoleLabel() 동형) 이
  // 스캔이 반드시 0을 낸다는 것 자체를 자가 증명.
  it('뮤테이션 대조 — orgRoleLabel(profile.role, t)로 감싼 형은 GREEN(CallExpression이라 대상 밖)', () => {
    const src = `function C() { return <span>{orgRoleLabel(profile.role, t)}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('뮤테이션 대조 — resolveRoleLabel(agent.role, null, t)로 감싼 형은 GREEN', () => {
    const src = `function C() { return <Badge>{resolveRoleLabel(agent.role, null, t)}</Badge>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — <select value={member.role}>는 JSX 속성(JsxAttribute)이지 자식(JsxChild)이
  // 아니다. roles/page.tsx:168 실사용 형과 동형(정당).
  it('음성대조 — <option value={member.role}>는 GREEN(속성 자리는 애초 대상 밖)', () => {
    const src = `function C() { return <select value={member.role}><option value={member.role}>x</option></select>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  // 음성대조 — 조건부 렌더의 가드 조건 자체(top-level이 ConditionalExpression)는 대상 밖.
  // chat-input.tsx의 `{member.role ? <span>...</span> : null}` 감싸는 형과 동형.
  it('음성대조 — 삼항 가드 조건({member.role ? <x/> : null})의 조건 자체는 안 걸린다(안쪽만 검사)', () => {
    const src = `function C() { return <>{member.role ? <span>{label}</span> : null}</>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('음성대조 — role로 끝나지 않는 프로퍼티({member.roleLabel})는 GREEN', () => {
    const src = `function C() { return <span>{member.roleLabel}</span>; }`;
    expect(scanJsxFileContent(src, 'fake.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanJsxFileContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('scanRepo — story #3770(실 트리 실행)', () => {
  it('실 트리(apps/web/src) — 위반 0건, ALLOWLIST 2건(event stage role — 다른 축, 전부 실제로 걸림)', () => {
    const { refs, fileCount, allowlistHit } = scanRepo(SRC_ROOT);
    expect(fileCount).toBeGreaterThan(400);
    expect(refs).toEqual([]);
    expect(allowlistHit.size).toBe(2);
  });
});
