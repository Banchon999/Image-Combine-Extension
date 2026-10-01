/**
 * Chapter selection parsing.
 *
 * Accepted syntax (comma-separated, whitespace tolerated):
 *   all              every chapter
 *   latest           the newest chapter only
 *   latest:5         the newest 5 chapters
 *   12               a single chapter
 *   152.5            a side chapter (some sites number these with decimals)
 *   1-25             an inclusive range
 *   30-              from 30 to the end
 *   -10              from the start to 10
 *   1,3,5-9          any union of the above
 */

import { RangeError_ } from './errors.js';

// A chapter number: an integer, or a decimal side chapter such as 152.5.
const NUM = '\\d+(?:\\.\\d+)?';
const SINGLE = new RegExp(`^${NUM}$`);
const CLOSED = new RegExp(`^(${NUM})\\s*-\\s*(${NUM})$`);
const OPEN_END = new RegExp(`^(${NUM})\\s*-$`);
const OPEN_START = new RegExp(`^-\\s*(${NUM})$`);
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
 *
 * Pass `available` (every chapter the series has) whenever the result will be
 * fed back into parseRange. A run is then only collapsed across chapters that
 * are adjacent in the series itself: with a locked 2.5 between them, [1, 2, 3]
 * must stay "1,2,3", because "1-3" would select 2.5 as well. Without
 * `available`, consecutive integers are treated as adjacent.
 *
 * @param {number[]} numbers
 * @param {number[]} [available]
 */
export function toRangeSpec(numbers, available) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length === 0) return '';

  const order = Array.isArray(available)
    ? new Map([...new Set(available)].sort((a, b) => a - b).map((n, i) => [n, i]))
    : null;
  const adjacent = (a, b) => (order
    ? order.has(a) && order.get(b) === order.get(a) + 1
    : Number.isInteger(a) && b === a + 1);

  const parts = [];
  let start = sorted[0];
  let previous = sorted[0];
  let length = 1;

  const flush = () => {
    if (length === 1) parts.push(String(start));
    else if (length === 2) parts.push(`${start},${previous}`);
    else parts.push(`${start}-${previous}`);
  };

  for (const n of sorted.slice(1)) {
    if (adjacent(previous, n)) {
      previous = n;
      length += 1;
      continue;
    }
    flush();
    start = previous = n;
    length = 1;
  }
  flush();
  return parts.join(',');
}
