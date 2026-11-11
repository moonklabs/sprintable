/**
 * 앱 셸 안 표지 — UI-3(a9d56577) `touch:` 변형의 셋째 조건(PO 결정 11-11).
 * 폰 앱(iOS · Android 웹뷰)은 기기 분류(`pointer` · `hover`)가 에뮬 · 스타일러스 폰에서 «마우스»로 읽혀도 우리 앱 안만큼은 44 바닥을 걸어야 한다.
 * CSS는 JS 전역을 못 읽으므로, 루트 `<head>`의 인라인 동기 스크립트(파서가 `<body>`를 읽기 前에 돈다)가 셸이 document-start에 심어 둔 `window.__SPRINTABLE_SHELL__.platform`을
 * `<html data-sprintable-shell="ios|android">`로 옮긴다(첫 페인트 前 · 앱 새 빌드 없이). `macos`(맥 데스크톱 앱 = 마우스)와 전역이 없는 브라우저는 속성을 달지 않는다.
 * 속성 이름 · 값은 앱 쪽(민군 · native-shell-bridge)이 정한 그대로다.
 */
export const SHELL_ATTRIBUTE = 'data-sprintable-shell';

export const SHELL_ATTRIBUTE_SCRIPT =
  `(function(){try{var s=window.__SPRINTABLE_SHELL__;var p=s&&s.platform;if(p==='ios'||p==='android'){document.documentElement.setAttribute('${SHELL_ATTRIBUTE}',p)}}catch(e){}})();`;
