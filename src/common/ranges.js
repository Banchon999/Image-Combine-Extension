/**
 * Chapter selection parsing.
 *
 * Accepted syntax (comma-separated, whitespace tolerated):
 *   all              every chapter
 *   latest           the newest chapter only
 *   latest:5         the newest 5 chapters
 *   12               a single chapter
 *   1-25             an inclusive range
 *   30-              from 30 to the end
 *   -10              from the start to 10
 *   1,3,5-9          any union of the above
 */

import { RangeError_ } from './errors.js';

const SINGLE = /^\d+$/;
const CLOSED = /^(\d+)\s*-\s*(\d+)$/;
const OPEN_END = /^(\d+)\s*-$/;
const OPEN_START = /^-\s*(\d+)$/;
const LATEST_N = /^latest\s*:\s*(\d+)$/i;

/**
 * Resolve a selection spec against the chapter numbers a series actually has.
 *
 * Selecting against the real list (rather than emitting a numeric range) means
 * a series with gaps or non-contiguous numbering cannot produce requests for
 * chapters that do not exist.
 *
 * @param {string} spec
 * @param {number[]} available the chapter numbers that exist
 * @returns {number[]} selected chapter numbers, ascending, de-duplicated
 */
export function parseRange(spec, available) {
  if (!Array.isArray(available) || available.length === 0) {
    throw new RangeError_('This series has no chapters to select from');
  }

  const text = String(spec ?? '').trim();
  if (text === '' || text.toLowerCase() === 'all') {
    return [...available].sort((a, b) => a - b);
  }

  const sorted = [...available].sort((a, b) => a - b);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const selected = new Set();

  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;

    if (part.toLowerCase() === 'latest') {
      selected.add(highest);
      continue;
    }

    const latestN = part.match(LATEST_N);
    if (latestN) {
      const count = Number(latestN[1]);
      if (count === 0) throw new RangeError_(`"${part}" selects nothing`);
      for (const n of sorted.slice(-count)) selected.add(n);
      continue;
    }

    let start;
    let end;
    let match;
    if (SINGLE.test(part)) {
      start = end = Number(part);
    } else if ((match = part.match(CLOSED))) {
      start = Number(match[1]);
      end = Number(match[2]);
    } else if ((match = part.match(OPEN_END))) {
      start = Number(match[1]);
      end = highest;
    } else if ((match = part.match(OPEN_START))) {
      start = lowest;
      end = Number(match[1]);
    } else {
      throw new RangeError_(`Could not understand "${part}" in the chapter selection`);
    }

    if (start > end) {
      throw new RangeError_(`Range "${part}" starts after it ends`);
    }
    for (const n of sorted) {
      if (n >= start && n <= end) selected.add(n);
    }
  }

  if (selected.size === 0) {
    throw new RangeError_(`"${text}" did not match any chapter in this series`);
  }
  return [...selected].sort((a, b) => a - b);
}

/** Human-readable summary of a selection, for the confirm step in the UI. */
export function describeSelection(numbers) {
  if (!numbers || numbers.length === 0) return 'nothing';
  if (numbers.length === 1) return `chapter ${numbers[0]}`;
  return `${numbers.length} chapters (${numbers[0]}-${numbers[numbers.length - 1]})`;
}

/**
 * Compress a list of chapter numbers into the spec syntax above.
 *
 * Used to pre-fill the selection box when only part of a series is
 * downloadable, so the user sees "1-3" rather than a wall of commas.
 */
export function toRangeSpec(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const parts = [];
  let start = sorted[0];
  let previous = sorted[0];

  const flush = () => {
    if (start === previous) parts.push(String(start));
    else if (previous === start + 1) parts.push(`${start},${previous}`);
    else parts.push(`${start}-${previous}`);
  };

  for (const n of sorted.slice(1)) {
    if (n === previous + 1) {
      previous = n;
      continue;
    }
    flush();
    start = previous = n;
  }
  flush();
  return parts.join(',');
}
