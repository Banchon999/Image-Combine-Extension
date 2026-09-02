# Webtoon Downloader

## v1.0.9 — fixed desktop stitching limits

This release supersedes the v1.0.8 mobile-oriented canvas limits below.
The same fixed limits now apply on every device; there is no mobile downgrade:

- JPG/PNG (and JPEG rendered for PDF): width and height up to **32,767 px**.
- WebP: width and height up to **16,383 px**, a codec constraint. Select JPG/PNG
  for 18,000 px output. Switching codecs does not silently change your input;
  an invalid manual height/width must be corrected before downloading.
- Maximum canvas area: **268,435,456 pixels (256 Mi-pixels)**. This replaces
  the 8,388,608-pixel mobile budget. At maximum area an RGBA canvas alone uses
  approximately 1 GiB; source decoding, encoding and archives need more RAM.
- Smart uses the codec height limit and desktop area budget. Manual height
  starts at **18,000 px**. Width `0` still preserves the narrowest source width;
  raising a limit does not upscale images automatically. Count mode still
  preserves all content and enforces the requested count/height constraints.

These are application limits, not universal PC/browser capabilities. Extremely
wide and tall dimensions cannot both reach the individual maximum under the
area budget. Allocation/encoding can fail earlier on a particular browser or
device, especially mobile; errors suggest reducing dimensions. Very large
allocations can also cause the browser to terminate the process before an error
can be shown. No automatic fallback to the old mobile limits is performed.
The 256 MiB compressed archive-content cap and sequential stitching remain.

Offline verification: 188 tests, plus native raster encode/decode checks for
JPG/PNG at 18,000 and 32,767 px in both orientations, and Smart WebP splitting
at 16,383 px. No maximum-area allocation stress test or Quetta E2E test was run.
Replace files in your existing unpacked extension folder and Reload; back up
Following first. No new browser permissions.

## v1.0.8 — per-chapter long-image stitching

Open a series, enable **ต่อภาพแนวตั้งแยกแต่ละตอน (Long images)**, then choose:

- **Smart**: automatically choose a height up to 8192 px, reduced as needed to
  keep each output canvas within 8,388,608 pixels. This is a conservative pixel
  budget, NOT a measurement of free device RAM or a guarantee against mobile
  memory limits. It does not detect panels, speech balloons, or whitespace.
- **Maximum height**: split at your requested pixel height; the last image may
  be shorter. Unsafe dimensions produce an error with the allowed height.
- **Count + maximum height**: produce exactly the requested number of images
  with nearly equal heights. The height is a ceiling, not padding/stretching to
  an exact size. If that count cannot hold the full chapter within the height
  and safety limits, report the minimum count; never discard the remaining rows.

Width `0` uses the narrowest source width. Other widths resize proportionally.
Limits are 8192 px width, 16384 px height, the pixel budget above, and 2000 parts.
Stitching is separate for each chapter and off by default. Settings apply to the
current download; reopening a series resets these controls to their defaults.

Image codecs: **JPG**, **PNG**, **WebP**. JPG/WebP quality is adjustable (1–100).
PNG is lossless for the rendered output, but resizing can change source pixels;
JPG/WebP are re-encoded. Transparent backgrounds become white. An unsupported
browser encoder is reported, not silently renamed to another extension.

Containers: choose **Raw images** for separate stitched image files, **ZIP/CBZ**
to bundle them, or **PDF** for one page per stitched part. PDF embeds JPEG, so
the image-type selector is disabled in PDF mode. Outputs include `- stitched`
in their chapter name. Turning stitching off preserves the original export path.

Only one stitching operation runs at a time. Input files remain compressed in
memory; rendering uses one source bitmap and one output canvas at a time.
Compressed stitched archive content is capped at 256 MiB; use separate images
for larger output. Total process memory may be higher than either limit.
If any source image fails, stitching refuses that incomplete chapter. Encoding
errors stop the chapter and suggest smaller dimensions; already saved separate
parts can remain on disk. Optional staged originals are removed only after the
archive saves successfully. No new permissions or changes to Kakao access.

Upgrade: back up Following using **สำรองรายการ JSON** first. Replace files in
the existing unpacked installation folder, then Reload the extension. Do not
uninstall if you want to retain its local data. Try one chapter with Smart +
PNG + ZIP first, then test your preferred count/height and codec.

