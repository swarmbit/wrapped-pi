import { randomUUID } from 'node:crypto';

export function validUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

// Each session owns a separate browser process. No personal browser profile is used.
export function createBrowserSessions(chromium, { idleMs = 600000, timeoutMs = 45000 } = {}) {
  const sessions = new Map();
  let starting = 0;
  async function close(id) {
    const session = sessions.get(id);
    sessions.delete(id);
    await session?.browser.close().catch(() => {});
  }
  const sweep = setInterval(() => {
    for (const [id, session] of sessions) {
      if (!session.busy && Date.now() - session.used > idleMs) void close(id);
    }
  }, Math.min(idleMs, 30000));
  sweep.unref();
  function requiredString(value, name, max = 20000) {
    if (typeof value !== 'string' || !value || value.length > max) throw new Error(`Invalid ${name}`);
    return value;
  }
  async function execute(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid request');
    if (input.action === 'start') {
      if (sessions.size + starting >= 4) throw new Error('Maximum of four sessions reached; close a session');
      if (input.url !== undefined && !validUrl(input.url)) throw new Error('Invalid HTTP(S) URL');
      starting++;
      let browser;
      try {
        browser = await chromium.launch({ headless: true, timeout: 30000 });
        const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block', acceptDownloads: false });
        await context.route('**/*', route => {
          const url = route.request().url();
          return validUrl(url) ? route.continue() : route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(30000);
        page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
        context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
        if (input.url) await page.goto(input.url, { waitUntil: 'domcontentloaded' });
        const sessionId = randomUUID();
        sessions.set(sessionId, { browser, page, used: Date.now(), busy: false });
        return { sessionId, url: page.url() };
      } catch (error) {
        await browser?.close().catch(() => {});
        throw error;
      } finally { starting--; }
    }
    const session = sessions.get(input.sessionId);
    if (!session) throw new Error('Unknown or expired session; start a new session');
    if (session.busy) throw new Error('Session busy; wait for the previous action');
    session.busy = true;
    let timer;
    try {
      return await Promise.race([
        act(input, session),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            void close(input.sessionId);
            reject(new Error('Action timed out; session closed'));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      session.busy = false;
      session.used = Date.now();
    }
  }
  async function act(input, { page }) {
    switch (input.action) {
      case 'close': await close(input.sessionId); return { closed: true };
      case 'navigate':
        if (!validUrl(input.url)) throw new Error('Invalid HTTP(S) URL');
        await page.goto(input.url, { waitUntil: 'domcontentloaded' });
        break;
      case 'inspect':
        return await page.evaluate(() => {
          document.querySelectorAll('[data-pi-browser-id]').forEach(el => el.removeAttribute('data-pi-browser-id'));
          const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
            .filter(el => el.getClientRects().length).slice(0, 200).map((el, i) => {
              el.setAttribute('data-pi-browser-id', String(i));
              return { selector: `[data-pi-browser-id="${i}"]`, tag: el.tagName.toLowerCase(),
                text: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').slice(0, 200),
                type: el.getAttribute('type') };
            });
          return { url: location.href, title: document.title, text: document.body?.innerText.slice(0, 20000) ?? '', elements };
        });
      case 'screenshot': {
        if (input.fullPage !== undefined && typeof input.fullPage !== 'boolean') throw new Error('Invalid fullPage');
        const image = await page.screenshot({ type: 'png', fullPage: input.fullPage ?? false, timeout: 10000 });
        if (image.length > 10 * 1024 * 1024) throw new Error('Screenshot exceeds 10 MB');
        return { image: image.toString('base64'), mimeType: 'image/png', url: page.url() };
      }
      case 'click':
        if (input.selector) await page.locator(requiredString(input.selector, 'selector', 1000)).click();
        else {
          if (![input.x, input.y].every(n => Number.isFinite(n) && n >= 0 && n <= 10000)) throw new Error('Provide selector or valid x/y coordinates');
          await page.mouse.click(input.x, input.y);
        }
        break;
      case 'type':
        if (typeof input.text !== 'string' || input.text.length > 20000) throw new Error('Invalid text');
        if (input.selector) await page.locator(requiredString(input.selector, 'selector', 1000)).fill(input.text);
        else await page.keyboard.insertText(input.text);
        break;
      case 'press': await page.keyboard.press(requiredString(input.key, 'key', 100)); break;
      case 'scroll':
        if (![input.deltaX ?? 0, input.deltaY].every(n => Number.isFinite(n) && Math.abs(n) <= 10000)) throw new Error('Invalid scroll deltas');
        await page.mouse.wheel(input.deltaX ?? 0, input.deltaY);
        break;
      case 'evaluate': {
        const expression = requiredString(input.expression, 'JavaScript expression');
        // Eval is deliberately opt-in at the tool call level, and runs only in the page.
        const result = await page.evaluate(async source => {
          const value = await (0, eval)(source);
          const text = typeof value === 'string' ? value : JSON.stringify(value) ?? 'undefined';
          return text.slice(0, 20000);
        }, expression);
        return { result, url: page.url() };
      }
      default: throw new Error('Unknown browser action');
    }
    return { url: page.url() };
  }
  return { execute, async shutdown() { clearInterval(sweep); await Promise.all([...sessions.keys()].map(close)); } };
}
