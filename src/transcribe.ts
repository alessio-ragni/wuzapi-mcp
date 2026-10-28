import type { Config } from './config.ts';

export interface Audio {
  data: Buffer;
  mimetype: string;
}

/** Turns a voice note into text with the provider chosen in .env, or explains that it is off. */
export async function transcribe(config: Config, audio: Audio): Promise<string> {
  const provider = config.TRANSCRIPTION_PROVIDER;
  if (provider === 'off') {
    throw new Error('Voice transcription is off. Set TRANSCRIPTION_PROVIDER (and its key) in .env to turn it on.');
  }

  const form = new FormData();
  const file = new Blob([new Uint8Array(audio.data)], { type: audio.mimetype });

  if (provider === 'elevenlabs') {
    form.append('model_id', 'scribe_v1');
    form.append('file', file, 'voice.ogg');
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': config.ELEVENLABS_API_KEY! },
      body: form,
    });
    if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}: ${await res.text()}`);
    return ((await res.json()) as { text: string }).text;
  }

  // OpenAI and any OpenAI-compatible local server (whisper.cpp, faster-whisper-server…).
  const base = provider === 'openai' ? 'https://api.openai.com/v1' : config.WHISPER_URL!.replace(/\/$/, '');
  form.append('model', 'whisper-1');
  form.append('file', file, 'voice.ogg');
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: provider === 'openai' ? { Authorization: `Bearer ${config.OPENAI_API_KEY}` } : {},
    body: form,
  });
  if (!res.ok) throw new Error(`Transcription server answered ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { text: string }).text;
}
