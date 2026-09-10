import assert from 'node:assert/strict';
import { extractBodyText, extractListing, extractMediaUrls } from './inven.mjs';

const listing = extractListing(
  '<a href="/board/webzine/2097/2725741"> 비키니 모델 화보 </a>' +
  '<a href="/board/webzine/2097/2725741">중복 제목</a>',
);
assert.equal(listing.length, 1);
assert.equal(listing[0].sourcePostId, '2725741');
assert.equal(listing[0].sourceUrl, 'https://www.inven.co.kr/board/webzine/2097/2725741');
assert.equal(listing[0].title, '비키니 모델 화보');

const detail = '<div id="powerbbsContent"><p>본문 설명</p>' +
  '<img src="https://upload2.inven.co.kr/upload/2026/09/10/example.jpg">' +
  '<video><source data-src="https://upload3.inven.co.kr/upload/2026/09/10/example.mp4"></video></div></div>';
assert.match(extractBodyText(detail), /본문 설명/);
assert.deepEqual(extractMediaUrls(detail), [
  'https://upload2.inven.co.kr/upload/2026/09/10/example.jpg',
  'https://upload3.inven.co.kr/upload/2026/09/10/example.mp4',
]);

console.log('inven fixture ok');
