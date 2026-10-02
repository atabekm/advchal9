# Citations, sources and I don't know

Ten control questions: 7 answerable (q01, q04–q08, q11), 2 unanswerable (q09 off-topic, q13 a
near miss) and 1 ambiguous (q16 "What did the evaluation show?", where the collection has two
evaluations). Both columns use the same `rewrite+rerank` retrieval. `legacy` is task 23's
free-text prompt; `rewrite+rerank` is the cited JSON answer with quote verification and the two
"I don't know" gates. The three checks the task asks for are in **bold** in the totals.

## Reading

**Sources and quotes are in every answer.** All 7 cited answers have sources (source · section ·
pages · chunk_id) and quotes; 30 of 31 quotes were found in their chunk. The legacy prompt also
cites a source in every answer (8 / 8: it was told to), but it has no quotes, so nothing in it
can be checked.

**The quote check catches what it should.** In the final run the one dropped quote is the
document's title, which the model took from the passage label in the prompt, not from the chunk
text (q08, match 85). The answer was retried and the quote dropped. In the first run a genuine
quote failed at 81 because a page break (a footnote URL and the running header) sits in the
middle of the sentence in the chunk; matching now allows one gap (head and tail, ≥ 4 words each,
in order), which scores it 100 and still rejects a changed tail (74).

**The meaning matches the quotes in 5 of 7 answers, partly in 2.** The faithfulness judge sees
only the answer and its quotes. The two partial verdicts are details the model wrote without
quoting them: the Apertium paper's title in q08, and "professional", "controlled studio" and
"two folders" in q11. These facts are true (they are in the chunks), but no quote states them.

**The prompt mattered most.** Three runs of the cited style:

| run | prompt | answers | supported / partial / unsupported | quotes found | quotes per answer | q16 |
|---|---|---:|---|---:|---:|---|
| `T231808` | "every [n] needs a quote" | 7 | 3 / 3 / 1 | 20 / 21 | 2.9 | I don't know |
| `T232030` | + "every fact must be in a quote; drop what you cannot quote" | 8 | 6 / 1 / 1 | 30 / 30 | 3.8 | answered (one evaluation) |
| `T232316` | + "ambiguous question → ask which one" | 7 | 5 / 2 / 0 | 30 / 31 | 4.3 | I don't know + both options |

With only "every [n] needs a quote", the model gave one quote per passage and wrote several
claims around it. Asking for a quote per fact raised the supported answers from 3 to 5–6.
q16 went from "I don't know" to an answer about one evaluation between the first two runs at
temperature 0, so on its own the model is not reliable here; the explicit ambiguity rule made it
name both evaluations and ask which one.

**"I don't know" comes with a clarifying question, 3 / 3.** q09 (creatine) is stopped by the
relevance threshold before the answering LLM (best rerank score 0.225 < 0.3), and a small LLM call
writes the question from the closest sections: "The closest material covers protein and
fat-loss advice in GUTLESS, not creatine dosage. Do you want to narrow the question to protein
intake …?" q13 and q16 pass the threshold (task 23: near misses score like real answers, 0.96)
and are caught by the model itself, which returns status `unknown` with its own question. No
answerable question got "I don't know" (0 / 7). The legacy prompt refuses q09 and q13 too, but
never asks anything back, and answers the ambiguous q16 by describing both evaluations.

**Correctness is unchanged, 8.0 / 10 in both columns.** The partial verdicts are omissions
(q01 leaves out the Tatar National Theatre, q08 the Tatar–Bashqort pair). Across the runs the
correctness judge flagged as hallucinations facts that are in the documents but not in the
written expectation (q05: Daniel Swanson, Google Summer of Code); the faithfulness judge,
which reads the quotes, rated the same answer supported.

**The cost is output tokens and time.** A cited answer writes its quotes, so it is about twice
as long. The mean of 2,053 completion tokens is inflated by one q08 reply that ran to ~16,000
tokens before the retry; without it, cited answers use 140–1,040. Answer latency rises from 1.7 s
to 7.3 s mean, but that is mostly q08 (48.8 s for the long reply and its retry); on the other
questions a cited answer takes 1.7–4.9 s against 1.2–3.3 s, and q09's "I don't know" adds a
2.8 s clarifying call where legacy refuses instantly.

