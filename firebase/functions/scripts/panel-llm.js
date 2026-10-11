#!/usr/bin/env node
/**
 * Print free-pool LLM edits for one text, using the same code as coachPanel.
 * Used by training/coach_benchmark/eval_panel.py --llm.
 *
 *   GROQ_API_KEY=... node scripts/panel-llm.js es "Espero que todo es tranquilo."
 */

const { llmEdits } = require("../lib/panel");

const [language, ...rest] = process.argv.slice(2);
const text = rest.join(" ");
if (!language || !text) {
  console.error("usage: panel-llm.js <es|fr|en> <text>");
  process.exit(2);
}

llmEdits(text, language, {
  groq: process.env.GROQ_API_KEY || "",
  openrouter: process.env.OPENROUTER_API_KEY || "",
  gemini: process.env.GEMINI_API_KEY || "",
})
  .then((res) => console.log(JSON.stringify(res)))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
