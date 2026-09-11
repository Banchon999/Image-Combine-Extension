/**
 * The download engine.
 *
 * All I/O arrives through the `io` object rather than being called directly, so
 * this module has no dependency on chrome.*, fetch, or the DOM. That is what
 * lets the whole pipeline -- retries, partial chapters, format branching,
 * cleanup ordering -- be tested deterministically outside a browser.
 *
 * offscreen.js supplies the real implementations; the tests supply fakes.
 */

import { STATUS } from '../common/messages.js';
import { pool, withRetry, delay } from '../common/pool.js';
import { normalizeSettings } from '../common/settings.js';
import { archivePath, imagePath, imageExtension, padChapter, chapterFolderName, seriesArchivePath } from '../common/filenames.js';
import { parseRange, toRangeSpec } from '../common/ranges.js';
import { CancelledError, FetchError, ProtectedContentError, RefererRuleError } from '../common/errors.js';
import { getAdapterById, resolveUrl } from '../adapters/registry.js';
import { buildCbz } from './convert/cbz.js';
import { buildPdf } from './convert/pdf.js';

// Peak memory while building a whole-series bundle is roughly twice the total
// image bytes (the held pages plus the assembled Blob). Refuse past this with a
// clear message rather than risk an out-of-memory crash in the offscreen
// document; per-chapter mode has no such ceiling.
const MAX_BUNDLE_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * @typedef {object} EngineIO
 * @property {(url: string, signal?: AbortSignal) => Promise<Document>} fetchDoc
 * @property {(url: string, signal?: AbortSignal) => Promise<any>} fetchJson
 * @property {(url: string, signal?: AbortSignal, opts?: {requirePlainImage?: boolean}) => Promise<{data: Uint8Array, mimeType: string}>} fetchImage
 * @property {(blob: Blob, filename: string) => Promise<number|undefined>} saveBlob
 * @property {(ids: number[]) => Promise<void>} removeFiles
 * @property {(page: {data: Uint8Array, mimeType: string}) => Promise<{data: Uint8Array, mimeType: string}>} [toJpeg]
 * @property {(pages: object[], settings: object, signal: AbortSignal, progress: Function) => AsyncIterable<object>} [stitchPages]
 * @property {(job: object) => void} [onJobUpdate]
 * @property {(id: string) => object|null} [getAdapter] defaults to the real registry
 */

