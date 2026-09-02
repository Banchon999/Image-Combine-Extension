/**
 * Live end-to-end check against webtoons.com.
 *
 * Opt-in and NOT part of `npm test`, because it makes real requests to a real
 * site. Run it deliberately, and keep the chapter count at one:
 *
 *   node test/browser/live.mjs
 *
 * It exists because everything else in the suite runs against fixtures. Only
 * this proves the parts that fixtures cannot: that the declarativeNetRequest
 * Referer rule actually satisfies the CDN (the difference between HTTP 200 and
 * a wall of 403s), that the live markup still matches the selectors, and that a
 * real chapter comes out the other end as a valid archive.
 */

import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SERIES = 'https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95';

let failures = 0;
const report = (pass, name, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  -- ${detail}` : ''}`);
};

const require = createRequire(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'n.js'));
const { chromium } = (await import(require.resolve('playwright'))).default;

// Point Chromium's download directory at a scratch folder by seeding the
// profile's Preferences before launch; chrome.downloads honours that setting.
const profile = mkdtempSync(join(tmpdir(), 'wtdl-live-'));
const downloads = join(profile, 'downloads');
mkdirSync(downloads, { recursive: true });
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(
  join(profile, 'Default', 'Preferences'),
  JSON.stringify({
    download: { default_directory: downloads, prompt_for_download: false },
    savefile: { default_directory: downloads },
  }),
);

// Chromium does not read HTTPS_PROXY from the environment the way curl does, so
// sandboxes that route egress through a local proxy need it passed explicitly.
// Absent on a normal machine, where this contributes no arguments.
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxyArgs = proxy
  ? [`--proxy-server=${proxy}`, `--proxy-bypass-list=<-loopback>`]
  : [];

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  args: [
    `--disable-extensions-except=${ROOT}`,
    `--load-extension=${ROOT}`,
    '--no-first-run',
    ...proxyArgs,
  ],
});

const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const extensionId = new URL(worker.url()).host;

const panel = await context.newPage();
await panel.goto(`chrome-extension://${extensionId}/src/ui/app.html`);
await panel.waitForTimeout(1000);

/* ------------------------- 1. live series listing ------------------------- */

const series = await panel.evaluate(async (url) => {
  const response = await chrome.runtime.sendMessage({ type: 'get-series', payload: { url } });
  return response?.ok ? response.result : { error: response?.error };
}, SERIES);

report(!series.error, 'fetched the live series page', series.error ?? '');
if (series.error) {
  await context.close();
  process.exit(1);
}

const chapters = series.series.chapters;
report(series.series.title.length > 0, 'parsed series title', series.series.title);
report(chapters.length > 100, 'parsed the full paginated chapter list', `${chapters.length} chapters`);
report(
  chapters.every((c) => Number.isFinite(c.number)) &&
    new Set(chapters.map((c) => c.number)).size === chapters.length,
  'chapter numbers are unique and numeric',
);

/* --------------------- 2. download one chapter as CBZ --------------------- */

// Track downloads from the worker, which is the only context that sees them.
await worker.evaluate(() => {
  globalThis.__seen = [];
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state?.current) globalThis.__seen.push(delta.state.current);
  });
});

const jobDone = panel.evaluate(
  () =>
    new Promise((done) => {
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'job-updated' && message.payload.finishedAt) done(message.payload);
        return false;
      });
      setTimeout(() => done({ status: 'timeout' }), 180000);
    }),
);

await panel.evaluate(
  async ({ adapterId, ref }) => {
    await chrome.runtime.sendMessage({
      type: 'start-job',
      payload: {
        adapterId,
        ref,
        selection: '1', // exactly one chapter
        settings: { format: 'cbz', originalQuality: true, writeRawThenClean: false },
      },
    });
  },
  { adapterId: series.adapterId, ref: series.ref },
);

const job = await jobDone;
report(job.status === 'done', 'job completed', `status=${job.status} ${job.error ?? ''}`);
report(
  job.chapters?.[0]?.total > 0,
  'chapter reported a page count',
  `${job.chapters?.[0]?.done}/${job.chapters?.[0]?.total} images`,
);

/* ---------------------------- 3. inspect output --------------------------- */

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });

await panel.waitForTimeout(2000);
const files = walk(downloads).filter((f) => !f.endsWith('.crdownload'));
report(files.length > 0, 'a file was written to disk', files.map((f) => f.replace(downloads, '')).join(', '));

const cbz = files.find((f) => f.endsWith('.cbz'));
if (cbz) {
  const size = statSync(cbz).size;
  report(size > 50_000, 'CBZ is a plausible size', `${(size / 1024).toFixed(0)} KB`);
  // Confirm it is a real ZIP: local file header signature "PK\x03\x04".
  const head = execSync(`head -c 4 "${cbz}" | xxd -p`, { encoding: 'utf8' }).trim();
  report(head === '504b0304', 'CBZ has a valid ZIP signature', head);
  try {
    const listing = execSync(`unzip -l "${cbz}"`, { encoding: 'utf8' });
    const pages = (listing.match(/\.(jpg|png|webp)/g) ?? []).length;
    report(pages > 0, 'CBZ contains page images', `${pages} pages`);
    execSync(`unzip -t "${cbz}"`, { stdio: 'pipe' });
    report(true, 'CBZ passes an integrity test');
  } catch (error) {
    report(false, 'CBZ passes an integrity test', String(error).slice(0, 120));
  }
}

await context.close();
console.log(`\n${failures === 0 ? 'Live end-to-end check passed.' : `${failures} check(s) failed.`}`);
console.log(`(downloads left in ${downloads})`);
process.exit(failures === 0 ? 0 : 1);
