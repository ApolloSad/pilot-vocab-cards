import React, { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Pilot Vocab Cards (minimal UI)
 * - Uses IndexedDB (reliable in Safari) instead of localStorage
 * - Migrates from old localStorage key "pilotVocabCards_v8" automatically
 * - Keep button loops (rotates current word to end of active review list)
 * - Bottom bar removed (clean/minimal)
 * - AI Fill button (Cloudflare Pages Functions -> /api/define?word=...)
 *
 * Updates in this version:
 * - Russian translation removed everywhere (data model + UI)
 * - Add UI cleaned and rescaled
 * - AI Fill cached per word (repeat clicks keep the same best output)
 * - AI is instructed to give aviation meaning if relevant, otherwise general meaning
 */

const LEGACY_LS_KEY = "pilotVocabCards_v8"; // old app saved here
const DB_NAME = "pilot-vocab-cards-db";
const DB_STORE = "kv";
const DB_CARDS_KEY = "cards_v1";
const DB_QUEUE_KEY = "queue_v1";
const DB_AI_CACHE_KEY = "ai_cache_v1";

// ---------- IndexedDB tiny helper ----------
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !("indexedDB" in window)) {
      reject(new Error("IndexedDB not available"));
      return;
    }

    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
    tx.oncomplete = () => db.close();
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("IndexedDB set failed"));
    tx.oncomplete = () => db.close();
  });
}

// ---------- Utilities ----------
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const startOfLocalDayMs = (d = new Date()) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

const addDaysMs = (baseMs, days) => {
  const d = new Date(baseMs);
  d.setDate(d.getDate() + days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

const safeJsonParse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

// 🔊 Pronunciation (used in Review only)
function speakWord(text) {
  if (typeof window === "undefined") return;
  const t = (text ?? "").trim();
  if (!t) return;
  if (!("speechSynthesis" in window)) return;

  const utter = new SpeechSynthesisUtterance(t);
  utter.lang = "en-US";
  utter.rate = 0.95;

  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utter);
}

// Spaced repetition (Done uses this)
function schedule(card, grade) {
  let { intervalDays = 0, ease = 2.5, reps = 0 } = card.srs || {};

  if (grade === 0) {
    reps = 0;
    intervalDays = 1;
    ease = Math.max(1.3, ease - 0.2);
  } else {
    reps += 1;
    if (grade === 1) ease = Math.max(1.3, ease - 0.15);
    if (grade === 2) ease = Math.max(1.3, ease - 0.05);
    if (grade === 3) ease += 0.1;

    if (reps === 1) intervalDays = 1;
    else if (reps === 2) intervalDays = 3;
    else intervalDays = Math.round(intervalDays * ease);
  }

  return {
    ...card,
    srs: {
      dueMs: addDaysMs(startOfLocalDayMs(), intervalDays),
      intervalDays,
      ease,
      reps,
    },
  };
}

// Normalize/migrate cards from storage (accepts old v8 ISO srs.due too)
// Russian removed: ignores legacy "ru"
function normalizeCards(input) {
  if (!Array.isArray(input)) return [];
  const todayMs = startOfLocalDayMs();

  return input.map((c) => {
    const id = c?.id != null ? String(c.id) : uid();
    const word = String(c?.word ?? "");
    const definition = String(c?.definition ?? "");
    const examples = Array.isArray(c?.examples)
      ? c.examples.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];

    const dueMsRaw = c?.srs?.dueMs;
    const dueIsoRaw = c?.srs?.due; // legacy
    const parsedIso = typeof dueIsoRaw === "string" ? Date.parse(dueIsoRaw) : NaN;

    const dueMs =
      Number.isFinite(dueMsRaw) ? dueMsRaw : Number.isFinite(parsedIso) ? parsedIso : todayMs;

    const intervalDays = Number(c?.srs?.intervalDays ?? 0);
    const ease = Number(c?.srs?.ease ?? 2.5);
    const reps = Number(c?.srs?.reps ?? 0);

    return {
      id,
      word,
      definition,
      examples,
      srs: {
        dueMs,
        intervalDays: Number.isFinite(intervalDays) ? intervalDays : 0,
        ease: Number.isFinite(ease) ? ease : 2.5,
        reps: Number.isFinite(reps) ? reps : 0,
      },
    };
  });
}

