/** Versioned, plain-data watchlist. Seen/handled is never a download receipt. */
export const FOLLOW_KEY = 'followedSeriesV1';
export const MAX_FOLLOWED = 500;
const MAX_CHAPTERS = 20000;
const text = (value, max = 500) => String(value ?? '').slice(0, max);
const numericId = value => /^\d{1,40}$/.test(String(value ?? ''));

export function cleanRef(adapterId, source) {
  if (!['webtoons', 'naver', 'kakao'].includes(adapterId) || !numericId(source?.seriesId)) {
    throw new Error('Invalid followed series reference.');
  }
  const ref = { seriesId: String(source.seriesId), lang: adapterId === 'webtoons' ? source.lang : 'ko' };
  if (adapterId === 'naver') {
    ref.section = source.section ?? 'webtoon';
    if (!['webtoon','bestChallenge','challenge'].includes(ref.section)) throw new Error('Invalid NAVER section.');
  }
  if (adapterId === 'webtoons') {
    if (!['en','zh-hant','th','id','es','fr','de'].includes(ref.lang)) throw new Error('Invalid WEBTOON language.');
    for (const field of ['genre','slug']) {
      const value = String(source[field] ?? '');
      if (value.length > 300 || /[/?#\\\s]/u.test(value) || value === '.' || value === '..') throw new Error('Invalid WEBTOON path.');
      ref[field] = value;
    }
  }
  return ref; // Intentionally drops episodeNo and all unknown fields.
}

export function followId(adapterId, source) {
  const ref = cleanRef(adapterId, source);
  return [adapterId, ref.lang, ref.section ?? '', ref.seriesId].join(':');
}

export function chapterIdentity(adapterId, chapter) {
  const value = adapterId === 'kakao' ? chapter.productId : chapter.number;
  if (!numericId(value)) throw new Error('Chapter is missing its stable ID.');
  return String(value);
}

export function chapterSnapshot(adapterId, chapters) {
  if (!Array.isArray(chapters) || chapters.length === 0 || chapters.length > MAX_CHAPTERS) {
    throw new Error('Cannot update following from an empty or oversized chapter list.');
  }
  const found = new Map();
  for (const chapter of chapters) {
    if (!Number.isSafeInteger(chapter.number) || chapter.number < 0) throw new Error('Invalid chapter number.');
    const id = chapterIdentity(adapterId, chapter);
    found.set(id, { id, number: chapter.number, title: text(chapter.title) });
  }
  return [...found.values()].sort((a,b) => a.number - b.number);
}

export function safeCover(value) {
  try {
    const url = new URL(value);
    if (!['https:','http:'].includes(url.protocol)) return '';
    if (!['pstatic.net','webtoons.com','kakao.com','kakaoentcdn.com','webtoon.co.kr']
      .some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return '';
    return url.href;
  } catch { return ''; }
}

export function pendingChapters(entry) {
  const handled = new Set(entry.handledIds);
  return entry.known.filter(chapter => !handled.has(chapter.id));
}

export function createFollowEntry({ adapterId, ref, series }, now, token) {
  const normalizedRef = cleanRef(adapterId, ref);
  const known = chapterSnapshot(adapterId, series?.chapters);
  return { id: followId(adapterId, normalizedRef), token, adapterId, ref: normalizedRef,
    title: text(series.title), author: text(series.author), cover: safeCover(series.cover),
    known, handledIds: known.map(chapter => chapter.id),
    availableIds: known.map(chapter => chapter.id),
    createdAt: now, lastCheckedAt: now, lastAttemptAt: now, lastError: '' };
}

export function updateFollowEntry(entry, series, now) {
  const fresh = chapterSnapshot(entry.adapterId, series?.chapters);
  const known = new Map(entry.known.map(chapter => [chapter.id, chapter]));
  for (const chapter of fresh) known.set(chapter.id, chapter);
  if (known.size > MAX_CHAPTERS) throw new Error('Followed chapter history is too large.');
  return { ...entry, title: text(series.title) || entry.title,
    author: text(series.author), cover: safeCover(series.cover) || entry.cover,
    known: [...known.values()].sort((a,b) => a.number - b.number),
    availableIds: fresh.map(chapter => chapter.id),
    lastCheckedAt: now, lastAttemptAt: now, lastError: '' };
}

/** Only acknowledge the IDs actually shown when the user clicked, not later arrivals. */
export function markHandled(entry, ids) {
  if (!Array.isArray(ids)) throw new Error('Invalid chapter selection.');
  const known = new Set(entry.known.map(chapter => chapter.id));
  const handled = new Set(entry.handledIds);
  for (const id of ids) if (known.has(id)) handled.add(id);
  return { ...entry, handledIds: [...handled] };
}

/** Validate an entire backup before writing anything. Import never fetches URLs. */
export function parseFollowBackup(input) {
  if (input?.version !== 1 || !Array.isArray(input.items) || input.items.length > MAX_FOLLOWED) {
    throw new Error('Invalid following backup or unsupported version.');
  }
  const unique = new Set();
  return input.items.map(item => {
    const ref = cleanRef(item.adapterId, item.ref);
    const id = followId(item.adapterId, ref);
    if (unique.has(id)) throw new Error('Duplicate series in backup.');
    unique.add(id);
    if (!Array.isArray(item.known) || !item.known.length || item.known.length > MAX_CHAPTERS) throw new Error('Invalid chapter history.');
    const ids = new Set();
    const known = item.known.map(chapter => {
      if (!numericId(chapter.id) || ids.has(String(chapter.id)) || !Number.isSafeInteger(chapter.number) || chapter.number < 0) {
        throw new Error('Invalid chapter history entry.');
      }
      if (item.adapterId !== 'kakao' && String(chapter.number) !== String(chapter.id)) throw new Error('Chapter ID mismatch.');
      ids.add(String(chapter.id));
      return {id:String(chapter.id),number:chapter.number,title:text(chapter.title)};
    });
    const idList = values => {
      if (!Array.isArray(values) || values.length > MAX_CHAPTERS || values.some(value => typeof value !== 'string' || !ids.has(value))) {
        throw new Error('Invalid handled/available chapter IDs.');
      }
      return [...new Set(values)];
    };
    const stamp = value => Number.isFinite(value) && value >= 0 ? value : 0;
    return { id, adapterId:item.adapterId, ref, title:text(item.title),author:text(item.author),cover:safeCover(item.cover),
      known, handledIds:idList(item.handledIds),availableIds:idList(item.availableIds),
      createdAt:stamp(item.createdAt),lastCheckedAt:stamp(item.lastCheckedAt),lastAttemptAt:stamp(item.lastAttemptAt),
      lastError:text(item.lastError,1000) };
  });
}
