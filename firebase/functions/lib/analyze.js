/**
 * Provider routing — mirrors Parlance/ExternalAnalyzer, AnthropicAnalyzer, GeminiAnalyzer.
 */

const { buildSystemPrompt, langNameFromCode } = require("./prompts");
const { parseAndNormalize } = require("./parse");

const ENDPOINTS = {
  groq: "https://api.groq.com/openai/v1/chat/completions",
  deepSeek: "https://api.deepseek.com/chat/completions",
  openRouter: "https://openrouter.ai/api/v1/chat/completions",
  openAI: "https://api.openai.com/v1/chat/completions",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
};

const OPENAI_COMPAT = new Set(["groq", "deepSeek", "openRouter", "openAI", "kimi"]);

function apiKeyForProvider(provider, secrets) {
  const map = {
    groq: secrets.groq,
    deepSeek: secrets.deepseek,
    gemini: secrets.gemini,
    openRouter: secrets.openrouter,
    openAI: secrets.openai,
    anthropic: secrets.anthropic,
    kimi: secrets.kimi,
  };
  return map[provider] || "";
}

async function callOpenAICompatible(endpoint, model, apiKey, systemPrompt, userMessage) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "Parlance-Functions/1.0",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 1024,
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(model, apiKey, systemPrompt, userMessage) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "User-Agent": "Parlance-Functions/1.0",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text ?? "";
}

async function callGemini(model, apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Parlance-Functions/1.0",
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

/**
 * @param {object} params
 * @param {string} params.sentence
 * @param {string} params.language - "es" | "fr" | "en"
 * @param {string} params.level
 * @param {string} [params.ragContext]
 * @param {string} params.provider
 * @param {string} params.model
 * @param {Record<string, string>} secrets
 */
async function analyzeWithProvider(params, secrets) {
  const { sentence, language, ragContext = "", provider, model } = params;

  const apiKey = apiKeyForProvider(provider, secrets);
  if (!apiKey) {
    throw new Error(`Server API key not configured for provider: ${provider}`);
  }

  const langName = langNameFromCode(language);
  const systemPrompt = buildSystemPrompt(langName, ragContext);
  const userMessage = `Analyze this ${langName} sentence: "${sentence}"`;

  let rawText;

  if (provider === "anthropic") {
    rawText = await callAnthropic(model, apiKey, systemPrompt, userMessage);
  } else if (provider === "gemini") {
    rawText = await callGemini(model, apiKey, systemPrompt, userMessage);
  } else if (OPENAI_COMPAT.has(provider)) {
    const endpoint = ENDPOINTS[provider];
    if (!endpoint) {
      throw new Error(`Unsupported provider: ${provider}`);
    }
    rawText = await callOpenAICompatible(endpoint, model, apiKey, systemPrompt, userMessage);
  } else {
    throw new Error(`Unsupported provider: ${provider}`);
  }

  return parseAndNormalize(rawText, sentence, language);
}

module.exports = {
  analyzeWithProvider,
  apiKeyForProvider,
  ENDPOINTS,
};
