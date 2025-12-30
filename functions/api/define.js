export async function onRequest({ request, env }) {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, request);
  }

  try {
    const url = new URL(request.url);
    const wordRaw = (url.searchParams.get("word") || "").trim();
    if (!wordRaw) return json({ error: "Missing word" }, 400, request);
    if (!env?.AI) return json({ error: "Workers AI binding AI missing" }, 500, request);

    const word = wordRaw;
    const w = word.toLowerCase();

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
- Examples: exactly 2, short, aviation context
- Russian must be Cyrillic
- ru MUST start with the standard Russian aviation term (TERM FIRST)
- If helpful, add a very short explanation in parentheses after the term
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
      return json({ error: "AI returned invalid JSON", raw }, 502, request);
    }

    // Normalize
    data.definition = String(data.definition || "").trim();
    data.examples = Array.isArray(data.examples)
      ? data.examples.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 2)
      : [];
    data.ru = String(data.ru || "").trim();

    // Fix classic mojibake ONLY when it looks like mojibake
    if (looksLikeMojibakeLatin1(data.ru)) {
      data.ru = fixLatin1Mojibake(data.ru).trim();
    }

    // Enforce TERM FIRST with a glossary override for common terms
    const forcedRu = aviationRuTerm(w);
    if (forcedRu) {
      data.ru = `${forcedRu}${defaultExplanationSuffix(w)}`;
    } else {
      // If model ru is not Cyrillic, keep it safe
      if (!containsCyrillic(data.ru)) {
        data.ru = "Термин (нет надежного перевода)";
      }
    }

    return json(data, 200, request);
  } catch (e) {
    return json({ error: "Unhandled exception", message: e?.message || String(e) }, 500, request);
  }
}

function json(obj, status, request) {
  const headers = corsHeaders(request);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(obj), { status, headers });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = new Headers();

  // Allow your deployed site + local dev
  const allowed =
    origin === "https://pilot-vocab-cards.pages.dev" ||
    /^http:\/\/localhost:\d+$/.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/.test(origin);

  if (allowed) {
    headers.set("Access-Control-Allow-Origin", origin);
  }

  headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}

function looksLikeMojibakeLatin1(s) {
  return /[ÐÑÃâ€“â€”]/.test(String(s || ""));
}

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