export function createEngine(/** @type {EngineIO} */ io) {
  /** Jobs in flight, so cancel can reach their abort controller. */
  const running = new Map();
  // Injectable so the job pipeline can be exercised against a stub adapter,
  // which is the only way to test it without a DOM.
  const lookup = io.getAdapter ?? getAdapterById;
  const emit = (job) => io.onJobUpdate?.(structuredClone(job));

  const context = (signal) => ({
    signal,
    fetchDoc: (url) => io.fetchDoc(url, signal),
    fetchJson: (url) => io.fetchJson(url, signal),
    fetchRaw: (url) => io.fetchRaw?.(url, signal),
  });

  /**
   * Fetch every image of one chapter.
   *
   * Failures are collected rather than thrown: a chapter that lost one image of
   * forty is still worth delivering, marked partial, rather than discarding the
   * thirty-nine that succeeded.
   */
  async function fetchChapterImages(images, settings, signal, onImageDone) {
    let completed = 0;

    const fetchPage = async (image) => {
      try {
        return await io.fetchImage(image.url, signal, { requirePlainImage: image.requirePlainImage === true });
      } catch (error) {
        // Full-quality URLs occasionally fail on one CDN edge even though the
        // q90 URL published in the viewer remains available. Fall back once;
        // if the Referer rule itself is broken, both URLs fail and the second
        // error still surfaces clearly without entering the retry loop.
        if (
          image.fallbackUrl &&
          image.fallbackUrl !== image.url &&
          (error instanceof RefererRuleError || error?.status === 403 || error?.status === 404)
        ) {
          return io.fetchImage(image.fallbackUrl, signal, { requirePlainImage: image.requirePlainImage === true });
        }
        throw error;
      }
    };

    const results = await pool(
      images,
      settings.concurrentImages,
      async (image, index) => {
        // Stagger request starts so a wide pool does not open every socket in
        // the same millisecond.
        if (settings.throttleMs) {
          await delay(settings.throttleMs * (index % settings.concurrentImages), signal);
        }

        const fetched = await withRetry(() => fetchPage(image), {
          attempts: settings.retryAttempts,
          baseMs: 1_000,
          signal,
          // A Referer failure is deterministic; retrying only multiplies the 403s.
          shouldRetry: (error) => !(error instanceof RefererRuleError),
        });

        completed += 1;
        onImageDone?.(completed, images.length);
        return { ...image, ...fetched };
      },
      { signal },
    );

    const pages = [];
    const failures = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') pages.push(result.value);
      else failures.push({ index: i + 1, reason: String(result.reason?.message ?? result.reason) });
    });
    return { pages, failures };
  }

  /** Produce the output file(s) for one chapter. */
  async function writeChapter({ series, chapter, pages, settings, signal, progress }) {
    const common = {
      seriesTitle: series.title,
      chapterNumber: chapter.number,
      chapterTitle: chapter.title,
      padWidth: settings.padWidth,
    };
    const prefixed = (relative) =>
      settings.downloadFolder ? `${settings.downloadFolder}/${relative}` : relative;

    const saveRawPages = async (items = pages, stitched = false) => {
      const ids = [];
      for (const page of items) {
        if (signal?.aborted) throw new CancelledError();
        const relative = imagePath({
          ...common,
          ...(stitched ? {chapterTitle:`${common.chapterTitle ?? ''} - stitched`} : {}),
          index: page.index,
          url: page.url,
          mimeType: page.mimeType,
        });
        const id = await io.saveBlob(
          new Blob([page.data], { type: page.mimeType || 'image/jpeg' }),
          prefixed(relative),
        );
        if (id !== undefined && id !== null) ids.push(id);
      }
      return ids;
    };

    if (settings.stitchEnabled) {
      if (!io.stitchPages) throw new Error('Image stitching is unavailable in this browser.');
      const stagedIds = settings.writeRawThenClean && settings.format !== 'raw' ? await saveRawPages() : [];
      const converted=[];
      let count=0,bytes=0;
      for await (const page of io.stitchPages(pages,settings,signal,progress)) {
        if (signal?.aborted) throw new CancelledError();
        count++;
        if (settings.format === 'raw') await saveRawPages([page],true);
        else {
          bytes+=page.data.byteLength;
          if (bytes>256*1024*1024) throw new Error('Stitched archive exceeds 256 MB in memory. Use separate image files.');
          converted.push(page);
        }
      }
      if (!count) throw new Error('Stitching returned no images.');
      if (settings.format !== 'raw') {
        // The stitch encoder emits JPEG directly for PDF, avoiding a second recompression.
        const blob=settings.format==='pdf'
          ? buildPdf(converted,{title:`${series.title} - ${chapter.title ?? chapter.number}`,author:series.author})
          : buildCbz(converted.map(page=>({name:`${padChapter(page.index,3)}.${imageExtension('',page.mimeType)}`,data:page.data})));
        await io.saveBlob(blob,prefixed(archivePath({...common,chapterTitle:`${common.chapterTitle ?? ''} - stitched`,format:settings.format})));
        if (stagedIds.length) await io.removeFiles(stagedIds);
      }
      return {format:settings.format,pages:count,stitched:true};
    }

    if (settings.format === 'raw') {
      await saveRawPages();
      return { format: 'raw', pages: pages.length };
    }

    // Optionally stage the raw images on disk first and delete them once the
    // archive exists. Off by default, in which case nothing but the archive is
    // ever written.
    const stagedIds = settings.writeRawThenClean ? await saveRawPages() : [];

    let blob;
    if (settings.format === 'cbz' || settings.format === 'zip') {
      blob = buildCbz(
        pages.map((page) => ({
          name: `${padChapter(page.index, 3)}.${imageExtension(page.url, page.mimeType)}`,
          data: page.data,
        })),
      );
    } else {
      const jpegPages = [];
      for (const page of pages) {
        // The PDF writer embeds JPEG verbatim; anything else must be converted
        // first, which is the caller's job because it needs a canvas.
        jpegPages.push(io.toJpeg ? await io.toJpeg(page) : page);
      }
      blob = buildPdf(
        jpegPages.map((page) => ({ data: page.data, width: page.width, height: page.height })),
        { title: `${series.title} - ${chapter.title ?? chapter.number}`, author: series.author },
      );
    }

    await io.saveBlob(blob, prefixed(archivePath({ ...common, format: settings.format })));
    // Only after the archive is safely written.
    if (stagedIds.length) await io.removeFiles(stagedIds);
    return { format: settings.format, pages: pages.length, cleaned: stagedIds.length };
  }

  async function runJob({ jobId, adapterId, ref, selection, settings: rawSettings }) {
    const settings = normalizeSettings(rawSettings);
    const controller = new AbortController();
    running.set(jobId, controller);
    const signal = controller.signal;

    const adapter = lookup(adapterId);
    const job = {
      id: jobId,
      site: adapter?.label ?? adapterId,
      status: STATUS.RUNNING,
      startedAt: Date.now(),
      seriesTitle: '',
      chapters: [],
      error: null,
    };

    try {
      if (!adapter) throw new Error(`Unknown site adapter: ${adapterId}`);
      // Sites we deliberately do not download from never reach the network.
      if (!adapter.capabilities.download) {
        throw new ProtectedContentError(
          `${adapter.label} content is protected; this extension does not bypass DRM or paywalls.`,
        );
      }

      const ctx = context(signal);
      const series = await adapter.getSeries(ref, ctx);
      job.seriesTitle = series.title;

      const numbers = parseRange(
        selection,
        series.chapters.map((c) => c.number),
      );
      const chosen = series.chapters.filter((c) => numbers.includes(c.number));
      job.chapters = chosen.map((c) => ({
        number: c.number,
        title: c.title,
        status: STATUS.QUEUED,
        done: 0,
        total: 0,
        note: '',
      }));
      emit(job);

      // One archive for the whole selection, in chapter order, named by range.
      // Only cbz/zip can bundle (pdf/raw keep one file per chapter); stitching is
      // allowed and, when on, each chapter's stitched long images go in instead
      // of its raw pages.
      const bundle =
        settings.bundleSeries === true &&
        (settings.format === 'cbz' || settings.format === 'zip') &&
        chosen.length > 0;
      const bundleParts = bundle ? new Array(chosen.length) : null;
      let bundleBytes = 0;
      let bundleOverflow = false;

      await pool(
        chosen,
        settings.concurrentChapters,
        async (chapter, index) => {
          const entry = job.chapters[index];
          entry.status = STATUS.RUNNING;
          emit(job);

          try {
            const images = await adapter.getChapterImages(ref, chapter, ctx, {
              originalQuality: settings.originalQuality,
              kakaoAccountAccess: settings.kakaoAccountAccess,
            });
            entry.total = images.length;
            emit(job);

            const { pages, failures } = await fetchChapterImages(images, settings, signal, (done) => {
              entry.done = done;
              emit(job);
            });

            if (pages.length === 0) {
              entry.status = STATUS.FAILED;
              entry.note = failures[0]?.reason ?? 'No pages could be downloaded';
            } else if (bundle) {
              // Defer writing: hold each chapter's pages in its own in-archive
              // folder so page order survives across chapters, then save one
              // archive after every chapter is fetched.
              const folder = chapterFolderName(chapter.number, chapter.title, settings.padWidth);
              let entries;
              if (settings.stitchEnabled) {
                // Same rule as per-chapter stitching: never stitch a chapter
                // that lost a source image.
                if (failures.length) throw new FetchError(`${failures.length} source image(s) failed. Refusing to stitch an incomplete chapter; retry or disable stitching.`);
                if (!io.stitchPages) throw new Error('Image stitching is unavailable in this browser.');
                const stitched = [];
                for await (const page of io.stitchPages(pages, settings, signal, (note) => { entry.note = note; emit(job); })) {
                  if (signal?.aborted) throw new CancelledError();
                  stitched.push(page);
                }
                if (!stitched.length) throw new Error('Stitching returned no images.');
                entries = stitched.map((page) => ({
                  name: `${folder}/${padChapter(page.index, 3)}.${imageExtension('', page.mimeType)}`,
                  data: page.data,
                }));
              } else {
                entries = pages.map((page) => ({
                  name: `${folder}/${padChapter(page.index, 3)}.${imageExtension(page.url, page.mimeType)}`,
                  data: page.data,
                }));
              }
              bundleBytes += entries.reduce((sum, e) => sum + e.data.byteLength, 0);
              if (bundleBytes > MAX_BUNDLE_BYTES) {
                bundleOverflow = true;
                throw new Error('This series bundle is too large to build in memory. Download a smaller chapter range, or turn off "one archive per series".');
              }
              bundleParts[index] = { number: chapter.number, entries };
              entry.status = failures.length ? STATUS.PARTIAL : STATUS.DONE;
              entry.note = settings.stitchEnabled
                ? `Stitched into ${entries.length} image(s), added to the series archive`
                : (failures.length ? `${failures.length} image(s) failed` : 'Added to the series archive');
            } else {
              if (settings.stitchEnabled && failures.length) throw new FetchError(`${failures.length} source image(s) failed. Refusing to stitch an incomplete chapter; retry or disable stitching.`);
              const output=await writeChapter({ series, chapter, pages, settings, signal,
                progress:note=>{entry.note=note;emit(job);} });
              entry.status = failures.length ? STATUS.PARTIAL : STATUS.DONE;
              entry.note = output.stitched ? `Stitched into ${output.pages} image(s)${settings.format==='pdf'?' / PDF pages':''}` : '';
              if (failures.length) entry.note = `${failures.length} image(s) failed`;
            }
          } catch (error) {
            if (error instanceof CancelledError) {
              entry.status = STATUS.CANCELLED;
              throw error;
            }
            entry.status =
              error instanceof ProtectedContentError ? STATUS.SKIPPED_PROTECTED : STATUS.FAILED;
            entry.note = String(error?.message ?? error);
          }
          emit(job);
        },
        { signal },
      );

      if (bundle && !signal.aborted) {
        if (bundleOverflow) {
          throw new Error('Series bundle exceeded the in-memory size limit; nothing was written. Download a smaller chapter range, or turn off "one archive per series".');
        }
        // Assemble in the selection's original order, skipping chapters that
        // failed or were protected, so a gap never corrupts the archive.
        const ready = bundleParts.filter(Boolean);
        const entries = ready.flatMap((part) => part.entries);
        if (entries.length) {
          const relative = seriesArchivePath({
            seriesTitle: series.title,
            rangeLabel: toRangeSpec(ready.map((part) => part.number)),
            format: settings.format,
          });
          await io.saveBlob(
            buildCbz(entries),
            settings.downloadFolder ? `${settings.downloadFolder}/${relative}` : relative,
          );
        }
      }

      const states = job.chapters.map((c) => c.status);
      if (signal.aborted) job.status = STATUS.CANCELLED;
      else if (states.every((s) => s === STATUS.DONE)) job.status = STATUS.DONE;
      else if (states.some((s) => s === STATUS.DONE || s === STATUS.PARTIAL)) job.status = STATUS.PARTIAL;
      else job.status = STATUS.FAILED;
    } catch (error) {
      job.status = error instanceof CancelledError ? STATUS.CANCELLED : STATUS.FAILED;
      job.error = String(error?.message ?? error);
    } finally {
      running.delete(jobId);
      job.finishedAt = Date.now();
      emit(job);
    }
    return job;
  }

  return {
    runJob,
    cancel(jobId) {
      const controller = running.get(jobId);
      controller?.abort();
      return { cancelled: Boolean(controller) };
    },
    async search({ query, lang, adapterId }) {
      const adapter = lookup(adapterId);
      if (!adapter?.capabilities.search) return [];
      return adapter.search(query, lang, context());
    },
    async getSeries({ url, adapterId, ref }) {
      const resolved = url ? resolveUrl(url) : { adapter: lookup(adapterId), ref };
      if (!resolved.adapter) throw new Error(`Unknown site adapter: ${adapterId}`);
      const series = await resolved.adapter.getSeries(resolved.ref, context());
      return { adapterId: resolved.adapter.id, ref: resolved.ref, series };
    },
    // Exposed for tests; not part of the job API.
    _internals: { fetchChapterImages, writeChapter },
  };
}

export { FetchError, RefererRuleError };
