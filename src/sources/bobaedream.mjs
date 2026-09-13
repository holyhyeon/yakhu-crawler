const LIST_URL = 'https://www.bobaedream.co.kr/list?code=nsfw';
const BOARD_CODE = 'nsfw';
const SOURCE_AGENT = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const PAGE_CAP = 2;
const CANDIDATES_PER_PAGE = 15;
const DETAIL_CONCURRENCY = 2;
const DETAIL_DELAY_MS = 300;
const MAX_MEDIA = 20;

export class BobaedreamSourceError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BobaedreamSourceError';
    this.code = code;
  }
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function plainText(value) {
  return decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function attribute(tag, name) {
  const match = String(tag || '').match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : '';
}

function absoluteUrl(raw, base) {
  try {
    const url = new URL(decodeHtml(raw), base);
    if (url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function balancedElement(source, tag, token, attributeName = 'class|id') {
  const open = new RegExp(
    `<${tag}\\b[^>]*(?:${attributeName})\\s*=\\s*["'][^"']*${token}[^"']*["'][^>]*>`,
    'i',
  ).exec(source);
  if (!open || open.index == null) return '';
  const tags = new RegExp(`(?:<${tag}\\b[^>]*>|</${tag}\\s*>)`, 'gi');
  tags.lastIndex = open.index;
  let depth = 0;
  let match;
  while ((match = tags.exec(source))) {
    if (/^<\//.test(match[0])) depth--;
    else if (!/\/\\s*>$/.test(match[0])) depth++;
    if (depth === 0) return source.slice(open.index, tags.lastIndex);
  }
  return '';
}

function articleRoot(html) {
  const source = String(html || '');
  return balancedElement(source, 'div', 'print[_-]?area')
    || balancedElement(source, 'section', 'print[_-]?area')
    || balancedElement(source, 'div', 'view[_-]?(?:content|body)|article[_-]?(?:content|body)')
    || balancedElement(source, 'div', 'conView');
}

function articleMarkerScope(html) {
  const source = String(html || '');
  const open = /<div\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:print[_-]?area|content02|bodyCont)[^"']*["'][^>]*>/i.exec(source);
  if (!open || open.index == null) return '';
  const start = open.index;
  const bodyEnd = /<!--\s*본문\s*끝\s*-->/i.exec(source.slice(start + open[0].length));
  if (!bodyEnd) return '';
  return source.slice(start, start + open[0].length + bodyEnd.index);
}

function boardListRoot(html) {
  const source = String(html || '');
  return balancedElement(source, 'table', 'boardlist', 'id')
    || balancedElement(source, 'div', 'boardlist', 'id|class')
    || source;
}

function parseBoardUrl(raw, base = LIST_URL) {
  const href = absoluteUrl(raw, base);
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.hostname.toLowerCase() !== 'www.bobaedream.co.kr') return null;
    if (!/^\/view(?:\.php)?\/?$/i.test(url.pathname)) return null;
    const code = url.searchParams.get('code');
    const no = url.searchParams.get('No') || url.searchParams.get('no');
    if (code !== BOARD_CODE || !no || !/^\d+$/.test(no)) return null;
    return {
      sourcePostId: `${BOARD_CODE}:${no}`,
      sourceUrl: `https://www.bobaedream.co.kr/view?code=${BOARD_CODE}&No=${no}`,
      no,
    };
  } catch {
    return null;
  }
}

function parseDateText(value, now = new Date()) {
  const text = plainText(String(value || ''));
  let match = text.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})(?:\s*\([^)]*\))?\s*(\d{1,2}):(\d{2})/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]) - 9, Number(match[5])));
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  match = text.match(/(\d{1,2})[\/:](\d{2})/);
  if (match && !/\d{1,2}[.\/-]\d{1,2}/.test(text)) {
    const date = new Date(now);
    date.setUTCHours(Number(match[1]) - 9, Number(match[2]), 0, 0);
    if (date.getTime() > now.getTime() + 60 * 60 * 1000) date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString();
  }
  match = text.match(/(\d{1,2})[.\/-](\d{1,2})(?!\d)/);
  if (match) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), Number(match[1]) - 1, Number(match[2]), 0, 0));
    if (date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) date.setUTCFullYear(date.getUTCFullYear() - 1);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function normalizeTitle(value) {
  return plainText(value)
    .replace(/^\s*인기\s*/i, '')
    .replace(/\s*\(\s*\d+\s*\)\s*$/i, '')
    .trim()
    .slice(0, 300);
}

