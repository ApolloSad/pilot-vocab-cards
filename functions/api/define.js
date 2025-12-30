export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const word = (url.searchParams.get("word") || "").trim();

  if (!word) {
    return json({ error: "Missing word" }, 400);
  }

  const systemPrompt = `
You are an aviation vocabulary assistant.

Return ONLY valid JSON in this exact shape:
{
  "definition": "one short definition (max 14 words)",
  "examples": ["short example", "short example"],
  "ru": "short Russian translation"
}

Rules:
- Aviation meaning if relevant
- Simple English
- Russian must be Cyrillic (not transliteration)
- No extra text
- No markdown
`;

  const userPrompt = `Word: "${word}"`;

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 220,
  });

  let data;
  try {
    data = JSON.parse(result.response);
  } catch {
    return json({ error: "AI returned invalid JSON", raw: result.response }, 500);
  }

  // Fix mojibake Cyrillic like "Ð¥Ð²Ð¾Ñ..."
  if (typeof data?.ru === "string") {
    data.ru = fixMojibake(data.ru);
  }

  return json(data, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Attempts to re-decode strings that were UTF-8 decoded as Latin-1 (mojibake)
function fixMojibake(str) {
  try {
    const bytes = new Uint8Array([...str].map((c) => c.charCodeAt(0)));
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    // If it didn't change, just return original
    return decoded && decoded !== str ? decoded : str;
  } catch {
    return str;
  }
}
