/**
 * Adapter lookup.
 *
 * The rest of the extension goes through this module rather than importing a
 * site adapter directly, so no call site has to know which sites exist.
 */

import { webtoonsAdapter } from './webtoons.js';
import { naverAdapter } from './naver.js';
import { kakaoAdapter } from './kakao.js';
import { UnsupportedUrlError } from '../common/errors.js';

/** Registration order is match order. */
export const ADAPTERS = [webtoonsAdapter, naverAdapter, kakaoAdapter];

/** Look up an adapter by its id. */
export function getAdapterById(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) ?? null;
}

/**
 * Find the adapter whose host patterns cover a URL.
 *
 * Matches on the registrable domain with a leading-dot check rather than a
 * bare `includes`, so a lookalike host such as `webtoons.com.example.org`
 * cannot be routed to the WEBTOON adapter.
 */
export function getAdapterForUrl(input) {
  let hostname;
  try {
    hostname = new URL(String(input).trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
  return (
    ADAPTERS.find((adapter) =>
      adapter.hostPatterns.some(
        (pattern) => hostname === pattern || hostname.endsWith(`.${pattern}`),
      ),
    ) ?? null
  );
}

/**
 * Resolve a pasted URL to an adapter plus a parsed series reference.
 *
 * Throws rather than returning null: every caller of this needs to show the
 * user a reason, and the two failure modes (wrong site, right site but
 * unparseable URL) deserve different messages.
 */
export function resolveUrl(input) {
  const adapter = getAdapterForUrl(input);
  if (!adapter) {
    throw new UnsupportedUrlError(
      `No adapter handles that link. Supported sites: ${ADAPTERS.map((a) => a.label).join(', ')}.`,
    );
  }
  const ref = adapter.parseUrl(input);
  if (!ref) {
    throw new UnsupportedUrlError(
      `That looks like a ${adapter.label} link, but it is not a series or episode URL.`,
    );
  }
  return { adapter, ref };
}

/** Sites that can actually be downloaded from, for the UI to list. */
export function downloadableAdapters() {
  return ADAPTERS.filter((adapter) => adapter.capabilities.download);
}