Verification: 185 offline unit/integration tests passed. Optional real native
raster tests (`node test/native/stitch.mjs`, requires `@napi-rs/canvas`) encode
and decode JPG/PNG/WebP, check all 120 PNG fixture rows across split boundaries,
exact-count output, Smart splitting of 720×9000 input, white transparency,
and archive/PDF construction. These are not browser codec or Quetta E2E tests.
`test/browser/stitch.html` is included for browser testing; the remote test
browser could not open the local harness here. Actual Quetta testing is pending.

## v1.0.7 — followed series / new-chapter tracking

1. Open a series and click **ติดตามเรื่องนี้** (Follow this series). All currently
   listed chapters become the starting baseline; this does not claim that those
   chapters were downloaded.
2. Open **ติดตาม** (Following), then **เช็กตอนใหม่** or **เช็กตอนใหม่ทั้งหมด**.
   A series going from 100 to 101 reports the new chapter. Checks are manual;
   this version does not poll, notify, purchase, or download while closed.
3. **เลือกโหลดตอนใหม่** refreshes the series and opens the existing download form
   with only pending, currently listed chapters selected. Kakao account access
   remains an explicit per-job choice and is never stored in the watchlist.
4. After verifying downloads, use **จัดการตอนที่แสดงแล้ว** to acknowledge the
   displayed pending chapters. This is manual bookkeeping, not a download
   receipt. Simply checking again, a failed download, or a failed network check
   never clears pending chapters. You can also acknowledge chapters you choose
   to skip; a confirmation explains the effect.

The watchlist is stored in `chrome.storage.local` and survives app/browser
restarts. It identifies chapters by stable product ID on Kakao and episode
number on NAVER/WEBTOON, so inserted chapters and renumbered Kakao entries are
not missed by a highest-number-only comparison. Temporarily missing chapters
retain their history. Checks are sequential across the list; concurrent checks
of one series share a request. Storage updates are serialized.

**Backup before removing or reinstalling the extension:** use **สำรองรายการ JSON**
and **นำเข้ารายการ**. Import validates the entire file before writing and adds
missing series only; it does not overwrite progress of already-followed series
or fetch imported URLs. Limits: 500 series, 20,000 chapter IDs per series, 5 MB
watchlist data. Unsupported/corrupt data or storage quota errors are reported
without silently clearing the old list.

For unpacked upgrades, replace files in the same installation folder and click
Reload to preserve the extension ID/storage. Loading from a different path can
create a separate extension with separate data. A backup is the portable option.

No additional permissions are requested. Search, existing Kakao account access,
filename handling, and ZIP/CBZ exports from v1.0.6 are retained. User-confirmed
v1.0.6 account downloads worked; the new tracking workflow is separately tested.

Verification: 169 automated tests passed, including 23 following-model/storage
tests and 4 controller smoke tests using a small DOM double (not a browser).
Tests cover 100 → 101, repeated checks, older insertions,
Kakao product-ID renumbering, explicit acknowledgement, failed/empty responses,
concurrent writes, restart persistence, remove/re-add races, quota errors, and
backup validation/merge. Actual Quetta UI/storage/reinstall behavior has not
been exercised in this environment.

## v1.0.6 — opt-in existing Kakao account access (experimental)

For a chapter you already purchased or rented and can fully read in the same
browser/profile, enable **Use my existing Kakao access** on the chapter page.
This option is off each time a series is opened. Start with one episode.

The existing viewer GET request uses `credentials: include`. Account mode removes
only the local free-only precheck: Kakao's server must still return supported
viewer data. The extension does not call purchase, ticket-redemption or unlock
APIs, extract credentials/tokens, manufacture entitlement flags, or decrypt DRM.
Unrecognized image bytes are rejected, even if labeled `image/jpeg` by a server.

The `is_free` catalog field does not establish whether a user owns a chapter.
Non-free chapters are now labeled **access unchecked**, not falsely presented as
known locked. Pasted Kakao viewer product IDs are matched against the chapter
list before selection; a missing match never silently selects all/free chapters.

The supplied viewer `62711843 / 70440946` displayed episode 146 and a login prompt
in the test browser. The user reports fully reading it in their own Quetta session.
That session is not available here: successful authenticated API access/download
has **not** been verified. Cookies may not be sufficient if Kakao's website uses
another session mechanism. HTTP 401/403 therefore reports an API/session issue
without asserting missing ownership or DRM; no alternate authentication or
access-bypass path is attempted.

