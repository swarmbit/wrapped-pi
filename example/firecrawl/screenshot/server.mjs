import http from 'node:http';
import { chromium } from 'playwright';
import { createBrowserSessions } from './browser.mjs';

const token = process.env.SCREENSHOT_TOKEN;
if (!token) throw new Error('SCREENSHOT_TOKEN is required');
const browserSessions = createBrowserSessions(chromium);
let active = 0;
const server = http.createServer(async (req, res) => {
  const json = (status, error) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify({error})); };
  if (req.method !== 'POST' || !['/screenshot', '/browser'].includes(req.url)) return json(404, 'Not found');
  if (req.headers.authorization !== `Bearer ${token}`) return json(401, 'Unauthorized');
  if (active >= 2) return json(429, 'Screenshot service busy; retry later');
  active++;
  let browser;
  let timer;
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 65536) { json(413, 'Request too large'); return; }
    }
    let input;
    try { input = JSON.parse(body); } catch { return json(400, 'Invalid JSON'); }
    if (req.url === '/browser') {
      try {
        const result = await browserSessions.execute(input);
        if (!res.destroyed) {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ success: true, ...result }));
        }
      } catch (error) { json(400, error.message); }
      return;
    }
    let url;
    try { url = new URL(input.url); } catch { return json(400, 'Invalid URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        (input.fullPage !== undefined && typeof input.fullPage !== 'boolean')) return json(400, 'Invalid screenshot parameters');
    browser = await chromium.launch({headless: true});
    timer = setTimeout(() => void browser.close(), 45000);
    const context = await browser.newContext({viewport: {width: 1280, height: 720}, serviceWorkers: 'block', acceptDownloads: false});
    await context.route('**/*', route => {
      const protocol = new URL(route.request().url()).protocol;
      return ['http:', 'https:'].includes(protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    await page.goto(url.href, {waitUntil: 'load', timeout: 30000});
    const image = await page.screenshot({type: 'png', fullPage: input.fullPage ?? true, timeout: 10000});
    if (image.length > 10 * 1024 * 1024) return json(413, 'Screenshot exceeds 10 MB');
    res.writeHead(200, {'Content-Type': 'image/png', 'Cache-Control': 'no-store'});
    res.end(image);
  } catch (error) {
    console.error(error.message);
    if (!res.headersSent && !res.destroyed) json(502, 'Screenshot failed or timed out');
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => {});
    active--;
  }
});
server.requestTimeout = 15000;
server.listen(3003, '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close();
    const deadline = setTimeout(() => process.exit(0), 5000);
    deadline.unref();
    void browserSessions.shutdown().finally(() => process.exit(0));
  });
}
