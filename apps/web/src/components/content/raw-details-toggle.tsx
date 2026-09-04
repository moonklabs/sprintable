// story #3368 §4-1 "원문을 접어서 함께 보존한다" — gate_id 등 추적 정보를 사람 말
// 문구가 지워버리지 않게, 서버 원문(code+message)을 기본 접힌 <details>로 항상 옆에
// 둔다. content/[draftId]/page.tsx(site-posts)에서 처음 만들어져 story #3454(channel-
// posts 상세)가 그대로 가져다 쓴다(새 컴포넌트를 또 짓지 않는다) — 공용 위치로 뽑음.
//
// col-start-2 — Alert의 grid-cols-[auto_1fr] 레이아웃(components/ui/alert.tsx)에서
// AlertDescription과 같은 칸에 서게 맞춘다. AlertDescription 자체는 <p>라 <details>
// (block)를 그 안에 못 넣는다(HTML 무효화) — 그래서 <p> 형제로 둔다.
export function RawDetailsToggle({ raw, label }: { raw: string | undefined; label: string }) {
  if (!raw) return null;
  return (
    <details className="col-start-2 mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">{raw}</pre>
    </details>
  );
}
