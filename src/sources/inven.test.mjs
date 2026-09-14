import assert from 'node:assert/strict';
import { extractBodyText, extractDetailTitle, extractListing, extractMediaUrls, selectCategoryCandidates } from './inven.mjs';

const listing = extractListing(
  '<a href="/board/webzine/2097/2725741"> 비키니 모델 화보 </a>' +
  '<a href="/board/webzine/2097/2725741">중복 제목</a>',
);
assert.equal(listing.length, 1);
assert.equal(listing[0].sourcePostId, '2725741');
assert.equal(listing[0].sourceUrl, 'https://www.inven.co.kr/board/webzine/2097/2725741');
assert.equal(listing[0].title, '비키니 모델 화보');

const categoryListing = extractListing(
  '<a href="/board/party/6296/713"> 치어리더 움짤 </a>',
  { board: 'party/6296', categoryLabel: '치어리더 움짤', sourcePostIdPrefix: true },
);
assert.equal(categoryListing[0].sourcePostId, 'party/6296:713');
assert.equal(categoryListing[0].sourceUrl, 'https://www.inven.co.kr/board/party/6296/713');
assert.equal(categoryListing[0].category, '치어리더 움짤');

const detail = '<div id="powerbbsContent"><p>본문 설명</p>' +
  '<img src="https://upload2.inven.co.kr/upload/2026/09/10/example.jpg">' +
  '<img data-src="https://upload2.inven.co.kr/upload/2026/09/10/example-small.webp">' +
  '<img src="https://upload3.inven.co.kr/upload/2026/09/10/example.webp">' +
  '<video><source data-src="https://upload3.inven.co.kr/upload/2026/09/10/example.mp4"></video></div></div>' +
  '<h1>ㅇㅎ) 저 자연산 E컵이에요.</h1>';
assert.match(extractBodyText(detail), /본문 설명/);
assert.deepEqual(extractMediaUrls(detail), [
  'https://upload2.inven.co.kr/upload/2026/09/10/example.jpg',
  'https://upload2.inven.co.kr/upload/2026/09/10/example-small.webp',
  'https://upload3.inven.co.kr/upload/2026/09/10/example.webp',
  'https://upload3.inven.co.kr/upload/2026/09/10/example.mp4',
]);
assert.equal(extractDetailTitle(detail), 'ㅇㅎ) 저 자연산 E컵이에요.');

const actualTitle = '<h1 class="logo"><span class="is-blind">인벤</span></h1>' +
  '<meta property="og:title" content="(ㅎㅂ) 서안 발리여행 비키니">' +
  '<title>웹진 인벤 : (ㅎㅂ) 서안 발리여행 비키니 - 오픈이슈갤러리</title>' +
  '<div class="articleSubject"><div class="articleTitle"><h1>(ㅎㅂ) 서안 발리여행 비키니</h1></div></div>';
assert.equal(extractDetailTitle(actualTitle), '(ㅎㅂ) 서안 발리여행 비키니');

const openGraphFallback = '<h1 class="logo"><span class="is-blind">인벤</span></h1>' +
  '<meta property="og:title" content="발차기 시범을 보여주는 누나">';
assert.equal(extractDetailTitle(openGraphFallback), '발차기 시범을 보여주는 누나');

const documentFallback = '<h1 class="logo"><span class="is-blind">인벤</span></h1>' +
  '<title>웹진 인벤 : 실제 게시물 제목 - 오픈이슈갤러리</title>';
assert.equal(extractDetailTitle(documentFallback), '실제 게시물 제목');

assert.equal(extractDetailTitle('<h1 class="logo"><span class="is-blind">인벤</span></h1>'), '');

const candidates = Array.from({ length: 30 }, (_, index) => ({ sourcePostId: `party/6296:${index + 1}` }));
const allUnseen = selectCategoryCandidates(candidates, { candidateCap: 15, precheckSucceeded: true });
assert.deepEqual(allUnseen.selected.map((candidate) => candidate.sourcePostId), candidates.slice(0, 15).map((candidate) => candidate.sourcePostId));
assert.equal(allUnseen.seenSkipped, 0);
assert.equal(allUnseen.refilled, 0);

const partialSeen = selectCategoryCandidates(candidates, {
  candidateCap: 15,
  existingIds: candidates.slice(0, 5).map((candidate) => candidate.sourcePostId),
  precheckSucceeded: true,
});
assert.deepEqual(partialSeen.selected.map((candidate) => candidate.sourcePostId), candidates.slice(5, 20).map((candidate) => candidate.sourcePostId));
assert.equal(partialSeen.seenSkipped, 5);
assert.equal(partialSeen.refilled, 5);

const frontSaturated = selectCategoryCandidates(candidates, {
  candidateCap: 15,
  existingIds: candidates.slice(0, 15).map((candidate) => candidate.sourcePostId),
  precheckSucceeded: true,
});
assert.deepEqual(frontSaturated.selected.map((candidate) => candidate.sourcePostId), candidates.slice(15, 30).map((candidate) => candidate.sourcePostId));
assert.equal(frontSaturated.refilled, 15);

const fullSaturated = selectCategoryCandidates(candidates, {
  candidateCap: 15,
  existingIds: candidates.map((candidate) => candidate.sourcePostId),
  precheckSucceeded: true,
});
assert.equal(fullSaturated.selected.length, 0);

const precheckFallback = selectCategoryCandidates(candidates, { candidateCap: 15, precheckSucceeded: false });
assert.deepEqual(precheckFallback.selected.map((candidate) => candidate.sourcePostId), candidates.slice(0, 15).map((candidate) => candidate.sourcePostId));

const priorRejectIsUnseen = selectCategoryCandidates(candidates, {
  candidateCap: 15,
  existingIds: ['party/6296:9999'],
  precheckSucceeded: true,
});
assert.equal(priorRejectIsUnseen.selected.length, 15);

console.log('inven fixture ok');
