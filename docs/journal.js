// ── NATIVE GLOBALS HYDRATION ─────────────────────────────────────
// iOS injects __PARLANCE_CONFIG__ / __PARLANCE_AUTH__ with a document-start
// WKUserScript. Android's WebView has no equivalent, so its bridge exposes the
// same payloads synchronously and we read them here, before anything else in
// this file runs. Everything downstream then sees identical globals.
(function hydrateNativeGlobals() {
  const native = window.ParlanceNative;
  if (!native) return;
  try {
    if (!window.__PARLANCE_CONFIG__ && typeof native.getConfig === 'function') {
      window.__PARLANCE_CONFIG__ = JSON.parse(native.getConfig());
    }
    if (!window.__PARLANCE_AUTH__ && typeof native.getAuth === 'function') {
      window.__PARLANCE_AUTH__ = JSON.parse(native.getAuth());
    }
  } catch (e) {
    console.warn('[Parlance] native bridge hydration failed:', e);
  }
})();

// ── AI PROVIDER CONFIGURATION ────────────────────────────────────
const PARLANCE_SLM_URL = localStorage.getItem('parlance_slm_server_url') || 'http://127.0.0.1:8765';

/** Min trimmed length to analyze. */
const MIN_SENTENCE_CHARS = 15;
const MIN_SENTENCE_WORDS = 3;

/** Split a paragraph into sentence units for per-sentence feedback. */
function splitIntoSentences(text) {
  const trimmed = String(text || '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return [];
  // Keep terminator with each unit. Handles . ! ? … and Spanish/French spacing.
  const parts = trimmed.match(/[^.!?…]+(?:[.!?…]+(?:\s*["»”']+)?|(?=$))/g);
  if (!parts) return [trimmed];
  return parts.map(p => p.trim()).filter(p => p.length > 0);
}

function countSentencesInText(text) {
  return splitIntoSentences(text).length;
}

/** Parlance Coach on-device first load can take 60–120s+ on iPhone. */
const TIMEOUT_MS = {
  parlanceNative: 300000,
  parlanceServer: 180000,
  webllm: 180000,
  cloud: 20000,
};

const VALID_CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];

function normalizeAssessedLevel(raw) {
  if (!raw) return null;
  const u = String(raw).toUpperCase().trim();
  return VALID_CEFR_LEVELS.includes(u) ? u : null;
}

function extractAssessedLevel(obj) {
  if (!obj) return null;
  return normalizeAssessedLevel(obj.assessed_level || obj.assessedLevel || obj.sentence_level);
}

function extractComplexityNote(obj) {
  if (!obj) return null;
  const raw = obj.complexity_note || obj.complexityNote;
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!t) return null;
  const low = t.toLowerCase();
  if (low.includes('english sentences on sentence complexity')
      || low.includes('1–2 english sentences')
      || low.includes('1-2 english sentences')) {
    return null;
  }
  return t;
}

function altVersionLabels(assessedLevel) {
  if (!assessedLevel) {
    return { nextLabel: i18n.t('altNextLevel'), targetLabel: i18n.t('altHigherLevel') };
  }
  const nextKeys = {
    C2: 'altNativePolish', C1: 'altC2Mastery', B2: 'altC1Professional',
    B1: 'altB2Version', A2: 'altB1Version', A1: 'altA2Version',
  };
  const targetKeys = {
    B2: 'altC2Mastery', B1: 'altC1Professional', A2: 'altB2Version', A1: 'altB1Version',
  };
  return {
    nextLabel: i18n.t(nextKeys[assessedLevel] || 'altNextLevel'),
    targetLabel: targetKeys[assessedLevel] ? i18n.t(targetKeys[assessedLevel]) : null,
  };
}

function analysisCacheHash(sentence, language) {
  return btoa(unescape(encodeURIComponent(sentence + '|' + language + '|fbv15'))).slice(0, 40);
}

function sanitizeFeedbackResult(sentence, result, language = 'es') {
  if (typeof ParlanceFeedbackSanitize !== 'undefined' && ParlanceFeedbackSanitize.sanitizeFeedbackResult) {
    return ParlanceFeedbackSanitize.sanitizeFeedbackResult(sentence, result, language);
  }
  return result;
}

const AI_PROVIDERS = {
  parlance: {
    id: 'parlance',
    name: 'Parlance Coach',
    subtitle: 'Spanish & French fine-tuned · On-device',
    icon: '🎓',
    requiresKey: false,
    local: true,
    corsNote: false,
    models: [
      { id: 'parlance-es', name: 'Parlance Spanish (Gemma 4)' },
      { id: 'parlance-fr', name: 'Parlance French (Gemma 4)' },
    ],
    defaultModel: 'parlance-es',
  },
  webllm: {
    id: 'webllm',
    name: 'Browser AI',
    subtitle: 'Free · No account · On-device',
    icon: '🧠',
    requiresKey: false,
    local: true,
    corsNote: false,
    models: [
      { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', name: 'Qwen 0.5B — Fast (~380 MB)' },
      { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', name: 'Qwen 1.5B — Better (~900 MB)' },
    ],
    defaultModel: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    subtitle: 'Free · Very fast',
    icon: '⚡',
    requiresKey: true,
    local: false,
    corsNote: false,
    free: true,
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    keyUrl: 'https://console.groq.com/keys',
    models: [
      { id: 'openai/gpt-oss-120b', name: 'GPT-OSS 120B (best)' },
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B (versatile)' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B (fast)' },
    ],
    defaultModel: 'openai/gpt-oss-120b',
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    subtitle: 'Free · DeepSeek V4',
    icon: '🐋',
    requiresKey: true,
    local: false,
    corsNote: false,
    free: true,
    endpoint: 'https://api.deepseek.com/chat/completions',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash (fast)' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro (best)' },
    ],
    defaultModel: 'deepseek-v4-flash',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    subtitle: 'Free · 1M tokens/day',
    icon: '✨',
    requiresKey: true,
    local: false,
    corsNote: false,
    free: true,
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash (stable)' },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (best)' },
    ],
    defaultModel: 'gemini-2.5-flash',
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    subtitle: 'Free models · Multi-provider',
    icon: '🔀',
    requiresKey: true,
    local: false,
    corsNote: false,
    free: true,
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    keyUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B (free)' },
      { id: 'google/gemma-3-27b-it:free', name: 'Gemma 3 27B (free)' },
      { id: 'qwen/qwen3-8b:free', name: 'Qwen3 8B (free)' },
    ],
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    subtitle: 'GPT-5 · Paid',
    icon: '💎',
    requiresKey: true,
    local: false,
    corsNote: false,
    free: false,
    endpoint: 'https://api.openai.com/v1/chat/completions',
    keyUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.4-nano', name: 'GPT-5.4 Nano (fast)' },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini (best)' },
      { id: 'gpt-5.5', name: 'GPT-5.5 (premium)' },
    ],
    defaultModel: 'gpt-5.4-nano',
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    subtitle: 'Claude · Paid',
    icon: '🤖',
    requiresKey: true,
    local: false,
    corsNote: true,
    free: false,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5 (fast)' },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (best)' },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7 (premium)' },
    ],
    defaultModel: 'claude-haiku-4-5',
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    subtitle: 'Kimi K2.6 · Paid',
    icon: '🌙',
    requiresKey: true,
    local: false,
    corsNote: true,
    free: false,
    endpoint: 'https://api.moonshot.cn/v1/chat/completions',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'kimi-k2.5', name: 'Kimi K2.5 (multimodal)' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6 (best)' },
    ],
    defaultModel: 'kimi-k2.6',
  },
};

// ── AI SETTINGS (localStorage) ───────────────────────────────────
const LS_PROVIDER = 'parlance_ai_provider';
const LS_MODEL    = 'parlance_ai_model_';
const LS_KEY      = 'parlance_ai_key_';
const LS_PROVIDER_CHOSEN = 'parlance_ai_provider_chosen';

/** Cloud route used when someone is signed in — no API key, covered by the
 *  monthly account allowance. */
const DEFAULT_CLOUD_PROVIDER = 'groq';

function getSelectedProvider() {
  if (isCoachOnlyNative()) return 'parlance';
  return localStorage.getItem(LS_PROVIDER) || 'webllm';
}

/** True once the user picked a provider themselves, rather than us picking. */
function hasUserChosenProvider() {
  return localStorage.getItem(LS_PROVIDER_CHOSEN) === '1';
}

function markProviderChosenByUser() {
  try { localStorage.setItem(LS_PROVIDER_CHOSEN, '1'); } catch (_) {}
}

function getProviderModel(providerId) {
  const provider = AI_PROVIDERS[providerId];
  const stored = localStorage.getItem(LS_MODEL + providerId);
  // A saved id outlives the model it names — providers retire them without
  // notice. Falling back to the current default beats sending a 404 to the API.
  if (stored && provider?.models?.some((m) => m.id === stored)) return stored;
  return provider?.defaultModel || '';
}

function getProviderKey(providerId) {
  return localStorage.getItem(LS_KEY + providerId) || '';
}

function setSelectedProvider(id) { localStorage.setItem(LS_PROVIDER, id); }
function setProviderModel(id, m)  { localStorage.setItem(LS_MODEL + id, m); }
function setProviderKey(id, k)    { localStorage.setItem(LS_KEY + id, k); }

// ── FIREBASE AUTH & CLOUD PROXY ──────────────────────────────────
let firebaseApp = null;
let firebaseAuth = null;
let analyzeTextCallable = null;
let firebaseAuthUser = null;
let firebaseInitPromise = null;

const FIREBASE_PLACEHOLDER_API_KEY = 'YOUR_API_KEY';

function hasFirebaseConfig() {
  return typeof firebaseConfig !== 'undefined'
    && firebaseConfig?.apiKey
    && firebaseConfig.apiKey !== FIREBASE_PLACEHOLDER_API_KEY;
}

function isCloudProvider(providerId) {
  const p = AI_PROVIDERS[providerId];
  return !!(p && !p.local);
}

function isFirebaseSignedIn() {
  if (isNativeParlanceApp()) {
    return !!(window.__PARLANCE_AUTH__?.signedIn);
  }
  return !!firebaseAuthUser;
}

function firebaseDisplayName() {
  if (isNativeParlanceApp()) {
    const a = window.__PARLANCE_AUTH__ || {};
    return a.displayName || a.email || 'Signed in';
  }
  if (firebaseAuthUser) {
    return firebaseAuthUser.displayName || firebaseAuthUser.email || 'Signed in';
  }
  return '';
}

function shouldUseFirebaseCloud(providerId) {
  if (isNativeParlanceApp()) return false;
  if (!isCloudProvider(providerId)) return false;
  return isFirebaseSignedIn();
}

function canUseFirebaseWebAuth() {
  return hasFirebaseConfig()
    && typeof firebase !== 'undefined'
    && !isNativeParlanceApp();
}

async function ensureFirebaseReady() {
  if (!canUseFirebaseWebAuth()) return false;
  if (firebaseApp && analyzeTextCallable) return true;
  if (firebaseInitPromise) return firebaseInitPromise;

  firebaseInitPromise = (async () => {
    try {
      if (!firebase.apps?.length) {
        firebaseApp = firebase.initializeApp(firebaseConfig);
      } else {
        firebaseApp = firebase.app();
      }
      firebaseAuth = firebase.auth();
      analyzeTextCallable = firebase.functions().httpsCallable('analyzeText');
      firebaseAuth.onAuthStateChanged((user) => {
        firebaseAuthUser = user;
        reapplyDefaultProviderIfUnchosen();
        updateFirebaseAuthUI();
        updateModalForProvider(modalSelectedProvider);
        updateWaitingCard();
      });
      return true;
    } catch (e) {
      console.warn('[Parlance] Firebase init failed:', e);
      return false;
    } finally {
      firebaseInitPromise = null;
    }
  })();

  return firebaseInitPromise;
}

async function signInWithApple() {
  if (isNativeParlanceApp()) {
    try {
      await callNativeAuth('signInApple');
      showToast(i18n.t('signedInApple'), 'success');
    } catch (e) {
      const msg = e?.message || '';
      if (msg && msg !== 'cancelled' && !msg.includes('canceled')) {
        showToast(msg || i18n.t('appleSignInFailed'), 'error');
      }
    }
    reapplyDefaultProviderIfUnchosen();
    updateFirebaseAuthUI();
    updateModalForProvider(modalSelectedProvider);
    updateWaitingCard();
    return;
  }
  if (!canUseFirebaseWebAuth()) return;
  await ensureFirebaseReady();
  const provider = new firebase.auth.OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  try {
    await firebaseAuth.signInWithPopup(provider);
    showToast(i18n.t('signedInApple'), 'success');
  } catch (e) {
    if (e?.code !== 'auth/popup-closed-by-user') {
      showToast(e?.message || i18n.t('appleSignInFailed'), 'error');
    }
  }
  updateFirebaseAuthUI();
}

async function signInWithGoogle() {
  if (isNativeParlanceApp()) {
    try {
      await callNativeAuth('signInGoogle');
      showToast(i18n.t('signedInGoogle'), 'success');
    } catch (e) {
      const msg = e?.message || '';
      if (msg && msg !== 'cancelled' && !msg.includes('canceled')) {
        showToast(msg || i18n.t('googleSignInFailed'), 'error');
      }
    }
    reapplyDefaultProviderIfUnchosen();
    updateFirebaseAuthUI();
    updateModalForProvider(modalSelectedProvider);
    updateWaitingCard();
    return;
  }
  if (!canUseFirebaseWebAuth()) return;
  await ensureFirebaseReady();
  try {
    await firebaseAuth.signInWithPopup(new firebase.auth.GoogleAuthProvider());
    showToast(i18n.t('signedInGoogle'), 'success');
  } catch (e) {
    if (e?.code !== 'auth/popup-closed-by-user') {
      showToast(e?.message || i18n.t('googleSignInFailed'), 'error');
    }
  }
  updateFirebaseAuthUI();
}

async function signOutFirebase() {
  if (isNativeParlanceApp()) {
    try {
      await callNativeAuth('signOut');
      showToast(i18n.t('signedOut'));
    } catch (e) {
      showToast(e?.message || i18n.t('signOutFailed'), 'error');
    }
    updateFirebaseAuthUI();
    updateModalForProvider(modalSelectedProvider);
    updateWaitingCard();
    return;
  }
  if (canUseFirebaseWebAuth() && firebaseAuth) {
    try {
      await firebaseAuth.signOut();
    } catch (_) {}
  }
  updateFirebaseAuthUI();
  updateModalForProvider(modalSelectedProvider);
  updateWaitingCard();
  showToast(i18n.t('signedOut'));
}

// ── Account deletion (App Store guideline 5.1.1(v)) ──────────────────────────

function showDeleteAccountConfirm() {
  const overlay = document.getElementById('deleteAccountOverlay');
  if (overlay) overlay.style.display = 'flex';
}

function closeDeleteAccountConfirm() {
  const overlay = document.getElementById('deleteAccountOverlay');
  if (overlay) overlay.style.display = 'none';
}

function setDeleteAccountBusy(busy) {
  const btn = document.getElementById('deleteAccountConfirmBtn');
  if (!btn) return;
  btn.disabled = busy;
  btn.textContent = i18n.t(busy ? 'deleteAccountWorking' : 'deleteAccountConfirm');
}

async function deleteParlanceAccount() {
  setDeleteAccountBusy(true);
  try {
    if (isNativeParlanceApp()) {
      await callNativeAuth('deleteAccount');
    } else {
      await deleteAccountViaWeb();
    }
  } catch (e) {
    setDeleteAccountBusy(false);
    const message = e?.message || '';
    if (message === 'cancelled') return;
    showToast(i18n.t('deleteAccountFailed', { err: message }), 'error');
    return;
  }

  setDeleteAccountBusy(false);
  closeDeleteAccountConfirm();
  closeAISettings();
  updateFirebaseAuthUI();
  updateModalForProvider(modalSelectedProvider);
  updateWaitingCard();
  showToast(i18n.t('deleteAccountDone'), 'success');
}

async function deleteAccountViaWeb() {
  const ready = await ensureFirebaseReady();
  if (!ready || !firebaseAuth || !firebaseAuth.currentUser) {
    throw new Error(i18n.t('errFirebaseNotConfigured'));
  }
  await firebase.functions().httpsCallable('deleteAccountData')({});
  await firebaseAuth.currentUser.delete();
}

function updateFirebaseAuthUI() {
  const section = document.getElementById('authSection');
  if (!section) return;

  const signedOut = document.getElementById('authSignedOut');
  const signedInEl = document.getElementById('authSignedIn');
  const native = isNativeParlanceApp();
  const webAuth = canUseFirebaseWebAuth();

  // Sign-in buttons are gone on both phones. Coach does not need an account.
  // Keep the section only on the web, and only if a session is already live.
  if (native || !webAuth || !isFirebaseSignedIn()) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const signedIn = isFirebaseSignedIn();
  if (signedOut) signedOut.style.display = signedIn ? 'none' : '';
  if (signedInEl) signedInEl.style.display = signedIn ? '' : 'none';
  const label = document.getElementById('authUserLabel');
  if (label && signedIn) label.textContent = firebaseDisplayName();

  if (signedIn) refreshUsageDisplay();
}

