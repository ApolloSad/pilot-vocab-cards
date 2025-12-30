export async function onRequest({ request, env }) {
  // Only GET is allowed
  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const url = new URL(request.url);
    const wordRaw = (url.searchParams.get("word") || "").trim();
    if (!wordRaw) return json({ error: "Missing word" }, 400);
    if (!env?.AI) return json({ error: "Workers AI binding missing" }, 500);

    const word = wordRaw;
    const w = word.toLowerCase();

    // Force correct Russian term when we know it
    const forcedRu = aviationRuTerm(w);
    const forcedSuffix = defaultExplanationSuffix(w);

    const systemPrompt = `
You are an aviation vocabulary assistant.

Return ONLY valid JSON in this exact shape:
{
  "definition": "one short definition (max 14 words)",
  "examples": ["short example", "short example"],
  "ru": "TERM FIRST in Russian, optional explanation in parentheses"
}

Rules:
- Aviation meaning if relevant
- Simple English
- Definition max 14 words
- Exactly 2 short examples
- Russian must be Cyrillic
- ru MUST start with the standard Russian aviation term
- Optional explanation in parentheses
- No extra text
- No markdown
`;

    const result = await env.AI.run(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      {
        messages: [
          { role: "system", content: systemPrompt.trim() },
          { role: "user", content: `Word: "${word}"` },
        ],
        max_output_tokens: 220,
      }
    );

    let data;
    const raw = (result?.response || "").trim();
    try {
      data = JSON.parse(raw);
    } catch {
      // If model breaks, still return a safe response
      return json(
        {
          definition: "",
          examples: [],
          ru: forcedRu ? `${forcedRu}${forcedSuffix}` : "",
        },
        200
      );
    }

    // Normalize fields
    data.definition = String(data.definition || "").trim();
    data.examples = Array.isArray(data.examples)
      ? data.examples.map((x) => String(x).trim()).slice(0, 2)
      : [];
    data.ru = String(data.ru || "").trim();

    // If model returned mojibake like "Ð¥Ð²..."
    if (looksLikeMojibake(data.ru)) {
      data.ru = fixMojibake(data.ru).trim();
    }

    // Final authority: glossary wins
    if (forcedRu) {
      data.ru = `${forcedRu}${forcedSuffix}`;
    } else if (!containsCyrillic(data.ru)) {
      // Never return garbage
      data.ru = "";
    }

    return json(data, 200);
  } catch (e) {
    return json({ error: "Unhandled exception" }, 500);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ---------- helpers ---------- */

function looksLikeMojibake(s) {
  return /[ÐÑÃ]/.test(s);
}

function fixMojibake(str) {
  try {
    const bytes = new Uint8Array([...str].map((c) => c.charCodeAt(0)));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return str;
  }
}

function containsCyrillic(s) {
  return /[А-Яа-яЁё]/.test(s);
}

/* ---------- aviation glossary (TERM FIRST) ---------- */

function aviationRuTerm(w) {
  const map = {
    aileron: "Элерон",
    elevator: "Руль высоты",
    rudder: "Руль направления",
    flap: "Закрылок",
    flaps: "Закрылки",
    slat: "Предкрылок",
    slats: "Предкрылки",
    spoiler: "Спойлер",
    spoilers: "Спойлеры",
    yoke: "Штурвал",
    throttle: "Рычаг газа",
    mixture: "Рычаг смеси",
    propeller: "Воздушный винт",
    manifold: "Впускной коллектор",
  };
  return map[w] || "";
}

function defaultExplanationSuffix(w) {
  if (w === "aileron") return " (управление креном)";
  if (w === "elevator") return " (управление тангажом)";
  if (w === "rudder") return " (управление рысканьем)";
  if (w === "flap" || w === "flaps") return " (увеличивает подъемную силу)";
  if (w === "slat" || w === "slats") return " (улучшает обтекание на больших углах атаки)";
  if (w === "spoiler" || w === "spoilers") return " (уменьшает подъемную силу)";
  return "";
}
