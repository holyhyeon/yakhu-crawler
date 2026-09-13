import { extractBodyText, extractListing, extractMediaUrls, extractPublishedAt } from './src/sources/bobaedream.mjs';
import { sendToSite } from './src/ingest.mjs';

const LIST_URL = 'https://www.bobaedream.co.kr/list?code=nsfw';
const USER_AGENT = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const PAGE_COUNT = 4;
const DELAY_MS = 300;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url, referer, retries = 1) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, 'accept-language': 'ko-KR,ko;q=0.9', referer },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      const html = new TextDecoder('utf-8').decode(await response.arrayBuffer());
      if ([401, 403, 429].includes(response.status)) throw new Error('blocked_' + response.status);
      if (!response.ok) throw new Error('http_' + response.status);
      return { html, url: response.url };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(DELAY_MS);
    }
  }
  throw lastError;
}

async function mapLimit(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return output;
}

const startedAt = Date.now();
const discovered = new Map();
let listFailures = 0;
for (let page = 1; page <= PAGE_COUNT; page++) {
  try {
    const url = new URL(LIST_URL);
    if (page > 1) url.searchParams.set('page', String(page));
    const result = await fetchHtml(url.href, LIST_URL);
    for (const candidate of extractListing(result.html, { pageUrl: result.url })) {
      if (!discovered.has(candidate.sourcePostId)) discovered.set(candidate.sourcePostId, candidate);
    }
  } catch (error) {
    listFailures++;
    console.log(JSON.stringify({ stage: 'list', page, error: error instanceof Error ? error.message : 'unknown' }));
  }
  if (page < PAGE_COUNT) await sleep(DELAY_MS);
}

let detailSuccess = 0;
let detailFailure = 0;
let mediaSuccess = 0;
let mediaUrlMissing = 0;
let chzzkOnly = 0;
const candidates = [];
const rows = await mapLimit([...discovered.values()], 2, async (candidate) => {
  await sleep(DELAY_MS);
  try {
    const result = await fetchHtml(candidate.sourceUrl, candidate.sourceUrl);
    const mediaUrls = extractMediaUrls(result.html, { pageUrl: result.url });
    detailSuccess++;
    if (mediaUrls.length === 0) {
      mediaUrlMissing++;
      if (/chzzk\.naver\.com/i.test(result.html)) chzzkOnly++;
      return null;
    }
    mediaSuccess++;
    return {
      ...candidate,
      bodyText: extractBodyText(result.html),
      publishedAt: extractPublishedAt(result.html, candidate.publishedAt),
      mediaUrls,
    };
  } catch (error) {
    detailFailure++;
    console.log(JSON.stringify({ stage: 'detail', sourcePostId: candidate.sourcePostId, error: error instanceof Error ? error.message : 'unknown' }));
    return null;
  }
});
for (const row of rows) if (row) candidates.push(row);

const ingest = await sendToSite(candidates, {
  siteUrl: process.env.YAKHU_SITE_URL,
  secret: process.env.YAKHU_INGEST_SECRET,
});
console.log(JSON.stringify({
  source: 'bobaedream',
  pages: PAGE_COUNT,
  discovered: discovered.size,
  listFailures,
  detailSuccess,
  detailFailure,
  mediaSuccess,
  mediaUrlMissing,
  chzzkOnly,
  submitted: candidates.length,
  accepted: ingest.accepted,
  review: ingest.review,
  rejected: ingest.rejected,
  duplicate: ingest.duplicate,
  failed: ingest.failed,
  runtimeMs: Date.now() - startedAt,
}));
if (detailFailure || listFailures || ingest.failed) process.exitCode = 1;