async function refreshUsageDisplay() {
  try {
    const ready = await ensureFirebaseReady();
    if (!ready) return;
    const fn = firebase.functions().httpsCallable('getUsage');
    const result = await fn({});
    const u = result.data;
    if (!u) return;

    const el = document.getElementById('authCloudNote');
    const buyBtn = document.getElementById('buyCallPackBtn');

    if (!el) return;

    if (u.tier === 'plus') {
      el.textContent = i18n.t('plusUnlimited');
      el.style.display = '';
      if (buyBtn) buyBtn.style.display = 'none';
      return;
    }

    const used = u.monthlyUsed || 0;
    const limit = u.monthlyLimit || 30;
    const packs = u.packCallsRemaining || 0;
    const remaining = Math.max(0, limit - used);

    let msg = `${remaining} free cloud calls left this month`;
    if (packs > 0) msg += ` · ${packs} pack calls remaining`;
    el.textContent = msg;
    el.style.display = '';

    if (buyBtn) buyBtn.style.display = 'none';
  } catch (_) {
    // Non-critical if the function is unavailable
  }
}

function normalizeFirebaseAnalyzeResult(data, sentence, language = 'es') {
  if (!data) throw new Error(i18n.t('errCloudEmpty'));
  if (data.status === 'Excellent' || data.status === 'Needs Improvement') {
    return normalizeResult(data, sentence, language);
  }
  if (data.feedback && typeof data.feedback === 'object') {
    return normalizeResult(data.feedback, sentence, language);
  }
  const raw = data.rawContent ?? data.raw ?? (typeof data === 'string' ? data : null);
  if (raw) return normalizeResult(parseAIContent(raw), sentence, language);
  return normalizeResult(data, sentence, language);
}

function callNativeFirebaseAnalyze(sentence, language, providerId) {
  return new Promise((resolve, reject) => {
    if (!isNativeParlanceApp()) {
      reject(new Error('Native Firebase analysis is only available in the Parlance app.'));
      return;
    }
    const requestId = 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timeoutId = setTimeout(() => {
      reject(new Error(i18n.t('errCloudTimeout')));
    }, TIMEOUT_MS.cloud);
    const ragContext = typeof getRAGContext === 'function'
      ? getRAGContext(language, null, sentence) : '';
    window.__parlanceFirebaseResult = (id, result, err) => {
      if (id !== requestId) return;
      clearTimeout(timeoutId);
      delete window.__parlanceFirebaseResult;
      if (err) {
        reject(new Error(err));
        return;
      }
      try {
        if (typeof result === 'string') {
          resolve(normalizeFirebaseAnalyzeResult(parseAIContent(result), sentence, language));
        } else {
          resolve(normalizeFirebaseAnalyzeResult(result, sentence, language));
        }
      } catch (e) {
        reject(e);
      }
    };
    postToNative({
      action: 'analyzeFirebase',
      requestId,
      sentence,
      language,
      ragContext,
      provider: providerId,
      model: getProviderModel(providerId),
    });
  });
}

async function callFirebaseCloudAnalyze(sentence, language, providerId) {
  const ready = await ensureFirebaseReady();
  if (!ready || !analyzeTextCallable) {
    throw new Error(i18n.t('errFirebaseNotConfigured'));
  }
  const ragContext = typeof getRAGContext === 'function'
    ? getRAGContext(language, null, sentence) : '';
  const resp = await analyzeTextCallable({
    sentence,
    language,
    ragContext,
    provider: providerId,
    model: getProviderModel(providerId),
  });
  return normalizeFirebaseAnalyzeResult(resp.data, sentence, language);
}

// ── WEBLLM ENGINE ────────────────────────────────────────────────
let webLLMEngine = null;
let webLLMLoadingPromise = null;
let webLLMCurrentModelId = null;

async function ensureWebLLM(modelId, progressCallback) {
  if (webLLMEngine && webLLMCurrentModelId === modelId) return webLLMEngine;

  if (webLLMLoadingPromise) {
    // Already loading — attach progress UI but share the same promise
    return webLLMLoadingPromise;
  }

  webLLMEngine = null;

  if (!navigator.gpu) {
    throw new Error(i18n.t('errWebgpuUnavailable'));
  }

  webLLMLoadingPromise = (async () => {
    try {
      const webllm = await import('https://esm.run/@mlc-ai/web-llm');
      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report) => {
          if (progressCallback) progressCallback(report);
        },
      });
      webLLMEngine = engine;
      webLLMCurrentModelId = modelId;
      return engine;
    } finally {
      webLLMLoadingPromise = null;
    }
  })();

  return webLLMLoadingPromise;
}

// ── SYSTEM PROMPT BUILDER ─────────────────────────────────────────
function buildSystemPrompt(language, ragContext) {
  const info = parlanceLanguageInfo(language);
  const langName = info.coachRole;
  const langKey = info.code;
  let registerLabel;
  let formalRegister;
  let informalRegister;
  let evaluateFocus;
  if (langKey === 'fr') {
    registerLabel = 'tu/vous';
    formalRegister = 'vous';
    informalRegister = 'tu';
    evaluateFocus = 'verb tense and mood, gender/number agreement, register (tu/vous), Anglicisms, and naturalness for professional interpreting';
  } else if (langKey === 'en') {
    registerLabel = 'formal/informal (and US/UK/AU/CA variety)';
    formalRegister = 'formal';
    informalRegister = 'informal';
    evaluateFocus = 'articles, tense aspect, conditionals, false cognates from Spanish/French, preposition calques, register, and naturalness for professional interpreting';
  } else {
    registerLabel = 'tú/usted';
    formalRegister = 'usted';
    informalRegister = 'tú';
    evaluateFocus = 'verb tense and mood, gender/number agreement, register (tú/usted), Anglicisms, and naturalness for professional interpreting';
  }
  const exampleSentenceRule = langKey === 'en'
    ? `ALL example sentences (correction, next_level_alt, target_level_alt) MUST be COMPLETE SENTENCES written in English (the practice language). Do NOT return Spanish or French for those fields. Do NOT return short labels — return full, natural sentences.`
    : `ALL example sentences (correction, next_level_alt, target_level_alt) MUST be COMPLETE SENTENCES written in ${langName}, NEVER in English. Do NOT return short labels or descriptions — return full, natural sentences.`;
  const standardBlock = (typeof ParlanceCoachStandard !== 'undefined' && ParlanceCoachStandard.forLang)
    ? ParlanceCoachStandard.forLang(langKey)
    : '';

  let prompt = `You are a ${langName} professor training professional interpreters. Do NOT assume the learner picked a CEFR level.

Evaluate ${evaluateFocus}.

`;
  if (standardBlock) {
    prompt += `${standardBlock}\n`;
  }

  prompt += `CEFR & COMPLEXITY:
- assessed_level: A1–C2 ONLY if highly confident from specific structures in this sentence. When uncertain, omit and use complexity_note without a CEFR label. Never guess from word count.
- complexity_note: 1–2 English sentences on vocabulary, syntax, subordination, and register — what makes this sentence simple or advanced. Always include when possible, even without assessed_level.
- next_level_alt / target_level_alt: stronger rewrites; CEFR labels only when assessed_level is set.

`;

  if (ragContext) {
    prompt += `REFERENCE KNOWLEDGE (use these rules to verify accuracy):
${ragContext}

`;
  }

  prompt += `CRITICAL ACCURACY RULES:
- Do NOT invent grammatical errors. Only flag real, clear mistakes.
- Grammatically correct sentences are "Excellent" — but explanation must cite specific structures in the learner's words (not generic praise).
- Only mark "Needs Improvement" when there is an actual grammar error — not just a style preference.
- Do NOT set assessed_level unless highly confident from specific structures in the sentence. When uncertain, omit and describe complexity in complexity_note.
- ALWAYS include complexity_note describing THIS sentence's structures.
- next_level_alt MUST rewrite the sentence at a higher level — never copy the input verbatim.
- tip MUST include at least one complete example sentence in ${langName} showing a stronger phrasing.
- ${exampleSentenceRule}
- next_level_alt and target_level_alt must express the SAME idea as the original sentence rephrased with grammar and vocabulary appropriate for that CEFR level. Do NOT add new information or embellish.
- grammar_rule, explanation, register, and tip must be in English (meta commentary), even when the practice language is English.
${langKey === 'fr' ? `- Do NOT rewrite «merci à vous», «s'il vous plaît», or «cordialement» unless they are misspelled.
- «Est-il possible de» + infinitive is correct. Do not invent a subjunctive error.
- After être/se + participle, a coordinated verb is a participle («renseigné»), not an infinitive.
- «Le point négatif est que…» needs the copula «est».
- Never write 'X' instead of 'X'. If the two quoted forms are the same, you have not found an error.
` : ''}- complexity_note must describe THIS sentence — never copy the schema example text.

MULTIPLE ERRORS (very important for Browser AI):
- If the sentence has more than one mistake, list EVERY error in explanation as separate bullet points (•), quoting the learner's exact words.
- Each bullet must name the rule AND the fix (e.g. "«muchos cosas» → «muchas cosas» (gender agreement)").
- Do NOT bury fixes only inside next_level_alt — when status is "Needs Improvement", correction is REQUIRED: one full corrected sentence at the learner's level.
- Do NOT replace explanation with a single rewritten sentence — explain each error clearly in English first.
- next_level_alt and target_level_alt MUST be plain JSON strings (never nested objects).

Respond with ONLY a valid JSON object. No markdown fences, no text outside the JSON, no <think> tags:
{
  "assessed_level": "A1" | "A2" | "B1" | "B2" | "C1" | "C2" | null,
  "complexity_note": "What makes THIS sentence simple or advanced (syntax, mood, register)",
  "status": "Excellent" or "Needs Improvement",
  "grammar_rule": "The specific grammar rule tested or applied — always explain, even when correct",
  "explanation": "WHY the sentence is correct or incorrect — be specific and actionable",
  "correction": null or "Corrected sentence in ${langName} (only if Needs Improvement)",
  "register": "State the register as one declarative phrase — e.g. 'informal (${informalRegister}) — casual; shift to ${formalRegister} in clinical/legal settings' OR 'formal (${formalRegister}) — appropriate for professional interpreting'. Read the pronouns/verb endings IN THIS SENTENCE; do NOT default to formal just because the context is professional. Do NOT write meta-instructions like 'Note whether…'.",
  "next_level_alt": "COMPLETE SENTENCE in ${langName}: same idea one CEFR level above assessed_level, or null if no assessed_level",
  "target_level_alt": "COMPLETE SENTENCE in ${langName}: two levels above assessed_level, or null",
  "tip": "One concrete tip for an interpreter trainee. REQUIRED: include one complete ${langName} example sentence. Format: tip sentence. E.g. «complete ${langName} example here». Never write 'Apply each fix' or other generic advice."
}`;

  return prompt;
}

// ── API CALL: OpenAI-compatible format ────────────────────────────
// Works for: Groq, OpenAI, Kimi
async function callOpenAIFormat(endpoint, model, apiKey, systemPrompt, userMessage) {
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.3,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`${resp.status} from API: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// ── API CALL: Anthropic Messages API ─────────────────────────────
async function callAnthropic(model, apiKey, systemPrompt, userMessage) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Anthropic ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.content?.[0]?.text ?? '';
}

// ── API CALL: Gemini generateContent API ─────────────────────────
async function callGemini(model, apiKey, systemPrompt, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 1024,
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gemini ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

// ── API CALL: Parlance fine-tuned SLM (local server) ─────────────
async function callParlanceSLM(sentence, language, ragContext = '') {
  const base = PARLANCE_SLM_URL.replace(/\/$/, '');
  const resp = await fetch(`${base}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sentence, language, ragContext }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `Parlance SLM server error (${resp.status})`);
  }
  if (!data.feedback) throw new Error('No feedback from Parlance SLM server');
  return JSON.stringify(data.feedback);
}

// ── NATIVE BRIDGE ────────────────────────────────────────────────
// iOS delivers messages through a WKScriptMessageHandler; Android through an
// @JavascriptInterface object that takes a JSON string. Both accept the same
// message shapes and call back into the same window.__parlance* functions, so
// feature code below never branches on platform — it asks about capabilities.

/** Returns a send function for whichever host we're embedded in, or null. */
function nativeBridgeTransport() {
  if (window.webkit?.messageHandlers?.parlance) {
    return (message) => window.webkit.messageHandlers.parlance.postMessage(message);
  }
  if (window.ParlanceNative && typeof window.ParlanceNative.postMessage === 'function') {
    return (message) => window.ParlanceNative.postMessage(
      typeof message === 'string' ? message : JSON.stringify(message)
    );
  }
  return null;
}

function isNativeParlanceApp() {
  return !!(window.__PARLANCE_CONFIG__ && nativeBridgeTransport());
}

/** Sends to whichever native host is present. Returns false if there is none. */
function postToNative(message) {
  const send = nativeBridgeTransport();
  if (!send) return false;
  send(message);
  return true;
}

/**
 * Platforms ship different subsets of the bridge — Android has no native
 * settings sheet. Gate on the capability rather than on the platform so
 * adding one is a config change, not a hunt through every call site.
 *
 * Hosts that predate capability reporting (older iOS builds) advertise nothing,
 * and those were all iOS, so treat a missing list as "supports everything".
 */
function nativeSupports(capability) {
  if (!isNativeParlanceApp()) return false;
  const caps = (window.__PARLANCE_CONFIG__ || {}).capabilities;
  if (!caps) return true;
  return !!caps[capability];
}

/** In-app purchase (StoreKit on iPhone, Play Billing on Android). */
function nativeSupportsPurchases() {
  return nativeSupports('inAppPurchase');
}

/**
 * Native bridge calls this after config injected at document-start becomes
 * stale — e.g. StoreKit entitlement check resolves async, or a price loads
 * after the webview boots. Merges into window.__PARLANCE_CONFIG__ in place.
 */
window.__parlanceUpdateConfig = function (patch) {
  if (!patch) return;
  window.__PARLANCE_CONFIG__ = Object.assign({}, window.__PARLANCE_CONFIG__ || {}, patch);
  if ('isPlusActive' in patch) {
    plusActiveOverride = null; // defer back to the (now current) config value
    if (patch.isPlusActive) refreshPlusPaywallPrice();
    refreshPlusStatusPanel();
    refreshFeedbackMeter();
  }
  if ('plusMonthlyPriceDisplay' in patch) refreshPlusPaywallPrice();
  if ('plusPurchaseAvailable' in patch) refreshPlusPaywallPrice();
  if ('feedbackPackPriceDisplay' in patch || 'feedbackPackPurchaseAvailable' in patch
      || 'feedbackDebugTools' in patch) {
    refreshPlusPaywallPrice();
    refreshFeedbackMeter();
  }
  if ('parlanceCoachAvailable' in patch || 'parlanceCoachLanguages' in patch
      || 'parlanceCoachInstalling' in patch || 'coachOnly' in patch) {
    renderProviderGrid();
    applyDefaultProvider();
    updateWaitingCard();
    refreshCoachSettingsSummary();
  }
};

/**
 * Native bridge calls this right after it rewrites window.__PARLANCE_AUTH__.
 *
 * Firebase restores a persisted session from the keychain asynchronously, so
 * the auth injected at document-start says signed out on almost every launch
 * for a returning user. Without this the session lands silently: the provider
 * picked for a signed-out user (the on-device coach) sticks for the whole
 * session, and the settings UI keeps offering sign-in to someone already in.
 */
let lastKnownAuthUid = null;
window.__parlanceAuthChanged = function () {
  // iOS re-injects on every SwiftUI view update, not only on real transitions.
  const uid = window.__PARLANCE_AUTH__?.uid || '';
  if (uid === lastKnownAuthUid) return;
  lastKnownAuthUid = uid;
  try {
    reapplyDefaultProviderIfUnchosen();
    updateFirebaseAuthUI();
    updateModalForProvider(modalSelectedProvider);
    updateWaitingCard();
  } catch (err) {
    console.warn('[Parlance] auth refresh failed:', err);
  }
};

function parlanceAuthSignedIn() {
  return isFirebaseSignedIn();
}

function effectiveRequiresKey(providerId) {
  if (!isNativeParlanceApp() && isFirebaseSignedIn() && isCloudProvider(providerId)) return false;
  return AI_PROVIDERS[providerId]?.requiresKey ?? false;
}

function isCoachOnlyNative() {
  return isNativeParlanceApp();
}

function parlanceCoachAvailableForLanguage(language) {
  const cfg = window.__PARLANCE_CONFIG__ || {};
  const langs = cfg.parlanceCoachLanguages || (cfg.parlanceCoachAvailable ? ['es', 'fr', 'en'] : []);
  return langs.includes(language);
}

function parlanceCoachCoversLanguage(language) {
  return language === 'es' || language === 'fr' || language === 'en';
}

