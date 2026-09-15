const API_URL = 'https://commons.wikimedia.org/w/api.php';
const SOURCE_AGENT = 'YakhuArchiveCrawler/0.1 (Commons bounded canary; contact via Wikimedia user-agent policy)';
const DEFAULT_CATEGORIES = [
  'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)',
  'Category:Kindai Mahjong Swimsuit Festival (July 2, 2026)',
];
const DEFAULT_MAX_FILES = 50;
const DEFAULT_MAX_POSTS = 20;
const DEFAULT_MAX_MEDIA_PER_POST = 10;
const RETRY_ATTEMPTS = 4;
const MIN_REQUEST_INTERVAL_MS = 700;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>(\s*)/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function metadataValue(metadata, key) {
  const value = metadata?.[key];
  return stripHtml(typeof value === 'object' && value ? value.value : value);
}

function parseRetryAfter(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(30_000, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.min(30_000, date - Date.now())) : 0;
}

function categoryLabel(category) {
  return String(category || '').replace(/^Category:/i, '').trim();
}

function eventDateFromCategory(category) {
  const match = categoryLabel(category).match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (!match) return null;
  const month = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  }[match[1].toLocaleLowerCase('en-US')];
  return month ? `${match[3]}-${month}-${String(Number(match[2])).padStart(2, '0')}` : null;
}

function isoDate(value) {
  const match = String(value || '').match(/(\d{4})[-/:](\d{1,2})[-/:](\d{1,2})/);
  if (!match) return null;
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
}

const GENERIC_CATEGORY_PARTS = [
  'kindai mahjong', 'swimsuit festival', 'july', '2026', 'swimsuit', 'bikini',
  'photographs', 'photos', 'people', 'women', 'female', 'images', 'jpg',
  'self-published work', 'creative commons', 'missing sdc', 'cc-by',
];

function isGenericCategory(value) {
  const normalized = String(value || '').toLocaleLowerCase('en-US');
  return !normalized || GENERIC_CATEGORY_PARTS.some((part) => normalized.includes(part));
}

function personFromCategories(categories, description = '') {
  const candidates = (categories || [])
    .map((value) => categoryLabel(value))
    .filter((value) => !isGenericCategory(value))
    .filter((value) => !/^(?:creative commons|photographs? taken|events?|japan|tokyo|202[0-9])\b/i.test(value))
    .filter((value) => /[A-Za-zÀ-žぁ-んァ-ン一-龯]/.test(value));
  if (candidates.length) return candidates.sort((a, b) => a.length - b.length)[0];

  const text = stripHtml(description);
  const match = text.match(/(?:depicts?|model|出演者|被写体)\s*[:：]\s*([^,;|]+)/i);
  return match ? match[1].trim().slice(0, 120) : null;
}

