import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('image-gen', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns null when DEEPINFRA_API_KEY is not set', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', '');
    const { generateSceneImage } = await import('../src/server/image-gen.js');
    const result = await generateSceneImage('test-campaign', 'Dark Forest', 'A gloomy forest stretches ahead.');
    expect(result.imageUrl).toBeNull();
    expect(result.prompt).toBe('');
  });

  it('deduplicates identical prompts for the same campaign', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ images: [{ url: 'https://example.com/img.png' }] }), { status: 200 }),
    );

    const { generateSceneImage, clearCampaignImageCache } = await import('../src/server/image-gen.js');
    clearCampaignImageCache('dedup-test');

    await generateSceneImage('dedup-test', 'Tavern', 'A cozy tavern with a roaring fire.');
    const second = await generateSceneImage('dedup-test', 'Tavern', 'A cozy tavern with a roaring fire.');

    expect(second.imageUrl).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('clearCampaignImageCache allows regeneration', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ images: [{ url: 'https://example.com/img.png' }] }), { status: 200 }),
    );

    const { generateSceneImage, clearCampaignImageCache } = await import('../src/server/image-gen.js');
    clearCampaignImageCache('clear-test');

    await generateSceneImage('clear-test', 'Cave', 'A dark cave.');
    clearCampaignImageCache('clear-test');
    await generateSceneImage('clear-test', 'Cave', 'A dark cave.');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('handles API errors gracefully', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    const { generateSceneImage, clearCampaignImageCache } = await import('../src/server/image-gen.js');
    clearCampaignImageCache('error-test');

    const result = await generateSceneImage('error-test', 'Tower', 'A tall tower.');
    expect(result.imageUrl).toBeNull();
    expect(result.prompt).toContain('Tower');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('handles network failures gracefully', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

    const { generateSceneImage, clearCampaignImageCache } = await import('../src/server/image-gen.js');
    clearCampaignImageCache('network-test');

    const result = await generateSceneImage('network-test', 'Desert', 'Sand dunes.');
    expect(result.imageUrl).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('extracts image URL from response', async () => {
    vi.stubEnv('DEEPINFRA_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ images: [{ url: 'https://cdn.deepinfra.com/scene123.png' }] }), { status: 200 }),
    );

    const { generateSceneImage, clearCampaignImageCache } = await import('../src/server/image-gen.js');
    clearCampaignImageCache('url-test');

    const result = await generateSceneImage('url-test', 'Castle', 'A grand castle.');
    expect(result.imageUrl).toBe('https://cdn.deepinfra.com/scene123.png');
    expect(result.prompt).toContain('Castle');
  });
});
