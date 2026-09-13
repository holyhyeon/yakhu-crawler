import { extractBodyText as invenBody, extractMediaUrls as invenMedia } from './src/sources/inven.mjs';
import { extractListing as bobaListing, extractBodyText as bobaBody, extractMediaUrls as bobaMedia } from './src/sources/bobaedream.mjs';

const source = process.env.CANARY_SOURCE || 'inven';
const mode = process.env.CANARY_MODE || 'baseline';
const siteUrl = process.env.YAKHU_SITE_URL;
const secret = process.env.YAKHU_INGEST_SECRET;
const agent = 'Mozilla/5.0 (compatible; YakhuArchiveCanary/0.1; personal archive)';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function plain(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function html(url, referer, attempts = 2) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, {
        headers: { 'user-agent': agent, 'accept-language': 'ko-KR,ko;q=0.9', referer },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      });
      const text = await r.text();
      if (!r.ok) throw new Error('http_' + r.status);
      return { text, url: r.url, status: r.status };
    } catch (error) {
      last = error;
      if (i + 1 < attempts) await sleep(500);
    }
  }
  throw last || new Error('fetch_failed');
}

async function knownIds(kind) {
  const set = new Set();
  if (!siteUrl) return set;
  try {
    const r = await fetch(new URL('/api/qa/recent?limit=50', siteUrl), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return set;
    const data = await r.json();
    for (const item of data.items || []) {
      const u = String(item.sourceUrl || '');
      if (kind === 'inven') {
        const m = u.match(/\/board\/webzine\/2097\/(\d+)/);
        if (m) set.add(m[1]);
      } else if (kind === 'bobaedream') {
        const m = u.match(/[?&]No=(\d+)/i);
        if (m) set.add('nsfw:' + m[1]);
      }
    }
  } catch {}
  return set;
}

function dateNear(htmlText, index) {
  const around = String(htmlText).slice(Math.max(0, index - 500), Math.min(htmlText.length, index + 500));
  const full = around.match(/(20\d{2})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (full) return new Date(Date.UTC(+full[1], +full[2] - 1, +full[3])).getTime();
  const short = around.match(/(\d{1,2})[.\/-](\d{1,2})(?!\d)/);
  if (short) {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), +short[1] - 1, +short[2]));
    if (d.getTime() > now.getTime() + 86400000) d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.getTime();
  }
  return null;
}

function invenListAll(text) {
  const map = new Map();
  const re = /<a\b[^>]*href=["']((?:https?:\/\/www\.inven\.co\.kr)?\/board\/webzine\/2097\/(\d+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of text.matchAll(re)) {
    const id = m[2];
    const title = plain(m[3]).slice(0, 300);
    if (id && title && !map.has(id)) map.set(id, {
      source: 'inven', sourcePostId: id,
      sourceUrl: 'https://www.inven.co.kr/board/webzine/2097/' + id,
      title, category: '인벤', publishedAt: dateNear(text, m.index || 0),
    });
  }
  return [...map.values()];
}

async function collectInven() {
  const expanded = mode === 'expanded';
  const pages = expanded ? 5 : 3;
  const cap = expanded ? 30 : 15;
  const map = new Map();
  let pageFailures = 0;
  let oldStops = 0;
  let oldStreak = 0;
  for (let p = 1; p <= pages; p++) {
    try {
      const r = await html('https://www.inven.co.kr/board/webzine/2097?p=' + p, 'https://www.inven.co.kr/board/webzine/2097');
      const rows = invenListAll(r.text);
      let oldCount = 0;
      for (const row of rows) {
        if (row.publishedAt && Date.now() - row.publishedAt > 7 * 86400000) oldCount++;
        if (!map.has(row.sourcePostId)) map.set(row.sourcePostId, row);
      }
      if (rows.length && oldCount === rows.length) oldStreak++; else oldStreak = 0;
      if (oldStreak >= 2) { oldStops++; break; }
    } catch { pageFailures++; }
    if (p < pages) await sleep(300);
  }
  const discovered = map.size;
  const known = await knownIds('inven');
  const candidates = [...map.values()].filter((x) => !known.has(x.sourcePostId)).slice(0, cap);
  let detailSuccess = 0, detailFailure = 0, mediaSuccess = 0;
  const rows = [];
  for (const candidate of candidates) {
    try {
      const r = await html(candidate.sourceUrl, 'https://www.inven.co.kr/board/webzine/2097');
      const mediaUrls = invenMedia(r.text);
      rows.push({ ...candidate, bodyText: invenBody(r.text), mediaUrls, publishedAt: candidate.publishedAt ? new Date(candidate.publishedAt).toISOString() : null });
      detailSuccess++; if (mediaUrls.length) mediaSuccess++;
    } catch { detailFailure++; }
    await sleep(250);
  }
  return { rows, metrics: { discovered, uniqueDiscovered: discovered, knownSkipped: known.size, candidates: candidates.length, detailSuccess, detailFailure, mediaSuccess, pageFailures, oldStops, pages, cap } };
}