function slug(value) {
  return String(value || 'unknown')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function extractLicense(metadata) {
  const license = metadataValue(metadata, 'LicenseShortName') || metadataValue(metadata, 'License');
  const licenseUrl = metadataValue(metadata, 'LicenseUrl');
  const normalizedLicense = license.replace(/\s+/g, ' ').trim();
  const isCcBy4 = /\bcc\s*by\s*4\.0\b/i.test(normalizedLicense)
    || /creativecommons\.org\/licenses\/by\/4\.0/i.test(licenseUrl);
  return {
    license: normalizedLicense || null,
    licenseVersion: isCcBy4 ? '4.0' : null,
    licenseUrl: licenseUrl || (isCcBy4 ? 'https://creativecommons.org/licenses/by/4.0/' : null),
    reusable: isCcBy4,
  };
}

function authorFromMetadata(metadata) {
  return metadataValue(metadata, 'Artist')
    || metadataValue(metadata, 'Author')
    || metadataValue(metadata, 'Credit')
    || null;
}

function pageUrl(title) {
  return `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(title || '').replace(/ /g, '_'))}`;
}

export function normalizeCommonsFile(page, category) {
  const imageInfo = page?.imageinfo?.[0] || {};
  const metadata = imageInfo.extmetadata || {};
  const title = String(page?.title || '').replace(/^File:/i, '');
  const canonicalFileUrl = pageUrl(page?.title || title);
  const license = extractLicense(metadata);
  const description = metadataValue(metadata, 'ImageDescription') || metadataValue(metadata, 'ObjectName') || '';
  const apiCategories = Array.isArray(page?.categories) ? page.categories.map((item) => item.title).filter(Boolean) : [];
  const metadataCategories = metadataValue(metadata, 'Categories')
    .split('|')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.startsWith('Category:') ? value : `Category:${value}`);
  const categories = [...new Set([...apiCategories, ...metadataCategories])];
  const eventDate = eventDateFromCategory(category) || isoDate(metadataValue(metadata, 'DateTimeOriginal'));
  const person = personFromCategories(categories, description);
  const author = authorFromMetadata(metadata);
  const uploadTimestamp = imageInfo.timestamp || null;
  const captureDate = isoDate(metadataValue(metadata, 'DateTimeOriginal'));
  const attributionText = author && license.license
    ? `Photo: ${author} — ${license.license} (${license.licenseUrl || 'license URL unavailable'}) — Wikimedia Commons — Original: ${canonicalFileUrl} — Modification: resized/cropped`
    : null;
  return {
    pageid: Number(page?.pageid) || null,
    fileTitle: title,
    canonicalFileUrl,
    directMediaUrl: imageInfo.url || null,
    thumbnailUrl: imageInfo.thumburl || imageInfo.url || null,
    mime: imageInfo.mime || null,
    width: Number(imageInfo.width) || null,
    height: Number(imageInfo.height) || null,
    author,
    license: license.license,
    licenseVersion: license.licenseVersion,
    licenseUrl: license.licenseUrl,
    licenseVerified: license.reusable,
    attributionText,
    uploadTimestamp,
    captureDate,
    eventDate,
    description,
    categories,
    depictedPerson: person,
    consentStatus: 'PUBLIC_EVENT_CONTEXT',
  };
}

export function groupCommonsFiles(files, {
  maxPosts = DEFAULT_MAX_POSTS,
  maxMediaPerPost = DEFAULT_MAX_MEDIA_PER_POST,
} = {}) {
  const groups = new Map();
  for (const file of files || []) {
    if (!file?.licenseVerified || !file?.thumbnailUrl) continue;
    const eventDate = file.eventDate || 'unknown-date';
    const person = file.depictedPerson || 'unknown-person';
    const key = `${eventDate}|${person}`;
    if (!groups.has(key)) groups.set(key, {
      key,
      eventDate,
      depictedPerson: file.depictedPerson,
      files: [],
    });
    groups.get(key).files.push(file);
  }

  return [...groups.values()]
    .sort((a, b) => `${a.eventDate}|${a.depictedPerson || ''}`.localeCompare(`${b.eventDate}|${b.depictedPerson || ''}`))
    .slice(0, Math.max(0, Number(maxPosts) || DEFAULT_MAX_POSTS))
    .map((group) => {
      const filesForPost = [...group.files]
        .sort((a, b) => (a.pageid || 0) - (b.pageid || 0))
        .slice(0, Math.max(1, Number(maxMediaPerPost) || DEFAULT_MAX_MEDIA_PER_POST));
      const attribution = filesForPost.map((file) => file.attributionText).filter(Boolean);
      const titlePerson = group.depictedPerson ? ` — ${group.depictedPerson}` : '';
      const title = `수영복 화보 — Kindai Mahjong Swimsuit Festival ${group.eventDate}${titlePerson}`.slice(0, 300);
      const bodyText = [
        'Wikimedia Commons 공개 행사 사진.',
        `행사일: ${group.eventDate}`,
        group.depictedPerson ? `모델/출연자 분류: ${group.depictedPerson}` : '모델/출연자 분류: 확인되지 않음',
        '모든 media는 파일별 라이선스와 원본 페이지를 보존한다.',
        ...attribution,
      ].join('\n').slice(0, 5000);
      return {
        source: 'commons_kindai',
        sourcePostId: `kindai:${slug(group.eventDate)}:${slug(group.depictedPerson || 'unknown')}`,
        sourceUrl: filesForPost[0]?.canonicalFileUrl || 'https://commons.wikimedia.org/',
        title,
        bodyText,
        publishedAt: null,
        mediaUrls: filesForPost.map((file) => file.thumbnailUrl),
        category: 'Kindai Mahjong Swimsuit Festival',
        eventDate: group.eventDate,
        depictedPerson: group.depictedPerson,
        mediaMetadata: filesForPost,
        attributionComplete: filesForPost.length > 0 && filesForPost.every((file) => Boolean(file.attributionText)),
      };
    });
}

