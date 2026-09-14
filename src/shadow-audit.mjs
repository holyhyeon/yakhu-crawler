export const SHADOW_SAMPLE_MODULUS = 5;

// Keep this list aligned with the Site's diagnostic term list. It is used only
// for audit context; it never makes a quality decision in the crawler.
const SHADOW_TERMS = [
  'ㅇㅎ', 'ㅎㅂ', '약후', '후방', '후방주의', '비키니', '수영복', '모노키니',
  '란제리', '브라렛', '레깅스', '요가복', '운동복', '크롭탑', '오프숄더',
  '미니스커트', '핫팬츠', '시스루', '화보', '맥심', '그라비아', '바디프로필',
  '룩북', '패션 모델', '레이싱모델', '피팅모델', '인플루언서', '코스프레',
  '치어리더', '댄서', 'BJ', '스트리머', '몸매', '피지컬', '골반', '각선미',
  '복근', '필라테스', '요가', '수영장', '해변', '페스티벌', '공연 의상',
  '무대 의상', '인스타', '릴스', '틱톡', '셀카', '직캠', '여친룩', '파티룩',
  '비치웨어',
];

export function stableShadowHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function isShadowEligible(candidate, result) {
  return candidate?.source === 'inven'
    && candidate?.category === '인벤'
    && result?.status === 'rejected'
    && result?.reason === 'no_target_signal';
}

export function shouldShadowAudit(candidate, result) {
  return isShadowEligible(candidate, result)
    && stableShadowHash(candidate.sourceUrl) % SHADOW_SAMPLE_MODULUS === 0;
}

export function shadowMediaType(url) {
  const path = (() => {
    try { return new URL(url).pathname.toLowerCase(); } catch { return String(url).toLowerCase(); }
  })();
  if (/\.(?:mp4|webm|mov|m4v)$/i.test(path)) return 'video';
  if (/\.gif$/i.test(path)) return 'gif';
  if (/\.(?:png|webp|jpe?g|avif|bmp)$/i.test(path)) return 'image';
  return 'unknown';
}

function shadowSignals(title, bodyText) {
  const titleValue = String(title || '').toLocaleLowerCase('ko-KR');
  const bodyValue = String(bodyText || '').toLocaleLowerCase('ko-KR');
  const titleMatched = SHADOW_TERMS.filter((term) => titleValue.includes(term.toLocaleLowerCase('ko-KR')));
  const bodyMatched = SHADOW_TERMS.filter((term) => bodyValue.includes(term.toLocaleLowerCase('ko-KR')));
  return {
    titleMatched,
    bodyMatched,
    matchedCount: new Set([...titleMatched, ...bodyMatched]).size,
  };
}

export function buildShadowAudit(candidate, result, runId, createdAt = new Date().toISOString()) {
  if (!shouldShadowAudit(candidate, result)) return null;
  const mediaUrls = Array.isArray(candidate.mediaUrls)
    ? candidate.mediaUrls.filter((url) => typeof url === 'string' && url.startsWith('https:')).slice(0, 3)
    : [];
  return {
    source: 'inven',
    category: '인벤',
    sourcePostId: String(candidate.sourcePostId || ''),
    sourceUrl: String(candidate.sourceUrl || ''),
    runId: runId || null,
    title: String(candidate.title || '').slice(0, 300),
    bodyText: String(candidate.bodyText || '').slice(0, 5000),
    qualityDecision: 'reject',
    qualityReason: 'no_target_signal',
    signalsJson: JSON.stringify(shadowSignals(candidate.title, candidate.bodyText)),
    mediaCount: mediaUrls.length,
    mediaTypesJson: JSON.stringify(mediaUrls.map(shadowMediaType)),
    representativeMediaJson: JSON.stringify(mediaUrls),
    extractorError: null,
    createdAt,
  };
}

export function selectShadowAudits(candidates, resultRows, runId, createdAt = new Date().toISOString()) {
  const bySourcePostId = new Map((candidates || []).map((candidate) => [String(candidate.sourcePostId), candidate]));
  const eligible = [];
  const audits = [];
  const seen = new Set();
  for (const result of resultRows || []) {
    const candidate = bySourcePostId.get(String(result?.sourcePostId || ''));
    if (!candidate || !isShadowEligible(candidate, result)) continue;
    const identity = String(candidate.sourcePostId || candidate.sourceUrl || '');
    if (seen.has(identity)) continue;
    seen.add(identity);
    eligible.push(candidate);
    const audit = buildShadowAudit(candidate, result, runId, createdAt);
    if (audit) audits.push(audit);
  }
  return { eligibleCount: eligible.length, sampledCount: audits.length, audits };
}
