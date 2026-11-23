/**
 * Title lookup through comick.dev, then a search of the supported sites.
 *
 * comick.dev is used only as a title index: its public search API
 * (api.comick.dev/v1.0/search) matches English, original and alternative
 * titles well, so a reader who only knows "왕은 길 위에서 태어난다" or a
 * half-remembered name finds the series. Nothing is downloaded from comick:
 * its series and chapter pages sit behind a Cloudflare challenge and are
 * never requested. Each chosen title is then searched on the sites this
 * extension supports, and only results whose title matches are kept.
 */

export const COMICK_API = 'https://api.comick.dev/v1.0';
const COVER_HOST = 'https://meo.comick.pictures';
export const COMICK_LIMIT = 20;
const MAX_TITLES = 4;

/** Sites searched for a comick title, in the order they are shown. */
export const FIND_SITES = ['webtoons', 'asura', 'nyx', 'ezmanga', 'violet', 'eva', 'magus', 'valir', 'siren'];

export const comickSearchUrl = (query) =>
  `${COMICK_API}/search?q=${encodeURIComponent(String(query ?? '').trim())}&limit=${COMICK_LIMIT}`;

/** Lower case, accents and punctuation removed, spaces collapsed. */
export function normalizeTitle(title) {
  return String(title ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const ORIGINAL_LANG = { kr: 'ko', jp: 'ja', cn: 'zh', hk: 'zh', tw: 'zh' };
const langRank = (lang, country) => (lang === 'en' ? 0 : lang === ORIGINAL_LANG[country] ? 1 : 2);

/** Results of GET /v1.0/search, newest API shape (2026-11). */
export function parseComickResults(json) {
  if (!Array.isArray(json)) return [];
  const results = [];
  const seen = new Set();
  for (const row of json) {
    const hid = String(row?.hid ?? '');
    const names = (Array.isArray(row?.md_titles) ? row.md_titles : [])
      .map((entry) => ({ title: String(entry?.title ?? '').trim(), lang: String(entry?.lang ?? ''), isDefault: entry?.is_default === true }));
    // The API answers in the language the query matched ("왕은 길 위에서..."
    // for a Korean query); show the English name when there is one.
    const english = names.find((entry) => entry.lang === 'en' && entry.isDefault) ?? names.find((entry) => entry.lang === 'en');
    const title = english?.title || String(row?.title ?? '').trim();
    if (!title || !/^[A-Za-z0-9_-]{1,40}$/.test(hid) || seen.has(hid)) continue;
    seen.add(hid);
    const others = [...names, { title: String(row?.title ?? '').trim(), lang: '' }];
    const alt = [];
    for (const entry of others) {
      if (entry.title && normalizeTitle(entry.title) !== normalizeTitle(title) && !alt.some((a) => normalizeTitle(a.title) === normalizeTitle(entry.title))) alt.push(entry);
    }
    const cover = (Array.isArray(row.md_covers) ? row.md_covers : [])
      .map((entry) => String(entry?.b2key ?? ''))
      .find((key) => /^[A-Za-z0-9_-]+\.(jpe?g|png|webp|gif)$/i.test(key));
    results.push({
      hid,
      title,
      // English names first, then the original language, then the rest.
      altTitles: [...alt].sort((x, y) => langRank(x.lang, row.country) - langRank(y.lang, row.country)).map((entry) => entry.title),
      // English alternative names are the ones the scan sites use.
      englishTitles: [title, ...alt.filter((entry) => entry.lang === 'en').map((entry) => entry.title)],
      cover: cover ? `${COVER_HOST}/${cover}` : '',
      year: Number.isInteger(row.year) ? row.year : null,
      country: String(row.country ?? ''),
      lastChapter: Number.isFinite(Number(row.last_chapter)) && row.last_chapter !== null ? Number(row.last_chapter) : null,
      contentRating: String(row.content_rating ?? ''),
    });
  }
  return results;
}

/** The titles to search the supported sites for: distinct, English first. */
export function titlesToSearch(item) {
  const titles = [];
  const seen = new Set();
  for (const title of [...(item?.englishTitles ?? []), item?.title]) {
    const key = normalizeTitle(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    titles.push(String(title).trim());
    if (titles.length >= MAX_TITLES) break;
  }
  return titles;
}

/**
 * Whether a site's search result is the same series as one of the titles.
 * Exact after normalising, ignoring a trailing bracketed note such as
 * "(Official)" or "[Remake]". Prefixes do not count: "Solo Leveling" and
 * "Solo Leveling: Ragnarok" are different series. Alternative English titles
 * from comick cover the sites that use another name.
 */
const bare = (title) => normalizeTitle(String(title ?? '').replace(/\s*[([][^)\]]*[)\]]\s*$/, ''));

export function titleMatches(candidate, titles) {
  const found = bare(candidate);
  if (!found) return false;
  return titles.some((title) => {
    const wanted = bare(title);
    return Boolean(wanted) && found === wanted;
  });
}

/**
 * Search every site for every title and keep the matches. One failing site
 * never hides the others; it is reported with its error.
 *
 * @param {string[]} titles
 * @param {(adapterId: string, title: string) => Promise<Array<{title: string, url: string}>>} searchSite
 * @param {(adapterId: string) => string} labelOf
 */
export async function findOnSites(titles, searchSite, labelOf, sites = FIND_SITES) {
  const wanted = titles.filter((title) => normalizeTitle(title)).slice(0, MAX_TITLES);
  if (!wanted.length) return [];
  return Promise.all(sites.map(async (adapterId) => {
    const matches = new Map();
    let error = '';
    for (const title of wanted) {
      try {
        for (const result of await searchSite(adapterId, title)) {
          if (result?.url && titleMatches(result.title, wanted) && !matches.has(result.url)) matches.set(result.url, result);
        }
      } catch (failure) {
        error = String(failure?.message ?? failure);
      }
      // Several titles are only worth trying while nothing has matched.
      if (matches.size) break;
    }
    return { adapterId, label: labelOf(adapterId), results: [...matches.values()], ...(matches.size || !error ? {} : { error }) };
  }));
}
