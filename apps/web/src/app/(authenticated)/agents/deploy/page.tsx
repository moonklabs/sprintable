import { isOssMode } from '@/lib/storage/factory';

export default async function AgentDeployPage() {
  if (isOssMode()) {
    return (
      <div className="flex h-64 items-center justify-center p-6 text-center">
        <div>
          <h2 className="text-base font-semibold text-foreground">OSS 버전 미제공 기능인.</h2>
          <p className="mt-1 text-sm text-muted-foreground">에이전트 배포 관리는 SaaS 버전에서 이용 가능한.</p>
        </div>
      </div>
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return null as any;
}