function parlanceCoachErrorKey(language) {
  if (!parlanceCoachCoversLanguage(language)) return 'errParlanceLang';
  const cfg = window.__PARLANCE_CONFIG__ || {};
  if (cfg.parlanceCoachInstalling) return 'errParlanceInstalling';
  if (isCoachOnlyNative()) return 'errParlanceNotInstalled';
  return 'errParlanceNotBundled';
}

function parlanceCoachWaitingKey(language) {
  if (!parlanceCoachCoversLanguage(language)) return 'waitingParlanceLang';
  const cfg = window.__PARLANCE_CONFIG__ || {};
  if (parlanceCoachAvailableForLanguage(language)) return 'waitingParlanceOnDevice';
  if (cfg.parlanceCoachInstalling) return 'waitingParlanceInstalling';
  if (isCoachOnlyNative()) return 'waitingParlanceNotInstalled';
  return 'waitingParlanceMissing';
}

/** The bundled coach can only stand in for a language whose weights shipped. */
function coachCanCoverLanguage(language) {
  return isNativeParlanceApp() && parlanceCoachAvailableForLanguage(language);
}

/**
 * Classifies a failed cloud call as something the on-device coach can cover.
 * A malformed sentence or a bad model name is not, and must stay an error.
 */
function cloudFallbackReason(error) {
  if (!navigator.onLine) return 'offline';
  const code = error?.code || '';
  const msg  = String(error?.message || '');
  if (code === 'functions/resource-exhausted' || /monthly free limit/i.test(msg)) {
    return 'quota';
  }
  if (code === 'functions/unauthenticated') return 'signedOut';
  if (code === 'functions/unavailable'
      || code === 'functions/deadline-exceeded'
      || /failed to fetch|network|timed out|timeout/i.test(msg)) {
    return 'offline';
  }
  return null;
}

/**
 * Runs the bundled coach in place of the cloud, and says so. The badge on the
 * feedback card has to name the model that actually answered — a 0.5B verdict
 * labelled "Groq" would earn trust the coach has not got.
 */
async function runCoachFallback(sentence, language, reason) {
  const ragMeta = buildRAGMeta(language, null, sentence, true);
  const raw = await callNativeParlanceSLM(sentence, language, ragMeta.context);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const result = normalizeResult(attachRAGMeta(parsed, ragMeta.topics), sentence, language);
  result._actualSource = AI_PROVIDERS.parlance.name;

  const toastKey = {
    offline:   'coachFallbackOffline',
    quota:     'coachFallbackQuota',
    signedOut: 'coachFallbackSignedOut',
  }[reason];
  if (toastKey) showToast(i18n.t(toastKey));
  if (reason === 'quota') refreshUsageDisplay();

  return result;
}

/** SLM storage id for journal language. English shares the Spanish 0.5B file. */
function parlanceModelIdForLanguage(lang) {
  return lang === 'fr' ? 'parlance-fr' : 'parlance-es';
}

/** On iOS with bundled coach, model follows journal language — not a manual dual picker. */
function parlanceCoachModelFollowsJournal() {
  const cfg = window.__PARLANCE_CONFIG__ || {};
  return cfg.parlanceCoachAvailable && isNativeParlanceApp();
}

function parlanceCoachDisplayName(lang) {
  return 'Parlance Coach';
}

/** Keep localStorage parlance model aligned with state.currentLanguage on native iOS. */
function syncParlanceModelToJournalLanguage() {
  if (!parlanceCoachModelFollowsJournal()) return null;
  const modelId = parlanceModelIdForLanguage(state.currentLanguage);
  if (getProviderModel('parlance') !== modelId) {
    setProviderModel('parlance', modelId);
  }
  return modelId;
}

function unloadNativeParlanceSLM() {
  if (!isNativeParlanceApp()) return;
  try {
    postToNative({ action: 'unloadParlanceSLM' });
  } catch (_) {}
}

function plusDomainUnlocked() {
  return !isNativeParlanceApp() || isPlusActive();
}

function buildRAGMeta(language, level, sentence, condensed = false) {
  if (typeof getRAGContextWithMeta === 'function') {
    return getRAGContextWithMeta(language, level, sentence, {
      condensed,
      includePlusDomains: plusDomainUnlocked(),
    });
  }
  const context = typeof getRAGContext === 'function'
    ? getRAGContext(language, level, sentence, { condensed }) : '';
  return { context, topics: [] };
}

function attachRAGMeta(result, topics) {
  if (!result) return result;
  if (topics?.length) result._rag_topics = topics;
  return result;
}

function detectWrittenLanguage(sentence) {
  const text = String(sentence || '');
  const padded = ` ${text.toLowerCase()} `;
  const count = (re) => (padded.match(re) || []).length;
  const es = count(/\b(hola|hoy|quiero|estoy|está|están|también|porque|pero|muy|una|unos|unas|los|las|del|voy|vamos|cine|película|gracias|señor|señora|usted|qué|más|buenos|días)\b/g)
    + (/[áéíóúñ¿¡]/i.test(text) ? 2 : 0);
  const fr = count(/\b(bonjour|aujourd|je|suis|veux|aussi|parce|mais|une|les|des|au|cinéma|merci|vous|madame|avec|pour)\b/g)
    + (/[àâçéèêëîïôùûüœæ]/i.test(text) ? 1 : 0);
  const en = count(/\b(hello|today|want|going|the|and|with|movie|thanks|please|this|that|would|because)\b/g);
  const ranked = [['es', es], ['fr', fr], ['en', en]].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] < 2 || ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

function resolveAnalysisLanguage(sentence, writeLang) {
  const write = parlanceLanguageInfo(writeLang).code;
  const detected = detectWrittenLanguage(sentence);
  if (detected && detected !== write) {
    return { language: detected, mismatch: { write, detected } };
  }
  return { language: write, mismatch: null };
}

function applyWriteMismatchWarning(result, mismatch) {
  if (!result || !mismatch) return result;
  if (!result._coach_warning) {
    result._coach_warning = i18n.t('coachWriteMismatch', {
      detected: parlanceLanguageInfo(mismatch.detected).name,
      write: parlanceLanguageInfo(mismatch.write).name,
    });
  }
  return result;
}

function callNativeParlanceSLM(sentence, language, ragContext = '') {
  return new Promise((resolve, reject) => {
    const requestId = 'slm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timeoutId = setTimeout(() => {
      reject(new Error(parlanceTimeoutMessage(true)));
    }, TIMEOUT_MS.parlanceNative);
    window.__parlanceSLMResult = (id, result, err) => {
      if (id !== requestId) return;
      clearTimeout(timeoutId);
      delete window.__parlanceSLMResult;
      if (err) reject(new Error(err));
      else resolve(JSON.stringify(result));
    };
    postToNative({
      action: 'analyzeParlanceSLM',
      requestId,
      sentence,
      language,
      ragContext,
    });
  });
}

function parlanceTimeoutMessage(nativeOnDevice) {
  if (nativeOnDevice) {
    return i18n.t('errParlanceStillWorking');
  }
  return i18n.t('errParlanceTimeout');
}

function analysisTimeoutMs(providerId) {
  if (providerId === 'parlance') {
    return isNativeParlanceApp() ? TIMEOUT_MS.parlanceNative : TIMEOUT_MS.parlanceServer;
  }
  if (providerId === 'webllm') return TIMEOUT_MS.webllm;
  return TIMEOUT_MS.cloud;
}

function analysisTimeoutMessage(providerId) {
  if (providerId === 'parlance') {
    return parlanceTimeoutMessage(isNativeParlanceApp());
  }
  const provider = AI_PROVIDERS[providerId];
  return i18n.t('errProviderTimeout', { name: provider?.name || 'AI' });
}

async function checkParlanceSLMServer() {
  try {
    const base = PARLANCE_SLM_URL.replace(/\/$/, '');
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => ({}));
    return data.spanish_ready === true || data.french_ready === true;
  } catch (_) {
    return false;
  }
}

// ── API CALL: WebLLM (local) ─────────────────────────────────────
async function callWebLLM(engine, systemPrompt, userMessage) {
  const reply = await engine.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1024,
  });
  return reply.choices?.[0]?.message?.content ?? '';
}

// ── JSON PARSE & NORMALIZE ────────────────────────────────────────
function parseAIContent(raw) {
  const cleaned = (raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('No JSON object found in response');

  let jsonStr = repairUnescapedJsonQuotes(cleaned.slice(start));
  jsonStr = closeTruncatedJson(jsonStr)
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
  try {
    return JSON.parse(jsonStr);
  } catch (err) {
    const extracted = extractFeedbackFields(jsonStr);
    if (extracted && (extracted.status || extracted.explanation || extracted.grammar_rule)) {
      return extracted;
    }
    throw err;
  }
}

/** Escape a " that sits inside a value, not the key/value delimiter. */
function repairUnescapedJsonQuotes(json) {
  let out = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      continue;
    }
    if (escape) {
      out += ch;
      escape = false;
      continue;
    }
    if (ch === '\\') {
      out += ch;
      escape = true;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      const next = json[j] || '';
      if (next === ':' || next === ',' || next === '}' || next === ']' || next === '') {
        out += ch;
        inString = false;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

function closeTruncatedJson(slice) {
  let inString = false;
  let escape = false;
  let brace = 0;
  let end = -1;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') brace++;
    else if (ch === '}') {
      brace--;
      if (brace === 0) {
        end = i;
        break;
      }
    }
  }
  let out = end >= 0 ? slice.slice(0, end + 1) : slice;
  if (end < 0) {
    if (inString) out += '"';
    out = out.replace(/,\s*$/, '');
    while (brace > 0) {
      out += '}';
      brace--;
    }
  }
  return out;
}

function extractFeedbackFields(json) {
  const keys = [
    'assessed_level', 'complexity_note', 'status', 'grammar_rule',
    'explanation', 'correction', 'register', 'next_level_alt',
    'target_level_alt', 'tip',
  ];
  const out = {};
  for (const key of keys) {
    const needle = `"${key}"`;
    const keyAt = json.indexOf(needle);
    if (keyAt < 0) continue;
    const colon = json.indexOf(':', keyAt + needle.length);
    if (colon < 0) continue;
    let i = colon + 1;
    while (i < json.length && /\s/.test(json[i])) i++;
    if (json.startsWith('null', i) || json[i] !== '"') continue;
    let escape = false;
    let close = -1;
    for (let j = i + 1; j < json.length; j++) {
      if (escape) { escape = false; continue; }
      if (json[j] === '\\') { escape = true; continue; }
      if (json[j] === '"') { close = j; break; }
    }
    if (close < 0) continue;
    out[key] = json.slice(i + 1, close).replace(/\\"/g, '"').replace(/\\n/g, '\n');
  }
  return out;
}

function normalizeResult(raw, sentence = '', language = 'es') {
  const result = {};
  const assessed = extractAssessedLevel(raw);
  if (assessed) result.assessed_level = assessed;
  const complexity = extractComplexityNote(raw);
  if (complexity) result.complexity_note = complexity;
  result.status      = (raw.status === 'Excellent' || raw.status === 'Needs Improvement')
    ? raw.status : 'Excellent';
  result.grammar_rule = raw.grammar_rule || raw.grammarRule || '';
  result.explanation  = raw.explanation  || '';
  if (raw.correction)       result.correction      = raw.correction;
  if (raw.register)         result.register        = raw.register;
  if (raw.next_level_alt)   result.next_level_alt  = raw.next_level_alt;
  if (raw.target_level_alt) result.target_level_alt = raw.target_level_alt;
  if (raw.tip)              result.tip             = raw.tip;
  if (raw._coach_warning)   result._coach_warning  = raw._coach_warning;
  if (raw._coach_repaired)  result._coach_repaired = raw._coach_repaired;
  if (raw._rag_topics)      result._rag_topics     = raw._rag_topics;
  return sentence ? sanitizeFeedbackResult(sentence, result, language) : result;
}

// ── UNIFIED ANALYSIS ─────────────────────────────────────────────
// Called by analyzeSentence() — routes to the selected provider
async function analyzeWithAI(sentence, language, progressCallback) {
  const resolved = resolveAnalysisLanguage(sentence, language);
  language = resolved.language;
  const mismatch = resolved.mismatch;

  // Check offline cache first
  try {
    const cacheKey = 'parlance_analysis_cache';
    const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
    const hash = analysisCacheHash(sentence, language);
    if (cache[hash]) {
      return applyWriteMismatchWarning({
        ...sanitizeFeedbackResult(sentence, cache[hash].feedback, language),
        _cachedSource: (cache[hash].source || 'cached') + ' (cached)',
      }, mismatch);
    }
  } catch (_) {}

  const providerId = getSelectedProvider();
  const provider   = AI_PROVIDERS[providerId];
  if (!provider) throw new Error('Unknown AI provider');

  if (shouldUseFirebaseCloud(providerId)) {
    if (!navigator.onLine && coachCanCoverLanguage(language)) {
      return applyWriteMismatchWarning(await runCoachFallback(sentence, language, 'offline'), mismatch);
    }
    try {
      const ragMeta = buildRAGMeta(language, null, sentence, false);
      const timeoutMs = analysisTimeoutMs(providerId);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(analysisTimeoutMessage(providerId))), timeoutMs)
      );
      let result = await Promise.race([
        callFirebaseCloudAnalyze(sentence, language, providerId),
        timeoutPromise,
      ]);
      if (ragMeta.topics.length) attachRAGMeta(result, ragMeta.topics);
      result = applyWriteMismatchWarning(
        sanitizeFeedbackResult(sentence, result, language),
        mismatch
      );
      try {
        const cacheKey = 'parlance_analysis_cache';
        const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
        const hash = analysisCacheHash(sentence, language);
        cache[hash] = { feedback: result, source: `${provider.name} (account)`, ts: Date.now() };
        const keys = Object.keys(cache);
        if (keys.length > 200) {
          const sorted = keys.sort((a, b) => cache[a].ts - cache[b].ts);
          sorted.slice(0, keys.length - 200).forEach(k => delete cache[k]);
        }
        localStorage.setItem(cacheKey, JSON.stringify(cache));
      } catch (_) {}
      return result;
    } catch (err) {
      const reason = cloudFallbackReason(err);
      if (!reason || !coachCanCoverLanguage(language)) throw err;
      return applyWriteMismatchWarning(await runCoachFallback(sentence, language, reason), mismatch);
    }
  }

  // A cloud provider with no account and no key cannot run at all. The coach is
  // a worse answer than the cloud, but it is a far better one than an error.
  if (isCloudProvider(providerId)
      && !isFirebaseSignedIn()
      && !getProviderKey(providerId)
      && coachCanCoverLanguage(language)) {
    return applyWriteMismatchWarning(await runCoachFallback(sentence, language, 'signedOut'), mismatch);
  }

  const ragMeta     = buildRAGMeta(language, null, sentence, providerId === 'parlance');
  const ragContext  = ragMeta.context;
  const langName    = parlanceLanguageInfo(language).coachRole;
  const systemPrompt = buildSystemPrompt(language, ragContext);
  const userMessage  = `Analyze this ${langName} sentence: "${sentence}"`;

  const timeoutMs = analysisTimeoutMs(providerId);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(analysisTimeoutMessage(providerId))), timeoutMs)
  );

  const analysisPromise = (async () => {
    let rawContent;

    if (providerId === 'parlance') {
      if (isNativeParlanceApp() && !parlanceCoachAvailableForLanguage(language)) {
        throw new Error(i18n.t(parlanceCoachErrorKey(language)));
      }
      if (isNativeParlanceApp()) {
        const nativeRaw = await callNativeParlanceSLM(sentence, language, ragContext);
        // iOS pre-validates via ParlanceSLMFeedbackValidator. Android repairs
        // almost-JSON from the 0.5B coach, then this path normalizes.
        let nativeParsed;
        try {
          nativeParsed = typeof nativeRaw === 'string' ? JSON.parse(nativeRaw) : nativeRaw;
        } catch (_) {
          nativeParsed = parseAIContent(String(nativeRaw || ''));
        }
        return normalizeResult(
          attachRAGMeta(nativeParsed, ragMeta.topics),
          sentence,
          language
        );
      }
      rawContent = await callParlanceSLM(sentence, language, ragContext);

    } else if (providerId === 'webllm') {
      if (!navigator.gpu) {
        throw new Error(i18n.t('errWebgpuBrowser'));
      }
      const modelId = getProviderModel('webllm');
      const engine  = await ensureWebLLM(modelId, progressCallback);
      rawContent    = await callWebLLM(engine, systemPrompt, userMessage);

    } else if (providerId === 'anthropic') {
      const key   = getProviderKey('anthropic');
      if (effectiveRequiresKey('anthropic') && !key) {
        throw new Error(i18n.t('errNoApiKey', { name: 'Anthropic' }));
      }
      rawContent  = await callAnthropic(getProviderModel('anthropic'), key, systemPrompt, userMessage);

    } else if (providerId === 'gemini') {
      const key   = getProviderKey('gemini');
      if (effectiveRequiresKey('gemini') && !key) {
        throw new Error(i18n.t('errNoApiKey', { name: 'Gemini' }));
      }
      rawContent  = await callGemini(getProviderModel('gemini'), key, systemPrompt, userMessage);

    } else {
      // OpenAI-compatible: groq, openai, kimi, deepseek, openrouter
      const key   = getProviderKey(providerId);
      if (effectiveRequiresKey(providerId) && !key) {
        throw new Error(i18n.t('errNoApiKey', { name: provider.name }));
      }
      rawContent  = await callOpenAIFormat(
        provider.endpoint, getProviderModel(providerId), key, systemPrompt, userMessage
      );
    }

    return rawContent;
  })();

  const analysisResult = await Promise.race([analysisPromise, timeoutPromise]);
  let result = (typeof analysisResult === 'object' && analysisResult?.status)
    ? sanitizeFeedbackResult(sentence, analysisResult, language)
    : normalizeResult(parseAIContent(analysisResult), sentence, language);
  if (ragMeta.topics.length) attachRAGMeta(result, ragMeta.topics);
  result = applyWriteMismatchWarning(
    sanitizeFeedbackResult(sentence, result, language),
    mismatch
  );

  // Cache the analysis result in localStorage
  try {
    const cacheKey = 'parlance_analysis_cache';
    const cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
    const hash = analysisCacheHash(sentence, language);
    cache[hash] = { feedback: result, source: AI_PROVIDERS[providerId]?.name || providerId, ts: Date.now() };
    // Keep cache to 200 entries max
    const keys = Object.keys(cache);
    if (keys.length > 200) {
      const sorted = keys.sort((a, b) => cache[a].ts - cache[b].ts);
      sorted.slice(0, keys.length - 200).forEach(k => delete cache[k]);
    }
    localStorage.setItem(cacheKey, JSON.stringify(cache));
  } catch (_) {}

  return result;
}

