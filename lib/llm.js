// Groq (OpenAI-compatible). Handles the "model returned malformed output / tool error" failure modes the
// hackathon brief warns about: retries, model fallback, tolerant JSON extraction.
const URL_ = 'https://api.groq.com/openai/v1/chat/completions';

export function llmEnabled() { return !!process.env.GROQ_API_KEY; }
export function llmName() { return llmEnabled() ? (process.env.GROQ_MODEL || 'openai/gpt-oss-120b') : null; }

function extractJSON(text) {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '');
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object in response');
  return JSON.parse(clean.slice(start, end + 1));
}

export async function chatJSON(messages) {
  const models = [...new Set([process.env.GROQ_MODEL || 'openai/gpt-oss-120b', 'qwen/qwen3-32b'])];
  let lastErr;
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(URL_, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1400 }),
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 160)}`);
        const data = await res.json();
        return { json: extractJSON(data.choices?.[0]?.message?.content || ''), model };
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr;
}
