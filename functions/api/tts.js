export async function onRequest({ request, env }) {
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  let text = "";

  if (request.method === "GET") {
    text = url.searchParams.get("text") || "";
  } else {
    try {
      const body = await request.json();
      text = body?.text || "";
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
  }

  const clean = String(text || "").trim();
  if (!clean) return new Response("Missing text", { status: 400 });

  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) return new Response("Missing API key", { status: 500 });

  const voiceId = env.ELEVENLABS_VOICE_ID || "n1PvBOwxb8X6m7tahp2h";

  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text: clean,
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!r.ok) {
    const msg = await r.text();
    return new Response(msg || "TTS error", { status: r.status });
  }

  return new Response(r.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
