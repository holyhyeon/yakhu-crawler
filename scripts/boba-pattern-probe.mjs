import { extractListing, extractMediaUrls } from '../src/sources/bobaedream.mjs';

const LIST = 'https://www.bobaedream.co.kr/list?code=nsfw';
const UA = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function attr(tag, name) {
  const text = String(tag || '');
  const m = text.match(new RegExp(name + '=([\\x22\\x27])([\\s\\S]*?)\\1', 'i'));
  return m ? m[2].replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'") : '';
}
function normalizedUrl(raw, base) {
  try {
    const u = new URL(raw, base);
    return { host: u.hostname, path: u.pathname, ext: (u.pathname.match(/\\.([a-z0-9]{2,5})(?:$|[?#])/i) || [])[1] || '' };
  } catch { return null; }
}
function summarize(html, base) {
  const source = String(html || '');
  const tags = [...source.matchAll(/<(img|video|source|a|iframe|script)[ >]/gi)];
  const tagCounts = {};
  const attrCounts = {};
  const samples = [];
  let mediaHostHits = 0;
  for (const m of tags) {
    const tagName = m[1].toLowerCase();
    tagCounts[tagName] = (tagCounts[tagName] || 0) + 1;
    const attrs = m[0] || '';
    for (const name of ['src','data-src','data-original','data-lazy-src','lazy-src','href','poster','style']) {
      if (attrs.toLowerCase().includes(name.toLowerCase() + '=')) attrCounts[name] = (attrCounts[name] || 0) + 1;
      const raw = attr(m[0], name);
      if (!raw) continue;
      const u = normalizedUrl(raw, base);
      if (!u) continue;
      if (/file\\d*\\.bobaedream\\.co\\.kr/i.test(u.host) || /(?:upload|attach|image|img|media|files|photo)/i.test(u.path)) {
        mediaHostHits++;
        if (samples.length < 8) samples.push({ tag: tagName, attr: name, host: u.host, path: u.path.slice(0, 140), ext: u.ext });
      }
    }
  }
  const lower = source.toLowerCase();
  const signalCounts = {};
  for (const signal of ['content_video','chzzk','iframe','video','source','img','file','image','attach','media','player','videoid','data-url','data-file']) signalCounts[signal] = lower.split(signal).length - 1;
  const escapedTagCounts = {};
  for (const tag of ['img','video','source','iframe','a']) escapedTagCounts[tag] = lower.split('&lt;' + tag).length - 1;
  const snippets = [];
  for (const marker of ['content_video','chzzk','videoid','data-url','data-file','iframe','player']) {
    const index = lower.indexOf(marker);
    if (index >= 0) snippets.push({ marker, text: source.slice(Math.max(0, index - 80), index + 280).replaceAll('\\n', ' ').replaceAll('\\r', ' ') });
  }
  return { tagCounts, attrCounts, mediaHostHits, samples, signalCounts, escapedTagCounts, snippets };
}
async function get(url, referer) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'ko-KR,ko;q=0.9', referer }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  return { status: res.status, url: res.url, html: await res.text() };
}

const posts = new Map();
for (let page = 1; page <= 4; page++) {
  const pageUrl = page === 1 ? LIST : LIST + '&page=' + page;
  const pageRes = await get(pageUrl, LIST);
  for (const row of extractListing(pageRes.html, { pageUrl: pageRes.url })) posts.set(row.sourcePostId, row);
  await sleep(300);
}
const missing = [];
const success = [];
for (const row of [...posts.values()]) {
  if (missing.length >= 24 && success.length >= 3) break;
  const detail = await get(row.sourceUrl, row.sourceUrl);
  const media = extractMediaUrls(detail.html, { pageUrl: detail.url });
  if (media.length) {
    if (success.length < 3) success.push({ id: row.sourcePostId, title: row.title, mediaCount: media.length, summary: summarize(detail.html, detail.url) });
  } else if (missing.length < 24) {
    missing.push({ id: row.sourcePostId, title: row.title, status: detail.status, summary: summarize(detail.html, detail.url) });
  }
  await sleep(300);
}
console.log(JSON.stringify({ sampled: posts.size, missingCount: missing.length, successCount: success.length, missing, success }, null, 2));