async function collectBoba() {
  const expanded = mode === 'expanded';
  const pages = expanded ? 4 : 2;
  const map = new Map();
  let pageFailures = 0, oldStops = 0, oldStreak = 0;
  for (let p = 1; p <= pages; p++) {
    const u = 'https://www.bobaedream.co.kr/list?code=nsfw' + (p > 1 ? '&page=' + p : '');
    try {
      const r = await html(u, 'https://www.bobaedream.co.kr/list?code=nsfw');
      const rows = bobaListing(r.text, { pageUrl: r.url });
      let oldCount = 0;
      for (const row of rows) {
        if (row.publishedAt && Date.now() - new Date(row.publishedAt).getTime() > 7 * 86400000) oldCount++;
        if (!map.has(row.sourcePostId)) map.set(row.sourcePostId, row);
      }
      if (rows.length && oldCount === rows.length) oldStreak++; else oldStreak = 0;
      if (oldStreak >= 2) { oldStops++; break; }
    } catch { pageFailures++; }
    if (p < pages) await sleep(350);
  }
  const discovered = map.size;
  const known = await knownIds('bobaedream');
  const candidates = [...map.values()].filter((x) => !known.has(x.sourcePostId));
  let detailSuccess = 0, detailFailure = 0, mediaSuccess = 0;
  const rows = [];
  for (const candidate of candidates) {
    try {
      const r = await html(candidate.sourceUrl, candidate.sourceUrl);
      const mediaUrls = bobaMedia(r.text, { pageUrl: r.url });
      rows.push({ ...candidate, bodyText: bobaBody(r.text), mediaUrls, publishedAt: candidate.publishedAt || null });
      detailSuccess++; if (mediaUrls.length) mediaSuccess++;
    } catch { detailFailure++; }
    await sleep(300);
  }
  return { rows, metrics: { discovered, uniqueDiscovered: discovered, knownSkipped: known.size, candidates: candidates.length, detailSuccess, detailFailure, mediaSuccess, pageFailures, oldStops, pages } };
}

async function ingest(rows) {
  const out = { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, reasons: {} };
  const endpoint = new URL('/api/ingest', siteUrl).href;
  for (let i = 0; i < rows.length; i += 2) {
    const batch = rows.slice(i, i + 2);
    try {
      const r = await fetch(endpoint, {
        method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        body: JSON.stringify({ candidates: batch }), signal: AbortSignal.timeout(60_000),
      });
      if (!r.ok) { out.failed += batch.length; out.reasons['site_' + r.status] = (out.reasons['site_' + r.status] || 0) + batch.length; continue; }
      const data = await r.json();
      for (const key of ['processed','accepted','review','rejected','duplicate','failed']) out[key] += Number(data[key] || 0);
      for (const item of data.results || []) if (item.reason) out.reasons[item.reason] = (out.reasons[item.reason] || 0) + 1;
    } catch { out.failed += batch.length; out.reasons.transport = (out.reasons.transport || 0) + batch.length; }
  }
  return out;
}

async function probeBobaFailures(rows, ingestResult) {
  const failed = new Set(Object.entries(ingestResult.reasons).filter(([k]) => k === 'media_fetch_failed').map(() => 'x'));
  if (!failed.size) return {};
  const counts = {};
  let checked = 0;
  for (const row of rows) {
    if (!row.mediaUrls?.length || checked >= 20) continue;
    try {
      const r = await fetch(row.mediaUrls[0], { headers: { 'user-agent': agent, range: 'bytes=0-1023', referer: row.sourceUrl }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
      const ct = r.headers.get('content-type') || '';
      const key = r.status === 404 ? 'media_404' : r.status === 403 ? 'media_403' : r.status === 429 ? 'rate_limited' : !r.ok ? 'http_' + r.status : /text\/html/i.test(ct) ? 'invalid_media' : 'ok';
      counts[key] = (counts[key] || 0) + 1;
    } catch (e) { counts[e?.name === 'TimeoutError' ? 'timeout' : 'transient_fetch'] = (counts[e?.name === 'TimeoutError' ? 'timeout' : 'transient_fetch'] || 0) + 1; }
    checked++;
  }
  return counts;
}

async function modelProbe() {
  const url = 'https://www.inven.co.kr/board/webzine/2898?category=%EA%B2%8C%EC%9E%84%EB%AA%A8%EB%8D%B8';
  try {
    const r = await html(url, 'https://www.inven.co.kr/board/webzine/2898');
    const links = [...r.text.matchAll(/href=["']((?:https?:\/\/www\.inven\.co\.kr)?\/board\/webzine\/2898\/(\d+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ id: m[2], title: plain(m[3]).slice(0, 200), url: 'https://www.inven.co.kr/board/webzine/2898/' + m[2] }))
      .filter((x, i, a) => x.title && a.findIndex((y) => y.id === x.id) === i).slice(0, 100);
    let detailSuccess = 0, mediaSuccess = 0;
    for (const row of links.slice(0, 20)) {
      try { const d = await html(row.url, url); detailSuccess++; if (invenMedia(d.text).length) mediaSuccess++; } catch {}
      await sleep(200);
    }
    const target = links.filter((x) => /비키니|수영복|레이싱|치어리더|화보|모델|인플루언서|몸매|여캠/i.test(x.title)).length;
    return { access: true, sampled: links.length, targetTitleHits: target, detailSuccess, mediaSuccess };
  } catch (error) { return { access: false, error: error instanceof Error ? error.message : 'fetch_failed' }; }
}

if (source === 'inven-model') {
  console.log(JSON.stringify({ source, mode, ...(await modelProbe()) }));
  process.exit(0);
}
const result = source === 'bobaedream' ? await collectBoba() : await collectInven();
const ingestResult = siteUrl && secret ? await ingest(result.rows) : { processed: 0, accepted: 0, review: 0, rejected: 0, duplicate: 0, failed: 0, reasons: { dry_run: result.rows.length } };
const probe = source === 'bobaedream' ? await probeBobaFailures(result.rows, ingestResult) : {};
console.log(JSON.stringify({ source, mode, ...result.metrics, ...ingestResult, failureProbe: probe }));
