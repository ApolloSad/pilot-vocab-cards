export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const wordRaw = (url.searchParams.get("word") || "").trim();
    if (!wordRaw) return json({ error: "Missing word" }, 400);

    const word = wordRaw.slice(0, 64);
    if (!env?.AI) return json({ error: "Workers AI binding missing" }, 500);

    const systemPrompt = `
You are a vocabulary assistant.

Return ONLY valid JSON in this exact shape:
{
  "definition": "one short definition (max 14 words)",
  "examples": ["short example (max 12 words)", "short example (max 12 words)"]
}

Rules:
- If the word is aviation related, use the aviation meaning.
- If not aviation related, give the best general meaning.
- Simple English only.
- Exactly 2 examples.
- No extra keys.
- No extra text.
- No markdown.
`.trim();

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Word: "${word}"` },
      ],
      max_output_tokens: 220,
    });

    const raw =
      (typeof result === "string"
        ? result
        : result?.response ?? result?.text ?? result?.output ?? ""
      ).trim();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return json({ error: "Model returned non-JSON" }, 502);
    }

    const payload = normalizePayload(data, word);

    if (!payload.definition) {
      return json({ error: "Empty definition from model" }, 502);
    }

    return json(payload, 200);
  } catch {
    return json({ error: "Unhandled exception" }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizePayload(data, word) {
  const def = clampWords(String(data?.definition || "").trim(), 14);

  const ex = Array.isArray(data?.examples) ? data.examples : [];
  let examples = ex
    .map((x) => clampWords(String(x || "").replace(/\s+/g, " ").trim(), 12))
    .filter(Boolean)
    .slice(0, 2);

  examples = ensureTwoExamples(examples, word);

  return { definition: def, examples };
}

function clampWords(text, maxWords) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(" ");
  if (parts.length <= maxWords) return t;
  return parts.slice(0, maxWords).join(" ").trim();
}

function ensureTwoExamples(examples, word) {
  const w = String(word || "").trim();
  const base = [
    w ? `I reviewed the word "${w}".` : "I reviewed a new word today.",
    w ? `I used "${w}" in a short sentence.` : "I used it in a short sentence.",
  ];
  const out = Array.isArray(examples) ? examples.filter(Boolean) : [];
  while (out.length < 2) out.push(base[out.length] || base[0]);
  return out.slice(0, 2);
}