function normalizeAiPayload(data, fallbackWord) {
  const def = String(data?.definition || "").trim();
  const ex = Array.isArray(data?.examples) ? data.examples : [];

  const examples = ex
    .map((x) => String(x || "").trim())
    .filter(Boolean)
    .slice(0, 2);

  // Safety: keep output simple and short
  const cleanDefinition = clampWords(def, 14);
  const cleanExamples = ensureTwoExamples(
    examples.map((t) => clampWords(t, 12)),
    fallbackWord
  );

  return { definition: cleanDefinition, examples: cleanExamples };
}

function clampWords(text, maxWords) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const parts = t.split(" ");
  if (parts.length <= maxWords) return t;
  return parts.slice(0, maxWords).join(" ").trim();
}

function ensureTwoExamples(examples, word) {
  const w = String(word || "").trim();
  const base = [
    w ? `I reviewed the word "${w}".` : "I reviewed a new word today.",
    w ? `I used "${w}" in a short sentence.` : "I used it in a short sentence.",
  ];
  const out = Array.isArray(examples) ? examples.filter(Boolean) : [];
  while (out.length < 2) out.push(base[out.length] || base[0]);
  return out.slice(0, 2);
}

// ---------- UI ----------
function TabButton({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={active ? styles.tabBtnActive : styles.tabBtn}>
      {children}
    </button>
  );
}

