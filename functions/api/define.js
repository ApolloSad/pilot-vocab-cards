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
- No extra text
- No markdown
`;

  const userPrompt = `Word: "${word}"`;

  const result = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages: [
      { role: "system", content: systemPrompt.trim() },
      { role: "user", content: userPrompt },
    ],
    max_output_tokens: 200,
  });

  let data;
  try {
    data = JSON.parse(result.response);
  } catch {
    return json(
      { error: "AI returned invalid JSON", raw: result.response },
      500
    );
  }

  return json(data, 200);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
