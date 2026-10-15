// [SID:4696] the download card's bucket is a deployment setting — pinned where it is set (cloudbuild.yaml's frontend deploy step):
// dev names dev's bucket, prod names prod's own, and prod's branch never carries the dev one (a prod customer must not be sent to the
// dev app, which talks to the dev server).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const yaml = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'cloudbuild.yaml'), 'utf8');
const dev = yaml.slice(yaml.indexOf('if [ "${_DEPLOY_ENV}" == "dev" ]; then\n          # #4398'), yaml.indexOf('elif [ "${_DEPLOY_ENV}" == "prod" ]; then\n          # #4398'));
const prod = yaml.slice(yaml.indexOf('elif [ "${_DEPLOY_ENV}" == "prod" ]; then\n          # #4398'), yaml.indexOf('gcloud run deploy sprintable-frontend-${_DEPLOY_ENV}'));

describe('cloudbuild.yaml — the download card\'s bucket', () => {
  it('found the two branches', () => {
    expect(dev).toContain('DESKTOP_DOWNLOAD_ENABLED=true');
    expect(prod).toContain('--remove-secrets=EDGE_CLIENT_IP_SECRET');
  });
  it('dev: the dev bucket · prod: prod\'s own bucket, and the dev one nowhere in it', () => {
    expect(dev).toContain('DESKTOP_DOWNLOAD_BUCKET=sprintable-desktop-releases-dev"');
    expect(prod).toMatch(/DESKTOP_DOWNLOAD_ENABLED=true,DESKTOP_DOWNLOAD_BUCKET=sprintable-desktop-releases"/);
    expect(prod).not.toContain('releases-dev');
    expect(prod).not.toContain('SERVER_TIMING_MARKERS'); // (the existing dev-only marker stays dev-only)
  });
});