function CardView({ card }) {
  const examples = card.examples ?? [];
  return (
    <div style={styles.card}>
      <div style={styles.cardTop}>
        <div style={styles.cardWord}>{card.word}</div>
      </div>

      <div style={styles.cardDef}>{card.definition}</div>

      {examples.length > 0 && (
        <div style={styles.block}>
          <div style={styles.blockTitle}>Examples</div>
          <ul style={styles.ul}>
            {examples.map((e, i) => (
              <li key={`${i}`} style={styles.li}>
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [cards, setCards] = useState([]);
  const [tab, setTab] = useState("review");

  const [word, setWord] = useState("");
  const [definition, setDefinition] = useState("");
  const [examplesText, setExamplesText] = useState("");

  // AI Fill UI state
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");

  // AI cache - keep same "best" output if AI Fill clicked repeatedly for same word
  // Shape: { [lowerWord]: { definition: string, examples: string[] } }
  const [aiCache, setAiCache] = useState({});

  const [showAnswer, setShowAnswer] = useState(false);
  const [reviewId, setReviewId] = useState(null);
  const [search, setSearch] = useState("");
  const [studyQueueIds, setStudyQueueIds] = useState([]);

  const [hydrated, setHydrated] = useState(false);

  // LOAD: IndexedDB first. If empty, import from old localStorage automatically.
  useEffect(() => {
    if (typeof window === "undefined") return;

    (async () => {
      try {
        const rawCards = await idbGet(DB_CARDS_KEY);
        const rawQueue = await idbGet(DB_QUEUE_KEY);
        const rawAiCache = await idbGet(DB_AI_CACHE_KEY);

        const loadedCards = normalizeCards(safeJsonParse(rawCards, []));
        const loadedQueue = safeJsonParse(rawQueue, []);
        const loadedAiCache = safeJsonParse(rawAiCache, {});

        // If DB empty -> try legacy localStorage import once
        if (loadedCards.length === 0) {
          const legacyRaw = localStorage.getItem(LEGACY_LS_KEY);
          const legacyParsed = safeJsonParse(legacyRaw, []);
          const legacyNormalized = normalizeCards(legacyParsed);

          if (legacyNormalized.length > 0) {
            setCards(legacyNormalized);
            setStudyQueueIds([]); // old app didn't persist queue
            setAiCache(typeof loadedAiCache === "object" && loadedAiCache ? loadedAiCache : {});
            await idbSet(DB_CARDS_KEY, JSON.stringify(legacyNormalized));
            await idbSet(DB_QUEUE_KEY, JSON.stringify([]));
            await idbSet(DB_AI_CACHE_KEY, JSON.stringify(loadedAiCache || {}));
            setHydrated(true);
            return;
          }
        }

        setCards(loadedCards);
        setStudyQueueIds(Array.isArray(loadedQueue) ? loadedQueue.map(String) : []);
        setAiCache(typeof loadedAiCache === "object" && loadedAiCache ? loadedAiCache : {});
        setHydrated(true);
      } catch {
        // If IndexedDB fails (rare), fallback to localStorage (best effort)
        const legacyRaw = localStorage.getItem(LEGACY_LS_KEY);
        const legacyParsed = safeJsonParse(legacyRaw, []);
        setCards(normalizeCards(legacyParsed));
        setStudyQueueIds([]);
        setAiCache({});
        setHydrated(true);
      }
    })();
  }, []);

  // SAVE: cards to IndexedDB (only after load)
  useEffect(() => {
    if (!hydrated) return;
    if (typeof window === "undefined") return;

    (async () => {
      try {
        await idbSet(DB_CARDS_KEY, JSON.stringify(cards));
      } catch {
        // ignore
      }
    })();
  }, [cards, hydrated]);

  // SAVE: queue to IndexedDB
  useEffect(() => {
    if (!hydrated) return;
    if (typeof window === "undefined") return;

    (async () => {
      try {
        await idbSet(DB_QUEUE_KEY, JSON.stringify(studyQueueIds));
      } catch {
        // ignore
      }
    })();
  }, [studyQueueIds, hydrated]);

  // SAVE: AI cache to IndexedDB
  useEffect(() => {
    if (!hydrated) return;
    if (typeof window === "undefined") return;

    (async () => {
      try {
        await idbSet(DB_AI_CACHE_KEY, JSON.stringify(aiCache));
      } catch {
        // ignore
      }
    })();
  }, [aiCache, hydrated]);

  const byId = useMemo(() => new Map(cards.map((c) => [c.id, c])), [cards]);

  const dueCards = useMemo(() => {
    const now = Date.now();
    return cards.filter((c) => (c.srs?.dueMs ?? startOfLocalDayMs()) <= now);
  }, [cards]);

  const isStudyMode = studyQueueIds.length > 0;

  const reviewIds = useMemo(() => {
    if (studyQueueIds.length > 0) {
      const alive = new Set(byId.keys());
      return studyQueueIds.filter((id) => alive.has(id));
    }
    return dueCards.map((c) => c.id);
  }, [studyQueueIds, dueCards, byId]);

  const currentCard = useMemo(
    () => (reviewId ? byId.get(reviewId) || null : null),
    [byId, reviewId]
  );

  useEffect(() => {
    if (tab !== "review") return;
    if (reviewId && reviewIds.includes(reviewId)) return;
    setReviewId(reviewIds[0] ?? null);
    setShowAnswer(false);
  }, [tab, reviewIds, reviewId]);

  // AI Fill: cached per word so repeated clicks keep the same best output
  const aiFill = useCallback(async () => {
    const w = word.trim();
    if (!w) return;

    const key = w.toLowerCase();
    const cached = aiCache?.[key];
    if (cached?.definition && Array.isArray(cached?.examples) && cached.examples.length > 0) {
      setDefinition(String(cached.definition).trim());
      setExamplesText(cached.examples.slice(0, 2).join("\n"));
      setAiError("");
      return;
    }

    setAiLoading(true);
    setAiError("");

    try {
      const tryUrls = [
        `/api/define?word=${encodeURIComponent(w)}`,
        // fallback for local Vite dev if you do not proxy Pages Functions
        ...(import.meta.env.DEV ? [`https://pilot-vocab-cards.pages.dev/api/define?word=${encodeURIComponent(w)}`] : []),
      ];

      let res = null;
      let lastErr = "";

      for (const url of tryUrls) {
        try {
          const r = await fetch(url, { method: "GET" });
          const text = await r.text();

          let data;
          try {
            data = JSON.parse(text);
          } catch {
            throw new Error(`Non-JSON response: ${text.slice(0, 160)}`);
          }

          if (!r.ok) throw new Error(data?.error || "AI error");

          const normalized = normalizeAiPayload(data, w);

          if (!normalized.definition) throw new Error("Empty definition");

          // Apply and persist cache
          setDefinition(normalized.definition);
          setExamplesText(normalized.examples.join("\n"));

          setAiCache((prev) => ({
            ...(prev || {}),
            [key]: { definition: normalized.definition, examples: normalized.examples },
          }));

          res = r;
          lastErr = "";
          break;
        } catch (e) {
          lastErr = e?.message || "AI fill failed";
          // try next url
        }
      }

      if (!res) throw new Error(lastErr || "AI fill failed");
    } catch (e) {
      setAiError(e?.message || "AI fill failed");
    } finally {
      setAiLoading(false);
    }
  }, [word, aiCache]);

  const saveCard = useCallback(() => {
    const w = word.trim();
    const d = definition.trim();
    if (!w || !d) return;

    const examples = examplesText
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 2);

    const newCard = {
      id: uid(),
      word: w,
      definition: clampWords(d, 14),
      examples: ensureTwoExamples(examples.map((t) => clampWords(t, 12)), w),
      srs: { dueMs: startOfLocalDayMs(), intervalDays: 0, ease: 2.5, reps: 0 },
    };

    setCards((prev) => [newCard, ...prev]);

    setWord("");
    setDefinition("");
    setExamplesText("");
    setAiError("");
    setTab("deck");
  }, [word, definition, examplesText]);

  // REVIEW: Keep = rotate to end in study mode; otherwise move pointer to next due
  const keepInReview = useCallback(() => {
    if (!reviewId) return;
    setShowAnswer(false);

    if (studyQueueIds.length > 0) {
      setStudyQueueIds((prev) => {
        if (prev.length <= 1) return prev;
        const idx = prev.indexOf(reviewId);
        if (idx === -1) return prev;
        const next = [...prev];
        const [picked] = next.splice(idx, 1);
        next.push(picked);
        return next;
      });
      return;
    }

    const idx = reviewIds.indexOf(reviewId);
    if (idx === -1 || reviewIds.length === 0) return;
    setReviewId(reviewIds[(idx + 1) % reviewIds.length]);
  }, [reviewId, studyQueueIds, reviewIds]);

  const doneInReview = useCallback(() => {
    if (!reviewId) return;

    setCards((prev) => prev.map((c) => (c.id === reviewId ? schedule(c, 2) : c)));
    setStudyQueueIds((prev) => prev.filter((id) => id !== reviewId));
    setShowAnswer(false);
  }, [reviewId]);

  const studyCard = useCallback((id) => {
    setStudyQueueIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const deleteCard = useCallback((id) => {
    setCards((prev) => prev.filter((c) => c.id !== id));
    setStudyQueueIds((prev) => prev.filter((x) => x !== id));
    setReviewId((prevId) => (prevId === id ? null : prevId));
    setShowAnswer(false);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return cards;
    return cards.filter((c) => {
      const w = (c.word || "").toLowerCase();
      const d = (c.definition || "").toLowerCase();
      return w.includes(q) || d.includes(q);
    });
  }, [cards, search]);

  const dueCount = dueCards.length;
  const reviewMeta = isStudyMode ? `Study queue: ${reviewIds.length}` : `Due: ${dueCount}`;

  return (
    <div style={styles.root}>
      <div style={styles.bg} />

      <div style={styles.shell}>
        <div style={styles.topBar}>
          <div style={styles.brand}>
            <div style={styles.brandMark} />
            <div style={styles.brandTitle}>Pilot Vocab Cards</div>
          </div>

          <div style={styles.tabs}>
            <TabButton active={tab === "review"} onClick={() => setTab("review")}>
              Review <span style={styles.badge}>{reviewIds.length}</span>
            </TabButton>

            <TabButton active={tab === "add"} onClick={() => setTab("add")}>
              Add
            </TabButton>

            <TabButton active={tab === "deck"} onClick={() => setTab("deck")}>
              Deck
            </TabButton>
          </div>
        </div>

        <div style={styles.main}>
          <div style={styles.frameHeader}>
            <div style={styles.frameTitle}>
              {tab === "review" ? "Review" : tab === "add" ? "Add new word" : "Deck"}
            </div>
            <div style={styles.frameMeta}>
              {tab === "review"
                ? reviewMeta
                : tab === "deck"
                ? `${cards.length} cards`
                : "Saved locally"}
            </div>
          </div>

          <div style={styles.frameBody}>
            <div style={tab === "add" ? styles.contentAdd : styles.content}>
              {/* REVIEW */}
              {tab === "review" && (
                <div style={styles.section}>
                  {!currentCard ? (
                    <div style={styles.empty}>
                      <div style={styles.emptyTitle}>
                        {isStudyMode ? "No study cards selected" : "No cards due"}
                      </div>
                      <div style={styles.emptyText}>
                        {isStudyMode
                          ? "Go to Deck and press Study on a few words."
                          : "Add words in Add, then review them here."}
                      </div>
                    </div>
                  ) : (
                    <>
                      <div style={styles.reviewTop}>
                        <button
                          type="button"
                          style={styles.reviewWordBtn}
                          onClick={() => setShowAnswer((v) => !v)}
                          title={showAnswer ? "Hide answer" : "Show answer"}
                        >
                          {currentCard.word}
                        </button>

                        <button
                          style={styles.secondaryBtn}
                          onClick={() => speakWord(currentCard.word)}
                          type="button"
                        >
                          🔊 Speak
                        </button>
                      </div>

                      {showAnswer && (
                        <>
                          <CardView card={currentCard} />

                          <div style={styles.reviewActionRow}>
                            <button
                              style={styles.keepBtn}
                              type="button"
                              onClick={keepInReview}
                              title="Move to next word, keep this one in the review loop"
                            >
                              Keep
                            </button>

                            <button
                              style={styles.doneBtn}
                              type="button"
                              onClick={doneInReview}
                              title="Remove from Review and continue"
                            >
                              Done
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* ADD */}
              {tab === "add" && (
                <div style={styles.section}>
                  <div style={styles.formCard}>
                    <div style={styles.formGrid}>
                      <div style={styles.field}>
                        <div style={styles.label}>Word</div>
                        <input
                          style={styles.inputLarge}
                          placeholder="e.g., aileron"
                          value={word}
                          onChange={(e) => {
                            setWord(e.target.value);
                            if (aiError) setAiError("");
                          }}
                        />
                      </div>

                      <div style={styles.field}>
                        <div style={styles.label}>Definition</div>
                        <input
                          style={styles.inputLarge}
                          placeholder="One short meaning"
                          value={definition}
                          onChange={(e) => setDefinition(e.target.value)}
                        />
                      </div>

                      <div style={{ ...styles.field, gridColumn: "1 / -1" }}>
                        <div style={styles.label}>Examples</div>
                        <textarea
                          style={styles.textareaLarge}
                          placeholder={"Example 1\nExample 2"}
                          value={examplesText}
                          onChange={(e) => setExamplesText(e.target.value)}
                        />
                      </div>
                    </div>

                    <div style={styles.actions}>
                      <button style={styles.primaryBtn} onClick={saveCard} type="button">
                        Add card
                      </button>

                      <button
                        style={styles.secondaryBtn}
                        onClick={aiFill}
                        type="button"
                        disabled={aiLoading || !word.trim()}
                        title="Auto-fill definition and examples using AI"
                      >
                        {aiLoading ? "AI..." : "AI Fill"}
                      </button>

                      <button
                        style={styles.secondaryBtn}
                        type="button"
                        onClick={() => {
                          setWord("");
                          setDefinition("");
                          setExamplesText("");
                          setAiError("");
                        }}
                      >
                        Clear
                      </button>
                    </div>

                    {!!aiError && (
                      <div style={styles.errorBox}>
                        {aiError}
                      </div>
                    )}

                    <div style={styles.hint}>
                      Tip: AI Fill is cached. Clicking again keeps the same best result.
                    </div>
                  </div>
                </div>
              )}

              {/* DECK */}
              {tab === "deck" && (
                <div style={styles.section}>
                  <div style={styles.searchRow}>
                    <input
                      style={styles.input}
                      placeholder="Search word or definition..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>

                  <div style={styles.deckList}>
                    {filtered.length === 0 ? (
                      <div style={styles.empty}>
                        <div style={styles.emptyTitle}>No matches</div>
                        <div style={styles.emptyText}>Try a different search.</div>
                      </div>
                    ) : (
                      filtered.map((c) => {
                        const queued = studyQueueIds.includes(c.id);

                        return (
                          <div key={c.id} style={styles.deckRow}>
                            <div style={styles.deckLeft}>
                              <div style={styles.deckWord}>{c.word}</div>
                              <div style={styles.deckDef}>{c.definition}</div>
                            </div>

                            <div style={styles.deckActions}>
                              <button
                                style={queued ? styles.studyBtnQueued : styles.studyBtn}
                                type="button"
                                onClick={() => studyCard(c.id)}
                                title={queued ? "Already in study queue" : "Add to study queue"}
                              >
                                {queued ? "Queued" : "Study"}
                              </button>

                              <button
                                style={styles.deleteBtn}
                                type="button"
                                onClick={() => deleteCard(c.id)}
                                title="Delete this card"
                              >
                                Delete
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* bottom bar removed */}
        </div>
      </div>
    </div>
  );
}

// ---------- Minimalist Color Palette tokens ----------
const ACCENT = "#00ff66"; // toxic green accent (minimal use)
const BG = "#F6F7F9";
const SURFACE = "#FFFFFF";
const SURFACE_2 = "#F1F3F5";
const BORDER = "rgba(11, 15, 20, 0.12)";
const TEXT = "#0B0F14";
const MUTED = "rgba(11, 15, 20, 0.62)";
const SHADOW = "0 18px 50px rgba(11, 15, 20, 0.12)";
const R = 18;

const styles = {
  root: {
    width: "100vw",
    height: "100vh",
    overflow: "hidden",
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial",
    color: TEXT,
    background: BG,
  },

  bg: {
    position: "fixed",
    inset: 0,
    background:
      "radial-gradient(900px 600px at 20% 15%, rgba(0,255,102,0.08), transparent 60%), radial-gradient(800px 500px at 85% 25%, rgba(0,0,0,0.04), transparent 55%), #F6F7F9",
    pointerEvents: "none",
  },

  shell: {
    position: "relative",
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    padding: 18,
    boxSizing: "border-box",
    gap: 14,
  },

  topBar: {
    flex: "0 0 auto",
    height: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 16px",
    borderRadius: R,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    boxShadow: SHADOW,
  },

  brand: { display: "flex", alignItems: "center", gap: 10, minWidth: 0 },
  brandMark: {
    width: 10,
    height: 10,
    borderRadius: 99,
    background: ACCENT,
    boxShadow: "0 0 14px rgba(0,255,102,0.30)",
    flex: "0 0 auto",
  },
  brandTitle: {
    fontWeight: 950,
    letterSpacing: 0.2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },

  tabs: { display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },

  tabBtn: {
    padding: "10px 12px",
    borderRadius: 999,
    border: `1px solid ${BORDER}`,
    background: SURFACE_2,
    color: TEXT,
    cursor: "pointer",
    fontWeight: 850,
  },
  tabBtnActive: {
    padding: "10px 12px",
    borderRadius: 999,
    border: "1px solid rgba(0,255,102,0.55)",
    background: "rgba(0,255,102,0.10)",
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 22,
    height: 22,
    padding: "0 7px",
    marginLeft: 8,
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 950,
    color: TEXT,
    background: "rgba(0,255,102,0.16)",
    border: "1px solid rgba(0,255,102,0.35)",
  },

  main: {
    flex: "1 1 auto",
    minHeight: 0,
    borderRadius: R,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    boxShadow: SHADOW,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },

  frameHeader: {
    flex: "0 0 auto",
    padding: "14px 16px",
    borderBottom: `1px solid ${BORDER}`,
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    background: "linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.00))",
  },
  frameTitle: { fontSize: 16, fontWeight: 950, letterSpacing: 0.2 },
  frameMeta: { fontSize: 13, fontWeight: 800, color: MUTED },

  frameBody: {
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "auto",
    padding: 16,
    boxSizing: "border-box",
    background: SURFACE,
  },

  content: {
    maxWidth: 980,
    margin: "0 auto",
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },

  // Slightly narrower for Add so it looks tighter and "perfect"
  contentAdd: {
    maxWidth: 860,
    margin: "0 auto",
    minHeight: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },

  section: { display: "flex", flexDirection: "column", gap: 14 },

  empty: {
    padding: 18,
    borderRadius: 16,
    border: `1px dashed ${BORDER}`,
    background: SURFACE_2,
  },
  emptyTitle: { fontSize: 16, fontWeight: 950 },
  emptyText: { marginTop: 6, color: MUTED, fontWeight: 700 },

  reviewTop: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
  },

  reviewWordBtn: {
    padding: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    textAlign: "left",
    fontSize: 38,
    fontWeight: 1000,
    letterSpacing: 0.2,
    lineHeight: 1.05,
    color: TEXT,
  },

  secondaryBtn: {
    padding: "12px 14px",
    borderRadius: 14,
    border: `1px solid ${BORDER}`,
    background: SURFACE_2,
    color: TEXT,
    cursor: "pointer",
    fontWeight: 900,
  },

  primaryBtn: {
    padding: "12px 14px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,102,0.55)",
    background: "rgba(0,255,102,0.12)",
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },

  reviewActionRow: { display: "flex", gap: 10, flexWrap: "wrap" },
  keepBtn: {
    padding: "10px 12px",
    borderRadius: 14,
    border: `1px solid ${BORDER}`,
    background: SURFACE_2,
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },
  doneBtn: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,102,0.55)",
    background: "rgba(0,255,102,0.12)",
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },

  formCard: {
    borderRadius: 18,
    border: `1px solid ${BORDER}`,
    background: "linear-gradient(180deg, rgba(0,255,102,0.06), rgba(0,0,0,0.00))",
    padding: 14,
  },

  formGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12,
  },
  field: { display: "flex", flexDirection: "column", gap: 8 },
  label: {
    fontSize: 12,
    color: MUTED,
    fontWeight: 900,
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },

  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "12px 12px",
    borderRadius: 14,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    color: TEXT,
    outline: "none",
    fontWeight: 750,
  },

  inputLarge: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 12px",
    borderRadius: 14,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    color: TEXT,
    outline: "none",
    fontWeight: 800,
    fontSize: 15,
  },

  textareaLarge: {
    width: "100%",
    boxSizing: "border-box",
    padding: "14px 12px",
    borderRadius: 14,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    color: TEXT,
    outline: "none",
    minHeight: 150,
    resize: "vertical",
    fontWeight: 750,
    lineHeight: 1.4,
    fontSize: 14,
  },

  actions: { display: "flex", gap: 10, flexWrap: "wrap", marginTop: 12 },

  errorBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 14,
    border: "1px solid rgba(220, 20, 60, 0.35)",
    background: "rgba(220, 20, 60, 0.08)",
    color: "crimson",
    fontWeight: 900,
  },

  hint: {
    marginTop: 10,
    color: MUTED,
    fontWeight: 800,
    fontSize: 12,
  },

  searchRow: { display: "flex" },
  deckList: { display: "flex", flexDirection: "column", gap: 10 },
  deckRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 14,
    borderRadius: 16,
    border: `1px solid ${BORDER}`,
    background: SURFACE_2,
  },
  deckLeft: { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 },
  deckWord: { fontWeight: 1000, fontSize: 16, letterSpacing: 0.15 },
  deckDef: {
    color: MUTED,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 640,
  },

  deckActions: { display: "flex", gap: 10, alignItems: "center", flex: "0 0 auto" },

  studyBtn: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,102,0.55)",
    background: "rgba(0,255,102,0.10)",
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },
  studyBtnQueued: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(0,255,102,0.55)",
    background: "rgba(0,255,102,0.18)",
    color: TEXT,
    cursor: "default",
    fontWeight: 950,
    opacity: 0.85,
  },

  deleteBtn: {
    padding: "10px 12px",
    borderRadius: 14,
    border: "1px solid rgba(11,15,20,0.18)",
    background: "rgba(11,15,20,0.06)",
    color: TEXT,
    cursor: "pointer",
    fontWeight: 950,
  },

  card: {
    borderRadius: 18,
    border: `1px solid ${BORDER}`,
    background: SURFACE,
    padding: 14,
    boxShadow: "0 10px 30px rgba(11, 15, 20, 0.08)",
  },
  cardTop: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  cardWord: { fontSize: 22, fontWeight: 1000 },
  cardDef: { marginTop: 8, fontWeight: 700, lineHeight: 1.35, color: TEXT },

  block: { marginTop: 12 },
  blockTitle: {
    color: MUTED,
    fontWeight: 950,
    fontSize: 12,
    letterSpacing: 0.35,
    textTransform: "uppercase",
  },
  ul: { marginTop: 8, paddingLeft: 18, color: TEXT },
  li: { marginBottom: 6, lineHeight: 1.35 },
};