**Limits.** The ten questions also tuned the prompt, so these numbers are optimistic. The
faithfulness judge is the same model family as the answerer. Run-to-run variance is visible even
at temperature 0 (q16 above). The gap match lets a quote skip one stretch of the chunk, so a
quote stitched from two nearby sentences in order would pass.

## Generated results

<!-- eval:start -->
Run `2026-10-02T23:23:16`: answers from `deepseek-flash`, graded by `deepseek-flash`, k_before = 20 per query, k_after = 5, temperature 0.

### Totals

|  | legacy:rewrite+rerank | rewrite+rerank |
|---|---:|---:|
| answers / I don't know | 8 / 2 | 7 / 3 |
| **sources** in the answer | 8 / 8 | 7 / 7 |
| **quotes** in the answer | 0 / 8 | 7 / 7 |
| quotes found in their chunk (match ≥ 90) | — | 30 / 31 |
| answers retried for format or quotes | 0 | 1 |
| **meaning matches the quotes** (faithfulness judge): supported | — | 5 / 7 |
|   partial | — | 2 / 7 |
|   unsupported | — | 0 / 7 |
| I don't know where expected (3) | 2 / 3 | 3 / 3 |
|   with a clarifying question | 0 / 3 | 3 / 3 |
|   of them before the LLM (relevance below the threshold) | 1 | 1 |
| I don't know on an answerable question (7) | 0 / 7 | 0 / 7 |
| cites an expected source (answerable) | 7 / 7 | 7 / 7 |
| expected source in the context, hit@5 (answerable) | 7 / 7 | 7 / 7 |
| correctness judge (correct 1, partial ½) | 8.0 / 10 | 8.0 / 10 |
|   correct | 6 | 6 |
|   partial | 4 | 4 |
|   wrong | 0 | 0 |
|   refused | 0 | 0 |
| hallucinations (correctness judge) | 0 | 0 |
| keyword score (mean) | 80% | 100% |
| prompt tokens (mean) | 1,630 | 2,302 |
| completion tokens (mean) | 186 | 2,053 |
| latency: answer (mean) | 1.7s | 7.3s |
| latency: total (mean) | 7.7s | 13.3s |

### Per question

Correctness: ✅ correct · 🟡 partial · ❌ wrong · ⛔ refused (on the unanswerable and ambiguous questions, a refusal counts as ✅). Then for an answer: `NS` sources, `a/bQ` quotes found in their chunk / quotes given, `F✓` / `F~` / `F✗` the faithfulness verdict (supported / partial / unsupported). For an "I don't know": `IDK`, `+?` with a clarifying question, `∅` decided before the LLM (relevance below the threshold). `H`: the correctness judge flagged a hallucination.

| id | kind | legacy:rewrite+rerank | rewrite+rerank |
|---|---|---|---|
| q01 | fact | 🟡 3S 0Q | 🟡 2S 3/3Q F✓ |
| q04 | fact | ✅ 2S 0Q | ✅ 1S 3/3Q F✓ |
| q05 | explain | 🟡 1S 0Q | 🟡 1S 4/4Q F✓ |
| q06 | fact | ✅ 1S 0Q | ✅ 2S 3/3Q F✓ |
| q07 | fact | ✅ 2S 0Q | ✅ 2S 2/2Q F✓ |
| q08 | multi | 🟡 5S 0Q | 🟡 4S 7/8Q F~ |
| q11 | explain | ✅ 3S 0Q | 🟡 2S 8/8Q F~ |
| q09 | unanswerable | ✅ IDK ∅ | ✅ IDK+? ∅ |
| q13 | unanswerable | ✅ IDK | ✅ IDK+? |
| q16 | ambiguous | 🟡 3S 0Q | ✅ IDK+? |

### Keyword check vs judge

No disagreements.

### Answers

<details><summary><b>q01</b> How many hours of speech does the TatarTTS dataset contain, and who recorded it?</summary>