Verification: 142 automated tests, including 14 new tests for explicit opt-in,
default refusal, exact viewer-ID selection, rejected/missing viewer responses,
image signatures, and the actual adapter + engine pipeline with mocked I/O.
No new permissions beyond v1.0.5. Earlier search, filename, ZIP/CBZ and NAVER fixes
are retained.

## v1.0.5 — NAVER and Kakao title search

- Choose WEBTOON, NAVER Webtoon or Kakao Page in **Search site**.
- NAVER and Kakao search their Korean webtoon catalogs by title/author. WEBTOON retains all seven language choices.
- Select a result to open the existing chapter picker. Kakao's free-chapter restriction is unchanged.
- Korean searches open an inactive temporary tab, read rendered result cards, then close the owned tab. A tab navigated elsewhere by the user is preserved. No private API, login token or embedded application state is read.
- The new `scripting` permission is used only to read these search pages; `dn-img-page.kakao.com` is added for Kakao thumbnails. Reload/reinstall the unpacked extension and allow the updated permissions.
- Results are the first stable loaded batch, not a promise to enumerate the entire catalog. Use **See all results on the site** for more, then paste a series URL if needed.
- A loading failure is reported separately from genuine zero matches. Duplicate titles/links and stale responses after changing the search are handled.

Verification: 128 automated tests (including 15 new search tests), plus the exact
DOM reader evaluated on live search pages: NAVER `화산귀환` returned series
769209; Kakao `나 혼자만 레벨업` returned six webtoon results including 50866481.
Both sites' explicit no-results pages were also checked. These are live parser
checks, not an end-to-end extension/Quetta test. Existing filename, ZIP/CBZ and
NAVER mobile-viewer fixes are retained.

## v1.0.4 — invalid filename handling

Filename segments now respect a 180-byte UTF-8 budget as well as the existing
100-UTF-16-unit limit, without splitting surrogate pairs or losing extensions.
Unicode format/control characters and reserved device names are sanitized;
the entire relative path is validated before calling chrome.downloads.

If the browser rejects the name with `Invalid filename`, the same Blob is
retried once as `webtoon-<unique-id>.cbz` (or the selected image/archive
extension), directly in Downloads without subfolders. The rename is logged.
This fallback does not re-fetch images or retry permission/disk/network errors.
The user's exact Kakao filename was not supplied, so its specific cause and
successful saving on Quetta have not been independently reproduced.

## v1.0.3 — NAVER mobile viewer fix

Quetta/Android requests can redirect from comic.naver.com to m.comic.naver.com
with HTTP 200. The mobile viewer uses `img.toon_image`, not the desktop viewer
containers. The parser now includes that selector and reads `data-src` before
the transparent lazy-loading `src`. Static placeholders are still excluded;
chapter order and URL deduplication are preserved. No new permissions or
User-Agent changes are needed. ZIP/CBZ fixes from v1.0.2 are retained.

Regression tests cover mobile lazy images, placeholders, duplicate URLs,
whitespace attributes, and a mobile response returned for a desktop request.
Live parser checks are separate from an end-to-end Quetta extension download.

The exact revised parser was evaluated against the live episode-1 DOM for
title 836848: mobile changed from 0 selector matches to 103 unique page URLs,
with no static placeholders. Desktop also returned 103 page URLs; its 104 raw
image elements include an age-rating notice excluded by the existing filter.
The full Quetta download/save flow has not been tested in this environment.

A Chrome (Manifest V3) extension that downloads webtoon chapters as **PDF**, **CBZ**, **ZIP** or **raw images**, with title search, chapter-range selection, parallel fetching and original-quality images.

Requests ride on your browser's own session, so age-gated series work without the extension ever handling your credentials.

---

## Supported sites

| Site | Status |
|---|---|
| **webtoons.com** | Fully supported — search, chapter listing, downloads, all 7 languages |
| **comic.naver.com** | Korean webtoon search, URL support, episode API, pagination, viewer images; full extension download still needs live verification |
| **page.kakao.com** | Korean webtoon search; free downloads by default; experimental opt-in existing account access; no decryption or unlocking |

### Kakao Page: free by default, existing account access optional

Kakao Page mixes free and paid chapters in one series. Its API publishes an `is_free` catalog flag. By default, anything not explicitly free is refused before any viewer request. The opt-in account mode instead lets the viewer server decide whether the current browser session may read the selected chapter. It never treats `is_free: false` as proof that a purchase is missing.

