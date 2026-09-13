const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36 YakhuResearch/1.0';
const TIMEOUT_MS = 15000;
const mode = (process.env.RESEARCH_MODE || 'all').toLowerCase();
const SAMPLE_LIMIT = Math.min(200, Math.max(100, Number(process.env.RESEARCH_LIMIT || 120)));
const CHZZK_LIMIT = Math.min(10, Math.max(5, Number(process.env.CHZZK_LIMIT || 8)));

function decode(s) {
  return String(s || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}
function cleanText(value) {
  return decode(String(value || '')
    .replace(/<!--(?:.|\n|\r)*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|header|footer|nav|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}
function attr(tag, name) {
  const re = new RegExp(name + "\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']", 'i');
  return decode(re.exec(tag)?.[1] || '');
}
function abs(raw, base) {
  if (!raw || /^data:|^javascript:/i.test(raw)) return null;
  try { return new URL(raw.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}
async function fetchText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'follow', headers: {
      'user-agent': UA,
      accept: options.accept || 'text/html,application/xhtml+xml',
      referer: options.referer || undefined,
    }, signal: controller.signal });
    const body = await response.text();
    const title = cleanText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] || '').slice(0, 160);
    const head = body.slice(0, 240000).toLowerCase();
    const challenge = /captcha|cloudflare|access denied|just a moment|보안문자|자동입력 방지|성인인증|로그인 후|login required|security check/i.test(head);
    return { ok: response.ok, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type') || '', bytes: Buffer.byteLength(body), title, body, challenge, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, status: 0, finalUrl: url, contentType: '', bytes: 0, title: '', body: '', challenge: false, ms: Date.now() - started, error: error instanceof Error ? error.message : 'fetch_error' };
  } finally { clearTimeout(timer); }
}
async function mapLimit(items, limit, fn) {
  const out = []; let next = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
function targetClass(title, body, category, mediaCount) {
  const text = `${title} ${category} ${body}`.toLowerCase();
  if (!mediaCount) return 'NON_TARGET';
  if (/미성년|미자|아동|몰카|불법촬영|도촬|유출|비동의|딥페이크/i.test(text)) return 'NON_TARGET';
  if (/애니|만화|일러스트|팬아트|게임\s*(캐릭터|스크린샷)|ai\s*(그림|이미지)|캐릭터/i.test(text) && !/실사|코스프레/i.test(text)) return 'NON_TARGET';
  if (/비키니|수영복|치어리더|레이싱\s*모델|그라비아|화보|후방|약후|야짤|ㅇㅎ|ㅎㅂ|여캠|인플루언서|모델|몸매|여배우|여돌|여자\s*(연예인|사진)|코스프레|인스타|섹시/i.test(text)) return 'TARGET';
  if (/여성|여자|배우|아이돌|연예|방송|사진|영상|모델|인스타/i.test(text)) return 'AMBIGUOUS';
  return 'NON_TARGET';
}
function mediaFromDetail(html, base) {
  const out = [];
  const lower = html.toLowerCase();
  const contentStart = Math.max(lower.indexOf('class="content"'), lower.indexOf('class="article"'), lower.indexOf('id="content"'));
  const scoped = contentStart >= 0 ? html.slice(contentStart, Math.min(html.length, contentStart + 500000)) : html;
  for (const m of scoped.matchAll(/<(?:img|video|source)[^>]*>/gi)) {
    const tag = m[0];
    const raw = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src') || attr(tag, 'poster');
    const url = abs(raw, base);
    if (!url) continue;
    const low = url.toLowerCase();
    if (/(logo|icon|avatar|profile|emoji|emoticon|favicon|banner|sprite|pixel|loading|thumb\.pann\.com\/.*\/s\/)/i.test(low)) continue;
    if (/\.(?:jpe?g|png|gif|webp|mp4|webm|mov)(?:[?#]|$)/i.test(low) || /(?:image|upload|attach|download|media|file|img|photo|gallery)/i.test(low)) out.push(url);
  }
  return [...new Set(out)];
}
function publishedAt(html) {
  const m = html.match(/(20\d{2})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0)));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function parsePannList(html, base) {
  const out = new Map();
  // Pann list rows carry the category link and the numeric post link in the same row.
  for (const row of html.matchAll(/<(?:li|tr|div)\b[^>]*>[\s\S]*?<\/(?:li|tr|div)>/gi)) {
    const block = row[0];
    const catMatch = block.match(/href\s*=\s*["'](\/talk\/c\d+)["'][^>]*>([\s\S]*?)<\/a>/i);
    const category = catMatch ? { id: catMatch[1].split('/').pop(), label: cleanText(catMatch[2]).slice(0, 80) } : { id: 'unknown', label: 'unknown' };
    for (const m of block.matchAll(/<a\b[^>]*href\s*=\s*["'](\/talk\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = abs(m[1], base);
      if (!url || out.has(url)) continue;
      const title = cleanText(m[3]).slice(0, 240);
      if (!title || /공지|로그인|회원가입|이용약관/i.test(title)) continue;
      out.set(url, { url, title, category });
    }
  }
  // Fallback for markup without row wrappers.
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["'](\/talk\/(\d+))["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = abs(m[1], base);
    if (!url || out.has(url)) continue;
    const title = cleanText(m[3]).slice(0, 240);
    if (!title || /공지|로그인|회원가입|이용약관/i.test(title)) continue;
    out.set(url, { url, title, category: { id: 'unknown', label: 'unknown' } });
  }
  return [...out.values()];
}
async function pannDetails(items) {
  return mapLimit(items, 5, async (item) => {
    const detail = await fetchText(item.url);
    const body = detail.ok ? cleanText(detail.body).slice(0, 10000) : '';
    const media = detail.ok ? mediaFromDetail(detail.body, detail.finalUrl) : [];
    return { ...item, status: detail.status, ok: detail.ok, mediaCount: media.length, media, body, publishedAt: detail.ok ? publishedAt(detail.body) : null, classification: detail.ok ? targetClass(item.title, body, item.category.label, media.length) : 'NON_TARGET' };
  });
}
function summarize(details) {
  const target = details.filter(x => x.classification === 'TARGET').length;
  const ambiguous = details.filter(x => x.classification === 'AMBIGUOUS').length;
  const dates = details.map(x => x.publishedAt).filter(Boolean).sort();
  const spanDays = dates.length > 1 ? Math.max(1, (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000) : null;
  return { sampled: details.length, detailSuccess: details.filter(x => x.ok).length, detailFailure: details.filter(x => !x.ok).length, mediaSuccess: details.filter(x => x.ok && x.mediaCount > 0).length, mediaMissing: details.filter(x => x.ok && x.mediaCount === 0).length, TARGET: target, AMBIGUOUS: ambiguous, NON_TARGET: details.length - target - ambiguous, targetYield: details.length ? Number((target / details.length).toFixed(4)) : 0, potentialYield: details.length ? Number(((target + ambiguous) / details.length).toFixed(4)) : 0, newest: dates.at(-1) || null, oldest: dates[0] || null, spanDays, targetPerDay: spanDays ? Number((target / spanDays).toFixed(2)) : null, samples: details.filter(x => x.classification === 'TARGET').slice(0, 10).map(x => ({ title: x.title, url: x.url, category: x.category, mediaCount: x.mediaCount, publishedAt: x.publishedAt })) };
}
async function runPann() {
  const homeUrl = 'https://pann.nate.com/talk';
  const home = await fetchText(homeUrl);
  const broadLinks = home.ok && !home.challenge ? parsePannList(home.body, home.finalUrl) : [];
  const broad = await pannDetails(broadLinks.slice(0, SAMPLE_LIMIT));
  const concentration = {};
  for (const x of broad) {
    const key = x.category?.id || 'unknown';
    concentration[key] ||= { id: key, label: x.category?.label || 'unknown', sampled: 0, TARGET: 0, AMBIGUOUS: 0, NON_TARGET: 0 };
    concentration[key].sampled++;
    concentration[key][x.classification]++;
  }
  const ranked = Object.values(concentration).filter(x => x.id !== 'unknown' && x.sampled >= 2).sort((a, b) => (b.TARGET / b.sampled) - (a.TARGET / a.sampled) || b.TARGET - a.TARGET).slice(0, 3);
  const refined = [];
  for (const cat of ranked) {
    const listUrl = `https://pann.nate.com/talk/${cat.id}`;
    const page = await fetchText(listUrl);
    const links = page.ok && !page.challenge ? parsePannList(page.body, page.finalUrl).filter(x => x.category.id === cat.id || x.category.id === 'unknown') : [];
    const details = await pannDetails(links.slice(0, Math.ceil(SAMPLE_LIMIT / Math.max(1, ranked.length))));
    refined.push({ category: cat, list: { url: listUrl, status: page.status, challenge: page.challenge, links: links.length }, ...summarize(details) });
  }
  console.log(JSON.stringify({ track: 'A', source: 'pann', list: { status: home.status, challenge: home.challenge, links: broadLinks.length }, broad: { ...summarize(broad), concentration: Object.values(concentration).sort((a, b) => b.TARGET - a.TARGET || b.sampled - a.sampled) }, refined }));
}
function extractBobaLinks(html, base) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const raw = decode(m[1]);
    let url; try { url = new URL(raw, base).href; } catch { continue; }
    const u = new URL(url);
    if (u.hostname !== 'www.bobaedream.co.kr' || u.pathname !== '/view') continue;
    if (u.searchParams.get('code') !== 'nsfw' || !/^\d+$/.test(u.searchParams.get('No') || '')) continue;
    out.set(`${u.searchParams.get('code')}:${u.searchParams.get('No')}`, { url: u.href, id: `${u.searchParams.get('code')}:${u.searchParams.get('No')}` });
  }
  return [...out.values()];
}
function extractChzzk(html, base) {
  const out = [];
  for (const m of html.matchAll(/<(?:iframe|embed)[^>]*>/gi)) {
    const url = abs(attr(m[0], 'src') || attr(m[0], 'data-src'), base);
    if (url && /chzzk|ncloud|naver/i.test(url)) out.push(url);
  }
  return [...new Set(out)];
}
function embedResources(html, base) {
  const posters = new Set(); const videos = new Set();
  for (const m of html.matchAll(/<(?:meta|video|source|link)[^>]*>/gi)) {
    const tag = m[0];
    const url = abs(attr(tag, 'content') || attr(tag, 'src') || attr(tag, 'href'), base);
    if (!url) continue;
    const low = url.toLowerCase();
    if (/og:image|twitter:image/i.test(tag) || /\.(?:jpe?g|png|gif|webp)(?:[?#]|$)/i.test(low)) posters.add(url);
    if (/og:video|video|source/i.test(tag) && /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(low)) videos.add(url);
  }
  return { posters: [...posters], videos: [...videos] };
}
async function runChzzk() {
  const links = new Map();
  for (let pageNo = 1; pageNo <= 4 && links.size < CHZZK_LIMIT * 4; pageNo++) {
    const listUrl = `https://www.bobaedream.co.kr/list?code=nsfw&page=${pageNo}`;
    const list = await fetchText(listUrl);
    if (!list.ok || list.challenge) continue;
    for (const item of extractBobaLinks(list.body, list.finalUrl)) links.set(item.id, item);
  }
  const candidates = [];
  for (const item of links.values()) {
    if (candidates.length >= CHZZK_LIMIT) break;
    const detail = await fetchText(item.url);
    if (!detail.ok) continue;
    const iframeUrls = extractChzzk(detail.body, detail.finalUrl);
    if (iframeUrls.length) candidates.push({ ...item, detailStatus: detail.status, iframeUrls });
  }
  const results = await mapLimit(candidates, 2, async (item) => {
    const embeds = [];
    for (const iframeUrl of item.iframeUrls.slice(0, 2)) {
      const response = await fetchText(iframeUrl, { referer: item.url });
      const resources = response.ok ? embedResources(response.body, response.finalUrl) : { posters: [], videos: [] };
      embeds.push({ url: iframeUrl, status: response.status, ok: response.ok, challenge: response.challenge, contentType: response.contentType, posters: resources.posters.slice(0, 2), videos: resources.videos.slice(0, 2) });
    }
    const publicVideo = embeds.some(e => e.ok && e.videos.length > 0 && !e.challenge);
    const posterOnly = !publicVideo && embeds.some(e => e.ok && e.posters.length > 0 && !e.challenge);
    const status = publicVideo ? 'PASS' : posterOnly ? 'THUMBNAIL_ONLY' : 'BLOCKED';
    return { id: item.id, url: item.url, iframeUrls: item.iframeUrls, embeds, status };
  });
  console.log(JSON.stringify({ track: 'B', source: 'bobaedream', sample: results.length, publicEmbedAccess: results.filter(x => x.embeds.some(e => e.ok && !e.challenge)).length, mediaExtraction: results.filter(x => x.status === 'PASS').length, thumbnailOnly: results.filter(x => x.status === 'THUMBNAIL_ONLY').length, blocked: results.filter(x => x.status === 'BLOCKED').length, results }));
}
if (mode === 'a' || mode === 'pann' || mode === 'all') await runPann();
if (mode === 'b' || mode === 'chzzk' || mode === 'all') await runChzzk();
