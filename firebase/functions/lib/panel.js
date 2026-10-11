/**
 * Coach panel: free-tier LLM pool proposes edits, a second free model verifies
 * them, and the signal server (LanguageTool, parser, ...) votes on the result.
 *
 * Every provider here has a no-cost tier. The pool falls through on rate limits
 * (429), any HTTP or network error, or unparseable output.
 */

const { ENDPOINTS } = require("./analyze");
const { langNameFromCode } = require("./prompts");

const DEFAULT_POOL = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "openRouter", model: "openai/gpt-oss-120b:free" },
  // Gemini's free tier may use prompts to improve Google products; keep it last.
  { provider: "gemini", model: "gemini-flash-lite-latest" },
];

function loadPool() {
  try {
    const custom = JSON.parse(process.env.COACH_POOL_JSON || "null");
    if (Array.isArray(custom) && custom.length) return custom;
  } catch (_) { /* fall back to default */ }
  return DEFAULT_POOL;
}

function editsPrompt(langName) {
  return [
    `You are a meticulous ${langName} copy editor helping a language learner.`,
    `Find every real error: grammar, agreement, verb mood/tense, prepositions, word choice, spelling, accents.`,
    `Do not change correct text. Do not rewrite for style. Preserve the writer's meaning.`,
    `Return JSON only:`,
    `{"edits":[{"original":"exact substring from the text","replacement":"corrected substring","type":"grammar|agreement|mood|tense|preposition|word_choice|spelling|accent|punctuation","explanation":"one short sentence in English"}],"corrected":"full corrected text"}`,
    `"original" must be copied exactly from the text and be as short as possible. If there are no errors return {"edits":[],"corrected":"<text unchanged>"}.`,
  ].join("\n");
}

function verifyPrompt(langName) {
  return [
    `You are a strict ${langName} grammar reviewer. Another editor proposed edits to a learner's text.`,
    `For each edit decide if the original is truly an error and the replacement is correct ${langName}.`,
    `Return JSON only: {"verdicts":[{"index":0,"valid":true}]}`,
  ].join("\n");
}

function keyFor(provider, secrets) {
  return {
    groq: secrets.groq,
    openRouter: secrets.openrouter,
    gemini: secrets.gemini,
    cloudflare: secrets.cloudflare,
  }[provider] || "";
}

async function callModel({ provider, model }, apiKey, system, user) {
  let resp;
  if (provider === "gemini") {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ parts: [{ text: user }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 2048, responseMimeType: "application/json" },
        }),
      }
    );
  } else {
    const body = {
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0,
      max_tokens: 2048,
      response_format: { type: "json_object" },
    };
    if (model.includes("gpt-oss")) body.reasoning_effort = "medium";
    resp = await fetch(ENDPOINTS[provider], {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": "Parlance-Functions/1.0",
      },
      body: JSON.stringify(body),
    });
  }
  if (resp.status === 429 || resp.status >= 500) {
    throw new Error(`${provider}/${model} HTTP ${resp.status}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${provider}/${model} HTTP ${resp.status}: ${text.slice(0, 160)}`);
  }
  const data = await resp.json();
  const raw = provider === "gemini"
    ? data.candidates?.[0]?.content?.parts?.[0]?.text
    : data.choices?.[0]?.message?.content;
  try {
    return JSON.parse(String(raw || "").replace(/^```(?:json)?|```$/g, "").trim());
  } catch (_) {
    throw new Error(`${provider}/${model} returned non-JSON`);
  }
}

/** Try each pool entry in order; returns { json, used, index } or throws. */
async function callPool(pool, secrets, system, user, skip = -1) {
  const failures = [];
  for (let i = 0; i < pool.length; i++) {
    if (i === skip) continue;
    const apiKey = keyFor(pool[i].provider, secrets);
    if (!apiKey) continue;
    try {
      const json = await callModel(pool[i], apiKey, system, user);
      return { json, used: `${pool[i].provider}/${pool[i].model}`, index: i };
    } catch (err) {
      failures.push(err.message);
    }
  }
  throw new Error(`All free providers unavailable: ${failures.join(" | ") || "no keys configured"}`);
}

