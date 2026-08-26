'use client';

import { DocsIndex } from './docs-index';

// story #2955 §6 — 미선택 상태=지식 인덱스 렌더(라우트 추가 불요). 옛 `DocsEmptyView`
// ("문서를 선택하세요" 죽은 화면)를 대체한다.
export default function DocsPage() {
  return <DocsIndex />;
}