// ── UI LANGUAGE (i18n) ───────────────────────────────────────────
// Locale data lives in locales/*.json — loaded by i18n.js module.
// HTML elements use data-i18n attributes for declarative binding.
// To add a language: create locales/xx.json and add an <option> to #uiLangSelect.

function updateDateBadge() {
  const locale = (typeof i18n !== 'undefined' && i18n.getLocale) ? i18n.getLocale() : 'en';
  const localeTag = locale === 'es' ? 'es' : locale === 'fr' ? 'fr' : 'en-US';
  document.getElementById('dateBadge').textContent = new Date()
    .toLocaleDateString(localeTag, { month: 'short', day: 'numeric', year: 'numeric' });
}

function refreshOpenGuideLanguage() {
  const overlay = document.getElementById('guideOverlay');
  const frame = document.getElementById('guideFrame');
  if (!overlay || overlay.style.display === 'none' || !frame?.src) return;
  const ui = document.getElementById('uiLangSelect')?.value
    || ((typeof i18n !== 'undefined' && i18n.getLocale) ? i18n.getLocale() : 'en');
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  try {
    frame.contentWindow?.postMessage({ type: 'parlanceGuideEnv', ui, theme }, '*');
    if (typeof frame.contentWindow?.applyGuideEnv === 'function') {
      frame.contentWindow.applyGuideEnv(ui, theme);
    }
  } catch (_) { /* ignore */ }
}

/** Refresh every dynamic UI surface that locales don't cover via data-i18n. */
function refreshDynamicI18nUI() {
  if (!document.getElementById('uiLangSelect')) return;
  updateCounts();
  renderPrompts();
  updateDateBadge();
  updateWaitingCard();
  document.querySelectorAll('.analyze-btn').forEach(btn => {
    btn.textContent = i18n.t('getFeedback');
  });
  document.querySelectorAll('.jump-feedback-btn').forEach(btn => {
    btn.textContent = i18n.t('viewFeedback');
  });
  document.querySelectorAll('.sentence-input').forEach(ta => {
    const hint = i18n.t('analyzeHint');
    if (hint && hint !== 'analyzeHint') ta.title = hint;
  });
  const loadAll = document.getElementById('loadAllToEditorBtn');
  if (loadAll) loadAll.textContent = i18n.t('loadAllToEditor');
  refreshOpenGuideLanguage();
  applyPlusStoreCopy();
  refreshPlusPaywallPrice();
  refreshPlusStatusPanel();
  refreshFeedbackMeter();
  applyCoachOnlySettingsChrome();
  updateLangSummary();
  updateEntryPager();
  if (typeof state !== 'undefined' && state.activeSentenceId) showFeedback(state.activeSentenceId);
  if (typeof state !== 'undefined' && state.viewingEntryIndex >= 0 && state.savedEntries[state.viewingEntryIndex]) {
    fillEntryPage(state.savedEntries[state.viewingEntryIndex]);
  }
  requestAnimationFrame(syncHeaderOffset);
}

function onUILangChange() {
  const lang = document.getElementById('uiLangSelect').value;
  // Explicit choice on this selector — stop auto-following the Write
  // language from here on, even if it changes later.
  try { localStorage.setItem('parlance_ui_lang_manual', '1'); } catch (_) {}
  i18n.load(lang);
  updateLangSummary();
  closeLangControls();
}

/** Phone header collapses the App/Write selects behind a single summary
 *  button (e.g. "EN · ES") instead of shrinking both permanently — see
 *  .lang-summary-btn / .header-langs ≤768px rules in styles.css. */
function updateLangSummary() {
  const summary = document.getElementById('langSummaryText');
  const uiSelect = document.getElementById('uiLangSelect');
  const writeSelect = document.getElementById('langSelect');
  if (!summary || !uiSelect || !writeSelect) return;
  const app = uiSelect.value.toUpperCase();
  const write = writeSelect.value.toUpperCase();
  summary.textContent = `${app} · ${write}`;
  refreshLangChips();
  const btn = document.getElementById('langSummaryBtn');
  if (btn && typeof i18n !== 'undefined' && i18n.t) {
    const title = i18n.t('langSummaryTitle', { app, write });
    btn.title = title;
    btn.setAttribute('aria-label', title);
  }
}

function toggleLangControls() {
  const btn = document.getElementById('langSummaryBtn');
  const controls = document.getElementById('headerLangs');
  if (!btn || !controls) return;
  const isOpen = controls.classList.contains('expanded');
  if (isOpen) closeLangControls();
  else {
    controls.classList.add('expanded');
    btn.setAttribute('aria-expanded', 'true');
  }
}

function setUiLangFromChip(lang) {
  const sel = document.getElementById('uiLangSelect');
  if (!sel || sel.value === lang) return;
  sel.value = lang;
  onUILangChange();
}

function setWriteLangFromChip(lang) {
  const sel = document.getElementById('langSelect');
  if (!sel || sel.value === lang) return;
  sel.value = lang;
  onLanguageChange();
}

function refreshLangChips() {
  const ui = document.getElementById('uiLangSelect')?.value;
  const write = document.getElementById('langSelect')?.value;
  document.querySelectorAll('#uiLangChips .lang-chip').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.lang === ui);
  });
  document.querySelectorAll('#writeLangChips .lang-chip').forEach((btn) => {
    btn.classList.toggle('selected', btn.dataset.lang === write);
  });
}

function closeLangControls() {
  const btn = document.getElementById('langSummaryBtn');
  const controls = document.getElementById('headerLangs');
  if (!btn || !controls) return;
  controls.classList.remove('expanded');
  btn.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  const controls = document.getElementById('headerLangs');
  const btn = document.getElementById('langSummaryBtn');
  if (!controls || !controls.classList.contains('expanded')) return;
  if (controls.contains(e.target) || (btn && btn.contains(e.target))) return;
  closeLangControls();
});

/** Keep the App language following the Write language until the user has
 *  explicitly overridden the App selector themselves (see onUILangChange). */
function syncUiLanguageToWriteLanguage() {
  try {
    if (localStorage.getItem('parlance_ui_lang_manual') === '1') return;
  } catch (_) {}
  const lang = state.currentLanguage;
  if (!['en', 'es', 'fr'].includes(lang)) return;
  const uiSelect = document.getElementById('uiLangSelect');
  if (uiSelect) uiSelect.value = lang;
  if (typeof i18n !== 'undefined' && i18n.getLocale && i18n.load && i18n.getLocale() !== lang) {
    i18n.load(lang);
  }
}

if (typeof i18n !== 'undefined' && i18n.onChange) {
  i18n.onChange(refreshDynamicI18nUI);
}

// ── DARK MODE ────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('parlance_theme');
  if (saved === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
  updateThemeIcon();
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('parlance_theme', 'light');
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem('parlance_theme', 'dark');
  }
  updateThemeIcon();
  const guideFrame = document.getElementById('guideFrame');
  if (guideFrame?.contentDocument?.body) {
    guideFrame.contentDocument.body.classList.toggle('dark', !isDark);
  }
}

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.textContent = isDark ? '☾' : '☀';
}

// ── LANGUAGE DEFINITIONS ──────────────────────────────────────────
// Single source of truth lives in languages.js (PARLANCE_LANGUAGES) — loaded before
// this file. Keep the `languages` name here since it's used throughout this file.
const languages = PARLANCE_LANGUAGES;

// ── STATE ─────────────────────────────────────────────────────────
const state = {
  sentences: [],
  activeSentenceId: null,
  analyzingSentenceIds: new Set(),
  savedEntries: [],
  viewingEntryIndex: -1,
  isOnline: navigator.onLine,
  currentLanguage: 'es',
};

// ── AI SETTINGS UI ────────────────────────────────────────────────
let modalSelectedProvider = 'webllm';

function openAISettings() {
  if (nativeSupports('nativeSettings')) {
    postToNative('showAISettings');
    return;
  }
  syncParlanceModelToJournalLanguage();
  modalSelectedProvider = getSelectedProvider();
  renderProviderGrid();
  updateFirebaseAuthUI();
  refreshPlusStatusPanel();
  updateModalForProvider(modalSelectedProvider);
  applyCoachOnlySettingsChrome();
  document.getElementById('aiSettingsOverlay').style.display = 'flex';
}

function applyCoachOnlySettingsChrome() {
  const coachOnly = isCoachOnlyNative();
  const hide = (id) => {
    const el = document.getElementById(id);
    if (el) el.style.display = coachOnly ? 'none' : '';
  };
  hide('providerSection');
  hide('apiKeySection');
  hide('modelSection');
  hide('corsWarning');
  const card = document.querySelector('.ai-settings-card');
  if (card) card.classList.toggle('is-coach-only', coachOnly);
  const coachModel = document.getElementById('coachModelSection');
  const coachAbout = document.getElementById('coachAboutSection');
  if (coachModel) coachModel.hidden = !coachOnly;
  if (coachAbout) coachAbout.hidden = !coachOnly;
  const heading = document.getElementById('aiSettingsHeading');
  if (heading) heading.textContent = i18n.t(coachOnly ? 'aiSettingsTitle' : 'aiProviderTitle');
  const saveBtn = document.getElementById('aiSettingsSaveBtn');
  if (saveBtn) saveBtn.textContent = i18n.t(coachOnly ? 'settingsDone' : 'saveAndClose');
  refreshCoachSettingsSummary();
}

function refreshCoachSettingsSummary() {
  const el = document.getElementById('coachLanguageSummary');
  if (!el) return;
  const langs = (window.__PARLANCE_CONFIG__ || {}).parlanceCoachLanguages || [];
  const keys = { en: 'langNameEn', es: 'langNameEs', fr: 'langNameFr' };
  if (!langs.length) {
    el.textContent = i18n.t('coachLanguagesInstalling');
    return;
  }
  el.textContent = langs.map((code) => i18n.t(keys[code] || 'langNameEn')).join(' · ');
}

/** Called by a native host after its own AI Settings sheet closes. */
function applyNativeAISettings(providerId, model) {
  if (providerId && AI_PROVIDERS[providerId]) {
    setSelectedProvider(providerId);
    markProviderChosenByUser();
    if (model) setProviderModel(providerId, model);
  }
  updateFirebaseAuthUI();
  updateWaitingCard();
}

function callNativeAuth(action) {
  return new Promise((resolve, reject) => {
    if (!isNativeParlanceApp()) {
      reject(new Error('Not in native app'));
      return;
    }
    const requestId = 'auth_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    const timeoutId = setTimeout(() => {
      delete window.__parlanceAuthResult;
      reject(new Error(i18n.t('errSignInTimeout')));
    }, 120000);
    window.__parlanceAuthResult = (id, err) => {
      if (id !== requestId) return;
      clearTimeout(timeoutId);
      delete window.__parlanceAuthResult;
      if (err) reject(new Error(err));
      else resolve();
    };
    postToNative({ action, requestId });
  });
}

function closeAISettings() {
  document.getElementById('aiSettingsOverlay').style.display = 'none';
}

// ── Call pack purchase ────────────────────────────────────────────────────────

function triggerCallPackPurchase() {
  if (!nativeSupportsPurchases()) {
    showErrorInPanel(i18n.t('errMonthlyLimit'));
    return;
  }
  const requestId = 'purchase_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__parlancePurchaseResult = (id, data, err) => {
    if (id !== requestId) return;
    delete window.__parlancePurchaseResult;
    if (err === 'cancelled') {
      showToast(i18n.t('purchaseCancelled'));
      return;
    }
    if (err) {
      // Same fix as the Plus paywall: this can fire while AI Settings (a modal) is
      // open, so a panel-only message would be invisible — toast it too.
      showToast(i18n.t('errPurchaseFailed', { err }), 'error');
      showErrorInPanel(i18n.t('errPurchaseFailed', { err }));
      return;
    }
    refreshUsageDisplay();
    showToast(i18n.t('callPackAdded'), 'success');
  };
  postToNative({ action: 'purchaseCallPack', requestId });
}

// ── Parlance Plus subscription (gates medical/legal guides) ──────────────────

// Session-level override so a successful purchase/restore unlocks immediately
// without waiting for the native config bridge to be re-injected.
let plusActiveOverride = null;
let pendingPlusGuideKind = null;
let pendingFeedbackAnalyzeId = null;
let paywallReason = 'quota';

function debugIgnorePlus() {
  if (!feedbackDebugToolsEnabled()) return false;
  try { return localStorage.getItem(LS_DEBUG_IGNORE_PLUS) === '1'; } catch (_) { return false; }
}

function setDebugIgnorePlus(on) {
  try { localStorage.setItem(LS_DEBUG_IGNORE_PLUS, on ? '1' : '0'); } catch (_) {}
  plusActiveOverride = on ? false : null;
  refreshPlusStatusPanel();
  refreshFeedbackMeter();
}

function toggleDebugIgnorePlus() {
  setDebugIgnorePlus(!debugIgnorePlus());
}

function isPlusActive() {
  if (debugIgnorePlus()) return false;
  if (plusActiveOverride !== null) return plusActiveOverride;
  const cfg = window.__PARLANCE_CONFIG__ || {};
  return !!cfg.isPlusActive;
}

const APPLE_STANDARD_EULA_URL =
  'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/';
const PLAY_TERMS_URL = 'https://play.google.com/about/play-terms/';

function isPlayStoreApp() {
  return (window.__PARLANCE_CONFIG__ || {}).platform === 'android';
}

/** Opens a legal page outside the app. The webview has no navigation delegate,
 *  so a plain link would replace the journal instead of leaving the app. */
function openTermsOfUse() {
  const url = isPlayStoreApp() ? PLAY_TERMS_URL : APPLE_STANDARD_EULA_URL;
  if (postToNative({ action: 'openURL', url })) {
    return;
  }
  window.open(url, '_blank', 'noopener');
}

function applyPlusStoreCopy() {
  const play = isPlayStoreApp();
  if (typeof i18n === 'undefined') return;
  const termsKey = play ? 'plusPaywallTermsPlay' : 'plusPaywallTerms';
  const unavailableKey = play ? 'plusPaywallUnavailablePlay' : 'plusPaywallUnavailable';
  ['plusPaywallTerms', 'plusStatusTerms'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = i18n.t(termsKey);
  });
  ['plusPaywallUnavailable', 'plusStatusUnavailable'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = i18n.t(unavailableKey);
  });
  ['plusPaywallLength', 'plusStatusLength'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = i18n.t('plusPaywallLength');
  });
}

function showPlusPaywall(kind) {
  const isGuide = kind === 'medical' || kind === 'legal';
  pendingPlusGuideKind = isGuide ? kind : null;
  paywallReason = isGuide ? 'guide' : 'quota';
  const overlay = document.getElementById('plusPaywallOverlay');
  if (!overlay) return;
  const subscribeBtn = document.getElementById('plusPaywallSubscribeBtn');
  if (subscribeBtn) subscribeBtn.style.display = nativeSupportsPurchases() ? '' : 'none';
  const desc = document.getElementById('plusPaywallDesc');
  if (desc && typeof i18n !== 'undefined') {
    desc.textContent = i18n.t(paywallReason === 'quota' ? 'plusPaywallDescQuota' : 'plusPaywallDesc');
  }
  const packBtn = document.getElementById('plusPaywallPackBtn');
  if (packBtn) {
    packBtn.style.display = (paywallReason === 'quota' && nativeSupportsPurchases()) ? '' : 'none';
  }
  applyPlusStoreCopy();
  overlay.style.display = 'flex';
  refreshPlusPaywallPrice();
}