**Expected:** About 70 hours of transcribed audio (over 38,000 segments) from two professional speakers, one male (36.2 h) and one female (33.9 h), actors of the Tatar National Theatre.

**legacy:rewrite+rerank**: 🟡 *It correctly gives ~70 hours, 38,000 segments, two professional speakers with 36.2 h male and 33.9 h female, but omits that they are actors of the Tatar National Theatre.*

> The TatarTTS dataset contains approximately 70 hours of transcribed audio recordings [3], made up of over 38,000 segments from two professional speakers, one male and one female [1]. Table I gives 36.2 h for the male speaker and 33.9 h for the female speaker [4].

Sources:

- [3] `1570978467.pdf` · (front matter) · p. 1 · `1570978467:struct:0000`
- [1] `1570978467.pdf` · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2 · `1570978467:struct:0009`
- [4] `1570978467.pdf` · II. RELATED WORKS > B. NLP for Tatar Language · p. 2 · `1570978467:struct:0006`

**rewrite+rerank**: 🟡 *It gives the ~70 hours and two professional speakers (one male, one female), but omits the individual speaker durations (36.2 h / 33.9 h) and that the speakers were actors of the Tatar National Theatre.*

> The TatarTTS dataset contains around 70 hours of audio [1], or approximately 70 hours of transcribed audio recordings [3]. It was recorded by two professional speakers, one male and one female [3]; the recordings come from two speakers, one male and one female [1].

Sources:

- [1] `1570978467.pdf` · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2 · `1570978467:struct:0009`
- [3] `1570978467.pdf` · (front matter) · p. 1 · `1570978467:struct:0000`

Quotes:

- ✓ 100 [1] “In total, the dataset contains around 70 hours of audio consisting of over 38,000 segments.”
- ✓ 100 [1] “The TatarTTS dataset comprises speech recordings from two speakers, one male and one female speaker.”
- ✓ 100 [3] “The dataset comprises approximately 70 hours of transcribed audio recordings, featuring two professional speakers (one male and one female).”

Faithfulness: **supported**. The quotes state the dataset contains around 70 hours of audio/transcribed recordings and was recorded by two speakers, one male and one female, matching the answer's claims.

</details>

<details><summary><b>q04</b> How did the apertium-anaphora module change the accuracy of anaphor translation in its preliminary evaluation?</summary>

**Expected:** Spanish–English (120 anaphors): accuracy rose from 29.2% to 54.2%. Catalan–Italian (108 anaphors): it fell from 83.3% to 75.0%, because the test data was skewed towards singular antecedents, which the default translation already covers.

**legacy:rewrite+rerank**: ✅ *The answer correctly reports the Spanish–English increase from 29.2% to 54.2% and the Catalan–Italian decrease from 83.3% to 75.0%, matching the expectation's key facts without contradiction.*

> In the preliminary evaluation, the module increased accuracy for Spanish–English from 29.2% to 54.2%, but caused a slight decrease for Catalan–Italian, from 83.3% to 75.0% [2]. The evaluation covered 120 Spanish–English sentences and 108 Catalan–Italian sentences, with only third person possessive determiners marked as anaphors [1][2].

Sources:

- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · pp. 15–16 · `s10590-021-09260-6:struct:0039`
- [1] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · p. 15 · `s10590-021-09260-6:struct:0038`

**rewrite+rerank**: ✅ *The answer correctly reports both key results (Spanish–English 29.2%→54.2%, Catalan–Italian 83.3%→75.0%) with no contradictions, though it omits the explanation about skewed test data.*

> Using the apertium-anaphora module raised accuracy for Spanish–English but slightly lowered it for Catalan–Italian: Spanish–English went from 29.2% without anaphora resolution to 54.2% with it [2], while Catalan–Italian went from 83.3% without to 75.0% with it [2]. Overall, use of the module led to an increase in accuracy of anaphor translation for Spanish–English, but for Catalan–Italian it resulted in a slight decrease in the accuracy of resolution [2].

Sources:

- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · pp. 15–16 · `s10590-021-09260-6:struct:0039`

Quotes:

