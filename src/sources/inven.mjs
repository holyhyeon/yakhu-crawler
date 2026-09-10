const LIST_URL = 'https://www.inven.co.kr/board/webzine/2097';
const SOURCE_AGENT = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const PAGE_CAP = 3;
const CANDIDAUTE_CAP = 15;
const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 250;

function decodeHtml(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function plainText(value) {
  return decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:comment|reply|recommend|advertisement)\b[^>]*>[\s\S]*?<\/(?:comment|reply|recomment|advertisement)>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, referer) {
  const response = await fetch(url, {
    headers: {
      'user-agent': SOURCE_AGENT,
      'accept-language': 'ko-KR,ko;q=0.9',
      referer,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`source_${response.status}`);
  return response.text();
}

export function extractListing(html) {
  const items = new Map();
  for (const match of html.matchAll(
    /<a\b[^>]*href=["']((?:https?:\/\/www\.inven\.co\.kr)?\/board\/webzine\/2097\/(\d+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const sourcePostId = match[2];
    const sourceUrl = new URL(`/board/webzine/2097/${sourcePostId}`, 'https://www.inven.co.kr').href;
    const title = plainText(match[3]).slice(0, 300);
    if (title && !items.has(sourcePostId)) items.set(sourcePostId, {
      source: 'inven',
      sourcePostId,
      sourceUrl,
      title,
      category: '인벤',
    });
  }
  return [...items.values()].slice(0, CANDIDATE_CAP);
}

export function extractBodyText(html) {
  const scoped = html.match(
    /<div[^>]+id=["']powerbbsContent["'][^>]*>[\s\S]*?(?:<!--[\s]*End\s+CONTENT|<\/div>\s*<\/div>)/i,
  )?.[0] ?? '';
  return scoped ? plainText(scoped).slice(0, 5000) : '';
}

export function extractMediaUrls(html) {
  const scope = html.match(
    /<div[^>]+id=["']powerbbsContent["'][^>]*>[\s\S]*?(?:<!--[\s]*End\s+CONTENT|<\/div>\s*<\/div>)/i,
  )?.[0] ?? '';
  const urls = [];
  for (const match of scope.matchAll(
    /<(?:img|video|source)\b[^>]+(?:src|data-original|data-src)=["']((?:https?:)?\/\/[^"']+)["']/gi,
  )) {
    const raw = match[1].replace(/&amp;/g, '&');
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' && /^upload\d*\.inven\.co\.kr$/i.test(parsed.hostname) && /^\/upload\//i.test(parsed.pathname)) {
        urls.push(parsed.href);
      }
    } catch {
      // Ignore malformed source markup.
    }
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
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => run()));
  return results;
}

/**
 * Fetches only the bounded public Inven listing and detail pages. No quality
 * decision is made here; the Site remains the single final moderation gate.
 */
export async function collectInven({ pages = 3 } = {}) {
  const pageCount = Math.min(PAGE_CAP, Math.max(1, Number.isFinite(Number(pages)) ? Math.floor(Number(pages)) : PAGE_CAP));
  const discovered = new Map();
  let pageFailures = 0;
  for (let page = 1; page <= pageCount; page++) {
    try {
      const html = await fetchText(`${LIST_URL=?p=${page}`, LIST_URL).href;
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