function refreshPlusStatusPanel() {
  const list = document.getElementById('plusStatusList');
  const lead = document.getElementById('plusStatusLead');
  const actions = document.getElementById('plusStatusActions');
  const details = document.getElementById('plusStatusDetails');
  const toggle = document.getElementById('plusStatusToggle');
  const active = isPlusActive();
  if (list) list.classList.toggle('is-active', active);
  if (lead) lead.textContent = i18n.t(active ? 'plusStatusLeadActive' : 'plusStatusLeadLocked');
  const mark = i18n.t(active ? 'plusStatusIncluded' : 'plusStatusLocked');
  document.querySelectorAll('[data-plus-mark]').forEach((el) => { el.textContent = mark; });
  if (active) {
    if (details) details.hidden = false;
    if (toggle) toggle.hidden = true;
  } else {
    if (details && !details.dataset.opened) details.hidden = true;
    if (toggle) {
      toggle.hidden = false;
      const open = details && !details.hidden;
      toggle.textContent = i18n.t(open ? 'plusStatusHideFeatures' : 'plusStatusSeeFeatures');
    }
  }
  if (actions) {
    actions.style.display = (!active && nativeSupportsPurchases()) ? 'flex' : 'none';
  }
  const packBtn = document.getElementById('plusStatusPackBtn');
  if (packBtn) packBtn.style.display = (!active && nativeSupportsPurchases()) ? '' : 'none';
  if (!active) refreshPlusPaywallPrice();
}

function togglePlusStatusDetails() {
  const details = document.getElementById('plusStatusDetails');
  if (!details || isPlusActive()) return;
  const open = details.hidden;
  details.hidden = !open;
  if (open) details.dataset.opened = '1';
  else delete details.dataset.opened;
  refreshPlusStatusPanel();
}

function closePlusPaywall() {
  pendingPlusGuideKind = null;
  pendingFeedbackAnalyzeId = null;
  const overlay = document.getElementById('plusPaywallOverlay');
  if (overlay) overlay.style.display = 'none';
}

function refreshPlusPaywallPrice() {
  const cfg = window.__PARLANCE_CONFIG__ || {};
  const priceLabel = cfg.plusMonthlyPriceDisplay
    ? i18n.t('plusPaywallPriceMonthly', { price: cfg.plusMonthlyPriceDisplay })
    : i18n.t('plusPaywallPrice');
  ['plusPaywallPrice', 'plusStatusPrice'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.textContent = priceLabel;
  });

  // Don't offer a Subscribe button that can only fail: StoreKit hasn't
  // returned the product, so a tap would surface a raw store error.
  const subscribeBtns = ['plusPaywallSubscribeBtn', 'plusStatusSubscribeBtn']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  const unavailableEls = ['plusPaywallUnavailable', 'plusStatusUnavailable']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!nativeSupportsPurchases()) {
    unavailableEls.forEach((el) => { el.style.display = 'none'; });
    return;
  }
  const available = cfg.plusPurchaseAvailable !== false;
  subscribeBtns.forEach((btn) => { btn.disabled = !available; });
  unavailableEls.forEach((el) => { el.style.display = available ? 'none' : ''; });
  applyPlusStoreCopy();
  applyFeedbackPackButtonCopy();
}

function triggerPlusPurchase() {
  if (!nativeSupportsPurchases()) {
    showToast(i18n.t('plusPaywallWebNotAvailable'));
    return;
  }
  const requestId = 'purchasePlus_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__parlancePlusPurchaseResult = (id, data, err) => {
    if (id !== requestId) return;
    delete window.__parlancePlusPurchaseResult;
    if (err === 'cancelled') {
      showToast(i18n.t('purchaseCancelled'));
      return;
    }
    if (err) {
      // showErrorInPanel writes behind the paywall modal (still open here), so it's
      // invisible until the user closes the modal — surface it as a toast instead,
      // which renders above modals, and keep the panel copy for later reference.
      showToast(i18n.t('errPlusPurchaseFailed', { err }), 'error');
      showErrorInPanel(i18n.t('errPlusPurchaseFailed', { err }));
      return;
    }
    plusActiveOverride = true;
    showToast(i18n.t('plusSubscribed'), 'success');
    finishPaidUnlock();
  };
  postToNative({ action: 'purchasePlus', requestId });
}

function triggerPlusRestore() {
  if (!nativeSupportsPurchases()) {
    showToast(i18n.t('plusPaywallWebNotAvailable'));
    return;
  }
  const requestId = 'restorePlus_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__parlancePlusRestoreResult = (id, data, err) => {
    if (id !== requestId) return;
    delete window.__parlancePlusRestoreResult;
    if (err) {
      showToast(i18n.t('errPlusPurchaseFailed', { err }), 'error');
      showErrorInPanel(i18n.t('errPlusPurchaseFailed', { err }));
      return;
    }
    if (data && data.restored) {
      plusActiveOverride = true;
      showToast(i18n.t('plusRestored'), 'success');
      finishPaidUnlock();
    } else {
      showToast(i18n.t('plusNoneToRestore'));
    }
  };
  postToNative({ action: 'restorePlus', requestId });
}

const FREE_FEEDBACK_LIMIT = 15;
const FEEDBACK_PACK_SIZE = 15;
const LS_FEEDBACK_USED = 'parlance_feedback_used';
const LS_FEEDBACK_PACK = 'parlance_feedback_pack';
const LS_FEEDBACK_DEBUG = 'parlance_feedback_debug';
const LS_DEBUG_IGNORE_PLUS = 'parlance_debug_ignore_plus';
const LS_CREDITED_PACK_TX = 'parlance_credited_pack_tx';

function feedbackQuotaApplies() {
  return isNativeParlanceApp();
}

function feedbackDebugToolsEnabled() {
  // Release / TestFlight / App Store / GitHub Pages must never show the Testing
  // row. Only native Debug (or Android debuggable) sets feedbackDebugTools.
  // Do not unlock via localStorage — that stuck on devices after Debug testing
  // and would ship into App Review screenshots.
  const cfg = window.__PARLANCE_CONFIG__ || {};
  if (cfg.feedbackDebugTools === true) return true;
  try { localStorage.removeItem(LS_FEEDBACK_DEBUG); } catch (_) {}
  return false;
}

function readFeedbackInt(key) {
  try {
    const n = parseInt(localStorage.getItem(key) || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch (_) {
    return 0;
  }
}

function writeFeedbackInt(key, n) {
  try { localStorage.setItem(key, String(Math.max(0, n | 0))); } catch (_) {}
}

function feedbackUsedCount() {
  return readFeedbackInt(LS_FEEDBACK_USED);
}

function feedbackPackRemaining() {
  return readFeedbackInt(LS_FEEDBACK_PACK);
}

function feedbackFreeRemaining() {
  return Math.max(0, FREE_FEEDBACK_LIMIT - feedbackUsedCount());
}

function feedbackRemaining() {
  return feedbackFreeRemaining() + feedbackPackRemaining();
}

function canAnalyzeFeedback() {
  if (!feedbackQuotaApplies()) return true;
  if (isPlusActive()) return true;
  return feedbackRemaining() > 0;
}

function consumeFeedbackCredit() {
  if (!feedbackQuotaApplies() || isPlusActive()) return;
  const used = feedbackUsedCount();
  if (used < FREE_FEEDBACK_LIMIT) writeFeedbackInt(LS_FEEDBACK_USED, used + 1);
  else writeFeedbackInt(LS_FEEDBACK_PACK, Math.max(0, feedbackPackRemaining() - 1));
  refreshFeedbackMeter();
}

function grantFeedbackPack(n) {
  const add = Number.isFinite(n) ? n : FEEDBACK_PACK_SIZE;
  writeFeedbackInt(LS_FEEDBACK_PACK, feedbackPackRemaining() + add);
  refreshFeedbackMeter();
}

function alreadyCreditedPackTx(transactionId) {
  if (!transactionId) return false;
  try {
    const credited = JSON.parse(localStorage.getItem(LS_CREDITED_PACK_TX) || '[]');
    return Array.isArray(credited) && credited.includes(String(transactionId));
  } catch (_) {
    return false;
  }
}

function rememberCreditedPackTx(transactionId) {
  if (!transactionId) return;
  try {
    const credited = JSON.parse(localStorage.getItem(LS_CREDITED_PACK_TX) || '[]');
    const next = Array.isArray(credited) ? credited : [];
    next.push(String(transactionId));
    localStorage.setItem(LS_CREDITED_PACK_TX, JSON.stringify(next.slice(-50)));
  } catch (_) {}
}

/** Credits 15 after a real store purchase. Same transaction id never credits twice. */
function creditPaidFeedbackPack(transactionId) {
  if (alreadyCreditedPackTx(transactionId)) return false;
  rememberCreditedPackTx(transactionId);
  grantFeedbackPack(FEEDBACK_PACK_SIZE);
  return true;
}

window.__parlanceCreditFeedbackPack = function (transactionId) {
  if (!creditPaidFeedbackPack(transactionId)) return;
  showToast(i18n.t('feedbackPackAdded'), 'success');
  finishPaidUnlock();
};

function setFeedbackRemainingForDebug(remaining) {
  setDebugIgnorePlus(true);
  const n = Math.max(0, remaining | 0);
  if (n >= FREE_FEEDBACK_LIMIT) {
    writeFeedbackInt(LS_FEEDBACK_USED, 0);
    writeFeedbackInt(LS_FEEDBACK_PACK, n - FREE_FEEDBACK_LIMIT);
  } else {
    writeFeedbackInt(LS_FEEDBACK_USED, FREE_FEEDBACK_LIMIT - n);
    writeFeedbackInt(LS_FEEDBACK_PACK, 0);
  }
  refreshFeedbackMeter();
  if (canAnalyzeFeedback() && pendingFeedbackAnalyzeId) finishPaidUnlock();
}

function debugGrantFeedbackPack() {
  setDebugIgnorePlus(true);
  grantFeedbackPack(FEEDBACK_PACK_SIZE);
  showToast(i18n.t('feedbackPackAdded'), 'success');
  finishPaidUnlock();
}

function feedbackMeterText() {
  if (isPlusActive()) return i18n.t('feedbackMeterUnlimited');
  const freeLeft = feedbackFreeRemaining();
  const packLeft = feedbackPackRemaining();
  if (freeLeft > 0 && packLeft > 0) {
    return i18n.t('feedbackMeterFreeAndPack', {
      n: freeLeft,
      limit: FREE_FEEDBACK_LIMIT,
      pack: packLeft,
    });
  }
  if (freeLeft > 0) {
    return i18n.t('feedbackMeterFreeLeft', { n: freeLeft, limit: FREE_FEEDBACK_LIMIT });
  }
  if (packLeft > 0) return i18n.t('feedbackMeterPackLeft', { n: packLeft });
  return i18n.t('feedbackMeterNone');
}

function refreshFeedbackMeter() {
  const meter = document.getElementById('feedbackMeter');
  const debug = document.getElementById('feedbackDebug');
  if (!feedbackQuotaApplies()) {
    if (meter) meter.hidden = true;
    if (debug) debug.hidden = true;
    return;
  }
  if (meter) {
    meter.hidden = false;
    meter.textContent = feedbackMeterText();
    meter.classList.toggle('is-empty', !canAnalyzeFeedback());
  }
  const showDebug = feedbackDebugToolsEnabled();
  if (debug) {
    debug.hidden = !showDebug;
    debug.style.display = showDebug ? '' : 'none';
  }
  const paywallDebug = document.getElementById('plusPaywallDebug');
  if (paywallDebug) {
    paywallDebug.hidden = !showDebug;
    paywallDebug.style.display = showDebug ? '' : 'none';
  }
  const ignoreLabel = i18n.t(debugIgnorePlus() ? 'feedbackDebugUsePlus' : 'feedbackDebugIgnorePlus');
  ['feedbackDebugPlusBtn', 'plusPaywallDebugPlusBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (btn) btn.textContent = ignoreLabel;
  });
  applyFeedbackPackButtonCopy();
}

function applyFeedbackPackButtonCopy() {
  const cfg = window.__PARLANCE_CONFIG__ || {};
  const price = cfg.feedbackPackPriceDisplay || '$2.99';
  const label = i18n.t('plusPaywallPack', { price });
  const storeReady = cfg.feedbackPackPurchaseAvailable === true;
  const canTap = storeReady;
  ['plusPaywallPackBtn', 'plusStatusPackBtn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = !canTap;
  });
}

function finishPaidUnlock() {
  const guideKind = pendingPlusGuideKind;
  const analyzeId = pendingFeedbackAnalyzeId;
  pendingPlusGuideKind = null;
  pendingFeedbackAnalyzeId = null;
  const overlay = document.getElementById('plusPaywallOverlay');
  if (overlay) overlay.style.display = 'none';
  refreshFeedbackMeter();
  refreshPlusStatusPanel();
  if (guideKind) openGuideOverlay(guideKind);
  else if (analyzeId && canAnalyzeFeedback()) analyzeSentence(analyzeId);
}

function triggerFeedbackPackPurchase() {
  if (!nativeSupportsPurchases()) {
    showToast(i18n.t('plusPaywallWebNotAvailable'));
    return;
  }
  const cfg = window.__PARLANCE_CONFIG__ || {};
  if (cfg.feedbackPackPurchaseAvailable !== true) {
    showToast(i18n.t('errPackPurchaseFailed', { err: i18n.t('plusPaywallUnavailable') }), 'error');
    return;
  }
  const requestId = 'purchasePack_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  window.__parlancePurchaseResult = (id, data, err) => {
    if (id !== requestId) return;
    delete window.__parlancePurchaseResult;
    if (err === 'cancelled') {
      showToast(i18n.t('purchaseCancelled'));
      return;
    }
    if (err) {
      showToast(i18n.t('errPackPurchaseFailed', { err }), 'error');
      return;
    }
    const txId = data && data.transactionId;
    if (creditPaidFeedbackPack(txId)) {
      showToast(i18n.t('feedbackPackAdded'), 'success');
      finishPaidUnlock();
    }
  };
  postToNative({ action: 'purchaseFeedbackPack', requestId });
}

/** Zero-setup or fastest-to-set-up options lead the grid; the rest live
 *  behind a "More providers" disclosure so first-run isn't 9 equal-weight
 *  cards. See journal_ux_revamp plan, Phase 2. */
function recommendedProviderIds() {
  if (isCoachOnlyNative()) return ['parlance'];
  if (isNativeParlanceApp() && (window.__PARLANCE_CONFIG__ || {}).parlanceCoachAvailable) {
    return ['parlance', 'groq', 'deepseek'];
  }
  return ['webllm', 'groq', 'deepseek'];
}

function makeProviderCard(p) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'ai-provider-card' + (p.id === modalSelectedProvider ? ' selected' : '');
  card.dataset.id = p.id;
  card.setAttribute('role', 'option');
  card.setAttribute('aria-selected', p.id === modalSelectedProvider ? 'true' : 'false');
  card.innerHTML = `
    <div class="ai-provider-icon" aria-hidden="true">${p.icon}</div>
    <div class="ai-provider-name">${p.name}</div>
    <div class="ai-provider-sub">${p.subtitle}</div>
  `;
  card.addEventListener('click', () => {
    modalSelectedProvider = p.id;
    document.querySelectorAll('#providerGrid .ai-provider-card, #providerGridMoreInner .ai-provider-card').forEach(c => {
      c.classList.remove('selected');
      c.setAttribute('aria-selected', 'false');
    });
    card.classList.add('selected');
    card.setAttribute('aria-selected', 'true');
    if (p.id === 'parlance') syncParlanceModelToJournalLanguage();
    updateModalForProvider(p.id);
  });
  return card;
}

function renderProviderGrid() {
  const grid = document.getElementById('providerGrid');
  const moreWrap = document.getElementById('providerGridMore');
  const moreGrid = document.getElementById('providerGridMoreInner');
  if (!grid || !moreGrid) return;
  grid.innerHTML = '';
  moreGrid.innerHTML = '';
  grid.setAttribute('role', 'listbox');
  moreGrid.setAttribute('role', 'listbox');

  const available = Object.values(AI_PROVIDERS).filter((p) => {
    if (isCoachOnlyNative()) return p.id === 'parlance';
    if (p.id === 'webllm') return canUseWebLLM;
    // Coach runs from on-device weights bundled into the native app. A native
    // host without them has no dev-server fallback, so offering the card would
    // only lead to "model not bundled".
    if (p.id === 'parlance' && isNativeParlanceApp()) {
      return !!(window.__PARLANCE_CONFIG__ || {}).parlanceCoachAvailable;
    }
    return true;
  });
  const recommended = recommendedProviderIds()
    .map(id => available.find(p => p.id === id))
    .filter(Boolean);
  const rest = available.filter(p => !recommended.includes(p));

  recommended.forEach(p => grid.appendChild(makeProviderCard(p)));
  rest.forEach(p => moreGrid.appendChild(makeProviderCard(p)));

  if (moreWrap) {
    moreWrap.style.display = rest.length ? '' : 'none';
    // If the currently-selected provider lives under "More providers", open
    // the disclosure so the selection is visible instead of hidden away.
    if (rest.some(p => p.id === modalSelectedProvider)) moreWrap.open = true;
  }
}