- ✓ 100 [2] “Spanish–English 120 29.2 54.2”
- ✓ 100 [2] “Catalan–Italian 108 83.3 75.0”
- ✓ 100 [2] “For Spanish–English translation, use of the module led to an increase in accuracy of anaphor translation, but for Catalan–Italian it resulted in a slight decrease in the accuracy of resolution.”

Faithfulness: **supported**. All figures (29.2→54.2 for Spanish–English, 83.3→75.0 for Catalan–Italian) appear in the quoted data, and the directional conclusion is stated verbatim in the third quote.

</details>

<details><summary><b>q05</b> Why was the apertium-recursive module developed, and how does it work?</summary>

**Expected:** The finite-state chunker only matches fixed, contiguous word sequences, so long-distance reordering and nested structures (relative clauses, prepositional phrases inside prepositional phrases) need many rules. apertium-recursive applies transfer rules recursively with context-free grammars and a GLR parser. Example: the 30+ English–Spanish noun-phrase rules shrink to fewer than 10 (mostly 3).

**legacy:rewrite+rerank**: 🟡 *It correctly describes the CFG/GLR recursive mechanism and mentions nested structures, but the reason for development is only vaguely stated (no fixed/contiguous matching or long-distance reordering detail) and the 30+ rules shrinking to under 10 example is missing.*

> The apertium-recursive module was developed to deal with the limitations of finite-state chunking [2]. It applies structural transfer rules recursively using context-free grammars (CFGs) and a Generalized Left-right Right-reduce (GLR) parser, which makes it possible to process nested structures such as relative clauses or prepositional phrases within prepositional phrases [2].

Sources:

- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.1  Recursive structural transfer · pp. 8–9 · `s10590-021-09260-6:struct:0022`

**rewrite+rerank**: 🟡 *It captures the recursive CFG/GLR mechanism and nested structures, but the stated rationale is vague and omits the fixed contiguous-sequence limitation, long-distance reordering, rule explosion, and the 30+ to under-10 rule example.*

> The apertium-recursive module was developed to deal with the limitations of finite-state chunking [2]. It works by applying structural transfer rules recursively using context-free grammars (CFGs) and a Generalized Left-right Right-reduce (GLR) parser [2], which makes it possible to process nested structures such as relative clauses or prepositional phrases within prepositional phrases [2].

Sources:

- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.1  Recursive structural transfer · pp. 8–9 · `s10590-021-09260-6:struct:0022`

Quotes:

- ✓ 100 [2] “To deal with the limitations of finite-state chunking, the apertium-recursive module (Swanson et al. 2021) was developed by Daniel Swanson as part of Google Summer of Code 2019”
- ✓ 100 [2] “to apply structural transfer rules recursively using contextfree grammars (CFGs) and a Generalized Left-right Right-reduce (GLR) parser.”
- ✓ 100 [2] “This makes it possible to process nested structures such as relative clauses or prepositional”
- ✓ 100 [2] “phrases within prepositional phrases.”

Faithfulness: **supported**. All claims—the motivation (limitations of finite-state chunking), the recursive CFG/GLR mechanism, and the ability to handle nested structures—are stated directly in the cited quotes.

</details>

<details><summary><b>q06</b> What are the three golden rules of fat loss in Gutless?</summary>

**Expected:** 1. Calories: a calorie deficit is the only requirement for fat loss. 2. Protein: it fills you up and spares muscle. 3. Consistency (sustainability): a diet you can stick to.

**legacy:rewrite+rerank**: ✅ *The answer names all three golden rules from the expectation (Calories, Protein, Consistency), matching the expected content without contradiction, even though it does not elaborate on each.*

> The three golden rules of fat loss in *Gutless* are: **1. Calories, 2. Protein, and 3. Consistency** [1].

Sources:

- [1] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11 · `gutless:struct:0012`

**rewrite+rerank**: ✅ *The answer names all three golden rules (Calories, Protein, Consistency) as in the expectation, with no contradicting facts, though it gives less detail on protein and consistency.*

> The three golden rules of fat loss are 1. Calories, 2. Protein, and 3. Consistency [1]. As long as you follow those three principles, you're going to lose fat [1]. Rule one concerns the amount of energy — measured in calories — that you get from your diet [2].

Sources:

- [1] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11 · `gutless:struct:0012`
- [2] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · p. 9 · `gutless:struct:0010`

Quotes:

- ✓ 100 [1] “1. Calories 2. Protein 3. Consistency”
- ✓ 100 [1] “As long as you’re following those three principles, you’re going to lose fat.”
- ✓ 100 [2] “RULE ONE​: Rule number one concerns the amount of energy - measured in calories - that you get from your diet.”

Faithfulness: **supported**. All factual claims in the answer are directly backed by the cited quotes.

</details>

<details><summary><b>q07</b> Using the simple method from Gutless, how many calories per day should a 185-pound person eat to lose fat?</summary>

**Expected:** Multiply body weight in pounds by 10–12: between 1,850 and 2,220 calories a day (11 per pound if unsure; 10 if inactive, 12 if very active).

**legacy:rewrite+rerank**: ✅ *The answer gives the 10–12 multiplier range (1,850–2,220 calories) and the 11-per-pound middle estimate, matching the expectation exactly.*

> For a 185-pound person using the simple method, the estimated calorie intake for fat loss is between **1,850 calories per day** (185 × 10) and **2,220 calories per day** (185 × 12) [1]. If unsure, the middle number is **11 calories per pound**, or about **2,035 calories per day** [3].

Sources:

- [1] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11 · `gutless:struct:0012`
- [3] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 11–12 · `gutless:struct:0013`

**rewrite+rerank**: ✅ *The answer gives the 10–12 multiplier, the 1,850–2,220 range for 185 lb, and the 11-per-pound middle guidance, matching the expectation exactly.*

> With the simple method, take your current body weight in pounds and multiply it by a number between 10 and 12, so a 185-pound person's estimated intake for fat loss is between 1850 and 2220 calories per day [1]. If you're not sure which end to use, use the middle number of 11 calories per pound of bodyweight [3].

Sources:

- [1] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11 · `gutless:struct:0012`
- [3] `Gutless.pdf` · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 11–12 · `gutless:struct:0013`

Quotes:

- ✓ 100 [1] “if you currently weigh 185 pounds, your estimated calorie intake for fat loss is somewhere between 1850 calories (185 x 10 = 1850) and 2220 calories (185 x 12 = 2220) per day.”
- ✓ 100 [3] “If you're not sure, just use the middle number (11 calories per pound of bodyweight).”

Faithfulness: **supported**. The quotes directly support the 10–12 calorie-per-pound range, the 1850–2220 daily calorie estimate for 185 pounds, and using 11 calories per pound as the middle number.

</details>

<details><summary><b>q08</b> Which documents in the collection deal with the Tatar language, and in what way?</summary>

**Expected:** Two documents. The TatarTTS paper introduces a 70-hour open-source text-to-speech dataset and baseline models for Tatar. The Apertium paper covers Tatar in machine translation: a released Kazakh–Tatar pair, Tatar listed as a Turkic language with minority status, and Tatar–Bashqort among unreleased pairs.

**legacy:rewrite+rerank**: 🟡 *It correctly covers the TatarTTS dataset (70 hours, baselines) and notes Tatar's minority status, but omits the Apertium paper's Kazakh–Tatar released pair, Tatar–Bashqort unreleased pair, and Tatar's classification as a Turkic language.*

> Two documents in the context deal with Tatar: - **TatarTTS** ([1], [3], [5]): an open-source text-to-speech synthesis dataset for the Tatar language — about 70 hours of transcribed audio from two professional speakers (one male, one female), the first large-scale publicly available dataset of its kind, with baseline TTS models built and evaluated by MOS [1][5]. The motivation is the lack of datasets for low-resourced languages, despite Tatar having more than 5 million speakers worldwide [3]. - **Recent advances in Apertium** ([2], [4]): Tatar (and Crimean Tatar) appear in the list of languages with released translation pairs [2]; Tatar is described as holding minority status in its state, and Crimean Tatar as vulnerable or endangered [4]. This paper deals with Tatar only as one of many languages supported by a rule-based machine translation platform, not with TTS.

Sources:

- [1] `1570978467.pdf` · (front matter) · p. 1 · `1570978467:struct:0000`
- [3] `1570978467.pdf` · I. INTRODUCTION · p. 1 · `1570978467:struct:0002`
- [5] `1570978467.pdf` · VI. CONCLUSION · p. 4 · `1570978467:struct:0016`
- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 7  Conclusion · p. 23 · `s10590-021-09260-6:struct:0059`
- [4] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 5  Supporting minoritised languages > 5.1  Released translation pairs · p. 18 · `s10590-021-09260-6:struct:0047`

**rewrite+rerank**: 🟡 *Identifies both correct documents and some key facts (70-hour TatarTTS dataset, Tatar minority status), but omits the baseline models, Tatar's listing as a Turkic language, and the unreleased Tatar–Bashqort pair, and adds unsupported Crimean Tatar details.*

> The documents that deal with Tatar are the TatarTTS paper and the Apertium paper. The TatarTTS paper [1] introduces an open-source dataset for speech synthesis in the Tatar language [1] and presents the TatarTTS corpus, which consists of 70 hours of transcribed speech from two speakers (one male and one female) [5]. The Apertium paper ('Recent advances in Apertium, a free/open-source rule-based machine translation platform for low-resource languages') [2] lists Tatar among its released languages [2] and states that Tatar holds minority status [4]; it also lists Crimean Tatar among its released languages [2] and notes that Crimean Tatar is considered vulnerable or endangered [4].

Sources:

- [1] `1570978467.pdf` · (front matter) · p. 1 · `1570978467:struct:0000`
- [5] `1570978467.pdf` · VI. CONCLUSION · p. 4 · `1570978467:struct:0016`
- [2] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 7  Conclusion · p. 23 · `s10590-021-09260-6:struct:0059`
- [4] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 5  Supporting minoritised languages > 5.1  Released translation pairs · p. 18 · `s10590-021-09260-6:struct:0047`

Quotes:

- ✓ 100 [1] “This paper introduces an open-source dataset for speech synthesis in the Tatar language.”
- ✓ 100 [5] “This study presents the TatarTTS corpus, which consists of 70 hours of transcribed speech from two speakers (one male and one female).”
- ✓ 100 [2] “The released languages are:25”
- ✓ 100 [2] “Bulgarian Maltese* Tatar*”
- ✓ 100 [2] “Catalan Norwegian Bokmål Crimean Tatar*”
- ✓ 100 [4] “Other languages hold minority status in their states, like Afrikaans, Catalan, Galician, Silesian, and Tatar.”
- ✓ 100 [4] “Eleven of the forty-four languages with released translators are considered vulnerable or endangered (Moseley 2010): Aragonese, Arpitan, Asturian, Basque, Belarusian, Breton, Crimean Tatar, North Sámi, Occitan, Sardinian, and Welsh.”
- ✗ 85 [2] “Recent advances in Apertium, a free/open-source rule-based machine translation platform for low-resource languages” (dropped)

Faithfulness: **partial**. The TatarTTS details and the Tatar/Crimean Tatar released-language and status claims are backed, but the Apertium paper name/title is not supported by the quotes. Unsupported: The identification of the second document as the Apertium paper and its title 'Recent advances in Apertium, a free/open-source rule-based machine translation platform for low-resource languages'; the quotes do not mention Apertium or this title.

Retried (2 attempts): these quotes are not copied word for word from the passage they cite: [2] "Recent advances in Apertium, a free/open-source rule-based machine translation p…" (best match 85%). Copy each quote exactly from its passage, and drop any claim you cannot quote

</details>

<details><summary><b>q11</b> How was that open voice dataset for a Turkic language put together?</summary>

**Expected:** TatarTTS: texts taken from the Tatar language corpus (fiction, media, official, educational and scientific texts) and checked to be free of grammatical errors; read by two Tatar National Theatre actors experienced in TV and radio narration; recorded in a controlled studio with Neumann microphones and Steinberg Cubase at 44.1 kHz / 32 bit; then transcribers manually segmented the recordings into sentences.

