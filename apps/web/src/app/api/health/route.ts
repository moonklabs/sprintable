import { NextResponse } from 'next/server';

/** AC6: 헬스체크 엔드포인트 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version ?? '0.0.1',
  });
}
