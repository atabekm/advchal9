# RAG vs no RAG

Ten control questions about the three indexed documents ([questions.json](questions.json)),
each asked three ways:

- **plain**: the question alone, and the model answers from what it knows.
- **rag/struct**: the top 5 chunks of the structure-based index, placed before the question.
- **rag/fixed**: the same with the fixed 1000-character chunks.

Each answer is scored twice. A **keyword check** looks for the terms a correct answer must
contain. An **LLM judge** compares the answer with the written expectation and returns
correct / partial / wrong / refused plus a hallucination flag; it never sees the mode or
the context. For RAG answers, **retrieval** is also checked: did the top 5 include a chunk
from the expected document and pages?

Raw answers and verdicts are in [eval/](eval/). The block between the markers is generated
by `uv run rag eval --markdown EVAL.md`; `--report eval/run-….json` rebuilds it without
calling the LLM.

## Reading

**RAG wins where the model can't know the answer.** Plain mode scores 3.0 / 10 and makes
up specifics on five questions. It gives 12 hours "recorded by SberDevices" for a 70-hour
dataset read by two theatre actors (q01), ESPnet instead of Piper (q02), invented accuracy
figures (q04), and a confident "5 grams of creatine per day" from a book that never
mentions creatine (q09). With retrieval, the same model scores 8.5 (struct) and 7.0
(fixed), with one flagged hallucination, and that one is a judge error (see below).

**Refusing is the RAG failure mode, and it's the safe one.** Every RAG miss is either a
refusal ("The documents do not contain the answer") or a partial answer that names what
is missing. There are no wrong answers. Plain mode fails the other way: it refused twice,
but gave wrong answers three times.

**Where RAG fell short, retrieval was the cause, not generation.** In each such case the
answer matched what the context actually contained:

- *q04, fixed*: counted as a retrieval "hit" at rank 1, yet the model refused. The fixed
  window cut §4.3.3 between the setup (120 sentences from Europarl…) and Table 2; the chunk
  with the numbers was not in the top 5. A page-level hit is too coarse: the right page is
  not always the right chunk.
- *q05, fixed*: the abstract and introduction mention "a module that allows rules to process
  recursive structures" and outrank §4.1 itself (ranks 6–7). The model said the context
  only names the module, which was true.
- *q06, both*: the struct chunker splits a long section into several chunks and repeats the
  heading only in the first. Only the chunk with Rule One ranked high enough, so both RAG
  answers explain Rule One and say Rules Two and Three are missing.
- *q08, multi-document*: every TatarTTS chunk mentions Tatar, so that paper takes all five
  slots in both indexes, and the first Apertium chunk is at rank 9 (struct) or 11 (fixed).
  Top-k over a corpus where one document is all about the topic crowds out the others. The
  fix would be per-document diversity (MMR) or a larger k, not a better prompt.

**struct vs fixed.** Struct wins 8.5 to 7.0, with retrieval hits of 7 / 8 vs 6 / 8. Whole
sections keep a claim and its evidence together (q04, q05). Fixed windows are better when
the answer is one short passage inside a long section (q07: rank 1 vs 3), but q04 shows
the cost: the window can cut a result off from its setup.

**Cost.** RAG sends ~1,600 prompt tokens instead of ~80 but answers in ~2 s. Plain mode
averages 31 s and 6,700 completion tokens, because `deepseek-flash` reasons at length
when it has no context to read from. With the passages in front of it, it answers in
~220 tokens.

**The two scores mostly agree, with two notes.** The keyword check and the judge disagree
once (q10 plain: an honest "I don't recall" contains none of the refusal phrases the keyword
check looks for, and the judge correctly counts it as right). The judge has blind spots of
its own:

- It marks as partial any answer that leaves out a detail of the expectation (q01 struct
  omits the per-speaker hours).
- It flagged q08/struct as a hallucination for "all of the passages come from a single
  document". That statement is true of the context; the real problem is the retrieval miss.
- It penalises correct facts that are not written in the expectation. The plain answer to
  q05 names Daniel Swanson as the module's author, which the paper confirms, and the judge
  called it unsupported.

Since the same model answers and judges, the judge column is read next to the keyword
column rather than on its own.

<!-- eval:start -->
Run `2026-09-30T22:22:25`: answers from `deepseek-flash`, graded by `deepseek-flash`, k = 5, temperature 0.

### Totals