**legacy:rewrite+rerank**: ✅ *The answer covers all key expectation facts (Tatar corpus sources with grammatical-error checking, two Tatar National Theatre actors experienced in TV/radio narration, controlled studio with Neumann mics and Steinberg Cubase at 44.1 kHz/32-bit, manual sentence segmentation), with only extra non-contradictory details.*

> The dataset (TatarTTS, for Tatar — a Turkic language [1]) was assembled as follows: - Text content was sourced from the Tatar language corpus, covering genres such as fiction, media texts, official documents, educational literature, and scientific publications, with texts carefully selected to be free of grammatical errors [5]. - Speakers were chosen from Tatar National Theatre actors who were fluent in Tatar and experienced in narrating TV and radio programs [5]. - Recordings were made in a controlled studio to minimize external noise, using professional equipment including Neumann microphones and the Steinberg Cubase digital audio workstation, sampled at 44.1 kHz with 32-bit depth [5]. - The result comprises about 70 hours of audio with over 38,000 segments from two professional speakers (one male, one female), with nearly equal data for each; the data is stored in two separate folders, each with a CSV file (audio file name and corresponding text) and a sub-folder of WAV recordings [4].

Sources:

- [1] `1570978467.pdf` · (front matter) · p. 1 · `1570978467:struct:0000`
- [5] `1570978467.pdf` · III. DATASET CONSTRUCTION > A. Tatar Speech Corpus · p. 2 · `1570978467:struct:0007`
- [4] `1570978467.pdf` · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2 · `1570978467:struct:0009`

**rewrite+rerank**: 🟡 *Covers text sourcing, the two Tatar National Theatre actors, and the studio/microphone/Cubase/44.1 kHz-32-bit recording details, but omits the expectation's key step that transcribers manually segmented the recordings into sentences (adding instead extra segment-count figures not in the expectation).*

> The TatarTTS dataset was built by sourcing its text from the Tatar language corpus, with texts chosen to be free of grammatical errors [5]. Narration was done by two professional speakers (one male, one female) picked from Tatar National Theatre actors fluent in Tatar and experienced in narrating TV and radio programs [5][4]. Recordings used professional equipment including Neumann microphones and the Steinberg Cubase digital audio workstation in a controlled studio, sampled at 44.1 kHz with 32-bit depth [5]. The result is around 70 hours of audio with over 38,000 segments, nearly equally split between the two speakers, stored in two folders each containing one CSV file and one sub-folder [4].

Sources:

- [5] `1570978467.pdf` · III. DATASET CONSTRUCTION > A. Tatar Speech Corpus · p. 2 · `1570978467:struct:0007`
- [4] `1570978467.pdf` · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2 · `1570978467:struct:0009`

Quotes:

- ✓ 100 [5] “The textual content for the dataset was sourced from the Tatar language corpus4.”
- ✓ 100 [5] “It is important to note that the texts selected for the dataset were carefully chosen to ensure they were free of grammatical errors.”
- ✓ 100 [5] “Speakers were chosen from Tatar National Theatre actors who demonstrated fluency in the Tatar language and possessed experience in narrating TV and radio programs.”
- ✓ 100 [5] “a range of professional equipment, including Neumann microphones and the Steinberg Cubase digital audio workstation, was utilized for the recordings”
- ✓ 100 [5] “The recordings were sampled at a frequency of 44.1 kHz with bit depth of 32 bits, ensuring a sufficient level of detail in the audio.”
- ✓ 100 [4] “The TatarTTS dataset comprises speech recordings from two speakers, one male and one female speaker.”
- ✓ 100 [4] “In total, the dataset contains around 70 hours of audio consisting of over 38,000 segments.”
- ✓ 100 [4] “Each folder contains one CSV file and one sub-folder.”

Faithfulness: **partial**. The core construction details are quoted, but the answer adds unsupported specifics about speakers being professional, a controlled studio, equal data split, and exactly two folders. Unsupported: professional speakers; in a controlled studio; nearly equally split between the two speakers; two folders

</details>

<details><summary><b>q09</b> According to Gutless, how many grams of creatine should you take per day?</summary>

**Expected:** Gutless does not discuss creatine. The reply should be "I don't know" with a clarifying question; it should say the documents do not cover it, not give a dose.

