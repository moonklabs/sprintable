#!/usr/bin/env node
/**
 * Translation key validation script
 * Scans all TSX/TS files for t() calls and validates against locale files
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Load locale files
const rootDir = path.join(__dirname, '..');
const enMessages = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/web/messages/en.json'), 'utf8'));
const koMessages = JSON.parse(fs.readFileSync(path.join(rootDir, 'apps/web/messages/ko.json'), 'utf8'));

// Find all TSX/TS files
const files = execSync('find apps/web/src -name "*.tsx" -o -name "*.ts"', { encoding: 'utf8', cwd: rootDir })
  .trim()
  .split('\n')
  .filter(f => !f.includes('.test.') && !f.includes('.spec.'));

const issues = [];
const namespaceUsage = new Map();

files.forEach(file => {
  const content = fs.readFileSync(path.join(rootDir, file), 'utf8');

  // Extract useTranslations() calls to find namespace
  const namespaceMatch = content.match(/useTranslations\(['"]([\w]+)['"]\)/);
  if (!namespaceMatch) return;

  const namespace = namespaceMatch[1];

  // Extract all t() calls
  const tCallMatches = content.matchAll(/\{?t\(['"]([\w]+)['"]\)/g);

  for (const match of tCallMatches) {
    const key = match[1];
    const fullKey = `${namespace}.${key}`;

    // Track usage
    if (!namespaceUsage.has(namespace)) {
      namespaceUsage.set(namespace, new Set());
    }
    namespaceUsage.get(namespace).add(key);

    // Check if key exists
    const enValue = enMessages[namespace]?.[key];
    const koValue = koMessages[namespace]?.[key];

    if (!enValue) {
      issues.push({
        file,
        namespace,
        key,
        fullKey,
        missing: ['en'],
        type: 'missing_en'
      });
    }

    if (!koValue) {
      issues.push({
        file,
        namespace,
        key,
        fullKey,
        missing: ['ko'],
        type: 'missing_ko'
      });
    }
  }
});

// Report
console.log('\n=== Translation Key Validation Report ===\n');

if (issues.length === 0) {
  console.log('✅ All translation keys are valid!\n');
} else {
  console.log(`❌ Found ${issues.length} issues:\n`);

  const missingEn = issues.filter(i => i.type === 'missing_en');
  const missingKo = issues.filter(i => i.type === 'missing_ko');

  if (missingEn.length > 0) {
    console.log(`\n🚨 Missing in en.json (${missingEn.length}):`);
    missingEn.forEach(issue => {
      console.log(`  - ${issue.fullKey} (used in ${issue.file})`);
    });
  }

  if (missingKo.length > 0) {
    console.log(`\n🚨 Missing in ko.json (${missingKo.length}):`);
    missingKo.forEach(issue => {
      console.log(`  - ${issue.fullKey} (used in ${issue.file})`);
    });
  }

  console.log('\n');
  process.exit(1);
}

console.log('Namespace usage summary:');
for (const [namespace, keys] of namespaceUsage.entries()) {
  console.log(`  ${namespace}: ${keys.size} keys`);
}
console.log('');
