import assert from 'node:assert/strict';
import { groupCommonsFiles, normalizeCommonsFile } from './commons-kindai.mjs';

function page(pageid, title, person, license = 'CC BY 4.0') {
  return {
    pageid,
    title: `File:${title}`,
    categories: [
      { title: 'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)' },
      ...(person ? [{ title: `Category:${person}` }] : []),
    ],
    imageinfo: [{
      url: `https://upload.wikimedia.org/wikipedia/commons/${pageid}/${title}`,
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/${pageid}/${title}/1280px-${title}`,
      mime: 'image/jpeg',
      width: 2400,
      height: 1600,
      timestamp: '2026-07-14T00:00:00Z',
      extmetadata: {
        Artist: { value: 'Bject' },
        LicenseShortName: { value: license },
        LicenseUrl: { value: license === 'CC BY 4.0' ? 'https://creativecommons.org/licenses/by/4.0/' : '' },
        DateTimeOriginal: { value: '2026-07-01 12:00:00' },
        ImageDescription: { value: `${person || 'event'} swimsuit photo` },
      },
    }],
  };
}

const ok = normalizeCommonsFile(page(1, 'IMG_0001.jpg', 'Chiharu Okui'), 'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)');
assert.equal(ok.eventDate, '2026-07-01');
assert.equal(ok.depictedPerson, 'Chiharu Okui');
assert.equal(ok.licenseVerified, true);
assert.equal(ok.author, 'Bject');
assert.match(ok.attributionText, /CC BY 4\.0/);

const notReusable = normalizeCommonsFile(page(2, 'IMG_0002.jpg', 'Chiharu Okui', 'All rights reserved'), 'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)');
assert.equal(notReusable.licenseVerified, false);

const grouped = groupCommonsFiles([
  ok,
  normalizeCommonsFile(page(3, 'IMG_0003.jpg', 'Chiharu Okui'), 'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)'),
  normalizeCommonsFile(page(4, 'IMG_0004.jpg', 'Ibuki Aoi'), 'Category:Kindai Mahjong Swimsuit Festival (July 1, 2026)'),
], { maxPosts: 20, maxMediaPerPost: 10 });
assert.equal(grouped.length, 2);
assert.equal(grouped.find((item) => item.depictedPerson === 'Chiharu Okui').mediaUrls.length, 2);
assert.equal(grouped.every((item) => item.attributionComplete), true);
assert.equal(grouped.every((item) => item.source === 'commons_kindai'), true);

console.log('commons kindai fixture ok');
