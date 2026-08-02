"""공용 스키마 검증 헬퍼.

story #2414 + #2413 AC3(PO 지시, 2026-08-02) — "빈 값"의 정의를 한 곳에 둔다. ""·공백만·
개행만·None 넷 다 blank로 본다. 이 판정이 엔드포인트마다 갈리면 한쪽은 막고 한쪽은 통과하는
재발 축이 된다(#2410 당일 EXEMPT 누적과 같은 뿌리 — 무엇을 재는지가 갈리면 가드가 무뎌진다).
"""


def is_blank(value: str | None) -> bool:
    return value is None or value.strip() == ""


def reject_if_all_blank(**fields: str | None) -> None:
    """story #2414 — 셋(또는 그 이상) 칸이 «전부» 다 blank일 때만 거부. 하나라도 채워지면
    통과(예: done만 빈 것은 오늘 시작한 사람의 정상 상태 — 실측 73/122건이 이 모양이었다).
    호출부가 필드명=값으로 넘기면 메시지에 그 필드명을 그대로 쓴다."""
    if all(is_blank(v) for v in fields.values()):
        names = "·".join(fields.keys())
        raise ValueError(f"{names} 중 최소 하나는 채워야 합니다")