The adapter accepts only the supported image-viewer response and does not decrypt protected content. A public free episode opened in the browser during v1.0.2 checks. Purchased-episode API compatibility remains unverified in an authenticated session. Do not interpret a missing API field or a generic HTTP 403 as proof of DRM or an incorrect Referer.

In practice this means a lot of a series is skipped. A sample series had **32 chapters: 3 free, 29 locked**. The app shows the split before you start and pre-fills the chapter box with just the free ones, so you are never queuing a job that mostly fails.

The `is_free` check in `src/adapters/kakao.js` is load-bearing. A unit test asserts a locked chapter produces **zero network calls**; if the check is ever moved after the fetch, that test fails. Do not "simplify" it away — it is the difference between a downloader for public chapters and a paywall bypass.

---

## Install

No build step and no dependencies — clone and load it.

1. `git clone` this repository.
2. Open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the repository folder.

Requires Chrome 116 or newer.

## Use

Click the toolbar icon. That opens the app in a **full browser tab** — one click, no popup in the way. Clicking again focuses the tab you already have open rather than piling up duplicates.

A tab rather than a popup because a popup closes the moment focus moves, which is hostile during a long download. If you click the icon while looking at a supported series, that series is loaded automatically so you don't have to paste the link you were already on.

The layout adapts to the window: wide enough, and the queue is pinned in its own column so you can watch a download progress while browsing for the next series; narrower, and it folds back into a third tab.

- **Search** — find a series by title in any supported language, or paste a series/episode URL directly.
- **Series** — pick chapters, choose a format, start the download.
- **Queue** — per-chapter progress, with cancel.

### Chapter selection syntax

| Input | Selects |
|---|---|
| `all` *(or blank)* | every chapter |
| `latest` | the newest chapter |
| `latest:5` | the newest five |
| `12` | one chapter |
| `1-25` | an inclusive range |
| `30-` | chapter 30 to the end |
| `-10` | the start through chapter 10 |
| `1,3,5-9` | any union of the above |

Selections resolve against the chapters the series actually has, so a range spanning a gap in the numbering won't request episodes that don't exist.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Format | `cbz` | `pdf`, `cbz`, `zip`, or `raw` images |
| Original-quality images | on | See below — roughly 3x the file size |
| Concurrent chapters | 1 | 1–8 |
| Concurrent images | 4 | 1–16 |
| Retry attempts | 5 | Exponential backoff with jitter |
| Throttle | 150 ms | Staggers request starts |
| Write raw, then clean up | off | See below |
| Download folder | `Webtoons` | Relative to your Downloads directory |

### Original-quality images

The viewer serves episode images with a `?type=q90` parameter — a server-side recompression. Dropping just that parameter returns the source encode at identical pixel dimensions. Measured on a sample page: **159 KB vs 57 KB** for the same 700×1140 image.

The PDF writer embeds JPEG data **verbatim** as a `DCTDecode` stream, so this quality survives into the finished file. Routing pages through a canvas — the usual approach — would decode and re-compress every page and silently undo it.

### "Write raw, then clean up"

An extension can't delete arbitrary folders, but it *can* delete files it downloaded itself. With this on, raw images are written to disk, the archive is built, and the staged images are then removed — and only after the archive is safely written. With it off (the default) images are held in memory and never touch disk at all, which is faster; the disk path exists for jobs large enough that holding them in RAM is unwise.

---

## How it works

```
App page    ──▶  Service worker  ──▶  Offscreen document
  (UI)            (downloads,           (fetch, parse,
                   routing)              convert  — the engine)
```

The split exists for one reason: **an MV3 service worker is torn down after ~30 seconds idle**, which would abort a chapter download mid-flight. So the worker only orchestrates and performs `chrome.downloads` calls, while the offscreen document — which persists — owns everything long-running. The engine itself (`src/offscreen/engine.js`) takes all I/O through an injected object, so it has no dependency on `chrome.*`, `fetch` or the DOM, and the whole pipeline is testable outside a browser.

### The Referer rule

The image CDN returns **403** without `Referer: https://www.webtoons.com/`. `Referer` is a [forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name), so `fetch()` cannot set it. A static `declarativeNetRequest` rule (`rules/referer.json`) attaches it instead.

