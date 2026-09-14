import assert from 'node:assert/strict';
import { extractBodyText, extractDetailTitle, extractListing, extractMediaUrls } from './inven.mjs';

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

console.log('inven fixture ok');
