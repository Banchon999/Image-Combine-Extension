/**
 * The site adapter contract.
 *
 * Every supported site implements this shape, so the UI and the download
 * pipeline never branch on which site a job belongs to. Adding a site means
 * adding one module here and registering it -- nothing above this layer
 * changes.
 *
 * Adapters are given a `ctx` rather than calling fetch/DOMParser directly.
 * That keeps them free of any dependency on the offscreen document, which is
 * what makes them testable outside a browser.
 *
 * @typedef {object} AdapterContext
 * @property {(url: string) => Promise<Document>} fetchDoc  fetch and parse HTML
 * @property {(url: string) => Promise<any>} fetchJson       fetch and parse JSON
 * @property {(url: string) => Promise<Response>} fetchRaw  fetch without parsing
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} SeriesRef
 * @property {string} seriesId
 * @property {string} lang
 * @property {string} [genre]
 * @property {string} [slug]
 *
 * @typedef {object} SearchResult
 * @property {string} seriesId
 * @property {string} title
 * @property {string} [author]
 * @property {string} [thumbnail]
 * @property {string} url
 *
 * @typedef {object} Chapter
 * @property {number} number    the site's own episode number
 * @property {string} [title]
 * @property {string} [date]
 * @property {string} url
 *
 * @typedef {object} Series
 * @property {string} title
 * @property {string} [author]
 * @property {string} [summary]
 * @property {string} [cover]
 * @property {Chapter[]} chapters
 *
 * @typedef {object} ImageRef
 * @property {string} url
 * @property {number} index
 * @property {number} [width]   from the page markup, when published there
 * @property {number} [height]
 * @property {boolean} [requirePlainImage] require a supported image signature; never decrypt
 *
 * @typedef {object} Capabilities
 * @property {boolean} search          can search by title
 * @property {boolean} originalQuality can bypass CDN recompression
 * @property {boolean} download        can actually retrieve page images
 * @property {boolean} [accountAccess] supports explicit existing-session access
 * @property {string[]} languages
 *
 * @typedef {object} SiteAdapter
 * @property {string} id
 * @property {string} label
 * @property {string[]} hostPatterns
 * @property {Capabilities} capabilities
 * @property {(url: string) => (SeriesRef & {episodeNo?: number}) | null} parseUrl
 * @property {(query: string, lang: string, ctx: AdapterContext) => Promise<SearchResult[]>} search
 * @property {(ref: SeriesRef, ctx: AdapterContext) => Promise<Series>} getSeries
 * @property {(ref: SeriesRef, chapter: Chapter, ctx: AdapterContext, opts: object) => Promise<ImageRef[]>} getChapterImages
 */

export {};