function updateModalForProvider(id) {
  const provider = AI_PROVIDERS[id];

  const cloudNote = document.getElementById('authCloudNote');
  if (cloudNote) {
    cloudNote.style.display = (isFirebaseSignedIn() && isCloudProvider(id) && !isNativeParlanceApp()) ? '' : 'none';
  }

  // API key section
  const keySection  = document.getElementById('apiKeySection');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const apiKeyHint  = document.getElementById('apiKeyHint');
  if (effectiveRequiresKey(id)) {
    keySection.style.display = '';
    apiKeyInput.value = getProviderKey(id);
    apiKeyHint.innerHTML = provider.keyUrl
      ? `Get a free key at <a href="${provider.keyUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${provider.keyUrl.replace('https://', '')}</a>`
      : '';
  } else {
    keySection.style.display = 'none';
    apiKeyInput.value = '';
    apiKeyHint.innerHTML = '';
  }

  // Model dropdown (native iOS Parlance Coach: single model tied to journal language)
  const modelSection = document.getElementById('modelSection');
  const modelSel = document.getElementById('modalModelSelect');
  modelSel.innerHTML = '';
  if (id === 'parlance' && parlanceCoachModelFollowsJournal()) {
    const modelId = syncParlanceModelToJournalLanguage();
    modelSection.style.display = 'none';
    const opt = document.createElement('option');
    opt.value = modelId;
    opt.textContent = parlanceCoachDisplayName(state.currentLanguage);
    opt.selected = true;
    modelSel.appendChild(opt);
  } else {
    modelSection.style.display = '';
    const savedModel = getProviderModel(id);
    provider.models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      opt.selected = m.id === savedModel;
      modelSel.appendChild(opt);
    });
  }

  // CORS warning
  document.getElementById('corsWarning').style.display = provider.corsNote ? '' : 'none';
  applyCoachOnlySettingsChrome();
}

function saveAISettingsFromModal() {
  const id    = modalSelectedProvider;
  let model   = document.getElementById('modalModelSelect').value;
  const key   = document.getElementById('apiKeyInput').value.trim();

  if (id === 'parlance' && parlanceCoachModelFollowsJournal()) {
    model = syncParlanceModelToJournalLanguage();
  }

  setSelectedProvider(id);
  markProviderChosenByUser();
  setProviderModel(id, model);
  if (effectiveRequiresKey(id) && key) setProviderKey(id, key);

  // Reset engine if WebLLM model changed
  if (id === 'webllm' && webLLMCurrentModelId !== model) {
    webLLMEngine = null;
    webLLMCurrentModelId = null;
  }

  closeAISettings();
  updateWaitingCard();
  showToast(i18n.t('providerSet', { name: AI_PROVIDERS[id].name }), 'success');
}

// ── PLATFORM DETECTION ────────────────────────────────────────────
const isCapacitor = !!(window.Capacitor);
const isAndroid   = isCapacitor && window.Capacitor.getPlatform?.() === 'android';
const hasWebGPU   = !!navigator.gpu;
const canUseWebLLM = hasWebGPU && !isCapacitor;

// ── INIT ──────────────────────────────────────────────────────────
/** Keep sticky feedback panel aligned with the real header height (wrap-safe). */
function syncHeaderOffset() {
  const header = document.querySelector('header');
  if (!header) return;
  const h = Math.ceil(header.getBoundingClientRect().height);
  if (h > 0) {
    document.documentElement.style.setProperty('--app-header-height', h + 'px');
  }
}

function initHeaderOffsetObserver() {
  const header = document.querySelector('header');
  if (!header) return;
  syncHeaderOffset();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => syncHeaderOffset());
    ro.observe(header);
  }
  window.addEventListener('resize', syncHeaderOffset);
  window.addEventListener('orientationchange', () => {
    requestAnimationFrame(syncHeaderOffset);
  });
}

function isMobileFeedbackLayout() {
  // Phones and iPads (incl. landscape / Split View) — not just ≤768 phone column.
  return window.matchMedia('(max-width: 1366px)').matches
    || window.matchMedia('(pointer: coarse)').matches;
}

/** True only for the single-column phone breakpoint where the feedback
 *  panel becomes a bottom sheet instead of a visible side column. */
function isMobileSheetLayout() {
  return window.matchMedia('(max-width: 768px)').matches;
}

/** Slide the mobile feedback bottom sheet open. No-op on wider layouts,
 *  where the panel is already a visible side column. */
function openFeedbackSheet() {
  if (!isMobileSheetLayout()) return;
  const panel = document.getElementById('feedbackPanel');
  const backdrop = document.getElementById('feedbackSheetBackdrop');
  const toggle = document.getElementById('feedbackSheetToggle');
  if (panel) panel.classList.add('sheet-open');
  if (backdrop) backdrop.classList.add('show');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'true');
    toggle.title = i18n.t('collapseCoachPanel');
    toggle.setAttribute('aria-label', i18n.t('collapseCoachPanel'));
  }
}

function closeFeedbackSheet() {
  const panel = document.getElementById('feedbackPanel');
  const backdrop = document.getElementById('feedbackSheetBackdrop');
  const toggle = document.getElementById('feedbackSheetToggle');
  if (panel) panel.classList.remove('sheet-open');
  if (backdrop) backdrop.classList.remove('show');
  if (toggle) {
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = i18n.t('expandCoachPanel');
    toggle.setAttribute('aria-label', i18n.t('expandCoachPanel'));
  }
}

function toggleFeedbackSheet() {
  const panel = document.getElementById('feedbackPanel');
  if (panel && panel.classList.contains('sheet-open')) closeFeedbackSheet();
  else openFeedbackSheet();
}

/** Jump from sentence editor to the feedback panel (phone/iPad). */
function jumpToFeedback(id) {
  if (id != null) {
    state.activeSentenceId = id;
    showFeedback(id);
  }
  const feedbackTab = document.querySelector('.feedback-tab');
  if (feedbackTab) switchTab('feedback', feedbackTab);
  if (isMobileSheetLayout()) return; // switchTab already opened the sheet
  const panel = document.getElementById('feedbackPanel');
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function init() {
  initTheme();
  // Before anything in this session can auto-switch providers, so a fallback
  // does not get recorded as something the user deliberately picked.
  migrateLegacyProviderChoice();

  // App (interface) language defaults to matching the Write (practice)
  // language — most people only ever touch one language control and expect
  // everything (menus, guides) to follow it. Once someone explicitly picks a
  // different App language via the selector, onUILangChange() sets the
  // "manual" flag below and this auto-follow stops for good.
  const savedLang = localStorage.getItem('parlance_language') || 'es';
  try {
    const manualUiLang = localStorage.getItem('parlance_ui_lang_manual') === '1';
    if (!manualUiLang && !localStorage.getItem('parlance_ui_lang') && ['en', 'es', 'fr'].includes(savedLang)) {
      localStorage.setItem('parlance_ui_lang', savedLang);
    }
  } catch (_) {}

  await i18n.init();
  initHeaderOffsetObserver();
  await ensureFirebaseReady().catch(() => {});
  updateFirebaseAuthUI();
  document.getElementById('uiLangSelect').value = i18n.getLocale();
  updateDateBadge();

  state.currentLanguage = savedLang;
  document.getElementById('langSelect').value = savedLang;
  updateLangSummary();
  if (getSelectedProvider() === 'parlance') {
    syncParlanceModelToJournalLanguage();
  }

  // Auto-switch from WebLLM if it can't run (Android WebView, no WebGPU)
  const currentProvider = getSelectedProvider();
  if (!isCoachOnlyNative() && currentProvider === 'webllm' && !canUseWebLLM) {
    const fallback = ['groq', 'openai', 'gemini', 'anthropic', 'kimi']
      .find(id => getProviderKey(id));
    if (fallback) {
      setSelectedProvider(fallback);
    }
  }

  updateWaitingCard();
  refreshFeedbackMeter();
  renderPrompts();
  addSentence();
  loadSavedEntries();
  initNetworkMonitor();
  updatePlaceholders();

  await applyDefaultProvider();

  // On Android/Capacitor with no cloud provider configured, prompt AI settings
  if (!isCoachOnlyNative() && !canUseWebLLM && getSelectedProvider() === 'webllm') {
    setTimeout(() => openAISettings(), 500);
  }
}

/**
 * Until now the app re-pinned iOS to the coach on every launch, so a stored
 * provider is not evidence that anyone picked it. Anything other than the coach
 * could only have come from the settings sheet, so treat that as a real choice;
 * coach-or-empty gets re-defaulted once.
 */
function migrateLegacyProviderChoice() {
  if (localStorage.getItem(LS_PROVIDER_CHOSEN)) return;
  const stored = localStorage.getItem(LS_PROVIDER);
  if (stored && stored !== 'parlance') markProviderChosenByUser();
}

/**
 * Chooses a provider on first run only, then never touches it again.
 *
 * The bundled coach is a 0.5B model. It is the right answer offline, but it is
 * clearly weaker than the cloud route, which costs the user nothing inside the
 * monthly account allowance. Defaulting everyone to the coach meant most people
 * never saw the better answer, and re-applying it every launch quietly undid
 * whatever they chose instead.
 */
async function applyDefaultProvider() {
  if (isCoachOnlyNative()) {
    setSelectedProvider('parlance');
    syncParlanceModelToJournalLanguage();
    updateWaitingCard();
    return;
  }

  if (hasUserChosenProvider()) {
    updateWaitingCard();
    return;
  }

  if (coachCanCoverLanguage(state.currentLanguage)) {
    setSelectedProvider('parlance');
  } else if (isFirebaseSignedIn()) {
    setSelectedProvider(DEFAULT_CLOUD_PROVIDER);
  } else if (await checkParlanceSLMServer()) {
    // Web / dev: Mac Python server
    setSelectedProvider('parlance');
  }

  if (getSelectedProvider() === 'parlance') syncParlanceModelToJournalLanguage();
  updateWaitingCard();
}

/**
 * Signing in is what makes the cloud route free, so someone who has never
 * picked a provider should move onto it the moment they have an account. On the
 * web the first auth callback can also land after init(), which would otherwise
 * leave a signed-in user on the coach for the rest of the session.
 */
function reapplyDefaultProviderIfUnchosen() {
  if (isCoachOnlyNative()) return;
  if (hasUserChosenProvider() || !isFirebaseSignedIn()) return;
  if (isCloudProvider(getSelectedProvider())) return;
  setSelectedProvider(DEFAULT_CLOUD_PROVIDER);
  updateWaitingCard();
}

function updateWaitingCard() {
  const id   = getSelectedProvider();
  const p    = AI_PROVIDERS[id];
  const hint = document.getElementById('waitingProviderHint');
  if (!hint || !p || typeof i18n === 'undefined') return;

  const linkStyle = 'background:none;border:none;color:var(--accent);font-family:inherit;font-size:inherit;cursor:pointer;padding:0;text-decoration:underline';
  const settingsBtn = (label) =>
    `<button type="button" onclick="openAISettings()" style="${linkStyle}">${label}</button>`;

  if (id === 'parlance') {
    if (isNativeParlanceApp()) {
      hint.innerHTML = i18n.t(parlanceCoachWaitingKey(state.currentLanguage), { icon: p.icon });
    } else {
      hint.innerHTML = i18n.t('waitingParlanceServer', { icon: p.icon });
    }
  } else if (id === 'webllm') {
    if (canUseWebLLM) {
      hint.innerHTML = i18n.t('waitingWebLLM', { icon: p.icon });
    } else {
      hint.innerHTML = `⚙ ${settingsBtn(i18n.t('waitingSetupProvider'))}`;
    }
  } else if (isCloudProvider(id) && !navigator.onLine && coachCanCoverLanguage(state.currentLanguage)) {
    hint.innerHTML = i18n.t('waitingCoachFallback', { icon: AI_PROVIDERS.parlance.icon });
  } else if (!isNativeParlanceApp() && isFirebaseSignedIn() && isCloudProvider(id)) {
    hint.innerHTML = i18n.t('waitingCloudReady', { icon: p.icon, name: p.name });
  } else if (isCloudProvider(id) && !getProviderKey(id) && coachCanCoverLanguage(state.currentLanguage)) {
    hint.innerHTML = i18n.t('waitingCoachFallback', { icon: AI_PROVIDERS.parlance.icon });
  } else if (getProviderKey(id)) {
    hint.innerHTML = i18n.t('waitingProviderWrite', { icon: p.icon, name: p.name });
  } else {
    hint.innerHTML = `⚙ ${settingsBtn(i18n.t('waitingAddKey', { name: p.name }))}`;
  }

  const cta = document.getElementById('waitingAnalyzeBtn');
  if (cta) cta.textContent = i18n.t('analyzeEntry');
}

/** Analyze the focused sentence, or the first draft that is ready. */
function analyzeActiveOrFirstReady() {
  const preferred = state.activeSentenceId
    && state.sentences.find(s => s.id === state.activeSentenceId);
  const candidates = preferred ? [preferred, ...state.sentences] : state.sentences;
  const target = candidates.find(s =>
    s && sentenceReadyToAnalyze(s.text) && !state.analyzingSentenceIds.has(s.id)
  );
  if (!target) {
    showToast(i18n.t('writeFirst'), 'error');
    return;
  }
  state.activeSentenceId = target.id;
  switchTab('feedback', document.querySelector('.feedback-tab'));
  analyzeSentence(target.id);
}

// ── LANGUAGE SWITCHING ────────────────────────────────────────────
function onLanguageChange() {
  const prevModel = getProviderModel('parlance');
  state.currentLanguage = document.getElementById('langSelect').value;
  localStorage.setItem('parlance_language', state.currentLanguage);
  syncUiLanguageToWriteLanguage();
  updateLangSummary();
  closeLangControls();
  updatePlaceholders();
  renderPrompts();
  loadGuide();

  if (getSelectedProvider() === 'parlance') {
    syncParlanceModelToJournalLanguage();
    if (parlanceCoachModelFollowsJournal() && prevModel !== getProviderModel('parlance')) {
      unloadNativeParlanceSLM();
    }
    updateWaitingCard();
  }
}

function currentLang() {
  return languages[state.currentLanguage] || languages.es;
}

function updatePlaceholders() {
  const lang = currentLang();
  document.getElementById('entryTitle').placeholder = lang.titlePlaceholder;
  document.querySelectorAll('.sentence-input').forEach(ta => {
    if (!ta.value) ta.placeholder = lang.placeholder;
  });
}

// ── NETWORK MONITOR ───────────────────────────────────────────────
function initNetworkMonitor() {
  updateOnlineStatus(navigator.onLine);
  window.addEventListener('online',  () => updateOnlineStatus(true));
  window.addEventListener('offline', () => updateOnlineStatus(false));
}

function updateOnlineStatus(online) {
  state.isOnline = online;
  document.getElementById('offlineBanner').classList.toggle('show', !online);
  updateWaitingCard();
}

// ── PRIVACY POLICY ────────────────────────────────────────────────
// Canonical English source: privacy.html (mirrored to docs/ + PrivacyPolicyView).
// On iOS, WKWebView fetch('privacy.html') from a file:// bundle often fails —
// prefer the native PrivacyPolicyView. Elsewhere open the GitHub Pages copy.
const PRIVACY_POLICY_URL = 'https://parlance-lang.github.io/ParlanceApp/privacy.html';
let _privacyBodyPromise = null;

function loadPrivacyBody() {
  if (_privacyBodyPromise) return _privacyBodyPromise;
  _privacyBodyPromise = fetch('privacy.html')
    .then((res) => {
      if (!res.ok) throw new Error('privacy.html ' + res.status);
      return res.text();
    })
    .then((html) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // Skip the page <h1>; the modal header already shows the title.
      return Array.from(doc.body.children).filter((el) => el.tagName !== 'H1');
    })
    .catch((err) => {
      _privacyBodyPromise = null;
      throw err;
    });
  return _privacyBodyPromise;
}

function openHostedPrivacyPolicy() {
  if (postToNative({ action: 'openURL', url: PRIVACY_POLICY_URL })) {
    return true;
  }
  window.open(PRIVACY_POLICY_URL, '_blank', 'noopener');
  return true;
}

