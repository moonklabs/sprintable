// [SID:4693] Yuna's words (`~/.sprintable-shared/yuna/4693-copy.md`, 10-15), pinned: the lines in ko and en (the six + the row button's aria-label), as she wrote them. `{file}` is the one new placeholder.
import { describe, expect, it } from 'vitest';
import ko from '../../messages/ko.json';
import en from '../../messages/en.json';

const rec = (m: unknown) => (m as { recruiter: Record<string, string> }).recruiter;
const nav = (m: unknown) => (m as { nav: Record<string, string> }).nav;

describe('4693 copy (Yuna) — ko and en, the six lines', () => {
  it('ko', () => {
    expect(rec(ko).folderTraceTitle).toBe('이 프로젝트 폴더에 {file} 파일이 있어요');
    expect(rec(ko).folderTraceBody).toBe('직무를 고르지 않고 채용해요 — {runtime} 에이전트가 이 폴더의 {file} 파일을 지침으로 읽어요.');
    expect(rec(ko).folderTraceRecruit).toBe('이 폴더의 에이전트로 채용');
    expect(rec(ko).folderAgentTitle).toBe('이 컴퓨터에서 이 프로젝트 폴더로 일하는 에이전트가 있어요');
    expect(rec(ko).folderAgentBody).toBe('새로 채용하지 않고 그대로 시작할 수 있어요.');
    expect(rec(ko).folderAgentStartAria).toBe('이 컴퓨터에서 시작 · {name}');
    expect(nav(ko).switcherFolderTrace).toBe('이 폴더에 {file} 파일이 있어요 — 프로젝트를 만든 뒤 채용관에서 이 폴더의 에이전트로 채용할 수 있어요.');
  });
  it('en', () => {
    expect(rec(en).folderTraceTitle).toBe("This project's folder has a {file} file");
    expect(rec(en).folderTraceBody).toBe("Recruit without choosing a role — the {runtime} agent reads this folder's {file} file as its instructions.");
    expect(rec(en).folderTraceRecruit).toBe("Recruit as this folder's agent");
    expect(rec(en).folderAgentTitle).toBe("An agent already works in this project's folder on this computer");
    expect(rec(en).folderAgentBody).toBe('You can start it without recruiting again.');
    expect(rec(en).folderAgentStartAria).toBe('Start on this computer · {name}');
    expect(nav(en).switcherFolderTrace).toBe("This folder has a {file} file — after the project is created, you can recruit it as this folder's agent in the Recruiter.");
  });
  it('the line says «이 컴퓨터에서» and no more than the app knows — no «없다» / «처음» promise about other computers', () => {
    for (const v of [rec(ko).folderAgentTitle, rec(ko).folderAgentBody]) expect(v).not.toMatch(/다른 컴퓨터|어디에도|없어요/);
  });
});
