/**
 * Error types shared across the extension.
 *
 * These exist so the UI can react to *why* something failed rather than
 * pattern-matching on message strings.
 */

/** Base class so callers can catch everything this extension throws. */
export class WebtoonDlError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Thrown when a site serves content behind DRM or an entitlement check that
 * this extension deliberately does not attempt to defeat.
 *
 * This is the boundary of the project. It is not a bug and not a
 * "not implemented yet" placeholder waiting to be filled in -- it marks the
 * point where downloading would mean circumventing an access control, and the
 * answer is to stop and tell the user.
 */
export class ProtectedContentError extends WebtoonDlError {
  constructor(message = 'Content is DRM-protected and cannot be downloaded', details = {}) {
    super(message);
    this.details = details;
  }
}

/** A network request failed after all retries were exhausted. */
export class FetchError extends WebtoonDlError {
  constructor(message, { url, status, retryAfterMs } = {}) {
    super(message);
    this.url = url;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * The site answered with an anti-bot check (Cloudflare's "Just a moment…"
 * page) instead of the data. The extension cannot pass such a check and does
 * not try to: it stops asking, instead of repeating the request for every
 * page, and tells the user.
 */
export class BotCheckError extends FetchError {
  constructor(url, { status } = {}) {
    let host = '';
    try { host = new URL(url).hostname; } catch { /* keep empty */ }
    super(
      `${host || 'The site'} answered with a Cloudflare "Just a moment…" check instead of the content. ` +
      'This extension cannot pass anti-bot checks and does not try to get around them. ' +
      'Open the chapter on the site in this browser; if it reads normally there, try again later. ' +
      'If it keeps happening, this site cannot be downloaded from right now.',
      { url, status },
    );
  }
}

/**
 * Whether an error response is an anti-bot challenge page rather than an
 * ordinary refusal. Cloudflare marks its challenges with the cf-mitigated
 * header; the page title and text are the fallback.
 */
export function isBotCheck(status, headers, body = '') {
  if (String(headers?.get?.('cf-mitigated') ?? '').toLowerCase() === 'challenge') return true;
  if (status !== 403 && status !== 429 && status !== 503) return false;
  return /<title>\s*Just a moment\.\.\.\s*<\/title>|challenges\.cloudflare\.com|Enable JavaScript and cookies to continue/i.test(String(body));
}

/**
 * The image CDN rejected us for a missing/incorrect Referer.
 *
 * Called out separately because it has exactly one cause (the
 * declarativeNetRequest rule did not apply) and would otherwise surface as
 * hundreds of identical 403s.
 */
export class RefererRuleError extends WebtoonDlError {
  constructor(message = 'Image CDN rejected the request (Referer rule not applied)', { url } = {}) {
    super(message);
    this.url = url;
  }
}

/** The user asked for a chapter selection that does not parse or does not exist. */
export class RangeError_ extends WebtoonDlError {}

/** A site adapter could not make sense of the URL it was handed. */
export class UnsupportedUrlError extends WebtoonDlError {}

/** The user cancelled the job. */
export class CancelledError extends WebtoonDlError {
  constructor(message = 'Cancelled') {
    super(message);
  }
}
