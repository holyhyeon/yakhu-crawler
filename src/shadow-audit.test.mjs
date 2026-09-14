import assert from 'node:assert/strict';
import {
  SHADOW_SAMPLE_MODULUS,
  selectShadowAudits,
  stableShadowHash,
} from './shadow-audit.mjs';

function candidate(sourceUrl, overrides = {}) {
  return {
    source: 'inven',
    category: '인벤',
    sourcePostId: 'post-1',
    sourceUrl,
    title: '테스트 제목',
    bodyText: '테스트 본문',
    mediaUrls: [
      'https://upload1.inven.co.kr/upload/2026/01/a.jpg',
      'https://upload1.inven.co.kr/upload/2026/01/b.gif',
      'https://upload1.inven.co.kr/upload/2026/01/c.mp4',
      'https://upload1.inven.co.kr/upload/2026/01/d.jpg',
    ],
    ...overrides,
  };
}

function result(sourcePostId = 'post-1', overrides = {}) {
  return { sourcePostId, status: 'rejected', reason: 'no_target_signal', ...overrides };
}

let sampledUrl = '';
let unsampledUrl = '';
for (let index = 0; index < 1000 && (!sampledUrl || !unsampledUrl); index += 1) {
  const url = `https://www.inven.co.kr/board/webzine/2097/${index + 1}`;
  if (stableShadowHash(url) % SHADOW_SAMPLE_MODULUS === 0 && !sampledUrl) sampledUrl = url;
  if (stableShadowHash(url) % SHADOW_SAMPLE_MODULUS !== 0 && !unsampledUrl) unsampledUrl = url;
}
assert.ok(sampledUrl && unsampledUrl);

const sampled = selectShadowAudits([candidate(sampledUrl)], [result()], 'run-a');
assert.equal(sampled.eligibleCount, 1);
assert.equal(sampled.sampledCount, 1);
assert.equal(sampled.audits[0].qualityDecision, 'reject');
assert.equal(sampled.audits[0].qualityReason, 'no_target_signal');
assert.equal(sampled.audits[0].mediaCount, 3);
assert.deepEqual(JSON.parse(sampled.audits[0].mediaTypesJson), ['image', 'gif', 'video']);

const unsampled = selectShadowAudits([candidate(unsampledUrl)], [result()], 'run-b');
assert.equal(unsampled.eligibleCount, 1);
assert.equal(unsampled.sampledCount, 0);

for (const rejectedResult of [
  result('post-1', { reason: 'explicit_minor' }),
  result('post-1', { reason: 'non_real_content' }),
  result('post-1', { status: 'accepted', reason: undefined }),
]) {
  const excluded = selectShadowAudits([candidate(sampledUrl)], [rejectedResult], 'run-c');
  assert.equal(excluded.sampledCount, 0);
}

const otherCategory = selectShadowAudits([candidate(sampledUrl, { category: '인벤 치어리더 움짤' })], [result()], 'run-d');
assert.equal(otherCategory.sampledCount, 0);

const duplicateRows = selectShadowAudits(
  [candidate(sampledUrl)],
  [result(), result()],
  'run-e',
);
assert.equal(duplicateRows.eligibleCount, 1);
assert.equal(duplicateRows.sampledCount, 1);

console.log('shadow audit fixture tests passed');