|  | plain | rag/struct | rag/fixed |
|---|---:|---:|---:|
| judge score (correct 1, partial ½) | 3.0 / 10 | 8.5 / 10 | 7.0 / 10 |
|   correct | 1 | 7 | 6 |
|   partial | 4 | 3 | 2 |
|   wrong | 3 | 0 | 0 |
|   refused | 2 | 0 | 2 |
| hallucinations (judge) | 5 | 1 | 0 |
| keyword score (mean) | 13% | 90% | 73% |
| keywords all matched | 0 / 10 | 8 / 10 | 7 / 10 |
| retrieval hit@5 (answerable) | — | 7 / 8 | 6 / 8 |
| cites an expected source | — | 8 / 8 | 7 / 8 |
| prompt tokens (mean) | 79 | 1,657 | 1,508 |
| completion tokens (mean) | 6,686 | 220 | 215 |
| latency (mean) | 30.9s | 1.9s | 1.9s |

### Per question

✅ correct · 🟡 partial · ❌ wrong · ⛔ refused, then the keyword score, `H` when the judge flagged a hallucination, and for RAG the rank of the first chunk from an expected source (`rN`) or `miss`. On the unanswerable questions (q09, q10), a refusal counts as ✅.

| id | kind | plain | rag/struct | rag/fixed |
|---|---|---|---|---|
| q01 | fact | ❌ 0% H | 🟡 100% · r1 | ✅ 100% · r1 |
| q02 | fact | 🟡 50% H | ✅ 100% · r1 | ✅ 100% · r2 |
| q03 | explain | 🟡 33% | ✅ 67% · r1 | ✅ 100% · r1 |
| q04 | fact | ❌ 0% H | ✅ 100% · r2 | ⛔ 0% · r1 |
| q05 | explain | 🟡 0% H | ✅ 100% · r1 | ⛔ 0% · miss |
| q06 | fact | ⛔ 0% | 🟡 33% · r2 | 🟡 33% · r3 |
| q07 | fact | 🟡 50% | ✅ 100% · r3 | ✅ 100% · r1 |
| q08 | multi | ⛔ 0% | 🟡 100% H · r1 partial | 🟡 100% · r1 partial |
| q09 | unanswerable | ❌ 0% H | ✅ 100% | ✅ 100% |
| q10 | unanswerable | ✅ 0% | ✅ 100% | ✅ 100% |

### Keyword check vs judge

- q10 plain: no keywords, judge says correct: The expectation says the documents do not contain a WER figure, and the answer declines to give one without inventing a number, which is the right behaviour.

### Answers

<details><summary><b>q01</b> How many hours of speech does the TatarTTS dataset contain, and who recorded it?</summary>

**Expected:** About 70 hours of transcribed audio (over 38,000 segments) from two professional speakers, one male (36.2 h) and one female (33.9 h), actors of the Tatar National Theatre.

**plain**: ❌ *The answer states 12 hours and a single speaker from SberDevices, contradicting the expected ~70 hours from two professional Tatar National Theatre actors.*

> The TatarTTS dataset contains **12 hours of speech**. It was recorded by **SberDevices**, with the voice recordings performed by native Tatar speaker **Aigul Khusainova**.

**rag/struct**: 🟡 *It correctly states ~70 hours of transcribed audio from two professional speakers (one male, one female), but omits the specific per-speaker durations and that they are actors of the Tatar National Theatre.*

> The TatarTTS dataset contains approximately 70 hours of transcribed audio [1][4]. It was recorded by two professional speakers, one male and one female, with nearly equal amounts of data from each [1][4].

**rag/fixed**: ✅ *The answer gives ~70 hours of transcribed audio and identifies the two professional speakers (one male, one female) as Tatar National Theatre actors, matching the key facts of the expectation without contradiction.*

> The TatarTTS dataset contains approximately 70 hours of transcribed audio recordings [1][2]. It was recorded by two professional speakers — one male and one female — selected from Tatar National Theatre actors [2][4].

</details>

<details><summary><b>q02</b> Which model architecture and training framework were used to build the TatarTTS baseline models?</summary>

**Expected:** VITS (end-to-end variational inference TTS with a conditional VAE, normalizing flows, adversarial training), trained with the Piper framework at its high quality tier (83M parameters), one single-speaker model per speaker, 1,000 epochs, exported to ONNX.

**plain**: 🟡 *Correctly names VITS as the architecture but contradicts the expectation by stating the training framework was ESPnet/ESPnet2 instead of Piper.*