function isNoiseTitle(title) {
  return /(?:^|[\s\[【])(공지|운영\s*규정|이벤트|게시판\s*안내|광고|협찬|프로모션)(?:$|[\s\]】])/i.test(title);
}

export function extractListing(html, { pageUrl = LIST_URL } = {}) {
  const scope = boardListRoot(html);
  const items = new Map();
  for (const match of scope.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const parsed = parseBoardUrl(attribute(match[1], 'href'), pageUrl);
    if (!parsed) continue;
    const title = normalizeTitle(match[2]);
    if (!title) continue;
    const rowStart = scope.lastIndexOf('<tr', match.index ?? 0);
    const rowEnd = scope.indexOf('</tr>', match.index ?? 0);
    const row = rowStart >= 0 && rowEnd > rowStart ? scope.slice(rowStart, rowEnd) : match[0];
    const candidate = {
      source: 'bobaedream',
      sourcePostId: parsed.sourcePostId,
      sourceUrl: parsed.sourceUrl,
      title,
      bodyText: '',
      publishedAt: parseDateText(row),
      mediaUrls: [],
      category: '보배드림 후방주의방',
      noise: isNoiseTitle(title),
    };
    const old = items.get(parsed.sourcePostId);
    if (!old || candidate.title.length > old.title.length) items.set(parsed.sourcePostId, candidate);
  }
  return [...items.values()]
    .filter((item) => !item.noise)
    .slice(0, CANDIDATES_PER_PAGE)
    .map(({ noise, ...item }) => item);
}

