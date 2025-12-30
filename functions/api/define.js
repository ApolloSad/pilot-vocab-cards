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
  "ru": "Russian term first, then optional short explanation"
}

Rules:
- Aviation meaning if relevant
- Definition: max 14 words, simple English
- Examples: 2 short examples, aviation context if possible
- Russian must be Cyrillic
- ru field MUST start with the standard Russian aviation term (TERM FIRST)
- If helpful, add a very short explanation in parentheses after the term
- If no standard term exists, translate the word, term first
- No extra text
- No markdown
`;

  const userPrompt = `Word: "${word}"`;

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 240,
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

  // Enforce "term first" gently if the model adds leading whitespace/quotes
  if (typeof data?.ru === "string") {
    data.ru = data.ru.trim();
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
    return decoded && decoded !== str ? decoded : str;
  } catch {
    return str;
  }
}
