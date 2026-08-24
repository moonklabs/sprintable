"""story #3031(2026-08-24) — deploy-realtime-gce(GCE, story #2089)엔 이미 realtime-relevant
path-filter가 있었는데 **실제로 브라우저 SSE를 서빙하는** deploy-realtime(Cloud Run) 스텝엔
그게 없어, 관련 없는 코드만 섞인 develop merge에서도 매번 무조건 재배포됐다 — 오늘(08-24)
sprintable-realtime-dev 리비전 12개(PO 실측), 롤아웃마다 라이브 SSE 전 연결 절단.

이 테스트는 그 비대칭이 해소됐음을 cloudbuild.yaml 내용으로 고정한다(test_2178_realtime_
flag_parity.py와 동일 관례 — 실제 gcloud/git 호출은 CI 밖이라 실행 자체를 테스트할 수
없고, "무조건 재배포하던 이전 상태로 되돌아가지 않는다"를 구조 검사로 pin한다)."""
from __future__ import annotations

from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CLOUDBUILD_YAML = _REPO_ROOT / "cloudbuild.yaml"


def _deploy_realtime_step_script() -> str:
    import yaml

    doc = yaml.safe_load(_CLOUDBUILD_YAML.read_text())
    step = next(s for s in doc["steps"] if s["id"] == "deploy-realtime")
    assert step["entrypoint"] == "bash"
    return step["args"][1]


def test_deploy_realtime_reuses_shared_path_filter_script():
    """GCE 선례와 같은 스크립트 재사용(SSOT — 판별 로직 이중선언 금지)."""
    script = _deploy_realtime_step_script()
    assert "backend/scripts/check_realtime_relevant_diff.sh" in script


def test_deploy_realtime_skip_branch_exits_before_actual_deploy():
    """스킵 결정이 실제 `gcloud run deploy`보다 앞서야 한다 — 순서가 뒤바뀌면 스킵이 무의미.

    ⚠️두 함정을 각각 피한다:
    ①"skip deploy-realtime:" 앵커는 이 스텝 맨 앞(prod-gate skip, story #2078 이전부터
    존재)에도 나온다 — story #3031 전용 스킵 메시지를 별도로 찾아야 한다.
    ②"exit 0"를 skip 메시지~배포커맨드 «전체 구간»에서 substring 검색하면 그 사이에
    껴 있는 무관한 산문 주석(story #2442, "함수 진입 전에 exit 0)")에 우연히 매치돼
    거짓양성이 난다(실제 겪음 — mutation으로 exit 0를 지워도 4/4 그대로 통과했었다).
    «스킵 echo 바로 다음 줄»이 정확히 exit 0인지, 줄 단위 인접성으로 좁혀야 한다."""
    script = _deploy_realtime_step_script()
    lines = script.splitlines()
    skip_line_idx = next(
        i for i, l in enumerate(lines)
        if "skip deploy-realtime:" in l and "story #3031 path-filter" in l
    )
    deploy_line_idx = next(
        i for i, l in enumerate(lines)
        if "gcloud run deploy sprintable-realtime-${_DEPLOY_ENV}" in l
    )
    assert skip_line_idx < deploy_line_idx, "path-filter 스킵 판단이 실제 배포 커맨드보다 뒤에 있음"

    next_nonblank = next(l.strip() for l in lines[skip_line_idx + 1 :] if l.strip())
    assert next_nonblank == "exit 0", (
        f"스킵 echo 바로 다음 줄이 'exit 0'가 아님(실제: {next_nonblank!r}) — "
        "로그만 찍고 실제로 안 빠져나가면 그 아래 배포가 그대로 실행됨"
    )


def test_deploy_realtime_reads_serving_revision_not_template_spec():
    """describe의 spec.template은 다음 배포 대상이지 실제 트래픽이 아니다(배포 실효=서빙
    리비전 digest 교훈) — 100% 트래픽 리비전을 명시로 골라야 한다."""
    script = _deploy_realtime_step_script()
    assert "status.traffic.filter(percent=100).revisionName" in script


def test_deploy_realtime_fails_safe_when_serving_revision_unknown():
    """최초 배포·트래픽 스플릿 중처럼 직전 SHA를 못 구하면 스킵하지 않고 배포로 진행해야
    한다(GCE 선례·check_realtime_relevant_diff.sh 자체의 fail-safe와 동일 방향 — "필터가
    실수로 좁아도 조용히 안 새게")."""
    script = _deploy_realtime_step_script()
    # ⚠️`$$`로 이스케이프돼 있다 — Cloud Build 자신의 substitution 파서가 bash 실행 前에
    # 이 args 문자열을 먼저 훑어(test_deploy_backend_redis_secret_conflict.py 가드), 미선언
    # `${serving_revision}` 참조를 build submit 자체 거부로 처리한다. 원문 그대로 대조한다.
    assert 'if [ -z "$$serving_revision" ]; then' in script
    # 그 분기 본문에 exit이 없어야(=스킵하지 않고 이어서 배포 진행) fail-safe가 성립.
    branch_start = script.index('if [ -z "$$serving_revision" ]; then')
    branch_end = script.index("else", branch_start)
    branch_body = script[branch_start:branch_end]
    assert "exit" not in branch_body, "serving_revision 판별 불가 분기에서 exit 하면 fail-safe(배포 진행)가 아니라 fail-closed가 됨"
