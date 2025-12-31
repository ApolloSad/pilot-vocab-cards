import { PILOT_GLOSSARY } from "./pilot_glossary.js";

const normalizeTerm = (raw) =>
  String(raw || "")
    .toLowerCase()
    .replace(/[“”"]/g, "")
    .replace(/[’']/g, "'")
    .replace(/[–—]/g, "-")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();

const termVariants = (normalized) => {
  const variants = new Set([normalized]);

  if (normalized.includes("-")) {
    variants.add(normalized.replace(/-/g, " "));
    variants.add(normalized.replace(/-/g, ""));
  }

  if (normalized.includes("/")) {
    variants.add(normalized.replace(/\//g, " "));
    variants.add(normalized.replace(/\//g, ""));
  }

  if (normalized.endsWith("ies") && normalized.length > 4) {
    variants.add(normalized.replace(/ies$/, "y"));
  } else if (normalized.endsWith("es") && normalized.length > 3) {
    variants.add(normalized.replace(/es$/, ""));
  } else if (normalized.endsWith("s") && normalized.length > 3) {
    variants.add(normalized.replace(/s$/, ""));
  }

  return Array.from(variants).filter(Boolean);
};

const getPilotDefinition = (word) => {
  const normalized = normalizeTerm(word);
  if (!normalized) return "";
  const variants = termVariants(normalized);
  for (const key of variants) {
    const def = PILOT_GLOSSARY.get(key);
    if (def) return def;
  }
  return "";
};

export async function onRequestGet({ request, env }) {
  try {
    const url = new URL(request.url);
    const wordRaw = (url.searchParams.get("word") || "").trim();
    if (!wordRaw) return json({ error: "Missing word" }, 400);

    const word = wordRaw.slice(0, 64);
    const pilotDefinition = getPilotDefinition(word);
    const isPilotTerm = Boolean(pilotDefinition);
    if (!env?.AI) {
      if (pilotDefinition) {
        return json(
          { definition: pilotDefinition, examples: ensureTwoExamples([], word) },
          200
        );
      }
      return json({ error: "Workers AI binding missing" }, 500);
    }

    const domainHint = isPilotTerm
      ? "The word is in the pilot glossary. Use the precise aviation meaning."
      : "The word is not in the pilot glossary. Use the best general meaning.";

    const systemPrompt = `
You are a vocabulary assistant.

Return ONLY valid JSON in this exact shape:
{
  "definition": "one short definition (max 14 words)",
  "examples": ["short example (max 12 words)", "short example (max 12 words)"]
}

Rules:
- ${domainHint}
- If a definition is provided, return it verbatim as the definition.
- Simple English only.
- Exactly 2 examples.
- No extra keys.
- No extra text.
- No markdown.
`.trim();

    const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: pilotDefinition
            ? `Word: "${word}"\nDefinition: "${pilotDefinition}"`
            : `Word: "${word}"`,
        },
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
      if (pilotDefinition) {
        return json(
          { definition: pilotDefinition, examples: ensureTwoExamples([], word) },
          200
        );
      }
      return json({ error: "Model returned non-JSON" }, 502);
    }

    const payload = normalizePayload(data, word, pilotDefinition);

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

function normalizePayload(data, word, definitionOverride = "") {
  const def = definitionOverride
    ? String(definitionOverride || "").trim()
    : clampWords(String(data?.definition || "").trim(), 14);

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
