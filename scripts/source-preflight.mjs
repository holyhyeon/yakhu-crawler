const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36 YakhuPreflight/1.0';
const TIMEOUT_MS = 12000;
const mode = (process.env.PREFLIGHT_MODE || 'preflight').toLowerCase();
const requested = (process.env.PREFLIGHT_SOURCE || 'all').toLowerCase();
const sampleLimit = Math.min(200, Math.max(100, Number(process.env.PREFLIGHT_LIMIT || 120)));

const sources = {
  fomos: { list: 'https://www.fomos.kr/talk/article_list/?bbs_id=5', links: /\/talk\/article_view[^"'<> ]*/i, detail: (h) => new URL(h, 'https://www.fomos.kr').href },
  ygosu: { list: 'https://www.ygosu.com/board/yeobgi', links: /\/board\/yeobgi\/[^"'<> ]*/i, detail: (h) => new URL(h, 'https://www.ygosu.com').href },
  quasarzone: { list: 'https://quasarzone.com/bbs/qb_humor', links: /\/bbs\/qb_humor\/views\/\d+/i, detail: (h) => new URL(h, 'https://quasarzone.com').href },
  dogdrip_girlgroup: { list: 'https://www.dogdrip.net/girlgroup', links: /\/(?:girlgroup|dogdrip)\/\d+/i, detail: (h) => new URL(h, 'https://www.dogdrip.net').href },
  pann: { list: 'https://pann.nate.com/talk', links: /\/talk\/[^"'<> ]+/i, detail: (h) => new URL(h, 'https://pann.nate.com').href },
  dogdrip: { list: 'https://www.dogdrip.net/dogdrip', links: /\/dogdrip\/\d+/i, detail: (h) => new URL(h, 'https://www.dogdrip.net').href },
};

function cleanText(value) {
  return String(value || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
}
function attr(tag, name) {
  const re = new RegExp(name + "\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']", 'i');
  return re.exec(tag)?.[1] || '';
}
function abs(raw, base) {
  if (!raw || raw.startsWith('data:') || raw.startsWith('javascript:')) return null;
  try { return new URL(raw.replace(/&amp;/g, '&'), base).href; } catch { return null; }
}
function mediaCandidate(url) {
  if (!url) return false;
  const low = url.toLowerCase();
  if (/(logo|icon|avatar|profile|emoji|emoticon|favicon|banner|sprite|pixel|loading)/i.test(low)) return false;
  return /\.(?:jpe?g|png|gif|webp|mp4|webm|mov)(?:[?#]|$)/i.test(low) || /(?:image|upload|attach|download|media|file|img|photo|gallery)/i.test(low);
}
function extractMedia(html, base) {
  const out = [];
  for (const m of html.matchAll(/<(?:img|video|source|a|iframe)[^>]*>/gi)) {
    const tag = m[0];
    const raw = attr(tag, 'src') || attr(tag, 'data-src') || attr(tag, 'data-original') || attr(tag, 'data-lazy-src') || attr(tag, 'href');
    const url = abs(raw, base);
    if (url && mediaCandidate(url)) out.push(url);
  }
  return [...new Set(out)];
}
function extractLinks(html, def, base) {
  const out = new Map();
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (!def.links.test(raw)) continue;
    const url = abs(raw, base);
    if (!url || out.has(url)) continue;
    const title = cleanText(m[2]).slice(0, 240);
    if (!title || /(?:로그인|회원가입|공지사항|이용약관)/i.test(title)) continue;
    out.set(url, { url, title });
  }
  return [...out.values()];
}
async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' }, signal: controller.signal });
    const body = await response.text();
    const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1] || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const lower = body.slice(0, 200000).toLowerCase();
    const challenge = /captcha|cloudflare|access denied|just a moment|보안문자|자동입력 방지|성인인증|로그인 후|login required/i.test(lower);
    return { ok: response.ok, status: response.status, finalUrl: response.url, contentType: response.headers.get('content-type') || '', bytes: Buffer.byteLength(body), title, body, challenge, ms: Date.now() - started };
  } catch (error) { return { ok: false, status: 0, finalUrl: url, contentType: '', bytes: 0, title: '', body: '', challenge: false, ms: Date.now() - started, error: error instanceof Error ? error.message : 'fetch_error' }; }
  finally { clearTimeout(timer); }
}
function classify(post) {
  const text = (post.title + ' ' + post.body).toLowerCase();
  if (!post.mediaCount) return 'NON_TARGET';
  if (/미성년|미자|교복|아동|몰카|불법촬영|도촬|유출|비동의|딥페이크/i.test(text)) return 'NON_TARGET';
  if (/애니|만화|일러스트|팬아트|게임\s*(캐릭터|스크린샷)|ai\s*(그림|이미지)|캐릭터/i.test(text) && !/실사|코스프레/i.test(text)) return 'NON_TARGET';
  if (/비키니|수영복|치어리더|레이싱\s*모델|그라비아|화보|후방|약후|야짤|ㅇㅎ|ㅎㅂ|여캠|인플루언서|모델|몸매|여배우|여돌|여자\s*(연예인|사진)|코스프레|인스타|섹시/i.test(text)) return 'TARGET';
  if (/여성|여자|배우|아이돌|연예|방송|사진|영상|모델|인스타/i.test(text)) return 'AMBIGUOUS';
  return 'NON_TARGET';
}
async function mapLimit(items, limit, fn) {
  const out = []; let next = 0;
  async function worker() { while (true) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function runSource(id) {
  const def = sources[id];
  const list = await fetchText(def.list);
  const links = list.ok && !list.challenge ? extractLinks(list.body, def, new URL(def.list)) : [];
  const selected = links.slice(0, mode === 'sample' ? sampleLimit : 3);
  const details = await mapLimit(selected, 4, async (item) => {
    const result = await fetchText(def.detail(item.url));
    const media = result.ok ? extractMedia(result.body, result.finalUrl) : [];
    const body = result.ok ? cleanText(result.body).slice(0, 5000) : '';
    const post = { ...item, url: def.detail(item.url), ok: result.ok, status: result.status, body, mediaCount: media.length, media, ms: result.ms };
    return { ...post, classification: result.ok ? classify(post) : 'NON_TARGET' };
  });
  const target = details.filter((x) => x.classification === 'TARGET').length;
  const ambiguous = details.filter((x) => x.classification === 'AMBIGUOUS').length;
  const report = { source: id, mode, list: { url: def.list, status: list.status, finalUrl: list.finalUrl, contentType: list.contentType, bytes: list.bytes, title: list.title, challenge: list.challenge, ms: list.ms, links: links.length }, detailRequested: details.length, detailSuccess: details.filter((x) => x.ok).length, detailFailure: details.filter((x) => !x.ok).length, mediaSuccess: details.filter((x) => x.mediaCount > 0).length, mediaMissing: details.filter((x) => x.ok && x.mediaCount === 0).length, TARGET: target, AMBIGUOUS: ambiguous, NON_TARGET: details.length - target - ambiguous, targetYield: details.length ? Number((target / details.length).toFixed(4)) : 0, samples: details.slice(0, 5).map((x) => ({ title: x.title, url: x.url, mediaCount: x.mediaCount, classification: x.classification, status: x.status })) };
  console.log(JSON.stringify(report));
}
const ids = requested === 'all' ? Object.keys(sources) : requested.split(',').map((x) => x.trim()).filter((x) => sources[x]);
for (const id of ids) await runSource(id);
