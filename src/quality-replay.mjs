// Production-parity snapshot used only by read-only diagnostic workflows.
// It never writes to Site, D1, R2, or the public feed.
export function textQualityReplay(title, bodyText) {
  const titleValue = String(title || '').toLocaleLowerCase('ko-KR');
  const value = `${title || ''}\n${bodyText || ''}`.toLocaleLowerCase('ko-KR').trim();
  if (!value) return { decision: 'reject', reason: 'empty_context' };
  const rules = [
    [/미성년(?:자)?|청소년|10대|여고생|남고생|초등학생|중학생|고등학생|아동|어린이|유아/i, 'explicit_minor'],
    [/몰카|도촬|불법\s*촬영|유출|해킹\s*유출|비동의\s*(?:촬영|배포|공유)|리벤지\s*포르노/i, 'explicit_nonconsensual'],
    [/딥페이크|deepfake|(?:ai|인공지능|생성형\s*ai)\s*(?:생성\s*)?(?:그림|일러스트|이미지|사진|아트)|(?:게임|인게임)\s*(?:캐릭터|스크린샷|화면|일러스트|스킨|원화)|애니(?:메이션)?|만화|웹툰|일러스트|팬아트|콘셉트\s*아트/i, 'non_real_content'],
    [/(?:^|[\s()[\]{}:])(?:공지|운영\s*(?:안내|규정)|게시판\s*안내)(?:$|[\s()[\]{}:])|광고|협찬|프로모션|스폰서|상품\s*(?:소개|판매)|구매\s*(?:링크|가능)/i, 'advertisement_or_notice'],
    [/(?:open\s*ai|gpt|llm|언어\s*모델|차세대\s*모델|내부\s*모델|신형\s*모델|소프트웨어\s*모델|제품\s*모델|자동차\s*모델|차량\s*모델|기기\s*모델)/i, 'non_target_context'],
  ];
  for (const [pattern, reason] of rules) if (pattern.test(value)) return { decision: 'reject', reason };
  if (/비키니|수영복|모노키니|란제리|브라렛|시스루|여친룩|파티룩|비치웨어|그라비아|맥심|바디\s*프로필|룩북|치어리더|레이싱\s*모델|피팅\s*모델|여캠|실사\s*(?:사진|인물|여성)|실제\s*인물|여성\s*모델|패션\s*모델|비키니\s*모델|맥심\s*모델/i.test(value)) return { decision: 'accept', reason: 'strong_target_signal' };
  if (/(여성|여자|여캠|눈나|누나|치어리더|인플루언서|아나운서|여배우|연예인|가수|아이돌|걸그룹|bj|스트리머|댄서|배우|인스타|인스타그램|셀카|직캠|릴스|틱톡|몸매|피지컬|골반|각선미|복근|가슴|폭유|슬랜더)/i.test(value) && /사진|화보|영상|움짤|gif|이미지|촬영|출사|직캠|사진\s*(?:세트|모음)/i.test(value)) return { decision: 'accept', reason: 'visual_target_context' };
  if (value.includes('모델') && !/레이싱\s*모델|여성\s*모델|패션\s*모델|화보\s*모델|비키니\s*모델|맥심\s*모델|피팅\s*모델|모델\s*(?:화보|촬영|사진|출사)/i.test(value)) return { decision: 'review', reason: 'ambiguous_model_context' };
  if (value.includes('배우') && !/성인\s*배우|여배우|화보|인스타|비키니|수영복/i.test(value)) return { decision: 'review', reason: 'ambiguous_actor_context' };
  if (/(ㅇㅎ|ㅎㅂ|약후|후방|후방주의|야짤)/i.test(titleValue)) return /인스타|인스타그램|셀카|직캠|릴스|틱톡|사진|화보|영상|움짤|gif|이미지|촬영|출사/i.test(value)
    ? { decision: 'accept', reason: 'weak_marker_with_visual_context' }
    : { decision: 'review', reason: 'weak_only' };
  if (/(여성|여자|여캠|눈나|누나|치어리더|인플루언서|아나운서|여배우|연예인|가수|아이돌|걸그룹|bj|스트리머|댄서|배우|몸매|피지컬|골반|각선미|복근|가슴|폭유|슬랜더|코스프레)/i.test(value)) return { decision: 'review', reason: 'ambiguous_context' };
  return { decision: 'reject', reason: 'no_target_signal' };
}