function createRateLimiter(intervalMs = MIN_REQUEST_INTERVAL_MS) {
  let nextAllowedAt = 0;
  return async () => {
    const waitMs = Math.max(0, nextAllowedAt - Date.now());
    if (waitMs) await sleep(waitMs);
    nextAllowedAt = Date.now() + intervalMs;
  };
}

async function requestJson(params, { rateLimit, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    await rateLimit();
    const url = new URL(API_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    try {
      const response = await fetchImpl(url, {
        headers: {
          'user-agent': SOURCE_AGENT,
          'api-user-agent': SOURCE_AGENT,
          accept: 'application/json',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429 || response.status >= 500) {
        const retryDelay = Math.max(parseRetryAfter(response), 750 * (2 ** attempt));
        lastError = new Error(`commons_${response.status}`);
        await sleep(Math.min(30_000, retryDelay));
        continue;
      }
      if (!response.ok) throw new Error(`commons_${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt === RETRY_ATTEMPTS - 1) break;
      await sleep(Math.min(30_000, 750 * (2 ** attempt)));
    }
  }
  throw lastError || new Error('commons_request_failed');
}

export async function fetchCommonsCategoryFiles(category, {
  limit = DEFAULT_MAX_FILES,
  fetchImpl = fetch,
  rateLimitMs = MIN_REQUEST_INTERVAL_MS,
} = {}) {
  const rateLimit = createRateLimiter(rateLimitMs);
  const files = [];
  let continuation = {};
  while (files.length < Math.max(1, Number(limit) || DEFAULT_MAX_FILES)) {
    const remaining = Math.min(50, Math.max(1, Number(limit) - files.length));
    const payload = await requestJson({
      action: 'query',
      generator: 'categorymembers',
      gcmtitle: category,
      gcmnamespace: 6,
      gcmtype: 'file',
      gcmlimit: remaining,
      gcmsort: 'timestamp',
      gcmdir: 'desc',
      prop: 'imageinfo|categories',
      cllimit: 'max',
      clshow: '!hidden',
      iiprop: 'url|mime|size|timestamp|extmetadata|commonmetadata',
      iiurlwidth: 1280,
      format: 'json',
      formatversion: 2,
      ...continuation,
    }, { rateLimit, fetchImpl });
    for (const page of payload?.query?.pages || []) {
      files.push(normalizeCommonsFile(page, category));
      if (files.length >= limit) break;
    }
    if (!payload?.continue || files.length >= limit) break;
    continuation = { gcmcontinue: payload.continue.gcmcontinue, continue: payload.continue.continue };
  }
  return files.slice(0, limit);
}

export async function collectKindaiCommons({
  categories = DEFAULT_CATEGORIES,
  filesPerCategory = 25,
  maxPosts = DEFAULT_MAX_POSTS,
  maxMediaPerPost = DEFAULT_MAX_MEDIA_PER_POST,
  fetchImpl = fetch,
  rateLimitMs = MIN_REQUEST_INTERVAL_MS,
} = {}) {
  const rawFiles = [];
  const categoryStats = [];
  let errors = 0;
  for (const category of categories) {
    try {
      const files = await fetchCommonsCategoryFiles(category, { limit: filesPerCategory, fetchImpl, rateLimitMs });
      rawFiles.push(...files);
      categoryStats.push({ category, rawFiles: files.length, errors: 0 });
    } catch (error) {
      errors++;
      categoryStats.push({ category, rawFiles: 0, errors: 1, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const deduped = [...new Map(rawFiles.map((file) => [file.pageid || file.canonicalFileUrl, file])).values()];
  const licenseSkipped = deduped.filter((file) => !file.licenseVerified).length;
  const groups = groupCommonsFiles(deduped, { maxPosts, maxMediaPerPost });
  return {
    categories: [...categories],
    categoryStats,
    rawFiles: deduped,
    groups,
    candidates: groups,
    metrics: {
      rawFiles: rawFiles.length,
      uniqueFiles: deduped.length,
      licenseSkipped,
      groupedPosts: groups.length,
      groupedMedia: groups.reduce((sum, group) => sum + group.mediaUrls.length, 0),
      errors,
    },
  };
}

export { DEFAULT_CATEGORIES, DEFAULT_MAX_FILES, DEFAULT_MAX_POSTS, DEFAULT_MAX_MEDIA_PER_POST };