> The TatarTTS baseline models were built using the **VITS** architecture and trained with the **ESPnet/ESPnet2** toolkit.

**rag/struct**: ✅ *The answer correctly identifies VITS as the architecture and Piper as the training framework, adds ONNX export and 1,000 epochs per speaker, and contradicts nothing in the expectation (only omitting the 83M-parameter tier detail).*

> The baseline TTS models used the end-to-end VITS (variational inference text-to-speech) architecture [5], implemented via the Piper framework for training and preparing models for inference in the ONNX format [5]. The models were randomly initialized and trained for 1,000 epochs per speaker [1].

**rag/fixed**: ✅ *The answer correctly identifies VITS as the architecture and Piper (high-quality tier, 83M parameters) as the training framework, with per-speaker training for 1,000 epochs; only the ONNX export detail is omitted.*

> The baseline models used the VITS architecture, initialized randomly for both female and male speakers and trained for 1,000 epochs per speaker [2]. Training and preparation for inference were done with the Piper framework, which offers VITS models in four quality tiers and was used here at the high-quality tier with 83M trainable parameters [5].

</details>

<details><summary><b>q03</b> How did the synthesized TatarTTS speech compare with the original recordings in the listening evaluation?</summary>

**Expected:** In naturalness both models fall within the confidence interval of the original audio. In pronunciation, coherence and overall quality they lag the originals by about 0.2 points, but still score above 4.5 MOS. The originals scored above 4.70.

