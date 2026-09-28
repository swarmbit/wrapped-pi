import { describe, expect, it, vi, afterEach } from 'vitest';
// Service logic has no browser dependency; inject a mock Chromium launcher.
// @ts-expect-error JavaScript service module
import { createBrowserSessions, validUrl } from '../../../example/firecrawl/screenshot/browser.mjs';
import { browserRequest, registerBrowserTool } from './browser';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(options = {}) {
  const page = {
    goto: vi.fn(), url: () => 'https://example.com', setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), on: vi.fn(),
    locator: vi.fn(() => ({ click: vi.fn(), fill: vi.fn() })),
    mouse: { click: vi.fn(), wheel: vi.fn() }, keyboard: { insertText: vi.fn(), press: vi.fn() },
    evaluate: vi.fn().mockResolvedValue('result'), screenshot: vi.fn().mockResolvedValue(Buffer.from('png')),
  };
  const context = { route: vi.fn(), newPage: vi.fn().mockResolvedValue(page), on: vi.fn() };
  const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn() };
  browser.close.mockResolvedValue(undefined);
  const chromium = { launch: vi.fn().mockResolvedValue(browser) };
  return { service: createBrowserSessions(chromium, options), chromium, browser, page };
}

describe('browser sessions', () => {
  it('accepts only HTTP(S) URLs without credentials', () => {
    expect(validUrl('https://example.com')).toBe(true);
    for (const url of ['file:///etc/passwd', 'javascript:1', 'https://user:pass@example.com']) expect(validUrl(url)).toBe(false);
  });
  it('starts, navigates, interacts, evaluates, screenshots and closes', async () => {
    const { service, page, browser } = fixture();
    try {
      const { sessionId } = await service.execute({ action: 'start' });
      await service.execute({ action: 'navigate', sessionId, url: 'https://example.com' });
      await service.execute({ action: 'click', sessionId, x: 10, y: 20 });
      expect(page.mouse.click).toHaveBeenCalledWith(10, 20);
      await service.execute({ action: 'type', sessionId, text: 'hello' });
      expect(page.keyboard.insertText).toHaveBeenCalledWith('hello');
      expect(await service.execute({ action: 'evaluate', sessionId, expression: 'document.title' })).toMatchObject({ result: 'result' });
      expect(await service.execute({ action: 'screenshot', sessionId, fullPage: true })).toMatchObject({ image: Buffer.from('png').toString('base64') });
      expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ fullPage: true }));
      await service.execute({ action: 'close', sessionId });
      expect(browser.close).toHaveBeenCalled();
      await expect(service.execute({ action: 'inspect', sessionId })).rejects.toThrow('expired');
    } finally { await service.shutdown(); }
  });
  it('bounds session count and validates navigation', async () => {
    const { service } = fixture();
    try {
      await expect(service.execute({ action: 'start', url: 'file:///tmp/a' })).rejects.toThrow('URL');
      for (let i = 0; i < 4; i++) await service.execute({ action: 'start' });
      await expect(service.execute({ action: 'start' })).rejects.toThrow('four');
    } finally { await service.shutdown(); }
  });
  it('rejects concurrent actions in one session', async () => {
    const { service, page } = fixture();
    try {
      const { sessionId } = await service.execute({ action: 'start' });
      let resolve!: () => void;
      page.goto.mockImplementation(() => new Promise<void>(r => { resolve = r; }));
      const pending = service.execute({ action: 'navigate', sessionId, url: 'https://example.com' });
      await expect(service.execute({ action: 'inspect', sessionId })).rejects.toThrow('busy');
      resolve(); await pending;
    } finally { await service.shutdown(); }
  });
  it('expires idle sessions', async () => {
    vi.useFakeTimers();
    const { service, browser } = fixture({ idleMs: 100 });
    try {
      const { sessionId } = await service.execute({ action: 'start' });
      await vi.advanceTimersByTimeAsync(201);
      expect(browser.close).toHaveBeenCalled();
      await expect(service.execute({ action: 'inspect', sessionId })).rejects.toThrow('expired');
    } finally { await service.shutdown(); }
  });
  it('closes timed out sessions', async () => {
    vi.useFakeTimers();
    const { service, page, browser } = fixture({ timeoutMs: 100 });
    try {
      const { sessionId } = await service.execute({ action: 'start' });
      page.evaluate.mockImplementation(() => new Promise(() => {}));
      const pending = expect(service.execute({ action: 'evaluate', sessionId, expression: 'new Promise(()=>{})' })).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(101);
      await pending;
      expect(browser.close).toHaveBeenCalled();
    } finally { await service.shutdown(); }
  });
});

describe('browser extension tool', () => {
  it('restricts explicit URLs, requires a started session and returns screenshots as images', async () => {
    let tool: any;
    const pi: any = { registerTool: (value: unknown) => { tool = value; }, on: vi.fn() };
    registerBrowserTool(pi, 'http://local', 'key', url => url.startsWith('https://allowed.example/'));
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, sessionId: 'session-1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, image: Buffer.from('png').toString('base64'), url: 'https://allowed.example/' })));
    vi.stubGlobal('fetch', fetch);
    await expect(tool.execute('call', { action: 'start', url: 'https://denied.example/' })).rejects.toThrow('domain');
    await expect(tool.execute('call', { action: 'inspect', sessionId: 'other' })).rejects.toThrow('Start');
    const start = await tool.execute('call', { action: 'start', url: 'https://allowed.example/' });
    expect(start.content[0].text).toContain('session-1');
    const screenshot = await tool.execute('call', { action: 'screenshot', sessionId: 'session-1' });
    expect(screenshot.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('browser client', () => {
  it('sends authenticated actions', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, sessionId: 'abc' })));
    vi.stubGlobal('fetch', fetch);
    expect(await browserRequest('http://local:3003', 'secret', { action: 'start' })).toMatchObject({ sessionId: 'abc' });
    expect(fetch).toHaveBeenCalledWith('http://local:3003/browser', expect.objectContaining({ body: '{"action":"start"}' }));
  });
  it('surfaces service errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Expired' }), { status: 400 })));
    await expect(browserRequest('http://local', 'secret', { action: 'inspect' })).rejects.toThrow('Expired');
  });
});
