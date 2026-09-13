import { extractBodyText, extractMediaUrls } from '../src/sources/inven.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36 YakhuInvenResearch/1.0';
const SOURCE_AGENT = 'Mozilla/5.0 (compatible; YakhuArchiveCrawler/0.1; personal archive)';
const TIMEOUT_MS = 15000;
const LIMIT = Math.min(100, Math.max(50, Number(process.env.INVEN_PREFLIGHT_LIMIT || 100)));
const DETAIL_CONCURRENCY = 4;

const boards = {
  cheer_photo: { label: '치어리더 사진', board: 'party/6296', category: '사진', kind: 'cheer' },
  cheer_gif: { label: '치어리더 움짤', board: 'party/6296', category: '움짤', kind: 'cheer' },
  cheer_video: { label: '치어리더 영상', board: 'party/6296', category: '영상', kind: 'cheer' },
  game_model: { label: '게임모델', board: 'webzine/2898', category: '게임모델', kind: 'game_model' },
};

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
function attr(tag, name) {
  return decode(new RegExp(name + "\\s*=\\s*([\"'])([\\s\\S]*?)\\1", 'i').exec(tag)?.[2] || '');
}
function abs(raw, base) {
  if (!raw || /^data:|^javascript:/i.test(raw)) return null;
  try { return new URL(raw.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}
async function fetchText(url, referer = 'https://www.inven.co.kr/') {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS); const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': SOURCE_AGENT, 'accept-language': 'ko-KR,ko;q=0.9', referer }, signal: controller.signal });
    const body = await response.text();
    const title = cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] || '').slice(0, 160);
    const challenge = /captcha|cloudflare|access denied|just a moment|보안문자|자동입력 방지|로그인 후|login required|성인인증/i.test(body.slice(0, 160000));
    return { ok: response.ok, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type') || '', bytes: Buffer.byteLength(body), title, body, challenge, ms: Date.now() - started };
  } catch (error) { return { ok: false, status: 0, finalUrl: url, contentType: '', bytes: 0, title: '', body: '', challenge: false, ms: Date.now() - started, error: error instanceof Error ? error.message : 'fetch_error' }; }
  finally { clearTimeout(timer); }
}
function listUrl(def, page) {
  const url = new URL(`https://www.inven.co.kr/board/${def.board}`);
  url.searchParams.set('category', def.category); url.searchParams.set('vtype', 'pc');
  if (page > 1) url.searchParams.set('p', String(page));
  return url.href;
}
function parseListing(html, def, base) {
  const out = new Map();
  const path = def.board.replace('/', '\\/');
  const re = new RegExp(`<a\\b[^>]*href=["']((?:https?:\\/\\/www\\.inven\\.co\\.kr)?\\/board\\/${path}\\/(\\d+)(?:[?#][^"']*)?)["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
  for (const m of html.matchAll(re)) {
    const url = abs(m[1], base); if (!url || out.has(m[2])) continue;
    const title = cleanText(m[3]).replace(/\[\s*\d+\s*\]$/, '').trim().slice(0, 300);
    if (!title || /공지|이용안내|로그인|회원가입/i.test(title)) continue;
    out.set(m[2], { sourcePostId: `${def.board}:${m[2]}`, sourceUrl: new URL(`/board/${def.board}/${m[2]}`, 'https://www.inven.co.kr').href, title, category: def.category, kind: def.kind });
  }
  return [...out.values()];
}
function publishedAt(html) {
  const dates = [...html.matchAll(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/g)];
  const m = dates.findLast(x => Number(x[1]) >= 2020) || dates.at(-1);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function nonTargetText(text) {
  return /미성년|미자|아동|몰카|불법촬영|도촬|유출|비동의|딥페이크|ai\s*(그림|이미지)|일러스트|팬아트|게임\s*스크린샷|인게임|스킨샷/i.test(text);
}
function classify(item, bodyText, mediaCount, rawHtml) {
  const text = `${item.title} ${item.category} ${bodyText}`;
  if (!mediaCount) return 'NON_TARGET';
  if (nonTargetText(text)) return 'NON_TARGET';
  if (item.kind === 'cheer') return 'TARGET';
  if (/게임모델|코스프레|모델|화보|수영복|비키니/i.test(text)) {
    // A page whose media is only an external embed is not a storable target here.
    if (/<(?:iframe|script)\b[^>]*(?:youtube|chzzk|twitch)/i.test(rawHtml) && mediaCount === 0) return 'AMBIGUOUS';
    return 'TARGET';
  }
  return 'AMBIGUOUS';
}
async function mapLimit(items, limit, fn) {
  const out = []; let next = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)); return out;
}
async function inspectBoard(id, def) {
  const listResults = []; const discovered = new Map();
  for (let page = 1; page <= 8 && discovered.size < LIMIT; page++) {
    const url = listUrl(def, page); const result = await fetchText(url, `https://www.inven.co.kr/board/${def.board}`);
    const items = result.ok && !result.challenge ? parseListing(result.body, def, result.finalUrl) : [];
    listResults.push({ page, status: result.status, bytes: result.bytes, title: result.title, challenge: result.challenge, links: items.length });
    for (const item of items) discovered.set(item.sourcePostId, item);
  }
  const selected = [...discovered.values()].slice(0, LIMIT);
  const details = await mapLimit(selected, DETAIL_CONCURRENCY, async item => {
    const result = await fetchText(item.sourceUrl, `https://www.inven.co.kr/board/${def.board}`);
    if (!result.ok) return { ...item, ok: false, status: result.status, mediaCount: 0, publishedAt: null, classification: 'NON_TARGET' };
    const bodyText = extractBodyText(result.body);
    const media = extractMediaUrls(result.body);
    return { ...item, ok: true, status: result.status, mediaCount: media.length, media, bodyText, publishedAt: publishedAt(result.body), classification: classify(item, bodyText, media.length, result.body) };
  });
  const target = details.filter(x => x.classification === 'TARGET').length;
  const ambiguous = details.filter(x => x.classification === 'AMBIGUOUS').length;
  const dates = details.map(x => x.publishedAt).filter(Boolean).sort();
  const spanDays = dates.length > 1 ? Math.max(1, (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / 86400000) : null;
  return { id, label: def.label, list: listResults, sample: details.length, detailSuccess: details.filter(x => x.ok).length, detailFailure: details.filter(x => !x.ok).length, mediaSuccess: details.filter(x => x.ok && x.mediaCount > 0).length, TARGET: target, AMBIGUOUS: ambiguous, NON_TARGET: details.length - target - ambiguous, targetYield: details.length ? Number((target / details.length).toFixed(4)) : 0, newest: dates.at(-1) || null, oldest: dates[0] || null, spanDays, targetPerDay: spanDays ? Number((target / spanDays).toFixed(2)) : null, examples: details.slice(0, 5).map(x => ({ title: x.title, url: x.sourceUrl, mediaCount: x.mediaCount, classification: x.classification, publishedAt: x.publishedAt })) };
}
for (const [id, def] of Object.entries(boards)) console.log(JSON.stringify(await inspectBoard(id, def)));