This is the single point of failure for every image request, so a 403 is typed as `RefererRuleError` and never retried — it's deterministic, and retrying would only multiply the failures.

### No third-party libraries

CBZ and PDF writing are implemented directly (`src/offscreen/convert/`). MV3 forbids remote code, so any library would have to be vendored into the tree anyway; a store-only ZIP writer and a JPEG-embedding PDF writer are small enough that vendoring one costs more than writing them. Writing them also buys the verbatim-JPEG behaviour above, which a general-purpose PDF library will not do unless carefully steered.

---

## Development

```bash
npm test              # 87 unit tests, no dependencies
npm run test:browser  # loads the extension in Chromium, checks DOM parsers
npm run icons         # regenerate src/icons/*.png
```

`test/browser/live.mjs` is an opt-in end-to-end check against the real site. It is **not** part of `npm test`, because it makes real requests; run it deliberately and keep the chapter count at one.

### What is verified, and what is not

Verified automatically:

- 87 unit tests covering range parsing, filename safety, adapter URL handling, the converters, and the full engine pipeline (retries, partial chapters, format branching, cleanup ordering, cancellation).
- CBZ output passes `unzip -t`, extracts byte-identical to source, and handles non-ASCII filenames.
- PDF output parses with an independent library, with correct page sizing and metadata, and the embedded JPEG is byte-identical to the source.
- The extension loads in Chromium with no manifest, module or service-worker errors; the DNR ruleset is active; the app page renders and message round-trips succeed.
- The page layout is checked at both a wide and a narrow window, by measured geometry rather than visibility flags, so a collapsed or overlapping column fails the build.
- DOM parsers run against fixtures that mirror the live markup, including the decoy `data-url` attributes that a naive selector would wrongly pick up.
- The Kakao adapter is exercised against **real captured API payloads**: 32 chapters parsed with the correct 3-free/29-locked split, 114 image references from a free chapter, and a locked chapter refused with zero network calls.

Verified manually against the live site (via `curl`) during development:

- `Referer` is required (403 without, 200 with) and the DNR rule satisfies it.
- Original-quality URLs return the larger source encode.
- Selectors match the live markup.

**Not** verified end-to-end in an automated run: a full live download through the extension. The sandbox this was built in blocks Chromium's outbound TLS, so `live.mjs` could not complete here. Run it yourself on a normal machine before trusting the pipeline end to end.

### Adding a site

Implement the contract in `src/adapters/types.js` and register the adapter in `src/adapters/registry.js`. Nothing above that layer branches on which site a job belongs to.

An adapter gets `fetchDoc` (HTML), `fetchJson` and `fetchRaw` from its context rather than calling `fetch` itself, which is what keeps it testable outside a browser. If a site publishes a per-chapter entitlement flag, expose it as `isFree` on each chapter: the UI reads it to pre-select the downloadable ones and to show what will be skipped.

---

## Notes on use

This tool downloads content you can already read in your browser, for personal offline reading. It does not bypass DRM, paywalls or entitlement checks, and it will not be extended to. Respect the terms of service of the sites you use it with, and the rights of the creators whose work you are reading.

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).

## v1.0.2 changes and verification

- Reserve the archive suffix before truncating long chapter filenames. Fixes missing `.cbz` and protects `.pdf` / `.zip` too.
- ZIP export contains the original page bytes, with ordered names and real image extensions, just like CBZ; MIME is `application/zip`.
- Add NAVER Webtoon URL routing, host permissions, JSON pagination, chapter parsing and a NAVER-specific CDN Referer rule. Paste a NAVER URL; title search is still WEBTOON-only.
- Kakao: report unexpected list/viewer responses accurately, validate image URLs, sort images, accept the nested viewer-data response form, and disable Download when no chapters are free.
- Generic image HTTP 403 is no longer automatically called a Referer error.

Verification: 97 automated unit tests passed, independent Python ZIP/CRC extraction, static module syntax checks. Live browser checks found 84 loaded NAVER images in episode 95 of title 828715, and 114 image elements in the sample Kakao free episode (lazy loading). These are site viewer checks, **not** an end-to-end extension download. Direct API access from the test environment was blocked/unavailable, so NAVER API integration and the user's Kakao failure still require live confirmation.

Install by extracting this archive and selecting its folder with Load unpacked in `chrome://extensions`. Disable the old copy to avoid conflicting Referer rules. Existing extension copies are not updated just by extracting a new ZIP.
