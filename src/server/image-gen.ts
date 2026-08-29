const DEEPINFRA_URL = 'https://api.deepinfra.com/v1/inference/black-forest-labs/FLUX-1-schnell';

interface SceneImageResult {
  imageUrl: string | null;
  prompt: string;
}

const recentPrompts = new Map<string, string>();

export async function generateSceneImage(
  campaignId: string,
  locationName: string,
  narration: string,
): Promise<SceneImageResult> {
  const apiKey = process.env.DEEPINFRA_API_KEY ?? '';
  if (!apiKey) return { imageUrl: null, prompt: '' };

  const prompt = buildScenePrompt(locationName, narration);

  const lastPrompt = recentPrompts.get(campaignId);
  if (lastPrompt === prompt) return { imageUrl: null, prompt };
  recentPrompts.set(campaignId, prompt);

  try {
    const response = await fetch(DEEPINFRA_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        prompt,
        width: 1024,
        height: 512,
        num_inference_steps: 4,
      }),
    });

    if (!response.ok) {
      console.error(`[image-gen] DeepInfra returned ${response.status}`);
      return { imageUrl: null, prompt };
    }

    const data = await response.json();
    const imageUrl: string | null = data.images?.[0]?.url ?? data.image_url ?? null;
    return { imageUrl, prompt };
  } catch (err) {
    console.error('[image-gen] DeepInfra request failed:', err);
    return { imageUrl: null, prompt };
  }
}

function buildScenePrompt(locationName: string, narration: string): string {
  const scene = narration.slice(0, 300);
  return `Fantasy TTRPG scene illustration, atmospheric, moody lighting, painterly style. Location: ${locationName}. ${scene}. No text, no UI, no watermarks.`;
}

export function clearCampaignImageCache(campaignId: string): void {
  recentPrompts.delete(campaignId);
}
