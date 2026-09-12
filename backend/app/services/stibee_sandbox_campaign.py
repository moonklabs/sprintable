"""story #3813(Phase3·3-4 PR2, 페드루 PO 確定 2026-09-12) — 뉴스레터 「발송」
(=수신자에게 실제로 나가는 행위) dev 전용 샌드박스. `ads_sandbox_campaign.py`와
동형 철학(같은 함수 시그니처 원칙은 이 축엔 대응하는 real 모듈이 이 PR에 없어
해당 없음 — 실 스티비 API 호출은 이 PR 범위 밖, PO 明示 2026-09-12) — 결정적·
상태 없음."""
from __future__ import annotations

_MARKER_SEND_FAILED = "[sandbox:send-failed]"


class StibeeSandboxSendError(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


# ads_spend_snapshots.py 동형 관례 — 결정적 고정값(항상 같은 수, sandbox 고정값
# 12,345와 같은 취지: 매 라이브 회차·테스트가 같은 수를 기대할 수 있게).
_FIXED_RECIPIENT_COUNT = 4_200


async def send_campaign(*, campaign_id: str, segment_name: str) -> dict:
    """마커 캐리어 — 세그먼트명(자유 문자열, 사람이 입력)에 마커가 있으면 발송
    실패를 흉내낸다(ads_sandbox_campaign.py의 objective 마커 캐리어와 동형 결정 —
    이 호출에 그 밖의 자유 텍스트 축이 없다)."""
    if _MARKER_SEND_FAILED in segment_name:
        raise StibeeSandboxSendError("sandbox: [sandbox:send-failed] marker simulation")
    return {
        "campaign_id": campaign_id, "recipient_count": _FIXED_RECIPIENT_COUNT,
        "segment_name_confirmed": segment_name,
    }
