require('dotenv').config({ path: 'backend/.env' });
const fetch = require('node-fetch') || globalThis.fetch;
const fs = require('fs');

async function test() {
  const plannerCode = fs.readFileSync('backend/src/agents/planner.ts', 'utf8');
  const promptMatch = plannerCode.match(/const PLANNER_SYSTEM_PROMPT = `([\s\S]*?)`;/);
  const sysPrompt = promptMatch[1] + "\n\nIMPORTANT: You MUST respond with valid JSON only. No markdown, no code fences, no explanatory text. Only output the JSON object.";
  const userPrompt = `User command: "find me plugins where i wated to create newplugin here"`;

  console.log("Starting full generation...");
  const start = Date.now();
  const res = await fetch(process.env.QWEN_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.QWEN_API_KEY}`,
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.QWEN_MODEL,
      messages: [{ role: 'system', content: sysPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.7,
      max_tokens: 4096
    })
  });
  console.log("Status:", res.status);
  console.log("Time:", Date.now() - start, "ms");
  const data = await res.json();
  const tk = data.usage?.completion_tokens;
  console.log("Completion Tokens:", tk);
  if (data.choices && data.choices[0]) {
    console.log("Response text length:", data.choices[0].message.content.length);
  }
}
test().catch(console.error);
