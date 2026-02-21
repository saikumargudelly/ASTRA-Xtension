require('dotenv').config({ path: 'backend/.env' });
const key = process.env.QWEN_API_KEY;
const model = process.env.QWEN_MODEL;

// Test the /no_think approach
const systemPrompt = '/no_think\nYou are ASTRA Planner. Output ONLY raw JSON.\n\nIMPORTANT: Output ONLY raw JSON starting with { and ending with }. No markdown fences, no explanation.';
const userPrompt = 'User command: "find best shirts under 1000" on ajio.com. Site context: ajio.com';

fetch('https://api.fireworks.ai/inference/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
  body: JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    max_tokens: 1024,
    temperature: 0.1
  })
}).then(async r => {
  if (!r.ok) { console.error('STATUS', r.status, await r.text()); return; }
  const d = await r.json();
  const content = d.choices?.[0]?.message?.content ?? '';

  // Strip think tags
  const stripped = content.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  console.log('STRIPPED (first 600):\n', stripped.substring(0, 600));

  // Extract JSON
  const obj = stripped.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]);
      console.log('✅ PARSED OK:', JSON.stringify(parsed).substring(0, 300));
    } catch (e) {
      console.log('❌ JSON PARSE FAIL:', e.message);
    }
  } else {
    console.log('❌ NO JSON FOUND IN:', stripped.substring(0, 300));
  }
}).catch(e => console.error('FETCH ERR:', e.message));
