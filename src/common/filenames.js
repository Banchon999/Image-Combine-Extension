/**
 * Filename construction for the downloads directory.
 *
 * chrome.downloads rejects a filename outright if it contains a path traversal
 * or a reserved character, which would fail the job at the very last step after
 * every image was already fetched. So sanitising is deliberately strict and
 * happens before any network work starts.
 */

// Reserved on Windows; a superset of what POSIX cares about.
const ILLEGAL = /[<>:"/\\|?*]/g;
// CON, PRN, AUX, NUL, COM1-9, LPT1-9 are reserved device names on Windows.
const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const MAX_SEGMENT = 100;
const MAX_SEGMENT_BYTES = 180;
const encoder = new TextEncoder();
const DEL = 0x7f;
const FIRST_PRINTABLE = 0x20;

/**
 * Drop C0 control characters and DEL, which are illegal in filenames on every
 * platform we target.
 *
 * Written as a codepoint scan rather than a regex on purpose: the equivalent
 * character class can only be spelled with raw control bytes or escapes, both
 * of which are invisible in a diff and easy to corrupt silently.
 */
function stripControl(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0);
    // Substitute a space rather than deleting: a tab or newline sits between
    // words, and dropping it outright would run them together.
    out += code < FIRST_PRINTABLE || code === DEL || (code >= 0xd800 && code <= 0xdfff) ? ' ' : ch;
  }
  return out;
}

/**
 * Make one path segment safe. Never returns an empty string, because an empty
 * segment silently collapses the path and lands files in the wrong folder.
 */
function truncateName(text, suffix = '') {
  let out = '';
  let bytes = encoder.encode(suffix).length;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (out.length + ch.length + suffix.length > MAX_SEGMENT || bytes + size > MAX_SEGMENT_BYTES) break;
    out += ch;
    bytes += size;
  }
  return out.trim().replace(/[. ]+$/, '');
}

export function sanitizeSegment(input, fallback = 'untitled') {
  let out = stripControl(String(input ?? '').normalize('NFC'))
    .replace(/\p{Cf}/gu, '')
    .replace(ILLEGAL, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Windows discards trailing dots and spaces, which would make the name on
    // disk differ from the one the UI reported. Strip them ourselves so the two
    // always agree.
    .replace(/[. ]+$/, '');

  if (RESERVED_DEVICE.test(out)) out = `_${out}`;
  out = truncateName(out);
  return out === '' ? truncateName(stripControl(String(fallback)).replace(ILLEGAL, ' ')) || 'untitled' : out;
}

/** Keep the terminal extension outside both filename length budgets. */
export function sanitizeFilename(input) {
  const text = String(input ?? '');
  const suffix = text.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? '';
  const stem = suffix ? text.slice(0, -suffix.length) : text;
  return `${truncateName(sanitizeSegment(stem), suffix)}${suffix}`;
}

/** Validate the entire relative path at the chrome.downloads boundary. */
export function safeDownloadPath(input) {
  const path = String(input ?? '').replace(/\\/g, '/');
  const parts = path.split('/');
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || parts.some(p => !p || p.trim() === '.' || p.trim() === '..')) {
    throw new Error('Unsafe download path: use a relative folder without empty or traversal segments.');
  }
  return parts.map((p, i) => i === parts.length - 1 ? sanitizeFilename(p) : sanitizeSegment(p)).join('/');
}

/** Left-pad a chapter number so lexical sort matches numeric sort. */
export function padChapter(number, width = 3) {
  const n = Number(number);
  if (!Number.isFinite(n)) return sanitizeSegment(number, '000');
  const body = String(Math.trunc(Math.abs(n))).padStart(width, '0');
  return n < 0 ? `-${body}` : body;
}

/** Extension for an image, inferred from MIME then URL, defaulting to jpg. */
export function imageExtension(url, mimeType) {
  const fromMime = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
  }[String(mimeType || '').split(';')[0].trim().toLowerCase()];
  if (fromMime) return fromMime;

  const path = String(url || '').split(/[?#]/)[0];
  const match = path.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i);
  if (!match) return 'jpg';
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * Build the relative path handed to chrome.downloads.
 *
 * Joins pre-sanitised segments; the leading-slash and ".." checks are a
 * belt-and-braces guard, since a traversal here would write outside the
 * downloads directory.
 */
export function buildPath(segments) {
  const parts = segments
    .filter((s) => s !== null && s !== undefined && s !== '')
    .map((s) => sanitizeSegment(s));
  const joined = parts.join('/');
  if (joined.startsWith('/') || joined.split('/').includes('..')) {
    throw new Error(`Refusing to build unsafe download path: ${joined}`);
  }
  return joined;
}

/** Folder name for one chapter, shared by the raw and archive paths. */
function chapterBase(chapterNumber, chapterTitle, padWidth) {
  const padded = padChapter(chapterNumber, padWidth);
  return chapterTitle ? `${padded} - ${sanitizeSegment(chapterTitle)}` : padded;
}

/** Full relative path for one raw image inside a chapter folder. */
export function imagePath({
  seriesTitle,
  chapterNumber,
  chapterTitle,
  index,
  url,
  mimeType,
  padWidth = 3,
}) {
  const file = `${padChapter(index, 3)}.${imageExtension(url, mimeType)}`;
  return buildPath([seriesTitle, chapterBase(chapterNumber, chapterTitle, padWidth), file]);
}

/** Full relative path for a converted single-file chapter (pdf/cbz/zip). */
export function archivePath({
  seriesTitle,
  chapterNumber,
  chapterTitle,
  format,
  padWidth = 3,
}) {
  const base = chapterBase(chapterNumber, chapterTitle, padWidth);
  if (!['pdf', 'cbz', 'zip'].includes(format)) throw new Error(`Unsupported archive format: ${format}`);
  // Reserve the suffix BEFORE buildPath applies the segment length limit.
  return buildPath([seriesTitle, sanitizeFilename(`${base}.${format}`)]);
}
