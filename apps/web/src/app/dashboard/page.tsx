import { redirect } from 'next/navigation';
import { readNavV3FlagsFromEnv } from '@/lib/nav-v3-flags-server';
import { resolveNavV3Destinations } from '@/lib/nav-v3-destinations';

// story #3179(S3c·SID 3179) — /dashboard(command-center) 폐합. attention(S3a #3177)·
// project pulse(S3b #3178)가 chat 구심점(/chats)으로 이사해 이 화면은 소임을 다했다
// (S3 와이어 심화 doc §2d). AC3 — 외부 실링크(북마크/메일/앱 딥링크) 존재를 이 리포 안에서는
// 반증도 확定도 못 했다(sprintable-landing 등 별도 리포·서버 접근 로그는 이 워크스페이스 밖
// — grep으로 증명 불가한 부재). 그래서 workforce/hitl·workforce/recruiter·dashboard/settings와
// 동일한 통 A 규율(「은퇴 주소 살아있는 클래스」 — 확信 없으면 폐기 아닌 redirect)을 따라
// 기존 사용자를 빈 화면 대신 새 홈으로 안내한다.
// story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z, 그라운딩에서 놓쳤던 자리 —
// AC1 표에 없었음) — env 읽기는 readNavV3FlagsFromEnv() 한 곳으로, 목적지 문자열은
// resolveNavV3Destinations() 한 곳으로만.
export default function DashboardRedirect() {
  redirect(resolveNavV3Destinations(readNavV3FlagsFromEnv()).chats.path);
}
