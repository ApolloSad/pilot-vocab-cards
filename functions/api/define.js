export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const wordRaw = (url.searchParams.get("word") || "").trim();
    if (!wordRaw) return json({ error: "Missing word" }, 400);
    if (!env?.AI) return json({ error: "Workers AI binding AI missing" }, 500);

    const word = wordRaw;
    const w = word.toLowerCase();

    // 1) If we know a standard aviation Russian term, FORCE it (term first)
    // This guarantees correct Russian for common words regardless of model weirdness.
    const forcedRu = aviationRuTerm(w);
    const forcedSuffix = defaultExplanationSuffix(w);

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
- Definition: max 14 words, simple English, must be accurate
- Examples: exactly 2, short, aviation context
- ru: Cyrillic only, TERM FIRST, optional short explanation in parentheses
- No extra text
- No markdown
`;

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: `Word: "${word}"` },
      ],
      max_output_tokens: 240,
    });

    let data;
    const raw = (result?.response || "").trim();
    try {
      data = JSON.parse(raw);
    } catch {
      // If the model returns non-JSON, still return something useful
      return json(
        {
          error: "AI returned invalid JSON",
          raw,
          fallback: {
            definition: "",
            examples: [],
            ru: forcedRu ? `${forcedRu}${forcedSuffix}` : "",
          },
        },
        502
      );
    }

    // Normalize fields
    data.definition = String(data.definition || "").trim();
    data.examples = Array.isArray(data.examples)
      ? data.examples.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2)
      : [];
    data.ru = String(data.ru || "").trim();

    // 2) Fix classic mojibake ONLY when it looks like mojibake
    if (looksLikeMojibakeLatin1(data.ru)) {
      data.ru = fixLatin1Mojibake(data.ru).trim();
    }

    // 3) Enforce ru validity:
    // - If we have a forced term: always use it (TERM FIRST guaranteed)
    // - Else: accept model ru only if it contains Cyrillic (sanity check)
    if (forcedRu) {
      data.ru = `${forcedRu}${forcedSuffix}`;
    } else {
      if (!containsCyrillic(data.ru)) {
        // Model failed - return empty ru or a simple fallback in Cyrillic
        // You can customize this fallback text if you want.
        data.ru = "Термин (нет надежного перевода)";
      } else {
        // Ensure "term first": if model started with explanation, we can't fully fix without knowing the term,
        // but at least we keep a clean Cyrillic string.
        data.ru = data.ru;
      }
    }

    return json(data, 200);
  } catch (e) {
    return json(
      { error: "Unhandled exception", message: e?.message || String(e) },
      500
    );
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Detect classic UTF-8-as-Latin1 mojibake patterns: "Ð", "Ñ", etc.
function looksLikeMojibakeLatin1(s) {
  return /[ÐÑÃâ€“â€”]/.test(String(s || ""));
}

// Fix strings that are UTF-8 bytes interpreted as Latin-1
function fixLatin1Mojibake(str) {
  try {
    const bytes = new Uint8Array([...str].map((c) => c.charCodeAt(0) & 0xff));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return str;
  }
}

function containsCyrillic(s) {
  return /[А-Яа-яЁё]/.test(String(s || ""));
}

// TERM FIRST glossary (expand anytime)
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