function showPrivacyPolicy() {
  const cfg = window.__PARLANCE_CONFIG__ || {};
  // iOS: native sheet already embeds the full policy (PrivacyPolicyView.swift).
  if (cfg.platform === 'ios' && postToNative('showPrivacyPolicy')) {
    return;
  }
  // Android / other native: open the hosted policy (no native sheet yet).
  if (isNativeParlanceApp() && openHostedPrivacyPolicy()) {
    return;
  }

  const overlay = document.getElementById('privacyOverlay');
  if (!overlay) {
    openHostedPrivacyPolicy();
    return;
  }
  const header = overlay.querySelector('.modal-header h2');
  if (header) header.textContent = i18n.t('privacyTitle');

  const body = document.getElementById('privacyBody');
  overlay.style.display = 'flex';
  if (!body) return;

  if (body.dataset.loaded === '1') return;

  body.innerHTML = '<p class="privacy-loading">' + i18n.t('privacyLoading') + '</p>';
  loadPrivacyBody()
    .then((nodes) => {
      body.innerHTML = '';
      nodes.forEach((n) => body.appendChild(document.importNode(n, true)));
      body.dataset.loaded = '1';
    })
    .catch(() => {
      // Last resort for Safari/web: jump to the hosted page instead of a dead modal.
      overlay.style.display = 'none';
      openHostedPrivacyPolicy();
    });
}

function closePrivacyPolicy() {
  document.getElementById('privacyOverlay').style.display = 'none';
}

// ── PROMPTS ───────────────────────────────────────────────────────
function renderPrompts() {
  const list = document.getElementById('promptList');
  list.innerHTML = '';
  const langCode = state.currentLanguage;
  for (let n = 1; n <= 7; n++) {
    const text = i18n.t(`prompts_${langCode}_${n}`);
    if (text === `prompts_${langCode}_${n}`) continue;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'prompt-item';
    el.textContent = text;
    el.addEventListener('click', () => usePrompt(text));
    list.appendChild(el);
  }
}

function usePrompt(p) {
  const empty = state.sentences.find(s => !s.text.trim());
  if (empty) {
    const ta = document.getElementById('ta-' + empty.id);
    if (ta) { ta.value = p; ta.dispatchEvent(new Event('input')); ta.focus(); }
  } else {
    addSentence(p);
  }
  switchTab('feedback', document.querySelector('.feedback-tab'));
}

// ── SENTENCES ─────────────────────────────────────────────────────
let sentenceIdCounter = 0;

function addSentence(prefill = '', opts = {}) {
  const { insertAt = null, focus = true } = opts;
  const id       = ++sentenceIdCounter;
  const sentence = { id, text: '', feedback: null, status: 'empty' };

  if (insertAt == null || insertAt >= state.sentences.length) {
    state.sentences.push(sentence);
  } else {
    state.sentences.splice(insertAt, 0, sentence);
  }

  const area = document.getElementById('sentencesArea');
  const row  = document.createElement('div');
  row.className = 'sentence-row';
  row.id = 'row-' + id;
  row.innerHTML = `
    <div class="sentence-num">${state.sentences.length}</div>
    <div class="sentence-input-wrap">
      <textarea
        class="sentence-input"
        id="ta-${id}"
        placeholder="${currentLang().placeholder}"
        rows="3"
        spellcheck="false"
        data-i18n-title="analyzeHint"
        title="Write freely. ⌘Enter / Ctrl+Enter for feedback."
      ></textarea>
      <div class="sentence-actions">
        <button type="button" class="btn btn-primary analyze-btn" id="analyze-btn-${id}" data-i18n="getFeedback" title="Get feedback">Feedback</button>
        <button type="button" class="jump-feedback-btn" id="jump-fb-${id}" data-i18n="viewFeedback">View feedback ↓</button>
        <div class="sentence-status" id="status-${id}"></div>
      </div>
    </div>
  `;

  if (insertAt == null || insertAt >= state.sentences.length - 1) {
    area.appendChild(row);
  } else {
    const afterId = state.sentences[insertAt + 1]?.id;
    const nextRow = afterId ? document.getElementById('row-' + afterId) : null;
    if (nextRow) area.insertBefore(row, nextRow);
    else area.appendChild(row);
  }

  const ta = row.querySelector('textarea');
  const analyzeBtn = row.querySelector('.analyze-btn');
  const jumpBtn = row.querySelector('.jump-feedback-btn');
  ta.addEventListener('input', () => onSentenceInput(id));
  ta.addEventListener('keydown', (e) => onSentenceKeydown(e, id));
  ta.addEventListener('focus', () => { state.activeSentenceId = id; showFeedback(id); });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 72) + 'px';
  });
  analyzeBtn.addEventListener('click', () => {
    state.activeSentenceId = id;
    analyzeSentence(id);
  });
  if (jumpBtn) {
    jumpBtn.addEventListener('click', () => jumpToFeedback(id));
  }
  if (typeof i18n !== 'undefined' && i18n.apply) {
    analyzeBtn.textContent = i18n.t('getFeedback');
    if (jumpBtn) jumpBtn.textContent = i18n.t('viewFeedback');
    const hint = i18n.t('analyzeHint');
    if (hint && hint !== 'analyzeHint') ta.title = hint;
  }

  if (prefill) {
    ta.value = prefill;
    sentence.text = prefill;
    sentence.status = 'dirty';
    ta.dispatchEvent(new Event('input'));
  }

  updateCounts();
  if (focus) setTimeout(() => ta.focus(), 50);
  return id;
}

function sentenceReadyToAnalyze(text) {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SENTENCE_CHARS) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  return words.length >= MIN_SENTENCE_WORDS;
}

function onSentenceInput(id) {
  const ta       = document.getElementById('ta-' + id);
  const text     = ta.value;
  const sentence = state.sentences.find(s => s.id === id);
  if (!sentence) return;
  sentence.text     = text;
  sentence.status   = 'dirty';
  sentence.feedback = null;
  sentence.feedbackUnits = null;
  const row = document.getElementById('row-' + id);
  if (row) row.classList.remove('has-feedback');
  updateCounts();
}

function onSentenceKeydown(e, id) {
  // Enter inserts a new line so people can write paragraphs.
  // ⌘Enter / Ctrl+Enter requests feedback for this block.
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const ta   = document.getElementById('ta-' + id);
    const text = ta.value.trim();
    if (sentenceReadyToAnalyze(text) || splitIntoSentences(text).some(sentenceReadyToAnalyze)) {
      state.activeSentenceId = id;
      analyzeSentence(id);
    }
  }
}

function updateCounts() {
  const filled = state.sentences.filter(s => s.text.trim());
  const sentenceUnits = filled.reduce(
    (acc, s) => acc + Math.max(1, countSentencesInText(s.text)), 0
  );
  document.getElementById('sentenceCount').textContent =
    i18n.tc('sentenceCount', sentenceUnits);
  const words = filled.reduce(
    (acc, s) => acc + s.text.trim().split(/\s+/).filter(Boolean).length, 0
  );
  document.getElementById('wordCount').textContent =
    i18n.tc('wordCount', words);

  state.sentences.forEach((s, i) => {
    const num = document.querySelector(`#row-${s.id} .sentence-num`);
    if (num) num.textContent = i + 1;
  });
}

// ── ANALYSIS ──────────────────────────────────────────────────────
async function analyzeSentence(id) {
  const sentence = state.sentences.find(s => s.id === id);
  if (!sentence) return;
  if (state.analyzingSentenceIds.has(id)) return;

  // Keep the paragraph in one editor box. Split only for the model, which
  // is trained per sentence, then show one feedback card per sentence.
  const parts = splitIntoSentences(sentence.text).filter(sentenceReadyToAnalyze);
  if (!parts.length) {
    return;
  }

  if (!canAnalyzeFeedback()) {
    pendingFeedbackAnalyzeId = id;
    showPlusPaywall('quota');
    return;
  }

  state.analyzingSentenceIds.add(id);

  const ta       = document.getElementById('ta-' + id);
  const statusEl = document.getElementById('status-' + id);
  ta.classList.add('analyzing');
  ta.classList.remove('has-error', 'is-great');
  statusEl.textContent = '⏳';

  showAnalyzingState(id);
  // Always surface the Feedback tab so iPad (side panel) and phone both show progress.
  requestAnimationFrame(() => jumpToFeedback(id));

  const providerId = getSelectedProvider();

  try {
    const units = [];
    for (const part of parts) {
      const result = await analyzeWithAI(
        part,
        state.currentLanguage,
        (report) => showWebLLMProgress(report)
      );
      let source;
      if (result._cachedSource) {
        source = result._cachedSource;
        delete result._cachedSource;
      } else if (result._actualSource) {
        source = result._actualSource;
        delete result._actualSource;
      } else {
        source = AI_PROVIDERS[providerId]?.name || providerId;
      }
      units.push({
        text: part,
        feedback: result,
        analysisSource: source,
        language: resolveAnalysisLanguage(part, state.currentLanguage).language,
      });
    }
    sentence.feedbackUnits = units;
    sentence.feedback = units[0].feedback;
    sentence.analysisSource = units[0].analysisSource;
    consumeFeedbackCredit();
    applyParagraphFeedback(id, sentence, ta, statusEl);

  } catch (err) {
    ta.classList.remove('analyzing');
    statusEl.textContent = '';
    console.error('[Parlance] Analysis error:', err);

    // Friendly message for rate-limit and auth errors from Firebase Functions
    const code = err.code || '';
    let msg = err.message || 'Could not analyze — check your settings.';
    if (code === 'functions/resource-exhausted' || msg.includes('Monthly free limit')) {
      refreshUsageDisplay();
      triggerCallPackPurchase();
      return;
    } else if (code === 'functions/unauthenticated') {
      msg = 'Sign in to use cloud AI providers — tap ⚙ AI.';
    }

    showErrorInPanel(msg);
    showToast(msg.length > 80 ? msg.slice(0, 80) + '…' : msg, 'error');
  } finally {
    state.analyzingSentenceIds.delete(id);
  }
}

function applyFeedback(id, sentence, parsed, ta, statusEl) {
  sentence.feedback = parsed;
  sentence.feedbackUnits = [{
    text: sentence.text,
    feedback: parsed,
    analysisSource: sentence.analysisSource,
  }];
  applyParagraphFeedback(id, sentence, ta, statusEl);
}

function applyParagraphFeedback(id, sentence, ta, statusEl) {
  const units = feedbackUnitsFor(sentence);
  const anyNeedsWork = units.some(u => u.feedback && u.feedback.status !== 'Excellent');
  sentence.status = anyNeedsWork ? 'error' : 'great';
  ta.classList.remove('analyzing');
  ta.classList.toggle('is-great', sentence.status === 'great');
  ta.classList.toggle('has-error', sentence.status === 'error');
  statusEl.textContent = sentence.status === 'great' ? '✓' : '⚠';
  const row = document.getElementById('row-' + id);
  if (row) row.classList.add('has-feedback');
  if (state.activeSentenceId === id) showFeedback(id);
  if (isMobileFeedbackLayout()) {
    // Soft jump so the user lands on results without hunting past the editor.
    requestAnimationFrame(() => jumpToFeedback(id));
  }
}

function feedbackUnitsFor(sentence) {
  if (Array.isArray(sentence.feedbackUnits) && sentence.feedbackUnits.length) {
    return sentence.feedbackUnits;
  }
  if (sentence.feedback) {
    return [{
      text: sentence.text,
      feedback: sentence.feedback,
      analysisSource: sentence.analysisSource,
    }];
  }
  return [];
}

// ── FEEDBACK DISPLAY ──────────────────────────────────────────────
function switchTab(tab, btn) {
  document.querySelectorAll('.feedback-tab').forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.getElementById('feedbackInner').style.display  = tab === 'feedback' ? 'flex' : 'none';
  document.getElementById('promptsInner').style.display   = tab === 'prompts'  ? 'flex' : 'none';
  document.getElementById('guideInner').style.display     = tab === 'guide'    ? 'flex' : 'none';
  // Tapping any tab on the phone bottom-sheet layout should reveal it —
  // it never collapses a tab switch, only the dedicated toggle button does.
  openFeedbackSheet();
}

function clearFeedbackCards() {
  const inner = document.getElementById('feedbackInner');
  const waiting = document.getElementById('waitingCard');
  if (waiting) waiting.style.display = 'none';
  inner.querySelectorAll('.feedback-card, .analyzing-card, .webllm-progress-card, .error-panel-card').forEach(el => el.remove());
}

function showAnalyzingState(id) {
  clearFeedbackCards();
  const inner = document.getElementById('feedbackInner');
  const card  = document.createElement('div');
  card.className = 'analyzing-card';
  card.id = 'analyzing-card';
  const providerId = getSelectedProvider();
  let analyzingKey = 'analyzing';
  if (providerId === 'parlance') {
    analyzingKey = isNativeParlanceApp() ? 'analyzingParlanceOnDevice' : 'analyzingParlanceServer';
  }
  card.innerHTML = `
    <div class="dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>
    <div class="analyzing-text">${i18n.t(analyzingKey)}</div>
  `;
  inner.appendChild(card);
}

function showWebLLMProgress(report) {
  const inner   = document.getElementById('feedbackInner');
  let card      = inner.querySelector('.webllm-progress-card');
  const pct     = Math.round((report.progress || 0) * 100);
  const text    = report.text || 'Loading model…';

  if (!card) {
    clearFeedbackCards();
    card = document.createElement('div');
    card.className = 'webllm-progress-card';
    card.innerHTML = `
      <div class="webllm-progress-title">🧠 Loading Browser AI</div>
      <div class="webllm-progress-text" id="webllmProgressText">${text}</div>
      <div class="webllm-progress-bar-wrap">
        <div class="webllm-progress-fill" id="webllmProgressFill" style="width:${pct}%"></div>
      </div>
      <div class="webllm-progress-sub">First load only — cached in your browser after this.</div>
    `;
    inner.appendChild(card);
  } else {
    const textEl = card.querySelector('#webllmProgressText');
    const fillEl = card.querySelector('#webllmProgressFill');
    if (textEl) textEl.textContent = text;
    if (fillEl) fillEl.style.width = pct + '%';
  }
}

function showErrorInPanel(msg) {
  clearFeedbackCards();
  const inner = document.getElementById('feedbackInner');
  const card  = document.createElement('div');
  card.className = 'error-panel-card';
  const settingsBtn = isCoachOnlyNative()
    ? ''
    : `<button class="btn btn-primary error-panel-btn" onclick="openAISettings()">⚙ ${escapeHTML(i18n.t('openAiSettings'))}</button>`;
  card.innerHTML = `
    <div class="error-panel-icon">⚠</div>
    <div class="error-panel-msg">${escapeHTML(msg)}</div>
    ${settingsBtn}
  `;
  inner.appendChild(card);
}

function showFeedback(id) {
  const sentence = state.sentences.find(s => s.id === id);
  if (!sentence) return;

  const inner   = document.getElementById('feedbackInner');
  const waiting = document.getElementById('waitingCard');
  if (waiting) waiting.style.display = 'none';
  inner.querySelectorAll('.feedback-card, .analyzing-card, .webllm-progress-card, .error-panel-card').forEach(el => el.remove());

  const units = feedbackUnitsFor(sentence);
  if (!units.length) {
    // Only show the analyzing spinner when analysis is actually running.
    // Focusing a draft used to fake that UI and made Coach look stuck.
    if (state.analyzingSentenceIds.has(id)) {
      showAnalyzingState(id);
    } else if (waiting) {
      waiting.style.display = 'block';
    }
    return;
  }

  units.forEach((unit, i) => {
    inner.appendChild(buildFeedbackCard(unit, i18n.t('feedbackSentenceN', { n: i + 1 })));
  });
  inner.scrollTop = 0;
}

function buildFeedbackCard(unit, refLabel) {
  const rawFb = unit.feedback || {};
  const fb = unit.text
    ? sanitizeFeedbackResult(unit.text, { ...rawFb }, unit.language || state.currentLanguage)
    : rawFb;
  const isExcellent = fb.status === 'Excellent';
  const statusLabel = isExcellent ? i18n.t('feedbackExcellent') : i18n.t('feedbackNeedsWork');
  const statusClass = isExcellent ? 'score-excellent' : 'score-needs-work';
  const assessedLevel = extractAssessedLevel(fb);
  const complexityNote = extractComplexityNote(fb);
  const { nextLabel, targetLabel } = altVersionLabels(assessedLevel);

  let body = '';
  if (assessedLevel) {
    body += feedbackItem('label-level', i18n.t('assessedLevelLabel'), i18n.t('assessedLevelRichText', { level: assessedLevel }));
  }
  if (complexityNote) {
    body += feedbackItem('label-complexity', i18n.t('complexityNoteLabel'), complexityNote);
  }
  body += feedbackItem('label-rule',         i18n.t('grammarRuleLabel'),  fb.grammar_rule);
  if (fb.correction && !isExcellent) {
    body += feedbackItem('label-correction', i18n.t('correctedSentenceLabel'), fb.correction);
  }
  body += feedbackItem(
    'label-explanation',
    isExcellent ? i18n.t('whyThisWorksLabel') : i18n.t('whatNeedsWorkLabel'),
    fb.explanation
  );
  if (fb.correction && isExcellent) {
    body += feedbackItem('label-correction', i18n.t('correctedSentenceLabel'), fb.correction);
  }
  if (fb.register)         body += feedbackItem('label-register',   i18n.t('registerLabel'),              fb.register);
  if (fb.next_level_alt)   body += feedbackItem('label-next',       nextLabel,  fb.next_level_alt);
  if (fb.target_level_alt && targetLabel)
                           body += feedbackItem('label-target',     targetLabel, fb.target_level_alt);
  if (fb.tip)              body += feedbackItem('label-tip',        i18n.t('tipLabel'),                   fb.tip);
  if (fb._coach_warning) {
    body += `<div class="feedback-coach-warning">${escapeHTML(fb._coach_warning)}</div>`;
  }
  if (fb._rag_topics?.length) {
    const chips = fb._rag_topics.map(t =>
      `<span class="feedback-rag-chip">${escapeHTML(t)}</span>`
    ).join('');
    body += `<div class="feedback-rag-topics"><span class="feedback-rag-label">${escapeHTML(i18n.t('referenceLabel'))}</span>${chips}</div>`;
  }

  const sourceLabel = unit.analysisSource || 'AI';
  const card = document.createElement('div');
  card.className = 'feedback-card';
  card.innerHTML = `
    <div class="feedback-card-header">
      <div class="feedback-sentence-ref">${escapeHTML(refLabel)}</div>
      <div class="feedback-header-badges">
        ${assessedLevel ? `<div class="feedback-level-badge" title="${escapeHTML(i18n.t('assessedLevelHint'))}">~${assessedLevel}</div>` : ''}
        <div class="feedback-score ${statusClass}">${statusLabel}</div>
        <div class="feedback-source">${escapeHTML(sourceLabel)}</div>
      </div>
    </div>
    <div class="feedback-original">"${escapeHTML(unit.text)}"</div>
    <div class="feedback-body">${body}</div>
  `;
  return card;
}