function cleanEdits(text, edits) {
  if (!Array.isArray(edits)) return [];
  return edits
    .filter((e) => e && typeof e.original === "string" && typeof e.replacement === "string")
    .filter((e) => e.original && e.original !== e.replacement && text.includes(e.original))
    .slice(0, 25)
    .map((e) => ({
      original: e.original,
      replacement: e.replacement,
      type: String(e.type || "grammar"),
      explanation: String(e.explanation || ""),
    }));
}

/** Propose edits with one free model, verify with a different one. */
async function llmEdits(text, language, secrets) {
  const langName = langNameFromCode(language);
  const pool = loadPool();
  const proposal = await callPool(pool, secrets, editsPrompt(langName), `Text:\n${text}`);
  const edits = cleanEdits(text, proposal.json.edits);
  const models = { proposer: proposal.used, verifier: null };
  if (!edits.length) return { edits, models };

  try {
    const list = edits.map((e, i) => `${i}. "${e.original}" -> "${e.replacement}" (${e.explanation})`).join("\n");
    const check = await callPool(
      pool, secrets, verifyPrompt(langName), `Text:\n${text}\n\nProposed edits:\n${list}`, proposal.index
    );
    models.verifier = check.used;
    const valid = new Map(
      (check.json.verdicts || []).map((v) => [Number(v.index), v.valid === true])
    );
    edits.forEach((e, i) => { e.verified = valid.get(i) === true; });
  } catch (err) {
    console.warn("verify skipped:", err.message);
    edits.forEach((e) => { e.verified = false; });
  }
  return { edits, models };
}

/** Ask the signal server to vote on and combine everything. */
async function combineWithSignals(text, language, edits, signalsUrl, signalsToken) {
  const resp = await fetch(`${signalsUrl.replace(/\/$/, "")}/panel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(signalsToken ? { Authorization: `Bearer ${signalsToken}` } : {}),
    },
    body: JSON.stringify({ text, language, llm_edits: edits }),
    signal: AbortSignal.timeout(25000),
  });
  if (!resp.ok) throw new Error(`signals HTTP ${resp.status}`);
  return resp.json();
}

/** Fallback when the signal server is down: trust only verified edits. */
function llmOnlyResult(text, edits) {
  const issues = edits.map((e) => {
    const start = text.indexOf(e.original);
    return {
      start,
      end: start + e.original.length,
      original: e.original,
      replacement: e.replacement,
      kind: e.type,
      message: e.explanation,
      source: e.verified ? "llm_verified" : "llm",
      sources: [e.verified ? "llm_verified" : "llm"],
      status: e.verified ? "error" : "possible",
      score: e.verified ? 0.8 : 0.5,
    };
  });
  let corrected = text;
  for (const i of issues.filter((i) => i.status === "error").sort((a, b) => b.start - a.start)) {
    corrected = corrected.slice(0, i.start) + i.replacement + corrected.slice(i.end);
  }
  const verdict = issues.some((i) => i.status === "error")
    ? "needs_work" : issues.length ? "check" : "excellent";
  return { verdict, issues, corrected, signals: { signal_server: "unavailable" } };
}

async function runPanel({ text, language, secrets, signalsUrl, signalsToken }) {
  let llm = { edits: [], models: { proposer: null, verifier: null } };
  let llmError = null;
  try {
    llm = await llmEdits(text, language, secrets);
  } catch (err) {
    llmError = err.message;
  }

  let result;
  if (signalsUrl) {
    try {
      result = await combineWithSignals(text, language, llm.edits, signalsUrl, signalsToken);
    } catch (err) {
      console.warn("signal server failed:", err.message);
    }
  }
  if (!result) {
    if (llmError) throw new Error(llmError);
    result = llmOnlyResult(text, llm.edits);
  }
  return { ...result, models: llm.models, ...(llmError ? { llm_error: llmError } : {}) };
}

module.exports = { runPanel, llmEdits, loadPool };