function mediaUrlAllowed(url) {
  try {
    const parsed = new URL(url);
    if (!/^file\d*\.bobaedream\.co\.kr$/i.test(parsed.hostname)) return false;
    if (/logo|icon|avatar|emoji|favicon|banner|advert|sponsor|btn_|button|level\//i.test(parsed.href)) return false;
    return /\.(?:jpe?g|png|gif|webp|avif|mp4|webm)(?:[?#]|$)/i.test(parsed.pathname + parsed.search)
      || /(?:upload|attach|image|img|media|files|photo|thumbnail)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function extractMediaUrls(html, { pageUrl } = {}) {
  const root = articleMarkerScope(html) || articleRoot(html);
  const urls = [];
  for (const tagMatch of root.matchAll(/<(?:img|video|source|a)\b[^>]*>/gi)) {
    const tag = tagMatch[0];
    for (const attributeName of ['src', 'data-src', 'data-original', 'href']) {
      const raw = attribute(tag, attributeName);
      if (!raw) continue;
      const url = absoluteUrl(raw, pageUrl || LIST_URL);
      if (url && mediaUrlAllowed(url)) urls.push(url);
    }
  }
  return [...new Set(urls)].slice(0, MAX_MEDIA);
}

export function extractBodyText(html) {
  const root = articleRoot(html);
  if (!root) return '';
  const body = root
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:img|video|source|iframe|svg)\b[^>]*>[\s\S]*?<\/(?:video|svg)>/gi, ' ')
    .replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, ' ');
  return plainText(body).slice(0, 5000);
}

export function extractPublishedAt(html, fallback = null) {
  const root = articleRoot(html);
  return parseDateText(root) || fallback;
}

function isBlockedResponse(status, url, html) {
  if ([401, 403, 429].includes(status)) return true;
  if (/\/login(?:[/?]|$)|\/adult(?:[/?]|$)|age[-_]?check/i.test(url)) return true;
  return /captcha|cloudflare|ddos|security\s*check|접근\s*제한|성인\s*(?:인증|전용)|본인\s*인증/i.test(
    `${html.match(/<title[^>]*>[\s\S]*?<\/title>/i)?.[0] || ''} ${String(html).slice(0, 6000)}`,
  );
}

async function fetchText(url, referer, { retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'user-agent': SOURCE_AGENT,
          'accept-language': 'ko-KR,ko;q=0.9',
          referer,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      const buffer = await response.arrayBuffer();
      const html = new TextDecoder('utf-8').decode(buffer);
      if (isBlockedResponse(response.status, response.url, html)) {
        throw new BobaedreamSourceError('blocked', `source_${response.status || 'challenge'}`);
      }
      if (!response.ok) {
        throw new BobaedreamSourceError('http', `source_${response.status}`);
      }
      if (!/text\/html|application\/xhtml/i.test(response.headers.get('content-type') || '')) {
        throw new BobaedreamSourceError('content_type', 'expected_html');
      }
      return { html, url: response.url, status: response.status };
    } catch (error) {
      lastError = error;
      if (error instanceof BobaedreamSourceError && error.code === 'blocked') throw error;
      if (attempt < retries) await sleep(DETAIL_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new BobaedreamSourceError('network');
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

function pageUrl(page) {
  const url = new URL(LIST_URL);
  if (page > 1) url.searchParams.set('page', String(page));
  return url.href;
}

/**
 * Collects only the public, exact code=nsfw board. The Site remains the
 * single moderation, dedupe, fingerprint, and storage authority.
 */
export async function collectBobaedream({ pages = 1 } = {}) {
  const pageCount = Math.min(PAGE_CAP, Math.max(1, Number.isFinite(Number(pages)) ? Math.floor(Number(pages)) : 1));
  const discovered = new Map();
  let pageFailures = 0;
  let blocked = false;
  let failureReason = null;
  for (let page = 1; page <= pageCount; page++) {
    try {
      const result = await fetchText(pageUrl(page), LIST_URL);
      const pageCandidates = extractListing(result.html, { pageUrl: result.url });
      if (!pageCandidates.length) {
        pageFailures++;
        failureReason = failureReason || 'no_board_posts';
      }
      for (const candidate of pageCandidates) {
        if (!discovered.has(candidate.sourcePostId)) discovered.set(candidate.sourcePostId, candidate);
      }
    } catch (error) {
      pageFailures++;
      if (error instanceof BobaedreamSourceError && error.code === 'blocked') {
        blocked = true;
        failureReason = error.message;
        break;
      }
    }
    if (page < pageCount) await sleep(DETAIL_DELAY_MS);
  }

  let detailSuccess = 0;
  let detailFailure = 0;
  const detailRows = await mapLimit([...discovered.values()], DETAIL_CONCURRENCY, async (candidate) => {
    await sleep(DETAIL_DELAY_MS);
    if (blocked) return null;
    try {
      const result = await fetchText(candidate.sourceUrl, candidate.sourceUrl);
      const mediaUrls = extractMediaUrls(result.html, { pageUrl: result.url });
      detailSuccess++;
      return {
        ...candidate,
        bodyText: extractBodyText(result.html),
        publishedAt: extractPublishedAt(result.html, candidate.publishedAt),
        mediaUrls,
      };
    } catch (error) {
      detailFailure++;
      if (error instanceof BobaedreamSourceError && error.code === 'blocked') {
        blocked = true;
        failureReason = error.message;
      }
      return null;
    }
  });
  const candidates = detailRows.filter(Boolean);
  return {
    candidates,
    metrics: {
      discovered: discovered.size,
      detailSuccess,
      detailFailure,
      pageFailures,
      candidates: candidates.length,
      mediaDetected: candidates.filter((item) => item.mediaUrls.length > 0).length,
      mediaTotal: candidates.reduce((total, item) => total + item.mediaUrls.length, 0),
      blocked,
      failureReason,
    },
  };
}