function feedbackItem(labelClass, label, text) {
  const display = (typeof ParlanceFeedbackSanitize !== 'undefined' && ParlanceFeedbackSanitize.coerceFeedbackText)
    ? (ParlanceFeedbackSanitize.coerceFeedbackText(text) || '')
    : String(text || '');
  if (!display.trim()) return '';
  return `
    <div class="feedback-item">
      <div class="feedback-item-label ${labelClass}">${label}</div>
      <div class="feedback-item-text">${escapeHTML(display)}</div>
    </div>
  `;
}

// ── GUIDE OVERLAY ─────────────────────────────────────────────────
function loadGuide() {
  // Called on language switch — resets the guide overlay
  const frame = document.getElementById('guideFrame');
  if (frame && frame.src) frame.src = '';
}

function guideRequiresPlus(kind) {
  return (kind === 'medical' || kind === 'legal') && isNativeParlanceApp();
}

function openGuideOverlay(kind = 'grammar') {
  if (guideRequiresPlus(kind) && !isPlusActive()) {
    showPlusPaywall(kind);
    return;
  }
  const lang    = currentLang();
  const overlay = document.getElementById('guideOverlay');
  const frame   = document.getElementById('guideFrame');
  const fileByKind = {
    dialect: lang.dialectFile,
    grammar: lang.guideFile,
    medical: 'domain-medical.html',
    legal: 'domain-legal.html',
  };
  const file = fileByKind[kind] || lang.guideFile;

  if (!file) { showToast(i18n.t('guideComingSoon'), 'error'); return; }

  // Pass interface language so dialect pages show English when the app UI is
  // English. Prefer the live <select> value so a just-changed language sticks
  // even if i18n.locale hasn't finished reloading yet.
  const uiSelect = document.getElementById('uiLangSelect');
  const ui = (uiSelect && uiSelect.value)
    || ((typeof i18n !== 'undefined' && i18n.getLocale) ? i18n.getLocale() : 'en');
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const qs = new URLSearchParams({ ui, theme });
  frame.src = `${file}?${qs.toString()}`;
  frame.onload = () => {
    try {
      frame.contentWindow?.postMessage({ type: 'parlanceGuideEnv', ui, theme }, '*');
      const doc = frame.contentDocument;
      if (doc?.body && typeof doc.defaultView?.applyGuideEnv === 'function') {
        doc.defaultView.applyGuideEnv(ui, theme);
      }
    } catch (_) { /* cross-origin safety */ }
    if (theme === 'dark') {
      frame.contentDocument?.documentElement?.setAttribute('data-theme', 'dark');
      frame.contentDocument?.body?.classList.add('dark');
    }
  };
  document.body.classList.add('guide-open');
  closeFeedbackSheet();
  overlay.style.display = 'block';
}

function closeGuideOverlay() {
  document.body.classList.remove('guide-open');
  document.getElementById('guideOverlay').style.display = 'none';
  document.getElementById('guideFrame').src = '';
}

window.addEventListener('message', (e) => {
  if (e.data === 'closeGuide') closeGuideOverlay();
});

// ── SAVE / LOAD ───────────────────────────────────────────────────
function saveEntry() {
  const title     = document.getElementById('entryTitle').value || 'Untitled Entry';
  const sentences = state.sentences.filter(s => s.text.trim());
  if (!sentences.length) { showToast(i18n.t('writeFirst'), 'error'); return; }

  const entry = {
    id:       Date.now(),
    title,
    language: state.currentLanguage,
    date:     new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    sentences: sentences.map(s => ({
      text: s.text,
      feedback: s.feedback || null,
      feedbackUnits: s.feedbackUnits || null,
      analysisSource: s.analysisSource || null,
    })),
  };

  state.savedEntries.unshift(entry);
  try { localStorage.setItem('parlance_entries', JSON.stringify(state.savedEntries)); } catch (_) {}

  renderPastEntries();
  const bar = document.getElementById('pastBar');
  if (bar) bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  showToast(i18n.t('entrySaved'), 'success');
}

function loadSavedEntries() {
  try {
    const saved = localStorage.getItem('parlance_entries');
    if (saved) state.savedEntries = JSON.parse(saved);
  } catch (_) {}
  // Always render (even with zero entries) — Past Entries shows a real
  // empty state now instead of staying hidden until the first save.
  renderPastEntries();
}

function renderPastEntries() {
  const bar  = document.getElementById('pastBar');
  const list = document.getElementById('pastEntries');
  if (!bar || !list) return;
  bar.hidden = false;
  list.innerHTML = '';
  if (!state.savedEntries.length) {
    const empty = document.createElement('p');
    empty.className = 'past-entries-empty';
    empty.textContent = i18n.t('pastEntriesEmpty');
    list.appendChild(empty);
    return;
  }
  state.savedEntries.slice(0, 8).forEach((entry, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'past-entry-chip' + (i === state.viewingEntryIndex ? ' current' : '');
    const langLabel = entry.language ? ` [${entry.language.toUpperCase()}]` : '';
    chip.textContent = `${entry.date} · ${entry.title}${langLabel}`;
    chip.addEventListener('click', () => {
      const overlay = document.getElementById('entryOverlay');
      const alreadyOpen = overlay && overlay.style.display !== 'none';
      if (alreadyOpen && i === state.viewingEntryIndex) return;
      const dir = !alreadyOpen ? 'open'
        : i > state.viewingEntryIndex ? 'next'
        : 'prev';
      viewEntry(entry, dir);
    });
    list.appendChild(chip);
  });
}

// ── ENTRY VIEWER ──────────────────────────────────────────────────
let entryTurnBusy = false;
let entryViewerChromeBound = false;
let entryTouchStartX = null;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function bindEntryViewerChrome() {
  if (entryViewerChromeBound) return;
  entryViewerChromeBound = true;
  document.addEventListener('keydown', onEntryViewerKey);
  const stage = document.getElementById('entryBookStage');
  if (!stage) return;
  stage.addEventListener('touchstart', (e) => {
    entryTouchStartX = e.changedTouches[0].clientX;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (entryTouchStartX == null) return;
    const dx = e.changedTouches[0].clientX - entryTouchStartX;
    entryTouchStartX = null;
    if (Math.abs(dx) < 56) return;
    turnEntryPage(dx < 0 ? 1 : -1);
  }, { passive: true });
}

function onEntryViewerKey(e) {
  const overlay = document.getElementById('entryOverlay');
  if (!overlay || overlay.style.display === 'none') return;
  if (e.key === 'Escape') { closeEntryViewer(); return; }
  if (e.key === 'ArrowRight') { e.preventDefault(); turnEntryPage(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); turnEntryPage(-1); }
}

function fillEntryPage(entry) {
  document.getElementById('entryViewerTitle').textContent = entry.title || 'Untitled Entry';
  const langName = parlanceLanguageInfo(entry.language).name;
  document.getElementById('entryViewerMeta').textContent =
    `${entry.date} · ${langName}`;

  const body = document.getElementById('entryViewerBody');
  body.innerHTML = '';

  const loadAllRow = document.createElement('div');
  loadAllRow.style.cssText = 'margin-bottom: 1rem; text-align: right;';
  const loadAllBtn = document.createElement('button');
  loadAllBtn.id = 'loadAllToEditorBtn';
  loadAllBtn.className = 'btn btn-primary entry-load-btn';
  loadAllBtn.textContent = i18n.t('loadAllToEditor');
  loadAllBtn.onclick = () => loadEntryToEditor(entry);
  loadAllRow.appendChild(loadAllBtn);
  body.appendChild(loadAllRow);

  (entry.sentences || []).forEach((s, i) => {
    const text = typeof s === 'string' ? s : s.text;
    const feedback = typeof s === 'string' ? null : s.feedback;
    const analysisSource = typeof s === 'string' ? null : s.analysisSource;

    const row = document.createElement('div');
    row.className = 'entry-viewer-sentence';

    let feedbackHTML = '';
    if (feedback) {
      const isExcellent = feedback.status === 'Excellent';
      const badgeClass = isExcellent ? 'excellent' : 'needs-work';
      const badgeLabel = isExcellent ? i18n.t('feedbackExcellent') : i18n.t('feedbackNeedsWork');
      const assessed = extractAssessedLevel(feedback);
      feedbackHTML = `
        <div class="entry-sentence-actions">
          <span class="entry-feedback-badge ${badgeClass}">${badgeLabel}</span>
          ${assessed ? `<span class="entry-feedback-badge" style="background:var(--blue-bg);color:var(--blue);">~${assessed}</span>` : ''}
          ${analysisSource ? `<span class="entry-feedback-badge" style="background:rgba(11,156,208,0.06);color:#0b9cd0;">${escapeHTML(analysisSource)}</span>` : ''}
        </div>
        ${feedback.grammar_rule ? `<div class="entry-feedback-rule">${escapeHTML(feedback.grammar_rule)}</div>` : ''}
        ${feedback.explanation ? `<div class="entry-feedback-rule" style="color:#5a534e;">${escapeHTML(feedback.explanation)}</div>` : ''}
      `;
    }

    row.innerHTML = `
      <div class="entry-viewer-num">${i + 1}</div>
      <div class="entry-viewer-text">
        ${escapeHTML(text)}
        ${feedbackHTML}
        <div class="entry-sentence-actions" style="margin-top:0.4rem;">
          <button class="btn btn-primary entry-load-btn" data-index="${i}" title="${escapeHTML(i18n.t('reAnalyze'))}">${escapeHTML(i18n.t('reAnalyze'))}</button>
        </div>
      </div>
    `;

    row.querySelector('.entry-load-btn[data-index]').addEventListener('click', () => {
      loadSentenceToEditor(text, entry.language);
    });

    body.appendChild(row);
  });

  document.getElementById('entryDeleteBtn').onclick = () => deleteEntry(entry.id);
  body.scrollTop = 0;
  updateEntryPager();
}

function updateEntryPager() {
  const total = state.savedEntries.length;
  const idx = state.viewingEntryIndex;
  const pageOf = document.getElementById('entryPageOf');
  const prev = document.getElementById('entryPagePrev');
  const next = document.getElementById('entryPageNext');
  if (pageOf) {
    pageOf.textContent = (idx >= 0 && total)
      ? i18n.t('entryPageOf', { current: idx + 1, total })
      : '';
  }
  if (prev) {
    prev.disabled = idx <= 0;
    prev.title = i18n.t('previousEntry');
    prev.setAttribute('aria-label', i18n.t('previousEntry'));
  }
  if (next) {
    next.disabled = idx < 0 || idx >= total - 1;
    next.title = i18n.t('nextEntry');
    next.setAttribute('aria-label', i18n.t('nextEntry'));
  }
}

function playPageTurn(direction) {
  const viewer = document.getElementById('entryViewer');
  if (!viewer || prefersReducedMotion()) return;
  viewer.classList.remove('page-in-open', 'page-in-next', 'page-in-prev');
  void viewer.offsetWidth;
  const cls = direction === 'prev' ? 'page-in-prev'
    : direction === 'next' ? 'page-in-next'
    : 'page-in-open';
  viewer.classList.add(cls);
}

function viewEntry(entry, direction) {
  const idx = state.savedEntries.findIndex(e => e.id === entry.id);
  if (idx === -1) return;
  bindEntryViewerChrome();
  state.viewingEntryIndex = idx;
  fillEntryPage(entry);
  playPageTurn(direction || 'open');
  renderPastEntries();

  const overlay = document.getElementById('entryOverlay');
  overlay.style.display = 'flex';
  overlay.onclick = (e) => { if (e.target === overlay) closeEntryViewer(); };
  if (typeof closeFeedbackSheet === 'function') closeFeedbackSheet();
}

function turnEntryPage(delta) {
  if (entryTurnBusy) return;
  const next = state.viewingEntryIndex + delta;
  if (next < 0 || next >= state.savedEntries.length) return;
  entryTurnBusy = true;
  viewEntry(state.savedEntries[next], delta > 0 ? 'next' : 'prev');
  setTimeout(() => { entryTurnBusy = false; }, prefersReducedMotion() ? 0 : 480);
}

function loadSentenceToEditor(text, language) {
  if (language) {
    state.currentLanguage = language;
    document.getElementById('langSelect').value = language;
    localStorage.setItem('parlance_language', language);
    syncUiLanguageToWriteLanguage();
    updatePlaceholders();
    renderPrompts();
    updateLangSummary();
  }
  const empty = state.sentences.find(s => !s.text.trim());
  if (empty) {
    const ta = document.getElementById('ta-' + empty.id);
    if (ta) { ta.value = text; ta.dispatchEvent(new Event('input')); ta.focus(); }
  } else {
    addSentence(text);
  }

  closeEntryViewer();
  switchTab('feedback', document.querySelector('.feedback-tab'));
}

function loadEntryToEditor(entry) {
  if (entry.language) {
    state.currentLanguage = entry.language;
    document.getElementById('langSelect').value = entry.language;
    localStorage.setItem('parlance_language', entry.language);
    syncUiLanguageToWriteLanguage();
    updatePlaceholders();
    renderPrompts();
    updateLangSummary();
  }

  // Set title
  if (entry.title) {
    document.getElementById('entryTitle').value = entry.title;
  }

  // Clear existing sentences from UI and state
  const area = document.getElementById('sentencesArea');
  area.innerHTML = '';
  state.sentences = [];
  sentenceIdCounter = 0;

  // Load each sentence from the entry
  (entry.sentences || []).forEach(s => {
    const text = typeof s === 'string' ? s : s.text;
    addSentence(text);
  });

  closeEntryViewer();
  switchTab('feedback', document.querySelector('.feedback-tab'));
  showToast(i18n.t('entryLoaded'), 'success');
}

function deleteEntry(entryId) {
  const idx = state.savedEntries.findIndex(e => e.id === entryId);
  if (idx === -1) return;
  state.savedEntries.splice(idx, 1);
  try { localStorage.setItem('parlance_entries', JSON.stringify(state.savedEntries)); } catch (_) {}
  if (state.savedEntries.length) {
    const nextIdx = Math.min(idx, state.savedEntries.length - 1);
    viewEntry(state.savedEntries[nextIdx], 'next');
  } else {
    closeEntryViewer();
  }
  renderPastEntries();
  showToast(i18n.t('entryDeleted'), 'success');
}

function closeEntryViewer() {
  document.getElementById('entryOverlay').style.display = 'none';
  state.viewingEntryIndex = -1;
  const viewer = document.getElementById('entryViewer');
  if (viewer) viewer.classList.remove('page-in-open', 'page-in-next', 'page-in-prev');
  renderPastEntries();
}

// ── UTILS ─────────────────────────────────────────────────────────
/** type: 'info' (default) | 'success' | 'error' — drives styling + the
 *  role announced to screen readers (status vs. alert). */
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show toast-' + type;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  clearTimeout(t._hideTimer);
  t._hideTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── START ─────────────────────────────────────────────────────────
try {
  init();
} catch (err) {
  console.error('[Parlance] init failed:', err);
  const inner = document.getElementById('feedbackInner');
  if (inner) {
    inner.innerHTML = `<div style="padding:1.5rem;font-family:'DM Mono',monospace;font-size:0.78rem;color:#b44;border:1px solid #f0d;border-radius:4px;">
      ⚠ Parlance failed to start: ${err.message}<br><br>Try a hard refresh (Cmd+Shift+R).
    </div>`;
  }
}
