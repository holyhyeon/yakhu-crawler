const LIST_URL = "https://www.inven.co.kr/board/webzine/2097";
const SOURCE_AGENT = "Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)";
const PAGE_CAP = 3;
const CANDIDATE_CAP = 15;
const CATEGORY_PAGE_CAP = 2;
const CATEGORY_CANDIDATE_CAP = 15;
const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 250;

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function plainText(value) {
  return decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:comment|reply|recommend|advertisement)\b[^>]*>[\s\S]*?<\/(?:comment|reply|recommend|advertisement)>/gi, " ")
    .replace(/<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: { "user-agent": SOURCE_AGENT, "accept-language": "ko-KR,ko;q=0.9", referer },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("source_" + response.status);
  return response.text();
}

function boardRegexPath(board) {
  return String(board).split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\/');
}

export function extractListing(html, {
  board = 'webzine/2097',
  categoryLabel = '인벤',
  sourcePostIdPrefix = false,
  candidateCap = CANDIDATE_CAP,
} = {}) {
  const items = new Map();
  const pattern = new RegExp(`<a\\b[^>]*href=["']((?:https?:\\/\\/www\\.inven\\.co\\.kr)?\\/board\\/${boardRegexPath(board)}\\/(\\d+))[^"']*["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  for (const match of html.matchAll(pattern)) {
    const sourcePostId = sourcePostIdPrefix ? `${board}:${match[2]}` : match[2];
    const title = plainText(match[3]).slice(0, 300);
    if (title && !items.has(sourcePostId)) items.set(sourcePostId, {
      source: "inven",
      sourcePostId,
      sourceUrl: new URL(`/board/${board}/${match[2]}`, "https://www.inven.co.kr").href,
      title,
      category: categoryLabel,
    });
  }
  return [...items.values()].slice(0, candidateCap);
}

function contentScope(html) {
  return html.match(/<div[^>]+id=["']powerbbsContent["'][^>]*>[\s\S]*?(?:<!--[\s]*End\s+CONTENT|<\/div>\s*<\/div>)/i)?.[0] || "";
}

export function extractBodyText(html) {
  return plainText(contentScope(html)).slice(0, 5000);
}

export function extractMediaUrls(html) {
  const urls = [];
  const pattern = /<(?:img|video|source)\b[^>]+(?:src|data-original|data-src)=["']((?:https?:)?\/\/[^"']+)["']/gi;
  for (const match of contentScope(html).matchAll(pattern)) {
    const raw = match[1].replace(/&amp;/g, "&");
    const url = raw.startsWith("//") ? "https:" + raw : raw;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && /^upload\d*\.inven\.co\.kr$/i.test(parsed.hostname) && /^\/upload\//i.test(parsed.pathname)) urls.push(parsed.href);
    } catch {}
  }
  return [...new Set(urls)].slice(0, 3);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

export async function collectInven({ pages = 3 } = {}) {
  const pageCount = Math.min(PAGE_CAP, Math.max(1, Number.isFinite(Number(pages)) ? Math.floor(Number(pages)) : PAGE_CAP));
  const discovered = new Map();
  let pageFailures = 0;
  for (let page = 1; page <= pageCount; page++) {
    try {
      const html = await fetchText(LIST_URL + "?p=" + page, LIST_URL);
      for (const candidate of extractListing(html)) discovered.set(candidate.sourcePostId, candidate);
    } catch { pageFailures++; }
    if (page < pageCount) await sleep(DETAIL_DELAY_MS);
  }
  let detailSuccess = 0;
  let detailFailure = 0;
  const candidates = (await mapLimit([...discovered.values()], DETAIL_CONCURRENCY, async (candidate) => {
    await sleep(DETAIL_DELAY_MS);
    try {
      const html = await fetchText(candidate.sourceUrl, LIST_URL);
      detailSuccess++;
      return { ...candidate, bodyText: extractBodyText(html), publishedAt: null, mediaUrls: extractMediaUrls(html) };
    } catch { detailFailure++; return null; }
  })).filter(Boolean);
  return { candidates, metrics: { discovered: discovered.size, detailSuccess, detailFailure, pageFailures, candidates: candidates.length } };
}

function categoryListUrl(board, category, page) {
  const url = new URL(`https://www.inven.co.kr/board/${board}`);
  url.searchParams.set('category', category);
  url.searchParams.set('vtype', 'pc');
  if (page > 1) url.searchParams.set('p', String(page));
  return url.href;
}

export async function collectInvenCategory({
  board,
  category,
  categoryLabel,
  pages = CATEGORY_PAGE_CAP,
  candidateCap = CATEGORY_CANDIDATE_CAP,
} = {}) {
  if (!board || !category || !categoryLabel) throw new Error('missing_inven_category_config');
  const pageCount = Math.min(CATEGORY_PAGE_CAP, Math.max(1, Number.isFinite(Number(pages)) ? Math.floor(Number(pages)) : CATEGORY_PAGE_CAP));
  const discovered = new Map();
  let pageFailures = 0;
  const listUrl = categoryListUrl(board, category, 1);
  for (let page = 1; page <= pageCount && discovered.size < candidateCap; page++) {
    try {
      const url = categoryListUrl(board, category, page);
      const html = await fetchText(url, listUrl);
      for (const candidate of extractListing(html, {
        board,
        categoryLabel,
        sourcePostIdPrefix: true,
        candidateCap,
      })) discovered.set(candidate.sourcePostId, candidate);
    } catch { pageFailures++; }
    if (page < pageCount) await sleep(DETAIL_DELAY_MS);
  }
  let detailSuccess = 0;
  let detailFailure = 0;
  const candidates = (await mapLimit([...discovered.values()], DETAIL_CONCURRENCY, async (candidate) => {
    await sleep(DETAIL_DELAY_MS);
    try {
      const html = await fetchText(candidate.sourceUrl, listUrl);
      detailSuccess++;
      return { ...candidate, bodyText: extractBodyText(html), publishedAt: null, mediaUrls: extractMediaUrls(html) };
    } catch { detailFailure++; return null; }
  })).filter(Boolean);
  const withMedia = candidates.filter((candidate) => candidate.mediaUrls.length > 0);
  return {
    candidates: withMedia,
    metrics: {
      discovered: discovered.size,
      detailSuccess,
      detailFailure,
      pageFailures,
      candidates: withMedia.length,
    },
  };
}
