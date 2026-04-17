#!/usr/bin/env node
/**
 * Korean casual tone → formal tone converter
 * Converts ~하는., ~되는., ~보는. to formal Korean (~합니다, ~하세요)
 */

const fs = require('fs');
const path = require('path');

const koJsonPath = path.join(__dirname, '../apps/web/messages/ko.json');
const ko = JSON.parse(fs.readFileSync(koJsonPath, 'utf8'));

let changeCount = 0;

function convertToFormal(text, key) {
  if (typeof text !== 'string') return text;

  let converted = text;

  // Placeholder 패턴 (~하는. → ...해 주세요)
  if (key.toLowerCase().includes('placeholder') || key.toLowerCase().includes('hint')) {
    converted = converted
      .replace(/(\S+)하는\.$/g, '$1해 주세요')
      .replace(/(\S+)되는\.$/g, '$1되어 주세요')
      .replace(/(\S+)보는\.$/g, '$1봐 주세요')
      .replace(/입력하는\.$/g, '입력해 주세요')
      .replace(/선택하는\.$/g, '선택해 주세요')
      .replace(/검색하는\.$/g, '검색...')
      .replace(/확인하는\.$/g, '확인해 주세요');
  }
  // Description 패턴 (~하는. → ~합니다)
  else if (key.toLowerCase().includes('description')) {
    converted = converted
      .replace(/(\S+)하는\.$/g, '$1합니다.')
      .replace(/(\S+)되는\.$/g, '$1됩니다.')
      .replace(/(\S+)보는\.$/g, '$1봅니다.')
      .replace(/(\S+)있는\.$/g, '$1있습니다.')
      .replace(/(\S+)없는\.$/g, '$1없습니다.')
      .replace(/(\S+)상태인\.$/g, '$1상태입니다.')
      .replace(/관리하는\.$/g, '관리합니다.')
      .replace(/확인하는\.$/g, '확인합니다.')
      .replace(/추적하는\.$/g, '추적합니다.')
      .replace(/정리하는\.$/g, '정리합니다.')
      .replace(/업데이트하는\.$/g, '업데이트합니다.')
      .replace(/추가하는\.$/g, '추가합니다.')
      .replace(/제외하는\.$/g, '제외합니다.')
      .replace(/저장하는\.$/g, '저장합니다.')
      .replace(/반영하는\.$/g, '반영합니다.')
      .replace(/유지하는\.$/g, '유지합니다.')
      .replace(/집중하는\.$/g, '집중합니다.')
      .replace(/매핑하는\.$/g, '매핑합니다.')
      .replace(/이동하는\.$/g, '이동합니다.');
  }
  // 일반 텍스트 (~하는. → ~합니다)
  else {
    converted = converted
      .replace(/(\S+)하는\.$/g, '$1합니다.')
      .replace(/(\S+)되는\.$/g, '$1됩니다.')
      .replace(/(\S+)보는\.$/g, '$1봅니다.')
      .replace(/(\S+)있는\.$/g, '$1있습니다.')
      .replace(/(\S+)없는\.$/g, '$1없습니다.')
      .replace(/(\S+)상태인\.$/g, '$1상태입니다.');
  }

  // 추가 패턴들
  // ~있는. → ~있습니다. (단독으로 끝나는 경우)
  if (converted.match(/[가-힣]+\s있는\.$/)) {
    converted = converted.replace(/([가-힣]+\s)있는\.$/g, '$1있습니다.');
  }

  // ~없는. → ~없습니다. (단독으로 끝나는 경우)
  if (converted.match(/[가-힣]+\s없는\.$/)) {
    converted = converted.replace(/([가-힣]+\s)없는\.$/g, '$1없습니다.');
  }

  // ~상태인. → ~상태입니다.
  converted = converted.replace(/상태인\./g, '상태입니다.');

  // ~되는. → ~됩니다. (문장 끝)
  if (converted.match(/[면되]\s되는\.$/)) {
    converted = converted.replace(/([면되]\s)되는\.$/g, '$1됩니다.');
  }

  // ~보는. → ~봅니다. (문장 끝)
  converted = converted.replace(/보는\.$/g, '봅니다.');

  // ~있고 → ~있으며 (formal conjunction)
  if (key.toLowerCase().includes('body') || key.toLowerCase().includes('description')) {
    converted = converted.replace(/([가-힣]+\s)있고,/g, '$1있으며,');
    converted = converted.replace(/([가-힣]+)있고,/g, '$1있으며,');
  }

  // ~해야 하는. → ~해야 합니다.
  converted = converted.replace(/해야\s하는\.$/g, '해야 합니다.');

  // ~하게 하는. → ~하게 합니다.
  converted = converted.replace(/하게\s하는\.$/g, '하게 합니다.');

  if (converted !== text) {
    changeCount++;
    console.log(`[${changeCount}] ${key}: "${text}" → "${converted}"`);
  }

  return converted;
}

function processObject(obj, parentKey = '') {
  for (const key in obj) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;

    if (typeof obj[key] === 'object' && obj[key] !== null) {
      processObject(obj[key], fullKey);
    } else if (typeof obj[key] === 'string') {
      obj[key] = convertToFormal(obj[key], fullKey);
    }
  }
}

console.log('Converting Korean casual tone to formal tone...\n');

processObject(ko);

fs.writeFileSync(koJsonPath, JSON.stringify(ko, null, 2) + '\n', 'utf8');

console.log(`\n✅ Conversion complete! ${changeCount} strings updated.`);
