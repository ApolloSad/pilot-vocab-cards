export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const word = (url.searchParams.get("word") || "").trim();

  if (!word) return json({ error: "Missing word" }, 400);
  if (!env?.AI) return json({ error: "Workers AI binding AI missing" }, 500);

  const systemPrompt = `
You are an aviation vocabulary assistant.

Return ONLY valid JSON in this exact shape:
{
  "definition": "one short definition (max 14 words)",
  "examples": ["short example", "short example"],
  "ru": "TERM FIRST in Russian, then optional short explanation"
}

Rules:
- Aviation meaning if relevant
- Definition: max 14 words, simple English
- Examples: exactly 2, short, aviation context if possible
- Russian must be Cyrillic
- ru MUST start with the standard Russian aviation term (TERM FIRST)
- If helpful, add a very short explanation in parentheses after the term
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
    data = JSON.parse(result?.response || "");
  } catch {
    return json({ error: "AI returned invalid JSON", raw: result?.response || "" }, 502);
  }

  // Normalize strings
  if (typeof data?.definition === "string") data.definition = data.definition.trim();
  if (Array.isArray(data?.examples)) {
    data.examples = data.examples.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2);
  }
  if (typeof data?.ru === "string") data.ru = data.ru.trim();

  // 1) Fix mojibake ONLY when it looks like mojibake (e.g., "Ð¥Ð²Ð¾Ñ...")
  if (typeof data?.ru === "string" && looksLikeMojibakeLatin1(data.ru)) {
    data.ru = fixLatin1Mojibake(data.ru).trim();
  }

  // 2) Enforce TERM FIRST with a small aviation glossary override (guarantees correctness)
  const forced = aviationRuTerm(word);
  if (forced) {
    const existingParen = extractParenSuffix(data?.ru);
    // Keep any short explanation if the model provided one; otherwise add a default for common terms.
    const suffix =
      existingParen ||
      defaultExplanationSuffix(word) ||
      "";

    data.ru = `${forced}${suffix}`;
  }

  return json(data, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Detect classic UTF-8-as-Latin1 mojibake patterns: "Ð", "Ñ", "Ã", etc.
function looksLikeMojibakeLatin1(s) {
  return /[ÐÑÃâ€“â€”]/.test(s);
}

// Fix strings that are UTF-8 bytes interpreted as Latin-1 ("Ð¥Ð²..." -> "Хв...")
function fixLatin1Mojibake(str) {
  try {
    const bytes = new Uint8Array([...str].map((c) => c.charCodeAt(0) & 0xff));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return str;
  }
}

// Extract "(...)" at the end, so we can keep an explanation if present
function extractParenSuffix(s) {
  if (typeof s !== "string") return "";
  const m = s.match(/\s*(\([^)]*\))\s*$/);
  return m ? ` ${m[1]}` : "";
}

// A small glossary for common aviation terms (TERM FIRST)
function aviationRuTerm(word) {
  const w = String(word || "").trim().toLowerCase();

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
    trim: "Триммер",
    trimtab: "Триммер",
    yoke: "Штурвал",
    throttle: "Рычаг газа",
    mixture: "Рычаг смеси",
    propeller: "Воздушный винт",
    manifold: "Впускной коллектор",
  };

  return map[w] || "";
}

function defaultExplanationSuffix(word) {
  const w = String(word || "").trim().toLowerCase();
  if (w === "aileron") return " (поверхность управления креном)";
  if (w === "elevator") return " (поверхность управления тангажом)";
  if (w === "rudder") return " (поверхность управления рысканьем)";
  if (w === "flap" || w === "flaps") return " (увеличивает подъемную силу на малых скоростях)";
  if (w === "slat" || w === "slats") return " (улучшает обтекание на больших углах атаки)";
  if (w === "spoiler" || w === "spoilers") return " (уменьшает подъемную силу)";
  return "";
}
