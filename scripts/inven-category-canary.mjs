import { extractBodyText, extractMediaUrls } from '../src/sources/inven.mjs';
import { sendToSite } from '../src/ingest.mjs';

const SOURCE_AGENT = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const TIMEOUT_MS = 15_000;
const DETAIL_CONCURRENCY = 3;
const PAGE_COUNT = 2;
const CATEGORY_LIMIT = 15;
const requested = (process.env.INVEN_CATEGORY_CANARY || 'both').toLowerCase();

const definitions = {
  cheer_gif: { label: '치어리더 움짤', board: 'party/6296', category: '움짤' },
  game_model: { label: '게임모델', board: 'webzine/2898', category: '게임모델' },
};

const selected = requested === 'both'
  ? Object.keys(definitions)
  : requested.split(',').map((value) => value.trim()).filter((value) => definitions[value]);

function decode(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function cleanText(value) {
  return decode(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(?:nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/(?:nav|header|footer|aside)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absoluteUrl(raw, base) {
  if (!raw || /^data:|^javascript:/i.test(raw)) return null;
  try { return new URL(raw.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}

async function fetchText(url, referer = 'https://www.inven.co.kr/') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': SOURCE_AGENT, 'accept-language': 'ko-KR,ko;q=0.9', referer },
      signal: controller.signal,
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, url: response.url, body };
  } finally {
    clearTimeout(timer);
  }
}

function listUrl(def, page) {
  const url = new URL(`https://www.inven.co.kr/board/${def.board}`);
  url.searchParams.set('category', def.category);
  url.searchParams.set('vtype', 'pc');
  if (page > 1) url.searchParams.set('p', String(page));
  return url.href;
}

function extractListing(html, def, base) {
  const boardPath = def.board.replace('/', '\\/');
  const re = new RegExp(`<a\\b[^>]*href=["']((?:https?:\\/\\/www\\.inven\\.co\\.kr)?\\/board\\/${boardPath}\\/(\\d+)(?:[?#][^"']*)?)["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  const items = new Map();
  for (const match of html.matchAll(re)) {
    const id = match[2];
    const url = absoluteUrl(match[1], base);
    const title = cleanText(match[3]).replace(/^\s*\[\s*\d+\s*\]\s*/, '').slice(0, 300);
    if (!url || !title || /공지|이용안내|로그인|회원가입/i.test(title)) continue;
    items.set(id, {
      source: 'inven',
      sourcePostId: `${def.board}:${id}`,
      sourceUrl: new URL(`/board/${def.board}/${id}`, 'https://www.inven.co.kr').href,
      title,
      bodyText: '',
      publishedAt: null,
      mediaUrls: [],
      category: `인벤 ${def.label}`,
    });
  }
  return [...items.values()];
}

async function mapLimit(items, limit, fn) {
  const result = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      result[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return result;
}

async function collect(def) {
  const discovered = new Map();
  const listStatuses = [];
  for (let page = 1; page <= PAGE_COUNT && discovered.size < CATEGORY_LIMIT; page += 1) {
    const response = await fetchText(listUrl(def, page), `https://www.inven.co.kr/board/${def.board}`);
    const items = response.ok ? extractListing(response.body, def, response.url) : [];
    listStatuses.push({ page, status: response.status, links: items.length });
    for (const item of items) {
      if (discovered.size >= CATEGORY_LIMIT) break;
      discovered.set(item.sourcePostId, item);
    }
  }
  const rows = await mapLimit([...discovered.values()], DETAIL_CONCURRENCY, async (candidate) => {
    try {
      const response = await fetchText(candidate.sourceUrl, `https://www.inven.co.kr/board/${def.board}`);
      if (!response.ok) return { ...candidate, detailOk: false, mediaUrls: [] };
      return {
        ...candidate,
        detailOk: true,
        bodyText: extractBodyText(response.body),
        mediaUrls: extractMediaUrls(response.body),
      };
    } catch {
      return { ...candidate, detailOk: false, mediaUrls: [] };
    }
  });
  return { listStatuses, rows, candidates: rows.filter((row) => row.detailOk && row.mediaUrls.length > 0) };
}

if (!process.env.YAKHU_SITE_URL || !process.env.YAKHU_INGEST_SECRET) {
  console.error(JSON.stringify({ status: 'failed', error: 'missing_ingest_configuration' }));
  process.exitCode = 1;
} else {
  for (const id of selected) {
    const def = definitions[id];
    const started = Date.now();
    try {
      const crawl = await collect(def);
      const ingest = await sendToSite(crawl.candidates, {
        siteUrl: process.env.YAKHU_SITE_URL,
        secret: process.env.YAKHU_INGEST_SECRET,
      });
      console.log(JSON.stringify({
        category: id,
        label: def.label,
        discovered: crawl.rows.length,
        detailSuccess: crawl.rows.filter((row) => row.detailOk).length,
        detailFailure: crawl.rows.filter((row) => !row.detailOk).length,
        mediaSuccess: crawl.candidates.length,
        submitted: crawl.candidates.length,
        ...Object.fromEntries(Object.entries(ingest).filter(([key]) => key !== 'transportErrors')),
        errors: ingest.failed + ingest.transportErrors.length,
        transportErrors: ingest.transportErrors,
        list: crawl.listStatuses,
        runtimeMs: Date.now() - started,
      }));
    } catch (error) {
      console.log(JSON.stringify({ category: id, label: def.label, status: 'failed', errors: 1, error: error instanceof Error ? error.message : 'canary_error' }));
      process.exitCode = 1;
    }
  }
}