**plain**: 🟡 *It correctly conveys that the synthetic speech scored lower overall than the originals, but it omits the key facts (naturalness within the originals' confidence interval, ~0.2 point gap on pronunciation/coherence/overall quality, still above 4.5 MOS vs originals above 4.70) and wrongly implies naturalness was lower.*

> In the listening evaluation, the synthesized TatarTTS speech was rated **lower than the original recordings** on naturalness/quality: the original recordings received the higher MOS scores, while the synthetic speech was still judged intelligible and reasonably natural, though not indistinguishable from the originals.

**rag/struct**: ✅ *The answer reports naturalness nearly matching the originals, pronunciation, coherence and overall quality lagging by roughly 0.2 points while staying above 4.5 MOS, and originals above 4.70, all consistent with the expectation.*

> In the listening evaluation, synthesized speech was generally close to, but somewhat lower than, the original recordings [5]. For male speakers, synthesized (MS) vs. original (MO) scores were: naturalness 4.85 vs. 4.84, pronunciation 4.66 vs. 4.81, coherence 4.61 vs. 4.79, and overall quality 4.54 vs. 4.76. For female speakers, synthesized (FS) vs. original (FO) scores were: naturalness 4.80 vs. 4.89, pronunciation 4.66 vs. 4.87, coherence 4.69 vs. 4.92, and overall quality 4.65 vs. 4.96 [5]. The evaluation criteria were audio quality/pronunciation, naturalness, and overall comprehensibility, rated by native speakers [2].

**rag/fixed**: ✅ *The answer includes all key facts: naturalness within the original audio's confidence interval, originals above 4.70, and a ~0.2 point lag in pronunciation, coherence and overall quality while still above 4.5 MOS.*

> In the listening evaluation, the synthesized models were rated as producing natural-sounding speech: for naturalness, both male and female TTS models fell within the confidence interval of the original audios [1]. The original male and female recordings scored above 4.70, while for pronunciation, coherence, and overall quality the models lagged behind the originals by about 0.2 points, still achieving MOS above 4.5 [1]. They were considered imperfect, with limitations in coherence and clear pronunciation, but showed notable naturalness and sound quality [5].

</details>

<details><summary><b>q04</b> How did the apertium-anaphora module change the accuracy of anaphor translation in its preliminary evaluation?</summary>

**Expected:** Spanish–English (120 anaphors): accuracy rose from 29.2% to 54.2%. Catalan–Italian (108 anaphors): it fell from 83.3% to 75.0%, because the test data was skewed towards singular antecedents, which the default translation already covers.

**plain**: ❌ *The answer gives different accuracy figures (36.84% to 63.16%) than the expected 29.2% to 54.2% for Spanish–English and omits the Catalan–Italian decrease.*

> In its preliminary evaluation, the **apertium-anaphora** module improved anaphor-translation accuracy from **36.84% to 63.16%**—an increase of about **26.3 percentage points**.

**rag/struct**: ✅ *It reports both key figures correctly (Spanish–English 29.2%→54.2% with 120 anaphors; Catalan–Italian 83.3%→75.0% with 108 anaphors), omitting only the stated cause of the Catalan–Italian drop, which does not contradict the expectation.*

> In the preliminary evaluation [2], Spanish–English translation accuracy for anaphors rose from 29.2% without anaphora resolution to 54.2% with it (120 anaphors evaluated), while Catalan–Italian showed a slight decrease, from 83.3% to 75.0% (108 anaphors) [2]. Without the module, anaphors simply translate to whatever the bilingual dictionary provides—the male singular possessive determiner in these pairs [2].

**rag/fixed**: ⛔ *The answer declines by stating the documents do not contain the accuracy figures, whereas the expectation requires the specific Spanish–English and Catalan–Italian accuracy changes.*

> The documents do not contain the answer. The context describes the setup of the preliminary evaluation — first 1000 Europarl sentences translated with and without apertium-anaphora, of which 120 had a possessive determiner, followed by manual accuracy checking [1] — and notes that in the worked example the anaphor's translation was "fixed" by the module, though the final translation was "still not ideal" [3], but it gives no accuracy figures or outcome of that evaluation.

</details>

<details><summary><b>q05</b> Why was the apertium-recursive module developed, and how does it work?</summary>

**Expected:** The finite-state chunker only matches fixed, contiguous word sequences, so long-distance reordering and nested structures (relative clauses, prepositional phrases inside prepositional phrases) need many rules. apertium-recursive applies transfer rules recursively with context-free grammars and a GLR parser. Example: the 30+ English–Spanish noun-phrase rules shrink to fewer than 10 (mostly 3).

**plain**: 🟡 *The answer captures the motivation but uses a different parsing mechanism (RTNs/chart parser) than the expected CFG/GLR parser, omits the rule-count example, and adds unsupported details like Daniel Swanson.*

> **Why it was developed:** Apertium’s traditional transfer pipeline uses three separate, non-recursive modules: `apertium-transfer` (t1x), `apertium-interchunk` (t2x), and `apertium-postchunk` (t3x). Rules in these modules operate on flat sequences and cannot match chunks produced by other rules in the same stage. This makes nested phrases, agreement across chunks, and complex reordering awkward—often requiring multiple passes and duplicated patterns. `apertium-recursive` was created (by Daniel Swanson as a Google Summer of Code 2018 project) to replace that pipeline with a single, recursive transfer module. It allows one rule file to build arbitrarily nested chunk structures, simplifying grammar writing and maintenance and improving translation quality. It is used in language pairs such as English–Catalan. **How it works:** - Rules are written in an XML `.rtx` file, similar to `apertium-transfer` but with `<chunk>` elements. Each rule has a **pattern** (a sequence of lexical units and/or chunks) and an **output** (lexical units and/or chunks). Variables and tags support agreement and feature transfer. - The rules are compiled by `apertium-recursive-compile` into a binary `.rtx.bin` file. - At runtime, `apertium-recursive` reads the binary and the input stream of tagged lexical units. Conceptually, the rules are compiled into **recursive transition networks (RTNs)**, and a **chart parser** finds the best parse of the input into a tree of chunks. Because rules can match chunks produced by other rules, structures can nest recursively (e.g., an NP inside a PP inside a larger NP). - Once a parse is selected (by rule priority/order), the tree is linearized into a sequence of target-language lexical units with morphological tags. This output is then passed to the morphological generator (e.g., `lt-proc -g`). In short, `apertium-recursive` unifies transfer, interchunk, and postchunk into one recursive, chart-parsing module that builds and flattens a chunk tree in a single pass.

**rag/struct**: ✅ *The answer correctly states the motivation (finite-state chunking limitations) and the mechanism (recursive transfer rules with CFGs and a GLR parser handling nested structures), matching the expectation, though it omits the illustrative rule-count example.*

> The apertium-recursive module was developed to deal with the limitations of finite-state chunking [2]. It applies structural transfer rules recursively using context-free grammars (CFGs) and a Generalized Left-right Right-reduce (GLR) parser, which makes it possible to process nested structures such as relative clauses or prepositional phrases within prepositional phrases [2].

**rag/fixed**: ⛔ *The answer declines by claiming the documents do not contain the answer, while the expectation shows they do (rationale: finite-state chunker limitations; mechanism: recursive transfer rules with CFGs and a GLR parser), so no facts are provided but nothing is fabricated.*

> The documents do not contain the answer. The context only mentions that Apertium added "a module that allows rules to process recursive structures at the structural transfer stage" among its new optional modules [1][4], without explaining its rationale or mechanism.

</details>

<details><summary><b>q06</b> What are the three golden rules of fat loss in Gutless?</summary>

**Expected:** 1. Calories: a calorie deficit is the only requirement for fat loss. 2. Protein: it fills you up and spares muscle. 3. Consistency (sustainability): a diet you can stick to.

**plain**: ⛔ *The answer declines to give the three golden rules, stating it does not know them, so no key facts from the expectation are present.*

> I don’t know the specific “three golden rules of fat loss” from *Gutless*. If you can share the author or a bit more context, I can help track them down.

**rag/struct**: 🟡 *It correctly gives Rule One (calorie deficit) but omits the protein and consistency rules, which the expectation requires.*

> The context names the chapter but only details RULE ONE: it concerns the amount of energy — measured in calories — that you get from your diet, with the only true requirement for losing fat being a calorie deficit (not keto, paleo, intermittent fasting, clean eating, cutting sugar/carbs/wheat/gluten/milk, etc.) [2]. The documents do not state Rules Two and Three. What the context does cover: Chapter 1 lists "inessentials" that don't matter for fat loss, including carbohydrate, dietary fat, meal timing, sugar, and the glycemic index [4].

**rag/fixed**: 🟡 *The answer correctly identifies the calories rule but omits protein and consistency, claiming they are not in the passages, so only one of the three key facts is present.*

> The context only identifies the first of the three: "1. CALORIES," which involves calculating daily calorie intake, e.g. multiplying body weight in pounds by 10–12 [4]. The names of the second and third rules are not given in these passages, although a section headed "3. MEAL FREQUENCY" appears [5] without being labelled as a golden rule.

</details>

<details><summary><b>q07</b> Using the simple method from Gutless, how many calories per day should a 185-pound person eat to lose fat?</summary>

**Expected:** Multiply body weight in pounds by 10–12: between 1,850 and 2,220 calories a day (11 per pound if unsure; 10 if inactive, 12 if very active).

**plain**: 🟡 *The answer correctly uses the body weight × multiplier method and gives 1,850 (the 10× lower bound), but omits the 10–12 range and thus the upper value of 2,220.*

> Using the simple method from *Gutless* (body weight in pounds × 10 for fat loss): 185 × 10 = **1,850 calories per day**.

**rag/struct**: ✅ *The answer correctly applies the 10–12 multiplier to 185 pounds, giving 1,850–2,220 calories per day, matching the expectation.*

> Using the simple method, take your body weight in pounds and multiply it by a number between 10 and 12 [3]. For a 185-pound person, that works out to somewhere between 1850 calories (185 x 10) and 2220 calories (185 x 12) per day [3]. These numbers are a starting point rather than a fixed prescription, and will need adjusting over time based on results [4].

**rag/fixed**: ✅ *The answer correctly applies the 10–12 calories per pound rule to 185 pounds, giving 1,850–2,220 calories, and notes the 10-calorie guideline for inactive/slow-metabolism individuals, matching the expectation.*

> Using the simple method, a 185-pound person should eat somewhere between 1,850 calories (185 x 10) and 2,220 calories (185 x 12) per day to lose fat [1]. If they are not very active or have a slow metabolism, they should aim for around 10 calories per pound of body weight [1].

</details>

<details><summary><b>q08</b> Which documents in the collection deal with the Tatar language, and in what way?</summary>

**Expected:** Two documents. The TatarTTS paper introduces a 70-hour open-source text-to-speech dataset and baseline models for Tatar. The Apertium paper covers Tatar in machine translation: a released Kazakh–Tatar pair, Tatar listed as a Turkic language with minority status, and Tatar–Bashqort among unreleased pairs.

**plain**: ⛔ *The answer declines to identify any documents, saying it lacks access to the collection, rather than giving the expected TatarTTS and Apertium facts.*

> I don’t have access to the collection you’re referring to, and no documents or catalog details are included in this conversation. So I can’t identify which specific items deal with the Tatar language. If you share the collection (or its file list/catalog), I can pick out the Tatar-related documents and explain how each one treats the language—e.g., grammar, dictionary, phrasebook, textbook, religious/translation text, linguistic study, or manuscript in Tatar.

**rag/struct**: 🟡 *The answer correctly details the TatarTTS paper but omits the Apertium document entirely and falsely asserts that all passages come from a single document, contradicting the expectation of two relevant documents.*

> All of the passages come from a single document in the collection: the TatarTTS paper, which deals with Tatar by presenting an open-source text-to-speech synthesis dataset for the language. Ways it addresses Tatar: - Dataset construction: texts were sourced from the Tatar language corpus, covering genres such as fiction, media, official documents, educational and scientific literature, and were read by Tatar National Theatre actors [1]. - Corpus content: it consists of 70 hours of transcribed speech from two speakers (one male, one female), with statistics given for segments, tokens, and durations (36.2 h male, 33.9 h female) [3][5]. - Models/results: preliminary baseline TTS models were created, and 30 hours of speech data was found sufficient for reasonably good MOS performance [3]. - Related work on Tatar NLP: corpora for tasks like text similarity and relatedness, named entity recognition tools, inclusion in the Turkic ASR model for 10 Turkic languages, and neural machine translation tools to and from Tatar [4]. - Prior TTS efforts: an earlier corpus of under 8 hours from 2 male and 1 female speakers, and attempts using transliteration into Kazakh that lacked intelligibility [5].

**rag/fixed**: 🟡 *Correctly describes the TatarTTS paper and its 70-hour TTS dataset, but omits the second document (Apertium) entirely, which covers Tatar in machine translation.*

> The context contains one document dealing with the Tatar language: the TatarTTS paper (1570978467.pdf), which introduces an open-source Tatar text-to-speech dataset of roughly 70 hours of transcribed audio from two professional speakers, one male and one female [5]. It also reviews prior Tatar NLP work, including corpora for tasks like text similarity and named entity recognition, integration into a multilingual Turkic ASR model [4], and machine translation tools, as well as earlier TTS corpus efforts and Kazakh-transliteration approaches [2]. Its dataset construction drew textual content from the Tatar language corpus, covering genres such as fiction, media texts, official documents, educational and scientific literature [1].

</details>

<details><summary><b>q09</b> According to Gutless, how many grams of creatine should you take per day?</summary>

**Expected:** Gutless does not discuss creatine. The answer should say the documents do not cover it, not give a dose.

**plain**: ❌ *The documents do not discuss creatine, yet the answer states a specific dosage of 5 grams per day as fact from Gutless.*

> According to Gutless, you should take **5 grams of creatine per day**.

**rag/struct**: ✅ *The answer correctly states the documents do not contain the answer, matching the expectation that creatine is not discussed.*

> The documents do not contain the answer. The context covers protein intake, meal frequency, and the author's pre/post-workout meals (banana, protein shake, fruit smoothie), but never mentions creatine.

**rag/fixed**: ✅ *The answer correctly states the documents do not contain the answer, noting they cover fat-loss topics but not creatine, matching the expectation.*

> The documents do not contain the answer. The context covers fat-loss topics such as calorie and protein intake, meal frequency and timing, and what doesn't matter for fat loss [1][3][5], but it does not mention creatine.

</details>

<details><summary><b>q10</b> What word error rate (WER) did the TatarTTS paper report for its synthesized speech?</summary>

**Expected:** The paper reports no WER. It evaluates with MOS only (naturalness, pronunciation, coherence, overall quality). The answer should say so and not invent a number.

**plain**: ✅ *The expectation says the documents do not contain a WER figure, and the answer declines to give one without inventing a number, which is the right behaviour.*

> I don’t have that exact figure; the TatarTTS paper’s reported WER for its synthesized speech is not something I can recall with confidence.

**rag/struct**: ✅ *The answer correctly states the documents do not contain a WER and notes MOS was used instead, matching the expectation without inventing a number.*

> The documents do not contain the answer. The context reports evaluation via Mean Opinion Score (MOS) with native-speaker ratings [4], not word error rate.

**rag/fixed**: ✅ *The answer correctly states the documents do not contain a WER, consistent with the expectation that the paper uses MOS only, and adds no contradicting figures.*

> The documents do not contain the answer. The context reports subjective evaluation results (mean opinion scores) for the TTS models, such as MOS scores above 4.5 for pronunciation, coherence, and overall quality [1], but no word error rate is mentioned.

</details>
<!-- eval:end -->
