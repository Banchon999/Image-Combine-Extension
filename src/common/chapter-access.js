import { parseRange, toRangeSpec } from './ranges.js';

/** Kakao viewer IDs are product IDs, NOT the chapter's display/cursor number. */
export function initialSelection(chapters, ref, adapterId) {
  if (ref?.episodeNo !== undefined) {
    const exact = chapters.find(chapter => adapterId === 'kakao'
      ? String(chapter.productId) === String(ref.episodeNo)
      : Number(chapter.number) === Number(ref.episodeNo));
    // Never silently replace a pasted episode with all/free episodes.
    return exact ? String(exact.number) : '';
  }
  const free = chapters.filter(chapter => chapter.isFree !== false).map(chapter => chapter.number);
  // Pass every chapter so a range never spans a locked one between two free
  // ones (e.g. a locked 2.5 between free 2 and 3).
  return free.length === chapters.length ? 'all' : toRangeSpec(free, chapters.map(chapter => chapter.number));
}

export function validateChapterSelection(chapters, input, allowAccountAccess, adapterId = 'kakao') {
  // parseRange accepts blank as "all", but the UI must require an explicit
  // selection when no free chapters or no matching pasted episode was found.
  if (!String(input ?? '').trim()) throw new Error('Enter the chapter number(s) you want to download.');
  const chosen = parseRange(input, chapters.map(chapter => chapter.number));
  const nonFree = chapters.filter(chapter => chosen.includes(chapter.number) && chapter.isFree === false);
  if (nonFree.length && allowAccountAccess !== true) {
    // Only Kakao has an account-access option; elsewhere, naming it would send
    // the user looking for a checkbox that isn't there.
    throw new Error(adapterId === 'kakao'
      ? 'Selection includes non-free chapters. Enable "Use my existing Kakao access" only if you already have access, or select free chapters.'
      : `Selection includes chapters that are not free yet (${toRangeSpec(nonFree.map(chapter => chapter.number), chapters.map(chapter => chapter.number))}). Select free chapters, or wait until they unlock.`);
  }
  return { chosen, nonFreeCount: nonFree.length };
}
