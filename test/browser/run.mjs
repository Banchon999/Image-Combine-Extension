/**
 * Browser-side verification.
 *
 * Two things cannot be checked from Node and are checked here instead:
 *   1. the DOM parsers, which need a real Document; and
 *   2. that the extension actually loads in Chromium with no manifest,
 *      module-resolution or service-worker errors.
 *
 * Playwright is expected to be available (globally installed is fine). Chromium
 * is pre-installed in this environment, so no browser download is attempted.
 *
 * Usage: node test/browser/run.mjs
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

/**
 * Resolve Playwright from the project or, failing that, the global root.
 *
 * Playwright ships as CommonJS, so a dynamic import of its resolved path puts
 * the real exports on `.default` rather than the namespace itself. Unwrapping
 * here keeps the call sites from having to know that.
 */
async function loadPlaywright() {
  const unwrap = (mod) => (mod?.chromium ? mod : mod?.default?.chromium ? mod.default : null);

  try {
    const found = unwrap(await import('playwright'));
    if (found) return found;
  } catch {
    // Not installed locally; fall through to the global lookup.
  }

  try {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    const require = createRequire(join(globalRoot, 'noop.js'));
    return unwrap(await import(require.resolve('playwright')));
  } catch {
    return null;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/** Static server over the repo, so the harness can import modules over http. */
function startServer() {
  const server = createServer(async (req, res) => {
    // Reject traversal before touching the filesystem.
    const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

let failures = 0;
const report = (pass, name, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail ? `  -- ${detail}` : ''}`);
};

async function main() {
  const playwright = await loadPlaywright();
  if (!playwright) {
    console.log('Playwright is not installed; skipping browser tests.');
    console.log('Install it with:  npm i -D playwright   (Chromium is already present)');
    return;
  }

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;

  /* ------------------------- 1. DOM parser fixtures ------------------------ */
  console.log('\nDOM parsers (fixtures):');
  const browser = await playwright.chromium.launch();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  await page.goto(`${base}/test/browser/harness.html`);
  await page.waitForFunction(() => window.__RESULTS__ !== undefined, null, { timeout: 15000 });
  for (const result of await page.evaluate(() => window.__RESULTS__)) {
    report(result.pass, result.name, result.pass ? '' : result.detail);
  }
  report(pageErrors.length === 0, 'harness raised no page errors', pageErrors.join('; '));
  await browser.close();

  /* -------------------------- 2. extension loads --------------------------- */
  console.log('\nExtension load:');
  const userDataDir = join(ROOT, 'test', 'browser', '.artifacts', `profile-${Date.now()}`);
  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      // Extensions require a headed-equivalent context; the new headless mode
      // supports them, unlike the legacy one.
      channel: 'chromium',
      args: [
        `--disable-extensions-except=${ROOT}`,
        `--load-extension=${ROOT}`,
        '--no-first-run',
      ],
    });
  } catch (error) {
    report(false, 'chromium launched with the extension', String(error).split('\n')[0]);
    server.close();
    process.exit(1);
  }

  const errors = [];
  context.on('weberror', (e) => errors.push(String(e.error())));

  // The MV3 service worker registers asynchronously after launch.
  let worker = context.serviceWorkers()[0];
  if (!worker) {
    worker = await context
      .waitForEvent('serviceworker', { timeout: 15000 })
      .catch(() => null);
  }

  report(Boolean(worker), 'MV3 service worker registered', worker ? worker.url() : 'none appeared');

  if (worker) {
    const extensionId = new URL(worker.url()).host;
    report(/^[a-z]{32}$/.test(extensionId), 'extension id looks valid', extensionId);

    // The app page is a real extension page; loading it catches CSP violations
    // and module errors that a static check would miss.
    const panel = await context.newPage();
    const panelErrors = [];
    panel.on('pageerror', (error) => panelErrors.push(String(error)));
    await panel.setViewportSize({ width: 1280, height: 900 });
    await panel.goto(`chrome-extension://${extensionId}/src/ui/app.html`);
    await panel.waitForTimeout(1200);
    report(panelErrors.length === 0, 'app page loads without errors', panelErrors.join('; '));
    report(
      (await panel.locator('#search-lang option').count()) > 0,
      'app page populated the language selector',
    );
    report((await panel.locator('.tab').count()) === 3, 'app page rendered its tabs');

    /*
     * The page opens as a full tab, so it must work at both a maximised width
     * and a narrow one. Wide pins the queue in its own column; narrow folds it
     * back into a tab. Getting this wrong strands the queue in a hidden view.
     */
    const manifest = await panel.evaluate(() => chrome.runtime.getManifest());
    report(!manifest.action?.default_popup, 'no popup: one click opens the page');
    report(!manifest.side_panel, 'side_panel entry removed');
    report(
      !(manifest.permissions ?? []).includes('sidePanel'),
      'sidePanel permission dropped',
      JSON.stringify(manifest.permissions),
    );

    /*
     * Assert real geometry, not just the `hidden` flag.
     *
     * A stylesheet collision once crushed the header to 4px and clipped its
     * contents while every `hidden`-based check still passed: the brand and
     * tabs were laid out correctly inside a parent that had been given
     * `height: 4px; overflow: hidden` by an unrelated rule. Measuring the
     * rendered box is what catches that class of bug.
     */
    const headerBoxes = await panel.evaluate(() => {
      const box = (sel) => {
        const node = document.querySelector(sel);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      return { header: box('header'), brand: box('.brand'), tabs: box('.tabs') };
    });
    report(
      headerBoxes.header?.h >= 60 && headerBoxes.brand?.h > 0 && headerBoxes.tabs?.h > 0,
      'header is actually rendered, not collapsed',
      JSON.stringify(headerBoxes),
    );

    const wide = await panel.evaluate(() => ({
      queueVisible: !document.getElementById('view-queue').hidden,
      queueTabHidden: document.getElementById('tab-queue').hidden,
      twoColumn: document.body.classList.contains('two-column'),
      // The two columns must not overlap or collapse onto each other.
      mainRight: Math.round(document.querySelector('.col-main').getBoundingClientRect().right),
      queueLeft: Math.round(document.querySelector('.col-queue').getBoundingClientRect().left),
    }));
    report(
      wide.queueLeft > wide.mainRight,
      'queue column sits beside the main column, not over it',
      `main ends ${wide.mainRight}, queue starts ${wide.queueLeft}`,
    );
    report(
      wide.queueVisible && wide.queueTabHidden && wide.twoColumn,
      'wide window pins the queue in its own column',
      JSON.stringify(wide),
    );

    await panel.setViewportSize({ width: 520, height: 900 });
    await panel.waitForTimeout(400);
    const narrow = await panel.evaluate(() => ({
      queueVisible: !document.getElementById('view-queue').hidden,
      queueTabHidden: document.getElementById('tab-queue').hidden,
      twoColumn: document.body.classList.contains('two-column'),
    }));
    report(
      !narrow.queueVisible && !narrow.queueTabHidden && !narrow.twoColumn,
      'narrow window folds the queue back into a tab',
      JSON.stringify(narrow),
    );

    // Selecting the queue tab at narrow width must actually show it.
    await panel.locator('#tab-queue').click();
    report(
      await panel.evaluate(() => !document.getElementById('view-queue').hidden),
      'queue tab shows the queue at narrow width',
    );

    // And returning to a wide window must not leave the main column empty.
    await panel.setViewportSize({ width: 1280, height: 900 });
    await panel.waitForTimeout(400);
    report(
      await panel.evaluate(
        () =>
          !document.getElementById('view-search').hidden &&
          !document.getElementById('view-queue').hidden,
      ),
      'resizing back to wide restores a populated main column',
    );

    /*
     * Exercise the worker through a real message round trip rather than by
     * evaluating an import() inside it: dynamic import is disallowed in a
     * ServiceWorkerGlobalScope by specification, and a round trip proves more
     * anyway -- it runs the worker's static import graph, its message router
     * and the adapter registry in one go.
     */
    const state = await panel
      .evaluate(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'get-state', payload: {} });
        return response?.ok ? response.result : { error: response?.error ?? 'no response' };
      })
      .catch((error) => ({ error: String(error) }));

    const adapters = state?.adapters;
    report(Array.isArray(adapters), 'worker answers messages (import graph resolved)', JSON.stringify(state).slice(0, 160));
    if (Array.isArray(adapters)) {
      report(
        adapters.some((a) => a.id === 'webtoons' && a.capabilities.download),
        'webtoons adapter is downloadable',
      );
      // Account access is an explicit job option; catalog flags are not proof
      // of whether the signed-in account purchased a chapter.
      const kakao = adapters.find((a) => a.id === 'kakao');
      report(
        kakao?.capabilities.download === true && kakao?.capabilities.accountAccess === true,
        'kakao adapter supports opt-in existing account access',
        JSON.stringify(kakao?.capabilities),
      );
    }

    // Settings round trip through chrome.storage, which the panel depends on.
    const settings = await panel
      .evaluate(async () => {
        const response = await chrome.runtime.sendMessage({ type: 'get-settings', payload: {} });
        return response?.ok ? response.result : null;
      })
      .catch(() => null);
    report(Boolean(settings?.format), 'settings round trip returns defaults', JSON.stringify(settings ?? {}).slice(0, 120));

    /*
     * The Referer rule is the single point of failure for every image request,
     * so it is worth asserting. Poll rather than sampling once: rulesets are
     * registered asynchronously after launch and an immediate read races them.
     */
    let rulesets = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      rulesets = await worker
        .evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())
        .catch(() => []);
      if (rulesets.includes('referer_rules')) break;
      await panel.waitForTimeout(250);
    }
    report(rulesets.includes('referer_rules'), 'Referer ruleset is enabled', JSON.stringify(rulesets));
  }

  report(errors.length === 0, 'no uncaught extension errors', errors.join('; '));

  await context.close();
  server.close();

  console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
