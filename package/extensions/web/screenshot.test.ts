import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@earendil-works/pi-coding-agent', () => ({}));
vi.mock('typebox', () => ({ Type: {} }));
import { requestLocalScreenshot } from './index';

afterEach(() => vi.unstubAllGlobals());
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
describe('local screenshots', () => {
  it.each([true, false])('passes fullPage=%s and returns image data', async fullPage => {
    const fetch = vi.fn().mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await requestLocalScreenshot('http://local:3003', 'secret', 'https://example.com', fullPage))
      .toBe(Buffer.from(png).toString('base64'));
    expect(fetch).toHaveBeenCalledWith('http://local:3003/screenshot', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
      body: JSON.stringify({ url: 'https://example.com', fullPage }),
    }));
  });
  it('requires a token', async () => {
    await expect(requestLocalScreenshot('http://local', '', 'https://example.com', true)).rejects.toThrow('TOKEN');
  });
  it('reports backend failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 429 })));
    await expect(requestLocalScreenshot('http://local', 'key', 'https://example.com', true)).rejects.toThrow('429');
  });
  it('rejects non-image responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { headers: { 'content-type': 'application/json' } })));
    await expect(requestLocalScreenshot('http://local', 'key', 'https://example.com', true)).rejects.toThrow('PNG');
  });
  it('rejects invalid PNG data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad', { headers: { 'content-type': 'image/png' } })));
    await expect(requestLocalScreenshot('http://local', 'key', 'https://example.com', true)).rejects.toThrow('Invalid PNG');
  });
  it('propagates cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => { options.signal.throwIfAborted(); }));
    await expect(requestLocalScreenshot('http://local', 'key', 'https://example.com', true, controller.signal)).rejects.toThrow();
  });
});