**legacy:rewrite+rerank**: ✅ *The answer correctly declines, stating the documents do not contain the answer, which matches the expectation that Gutless does not discuss creatine.*

> I don't know: the documents do not contain the answer.

**rewrite+rerank**: ✅ *The answer correctly states the documents do not cover creatine dosage and asks a clarifying question, matching the expected refusal.*

> I don't know: the documents do not contain the answer. The closest material covers protein and fat-loss advice in GUTLESS, not creatine dosage. Do you want to narrow the question to protein intake or ask about a different supplement topic in the collection?

</details>

<details><summary><b>q13</b> How many native Tatar speakers took part in the TatarTTS listening evaluation?</summary>

**Expected:** The paper does not give the number of raters. It says native speakers rated 200 held-out utterances through a Telegram bot, 30 recordings per session, until every audio had at least one rating. The reply should be "I don't know" with a clarifying question; it should say the number is not stated.

**legacy:rewrite+rerank**: ✅ *The answer correctly states the documents do not give the number of native Tatar speakers, while accurately describing the evaluation method from the expectation.*

> The documents do not contain the answer. The context describes the evaluation method — a Telegram bot shared with native Tatar speakers, with 30 recordings per session rated on a 1–5 scale [1] — but it does not state how many native speakers participated.

Sources:

- [1] `1570978467.pdf` · IV. TTS EXPERIMENTS > C. Model Evaluation · p. 3 · `1570978467:struct:0013`

**rewrite+rerank**: ✅ *The answer correctly refuses, stating the documents never give the number of raters, and asks a clarifying question, matching the expectation.*

> I don't know: the documents do not contain the answer. The passages describe the listening evaluation (a Telegram bot survey with native Tatar speakers rating 30 recordings per session on a 1-5 scale) but never state how many participants took part. Could you ask about something the passages do report, such as the size of the testing set or the number of recordings per session?

</details>

<details><summary><b>q16</b> What did the evaluation show?</summary>

**Expected:** Ambiguous: the collection has several evaluations (the TatarTTS MOS listening test, the apertium-anaphora preliminary evaluation). The reply should be "I don't know" and ask which evaluation is meant, ideally naming the options. Answering for one of them with the right figures is acceptable but not preferred; inventing results is wrong.

**legacy:rewrite+rerank**: 🟡 *It helpfully names and describes both evaluations rather than asking which one is meant as the expectation prefers, and adds specifics (30 hours, 120/108 sentences) not verifiable against the expectation, though nothing stated contradicts it.*

> Two evaluations appear in the context: - **Tatar TTS models**: Evaluated with Mean Opinion Score (MOS) by native speakers on audio quality, pronunciation, naturalness, and comprehensibility (1–5 scale) [5]. The findings showed that even with a relatively limited 30 hours of training data, reasonably good MOS performance can be achieved; the models show notable naturalness and sound quality, though with limitations in coherence and clear pronunciation [3]. - **Apertium anaphora module**: Manually evaluated on Spanish–English and Catalan–Italian by rating the translation of anaphors with and without the module in the pipeline, using only third-person possessive determiners (120 Spanish sentences and 108 Catalan sentences with at least one possessive determiner) [4].

Sources:

- [5] `1570978467.pdf` · IV. TTS EXPERIMENTS > C. Model Evaluation · p. 3 · `1570978467:struct:0013`
- [3] `1570978467.pdf` · VI. CONCLUSION · p. 4 · `1570978467:struct:0016`
- [4] `s10590-021-09260-6.pdf` · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · p. 15 · `s10590-021-09260-6:struct:0038`

**rewrite+rerank**: ✅ *The reply correctly identifies the question as ambiguous, declines to give a single answer, and names the two candidate evaluations (apertium-anaphora preliminary evaluation and Tatar TTS MOS evaluation), which matches the expected behaviour.*

> I don't know: the documents do not contain the answer. The passages describe more than one evaluation: a preliminary manual evaluation of the apertium-anaphora module on Spanish–English and Catalan–Italian, and a MOS-based evaluation of Tatar TTS models by native speakers via a Telegram bot. Which one did you mean?

</details>
<!-- eval:end -->
