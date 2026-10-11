/**
 * Daily per-user cap and a shared cache of panel results, so repeated learner
 * sentences cost nothing and one user can't drain the free tiers.
 */

const crypto = require("crypto");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const DAILY_CAP = Number(process.env.COACH_DAILY_CAP || 40);
const CACHE_VERSION = 1;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function takeDailySlot(uid) {
  const ref = getFirestore().collection("coachPanelUsage").doc(`${uid}_${today()}`);
  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const count = snap.exists ? snap.data().count || 0 : 0;
    if (count >= DAILY_CAP) return { allowed: false, remaining: 0 };
    tx.set(ref, { uid, day: today(), count: count + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { allowed: true, remaining: DAILY_CAP - count - 1 };
  });
}

function cacheKey(text, language) {
  const norm = text.normalize("NFC").replace(/\s+/g, " ").trim();
  return crypto.createHash("sha256").update(`v${CACHE_VERSION}|${language}|${norm}`).digest("hex");
}

async function readCache(text, language) {
  const snap = await getFirestore().collection("coachPanelCache").doc(cacheKey(text, language)).get();
  return snap.exists ? snap.data().result : null;
}

async function writeCache(text, language, result) {
  await getFirestore().collection("coachPanelCache").doc(cacheKey(text, language)).set({
    language,
    result,
    createdAt: FieldValue.serverTimestamp(),
  });
}

module.exports = { takeDailySlot, readCache, writeCache, DAILY_CAP };
