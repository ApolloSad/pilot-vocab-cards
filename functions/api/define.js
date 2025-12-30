export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const word = (url.searchParams.get("word") || "").trim();

  if (!word) {
    return new Response(
      JSON.stringify({ error: "Missing word" }),
      { status: 400, headers: { "content-type": "application/json" } }
    );
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

  const result = await env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct-fast",
    {
      messages: [
        { role: "system", content: systemPrompt.trim() },
        { role: "user", content: userPrompt }
      ],
      max_output_tokens: 200
    }
  );

  let data;
  try {
    data = JSON.parse(result.response);
  } catch {
    return new Response(
      JSON.stringify({ error: "AI returned invalid JSON", raw: result.response }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" }
  });
}
