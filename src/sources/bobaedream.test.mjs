import assert from 'node:assert/strict';
import {
  extractBodyText,
  extractListing,
  extractMediaUrls,
  extractPublishedAt,
} from './bobaedream.mjs';

const listing = extractListing(`
  <table id="boardlist"><tbody>
    <tr><td><a href="/view?code=nsfw&No=8014">어흐어흐 슴가</a></td><td>00:52</td></tr>
    <tr><td><a href="/view?code=nsfw&No=8013">인기올려주는 흰셔츠 가슴골 <span>(2)</span></a></td><td>09/03</td></tr>
    <tr><td><a href="/view?code=nsfw&No=9000">공지 게시판 운영 규정</a></td><td>09/01</td></tr>
    <tr><td><a href="/view?code=other&No=1">다른 게시판</a></td><td>09/01</td></tr>
  </tbody></table>
`);
assert.equal(listing.length, 2);
assert.equal(listing[0].sourcePostId, 'nsfw:8014');
assert.equal(listing[0].sourceUrl, 'https://www.bobaedream.co.kr/view?code=nsfw&No=8014');
assert.equal(listing[1].title, '올려주는 흰셔츠 가슴골');

const detail = `
  <header>사이트 navigation 후방주의방</header>
  <div class="conView">
    <div class="print_area">
      <div class="post_meta">제목 · 조회 100 · 2026.09.04 (금) 00:52</div>
      <p>본문에 남긴 설명입니다.</p>
      <a href="https://www.bobaedream.co.kr/view?code=nsfw&No=8014"><img src="https://file1.bobaedream.co.kr/nsfw/example-1.gif"></a>
      <video><source data-src="https://file1.bobaedream.co.kr/nsfw/example-2.mp4"></video>
      <img src="https://image.bobaedream.co.kr/level/avatar.gif">
    </div>
    <section class="related">관련글 광고 자동차 뉴스</section>
    <div class="cmt_reply">댓글 사이트 공통 문구</div>
  </div>
  <footer>footer 광고</footer>
`;
assert.match(extractBodyText(detail), /본문에 남긴 설명입니다/);
const tenMedia = `<div class="print_area">${Array.from({ length: 10 }, (_, index) => `<img src="https://file1.bobaedream.co.kr/nsfw/example-${index + 10}.jpg">`).join('')}</div>`;
assert.equal(extractMediaUrls(tenMedia, { pageUrl: 'https://www.bobaedream.co.kr/view?code=nsfw&No=8014' }).length, 10);

const markerScopedDetail = `
  <div id="print_area">
    <script>const template = "<div class='script-only'>";</script>
    <div class="bodyCont">
      <p><a href="#inlineContent"><img src="https://file1.bobaedream.co.kr/nsfw/fallback-image.jpg"></a></p>
      <video><source src="https://file1.bobaedream.co.kr/nsfw/fallback-video.mp4"></video>
    </div>
    <!-- 본문 끝 -->
  </div>
`;
assert.deepEqual(extractMediaUrls(markerScopedDetail, { pageUrl: 'https://www.bobaedream.co.kr/view?code=nsfw&No=8015' }), [
  'https://file1.bobaedream.co.kr/nsfw/fallback-image.jpg',
  'https://file1.bobaedream.co.kr/nsfw/fallback-video.mp4',
]);

const markerScopedAttachment = `
  <div class="content02">
    <script>const template = "<div class='script-only'>";</script>
    <p><a href="https://file1.bobaedream.co.kr/nsfw/fallback-attachment.webp">첨부 원본</a></p>
    <!-- 본문 끝 -->
  </div>
`;
assert.deepEqual(extractMediaUrls(markerScopedAttachment, { pageUrl: 'https://www.bobaedream.co.kr/view?code=nsfw&No=8016' }), [
  'https://file1.bobaedream.co.kr/nsfw/fallback-attachment.webp',
]);

assert.doesNotMatch(extractBodyText(detail), /navigation|관련글|댓글|footer|광고/);
assert.deepEqual(extractMediaUrls(detail, { pageUrl: 'https://www.bobaedream.co.kr/view?code=nsfw&No=8014' }), [
  'https://file1.bobaedream.co.kr/nsfw/example-1.gif',
  'https://file1.bobaedream.co.kr/nsfw/example-2.mp4',
]);
assert.match(extractPublishedAt(detail), /^2026-09-03T15:52:00/);

console.log('bobaedream fixture ok');
