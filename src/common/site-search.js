/** Public search pages, using only URLs observed in each site's search UI. */
export function buildSiteSearchUrl(provider, query) {
  const keyword = String(query ?? '').trim();
  if (!keyword) throw new Error('Type a title or author to search for.');
  const encoded = encodeURIComponent(keyword);
  if (provider === 'naver') return `https://m.comic.naver.com/search/result?keyword=${encoded}&searchType=WEBTOON`;
  if (provider === 'kakao') return `https://page.kakao.com/search/result/?keyword=${encoded}&categoryUid=10`;
  throw new Error('Unsupported search provider.');
}

/**
 * Self-contained for chrome.scripting.executeScript's isolated world.
 * Reads DOM cards only: no cookies, tokens, scripts or internal application state.
 * root is injectable for parser tests and non-rendered documents.
 */
export function readSearchPage(provider, root = document) {
  const naver = provider === 'naver';
  if (!naver && provider !== 'kakao') throw new Error('Unsupported search provider.');
  const base = naver ? 'https://m.comic.naver.com' : 'https://page.kakao.com';
  const selector = naver ? '.section_search_result .result_lst a[href]' : 'a.flex-1[href]';
  const items = [];
  const seen = new Set();
  const clean = node => String(node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  for (const card of root.querySelectorAll(selector)) {
    let link;
    try { link = new URL(card.getAttribute('href'), base); } catch { continue; }
    if (link.origin !== base) continue;
    const seriesId = naver ? link.searchParams.get('titleId') : link.pathname.match(/^\/content\/(\d+)\/?$/)?.[1];
    if (!/^\d+$/.test(seriesId ?? '') || (naver && link.pathname !== '/webtoon/list')) continue;
    // Kakao recommendation tiles do not have the search-result card metadata.
    if (!naver && !card.querySelector('[aria-label^="작품,"]')) continue;
    const title = clean(card.querySelector(naver ? '.toon_name' : '.line-clamp-2'));
    if (!title || seen.has(seriesId)) continue;
    const author = naver ? clean(card.querySelector('p.sub_info'))
      : clean(Array.from(card.querySelectorAll('.mb-12pxr span')).at(-1));
    const img = card.querySelector(naver ? 'img' : 'img[alt="썸네일"]');
    let thumbnail = '';
    try {
      const raw = img?.getAttribute('data-src')?.trim() || img?.getAttribute('src')?.trim();
      if (raw) {
        const url = new URL(raw, base);
        if (url.protocol === 'https:' || url.protocol === 'http:') thumbnail = url.href;
      }
    } catch { /* A bad thumbnail must not discard the title. */ }
    seen.add(seriesId);
    items.push({ seriesId, title, author, thumbnail,
      url: naver ? `https://comic.naver.com/webtoon/list?titleId=${seriesId}` : `${base}/content/${seriesId}` });
  }
  // An unrendered shell or changed selector is NOT an empty search result.
  const empty = naver ? Boolean(root.querySelector('.section_search_result .no_lst'))
    : Array.from(root.querySelectorAll('span, p, div')).some(node =>
      node.children.length === 0 && clean(node) === '검색 결과가 없습니다.');
  return { ready: items.length > 0 || empty, items };
}
