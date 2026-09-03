"""story #3374(Phase1·마케팅운영, 페드루 PO 확定 2026-09-03 08:13Z) — 게이트 봉인 판정
공용 헬퍼. story #3365(Phase0 S2)의 site_posts.py가 처음 만든 3종(canonical 해시 계산·
「봉인 없음」·「재승인 필요」 예외)을 payload dict 기반 범용으로 옮긴다 — site_posts.py와
channel_posts.py 둘 다 이걸 import한다.

**site_posts.py는 이 모듈의 원본을 별칭으로 재export한다**(`SitePostSealMissingError =
GateSealMissingError` 형태) — 라우터의 `except SitePostSealMissingError`·기존 테스트가
잡는 문자열/타입 이름이 코드 변경 없이 그대로 성립한다(story #3374 AC5 "site_posts 테스트
전량 GREEN"의 실제 함정: 제네릭 이름으로 새로 정의하면 이 except절이 깨진다).

에러코드 문자열은 SITE_POST_SEAL_MISSING/SITE_POST_REAPPROVAL_REQUIRED 한 쌍을
site_posts·channel_posts 두 도메인이 그대로 공유한다(페드루 PO 결정, 2026-09-03 09:02Z —
채널 전용 코드를 새로 만들지 않는다). 이 모듈 자체는 코드 문자열을 모른다(라우터가
HTTPException detail을 조립할 때 붙인다) — 헬퍼는 순수 판정만 한다."""
from __future__ import annotations

import hashlib
import json
import uuid


class GateReapprovalRequiredError(Exception):
    """승인된 버전(gate.sealed_content_sha256)과 지금 발행하려는 내용의 해시가 다르다."""

    def __init__(self, *, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"승인된 버전과 현재 내용이 다릅니다(gate_id={gate_id}) — 재승인이 필요합니다")


class GateSealMissingError(Exception):
    """fail-closed. gate.status가 approved/auto_passed인데 sealed_content_sha256이 None
    (제출→봉인 없이 승인된 구식/우회 게이트)이면, "무엇이 승인됐는지 서버가 모른다"는
    뜻이라 REAPPROVAL_REQUIRED(내용이 다르다는 걸 안다)와는 다른 별개 코드로 거부한다
    (유나 설계 §3-1-1 "모른다≠다르다")."""

    def __init__(self, *, gate_id: uuid.UUID):
        self.gate_id = gate_id
        super().__init__(f"이 게이트는 봉인된 버전이 없습니다(gate_id={gate_id}) — 재상신 후 다시 승인받아야 합니다")


def compute_seal_hash(payload: dict) -> str:
    """canonical payload hash — 봉인 대상 버전(gate.sealed_content_sha256)을 결정할 때
    쓰는 계산. 호출자가 payload dict를 조립한다(어떤 필드가 「내용」인지는 도메인마다
    다르다 — site_posts는 title/lang/summary/tags/body_md, channel_posts는 text/link_url).
    key 순서 무관(sort_keys) — 같은 논리 payload는 항상 같은 해시."""
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
