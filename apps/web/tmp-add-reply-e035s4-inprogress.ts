import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(__dirname, '.env.local') });

import { createSupabaseAdminClient } from './src/lib/supabase/admin';
import { MemoService } from './src/services/memo';

async function main() {
  const supabase = createSupabaseAdminClient();
  const service = new MemoService(supabase);

  const memoId = 'ee008ac3-b8d4-4b7a-a029-fed4ec0351da';
  const content = `[DEV][IN_PROGRESS] E-035:S4 착수

착수 확인했는. 작업 계획은 다음과 같은:

## 작업 계획

### 1. 스키마 변경
- Supabase 마이그레이션: \`assigned_to\` → \`assigned_to_ids text[]\`
- 기존 데이터 마이그레이션 (assigned_to → assigned_to_ids)

### 2. Backend/Service 변경
- MemoService: 복수 assigned_to_ids 처리
- Webhook 발송: 각 할당자에게 개별 발송

### 3. Frontend UI 변경
- memo-form.tsx: 멀티 셀렉트 combobox 구현
- memo-detail: 할당자 chip/badge 표시
- 하위호환: 기존 단일 할당 메모 정상 표시

### 4. 검증
- 단위 테스트
- 통합 테스트 (복수 할당 + 웹훅)
- 기존 데이터 호환성

작업 시작하겠는.`;

  const createdBy = '9cac9d96-5474-45f7-941e-787407597b52'; // 디디 은와추쿠 member_id

  await service.addReply(memoId, content, createdBy, 'comment');

  console.log('IN_PROGRESS reply added successfully');
}

main().catch(console.error);
