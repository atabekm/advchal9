# Task 25 — two long conversations, with and without task memory

Two scripted conversations of 13 user messages each (`scenarios.json`), run through the same
`ChatService` the web page uses: **s1** plans fat loss with Gutless, **s2** plans a Bashkir TTS
dataset from TatarTTS and later brings in the Apertium paper. Each runs twice. With the
**memory on**, the task memory goes into every prompt and its scope limits the search. With it
**off**, the model gets only the last 6 messages. Retrieval, answer prompt, quote check and gates
are the same in both. The judges grade against what the user actually established, written into
the scenario (`sets`), not against what the memory happened to keep, so a lost constraint counts
as lost.

## Reading

**The memory held everything, and the conversation stayed on track to the end.** With the
memory on, all 26 replies were of the expected kind. All 18 answers had sources and verified
quotes from the expected document. The judge counted every follow-up as resolved, every reply
as keeping the constraints and every reply as on track. Each of the 9 items the user
established was in the memory at the turn it was said and still there at the end, with no wrong
items. The scope was right after every turn: Gutless only in s1, TatarTTS only and then
TatarTTS + Apertium in s2.

**Without it, the conversation drifts once the early turns leave the window.** Constraints held
on 15 of 26 replies, against 26 of 26. The constraints were set on turns 1–2, so from turn 5 on
they are no longer in the 6-message window:

- s1 answers got long again (turns 5 and 9).
- s1 turn 13 did the whole calculation in pounds after the user asked for kilograms.
- s2 dropped the bullet points on turns 6–11 and 13.
- s2 lost "'the paper' = TatarTTS". On turn 11 "the paper" was read as the Apertium paper, so
  the answer was about the wrong paper. Turn 13 also searched for the Apertium paper's license.
- Both recaps (s1 turn 12, s2 turn 12) missed the goal: "fat loss" instead of "8 kg with
  Gutless, vegetarian, 82 kg", and a list of Apertium facts instead of the Bashkir project.

The sources survive without memory: sources and quotes are on every answer either way (18/18
and 18/18), because they come from the pipeline, not the conversation. The memory is what keeps
the answers about *this user's* task.

**Faithfulness: 8 supported, 10 partial, 0 unsupported with the memory on (4 / 13 / 1
without).** Most of the partials come from the chat applying the passages to the user: "82 kg
≈ 181 lb → 1,810–2,170 calories" is arithmetic on a quoted formula. The faithfulness judge sees
only the quotes, so it flags the user's numbers as unquoted. The rest are small details next to
a quoted fact (e.g. "professional speakers"). The one unsupported verdict, without memory, is
s1 turn 13: its pound calculation and its activity levels were not in its quotes.

**Cost.** The memory adds about 1,100 prompt tokens per turn (4,430 against 3,288) and about
1.6 s (9.9 s against 8.3 s): the memory update call, and the memory block in each prompt.

### What the first full run caught

The first run (same scenarios, before these fixes; its file was not kept) had 24/26 replies of
the expected kind and 23/25 with constraints kept, with the memory on. The failures led to four
changes (see PLAN.md, *What the build changed*):

- **s1 turn 5:** the condenser copied a number from an earlier answer ("the 60–120 grams of
  protein per day") into the search question. Retrieval narrowed to the wrong passages and the
  reply was "I don't know". It now must not carry facts from earlier answers into the question.
- **s2 turn 10:** the condenser named the Apertium paper by its full title. That title is in
  every page header, so the reranker scored front-matter chunks at 1.000. The evaluation chunk
  never reached the top 5 and the reply was "I don't know". It now uses short names
  ("Apertium").
- **s1 turns 3 and 12:** long answers and pounds, although the memory said "short" and "kg". The
  constraints were in the memory block at the top of a long prompt. They are now also repeated
  next to the question, in the meta prompt too.
- **s2 scope:** "use the Apertium paper as well" made the memory's scope TatarTTS + Apertium.
  The scenario had said "all documents", but the memory's reading was the right one: Gutless was
  never added. The scenario was fixed.

### Limits

- One run per configuration, at temperature 0. Retrieval still varies between runs (the
  rewriter's queries change). The first run had a protein question whose chunk never reached the
  top 5; in this run it was found.
- The judges are the same model as the chat (`deepseek-flash`). "Constraints kept" and "on track"
  are the judge's reading. The checks that need no LLM (reply kind, sources, quotes, expected
  document, units, scope) are exact.
- Turn 2 of each scenario is pure instruction ("use kg", "bullet points"), so it is a meta turn
  with no sources by design: 6 of the 26 replies are meta or "I don't know", and none of them
  claims a fact from the documents.

<!-- scenarios:start -->
Run 2026-10-03T12:08:48 · answers deepseek-flash · judge deepseek-flash · rewrite+rerank (threshold 0.3, floor 0.1) · history window 6 messages · 472 s

| | s1 · memory on | s1 · memory off | s2 · memory on | s2 · memory off | all · memory on | all · memory off |
|---|---:|---:|---:|---:|---:|---:|
| turns | 13 | 13 | 13 | 13 | 26 | 26 |
| reply of the expected kind | 13/13 | 13/13 | 13/13 | 13/13 | 26/26 | 26/26 |
| answers with sources and quotes | 10/10 | 10/10 | 8/8 | 8/8 | 18/18 | 18/18 |
| expected document cited | 10/10 | 10/10 | 8/8 | 7/8 | 18/18 | 17/18 |
| I don't know with a clarifying question | 1/1 | 1/1 | 2/2 | 2/2 | 3/3 | 3/3 |
| follow-up resolved | 7/7 | 7/7 | 7/7 | 5/7 | 14/14 | 12/14 |
| constraints kept | 13/13 | 9/13 | 13/13 | 6/13 | 26/26 | 15/26 |
| units / must contain | 3/3 | 3/3 | — | — | 3/3 | 3/3 |
| on track | 13/13 | 12/13 | 13/13 | 10/13 | 26/26 | 22/26 |
| faithful (supported / partial / unsupported) | 3 / 7 / 0 | 1 / 8 / 1 | 5 / 3 / 0 | 3 / 5 / 0 | 8 / 10 / 0 | 4 / 13 / 1 |
| memory: items recorded at their turn | 5/5 | — | 4/4 | — | 9/9 | — |
| memory: items still there at the end | 5/5 | — | 4/4 | — | 9/9 | — |
| memory: goal matches | 2/2 | — | 2/2 | — | 4/4 | — |
| memory: scope right after each turn | 13/13 | — | 13/13 | — | 26/26 | — |
| memory: wrong items (end) | 0 | — | 0 | — | 0 | — |
| mean seconds per turn | 10.9 | 8.8 | 8.8 | 7.7 | 9.9 | 8.3 |
| mean prompt tokens per turn | 4393 | 3313 | 4467 | 3263 | 4430 | 3288 |

### s1: Fat loss with Gutless

#### Transcript with the task memory

**1. user:** Hi! I want to lose about 8 kg of fat over the next few months, and I want answers from Gutless only. Please keep answers short. What are the main rules?  
*searched as:* What are the main rules for losing fat according to Gutless?

*answer* (expected answer) · 19.8 s

> Gutless boils fat loss down to three golden rules: calories, protein, and consistency [1]. Calories: to lose fat, the only thing you need is a calorie deficit [5]. Protein: rule two relates to the amount of protein in your diet, because protein fills you up better than carbohydrate or fat and has a "muscle sparing" effect — if you don't get enough while dieting, you'll drop muscle as well as fat [5]. Consistency: rule three is about sustainability, because a diet that looks perfect on paper isn't perfect if you can't stick to it long enough to reach your goal [5]. The passages don't give a specific plan for an 8 kg loss.

Sources: [1] Gutless.pdf · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11; [5] Gutless.pdf · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · p. 10  
Quotes: 5 verified (lowest 100)  
Memory: goal → Lose about 8 kg of fat over the next few months; scope → Gutless.pdf; + constraints: Keep answers short  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: partial · memory 2/2, goal ✓  

**2. user:** Good to know. I'm vegetarian and I weigh 82 kg. Please use kilograms, not pounds.  

*meta* (expected meta) · 4.5 s

> Got it — I’ll keep answers short and use kilograms. Noted: vegetarian, 82 kg. Ask whenever you want something from Gutless.

Memory: + clarified: Is vegetarian; + clarified: Weighs 82 kg; + constraints: Use kilograms, not pounds  
Checks: kind ✓ · resolved — · constraints ✓ · on track ✓ · memory 3/3  

**3. user:** How do I work out my calories with the first rule?  
*searched as:* How does the first rule in Gutless say to work out your calories? · *scope:* Gutless.pdf

*answer* (expected answer) · 9.6 s

> Rule one's "Simple But Less Accurate Way" is to take your body weight in pounds and multiply it by 10 to 12 [1]. At 82 kg (about 181 lb), that comes to roughly 1,810–2,170 calories a day (181 × 10 and 181 × 12) [1]. Gutless also offers a diet spreadsheet with a page for kilograms, where you enter your weight and estimated body fat percentage and it shows your daily calories [2]. The formula is given in pounds, and the passages say nothing about vegetarian diets [1].

Sources: [1] Gutless.pdf · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11; [2] Gutless.pdf · 3. MEAL FREQUENCY · pp. 18–19  
Quotes: 2 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · units ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**4. user:** And how much protein should I eat?  
*searched as:* How much protein per day does Gutless recommend? · *scope:* Gutless.pdf

*answer* (expected answer) · 15.5 s

> Gutless recommends 2.2 grams of protein per kilogram of lean bodyweight per day [3]. To work out your lean bodyweight, you first need a rough estimate of your body fat percentage [3]. The passages don't state your body fat percentage, so your 82 kg isn't enough to calculate an exact daily amount; they also don't mention vegetarian diets.

Sources: [3] Gutless.pdf · 2. PROTEIN · p. 13  
Quotes: 2 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · units ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**5. user:** Can I get that much without meat?  
*searched as:* According to Gutless, can the recommended daily protein intake be obtained without eating meat? · *scope:* Gutless.pdf

*answer* (expected answer) · 14.4 s

> Yes—if you're a lacto-ovo vegetarian. Gutless says dairy and eggs give you all the high-quality protein you need to maximize muscle growth [1], and a follow-up study shows no difference in muscle growth with a lacto ovo-vegetarian diet compared to an omnivorous diet providing similar amounts of protein [1].

Sources: [1] Gutless.pdf · 4. Use a Preload > Chapter 5: Q&A · p. 50  
Quotes: 2 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: supported  

**6. user:** How many grams of creatine should I take per day?  
*searched as:* How many grams of creatine per day does Gutless recommend? · *scope:* Gutless.pdf

*unknown* (expected unknown) · 7.3 s

> I don't know: the documents do not contain the answer. The passage I have covers Gutless's general philosophy of focusing on a few key principles rather than minor details, and it doesn't mention creatine or any supplement dose. I also don't have the sections on protein or calorie rules in front of me here. Could you ask about something the book does cover, such as your daily calories or protein target?

Checks: kind ✓ · resolved — · constraints ✓ · on track ✓  

**7. user:** Does it matter how many meals a day I eat?  
*searched as:* According to Gutless, does the number of meals eaten per day matter? · *scope:* Gutless.pdf

*answer* (expected answer) · 9.5 s

> For fat loss itself, not much: the book says meal frequency doesn't matter too much when it comes to losing fat [3]. It matters more for muscle — eating more frequently (6 versus 2 meals per day) makes you more likely to hold on to muscle while losing weight [3]. So it suggests a minimum of three meals per day, each separated by 2–6 hours, with 20–40 g of protein per meal [3].

Sources: [3] Gutless.pdf · 3. MEAL FREQUENCY · p. 14  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: supported  

**8. user:** What is time-restricted feeding?  
*searched as:* What is time-restricted feeding according to Gutless? · *scope:* Gutless.pdf

*answer* (expected answer) · 11.3 s

> Time-restricted feeding, also known as intermittent fasting, involves alternating times where you don't eat (the fasting window) with times where you do (the feeding window) [1]. The protocols simply make the feeding window shorter and the fasting window longer — you reduce the daily feeding window to somewhere between 4-10 hours [1]. Its main benefit is that it's a very simple way to create the energy deficit you need to lose fat [3], though most research shows it doesn't perform any better (or worse) than continuous calorie restriction for weight loss [4].

Sources: [1] Gutless.pdf · 1. Time-Restricted Feeding · p. 21; [3] Gutless.pdf · 1. Time-Restricted Feeding · p. 22; [4] Gutless.pdf · 1. Time-Restricted Feeding · p. 23  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: supported  

**9. user:** Would that help me eat less without noticing?  
*searched as:* Does time-restricted feeding (intermittent fasting) help you eat less without noticing, according to Gutless? · *scope:* Gutless.pdf

*answer* (expected answer) · 8.8 s

> Yes — the book's chapter on eating less without noticing says its strategies "affect hunger, appetite and/or satiety in such a way that you end up eating less without noticing that you're doing it" [3]. For time-restricted feeding specifically, its main benefit is that it's "a very simple way to create the energy deficit you need to lose fat," with no calorie counting needed, and any hunger during the fasting window "is going to be offset by a reduction in hunger during the feeding window" [4]. In one study, people given a 10-hour eating window with no other dietary advice reduced their window by about 4 hours 35 minutes and lost a little over 3.3 kg after 16 weeks [4].

Sources: [3] Gutless.pdf · 3. MEAL FREQUENCY > Chapter 3: How to Eat Less Without Really Noticing · pp. 20–21; [4] Gutless.pdf · 1. Time-Restricted Feeding · p. 22  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**10. user:** What's a preload, and what could I use as one?  
*searched as:* What is a preload, and what foods can be used as a preload, according to Gutless? · *scope:* Gutless.pdf

*answer* (expected answer) · 10.1 s

> A preload is what you eat or drink before a meal, used as a fat loss aid via its effect on satiety [1]. The cheapest and simplest preload is water, drunk anywhere between 30 minutes and immediately before a meal [1]; apple is also a highly effective preload [2]. If you don't like plain water, you can add squash, lemon, lime or cucumber, and tea or coffee does a similar job [2] — but fruit juice doesn't give the same benefit [2].

Sources: [1] Gutless.pdf · 4. Use a Preload · p. 33; [2] Gutless.pdf · 4. Use a Preload · pp. 34–35  
Quotes: 6 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: partial  

**11. user:** What should I do if my weight stops going down?  
*searched as:* What should you do if your weight loss stops going down, according to Gutless? · *scope:* Gutless.pdf

*answer* (expected answer) · 12.8 s

> A slowdown is normal: it’s "quite normal for your rate of progress to slow down over time" [2], and your rate of fat loss will keep slowing down [4]. What you should do is recalculate your calorie intake as you lose weight, because a smaller body burns fewer calories, and it’s worth updating the numbers every 2-4 weeks [4]. The book’s spreadsheet has a Kilograms page where you enter your weight and estimated body fat percentage [2]. Don’t try to speed things up by severely restricting your food intake or adding more exercise, as that increases the risk of losing muscle as well as fat [4].

Sources: [2] Gutless.pdf · 3. MEAL FREQUENCY · pp. 18–19; [4] Gutless.pdf · 3. MEAL FREQUENCY · p. 17  
Quotes: 6 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**12. user:** Remind me: what's my goal, and what have we agreed on so far?  

*meta* (expected meta) · 5.3 s

> Your goal is to lose about 8 kg of fat over the next few months. You’re vegetarian and weigh 82 kg. We’re working only from Gutless.pdf, and you’ve asked me to keep answers short and use kilograms. So far we’ve discussed time-restricted feeding, preloads like water or an apple, and what to do when weight loss slows — recalculate your calorie intake every 2–4 weeks.

Checks: kind ✓ · resolved — · constraints ✓ · on track ✓  

**13. user:** Last one: recalculate my daily calories for when I'm down to 78 kg.  
*searched as:* How should daily calorie intake be recalculated as body weight decreases, according to Gutless? · *scope:* Gutless.pdf

*answer* (expected answer) · 12.7 s

> The book's simple method is to take your weight in pounds and multiply by 10–12 [1]. At 78 kg (78 × 2.2 ≈ 172 lb), that's about 1,720–2,065 calories a day, and it's worth updating the numbers every 2–4 weeks because a smaller body burns fewer calories [3]. These figures are a guide, not a rigid prescription [5], and if you're not losing fat you reduce intake by your bodyweight in pounds — roughly 172 calories at 78 kg [5]. You can also enter your weight on the spreadsheet's Kilograms page [2].

Sources: [1] Gutless.pdf · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 10–11; [3] Gutless.pdf · 3. MEAL FREQUENCY · p. 17; [5] Gutless.pdf · By Christian Finn, M.Sc > Chapter 2: The Three Golden Rules of Fat Loss · pp. 12–13; [2] Gutless.pdf · 3. MEAL FREQUENCY · pp. 18–19  
Quotes: 5 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · units ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

Memory at the end:

```
Goal: Lose about 8 kg of fat over the next few months
Clarified by the user:
- [c2] Is vegetarian
- [c3] Weighs 82 kg
Constraints:
- [k1] Keep answers short
- [k4] Use kilograms, not pounds
Terms:
- none
Scope: Gutless.pdf
```

Against everything the user established: 5/5 items, goal ✓

#### Without the task memory

| turn | message | memory on: kind · constraints · on track | memory off: kind · constraints · on track |
|---:|---|---|---|
| 1 | Hi! I want to lose about 8 kg of fat over the next few months, and I w… | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 2 | Good to know. I'm vegetarian and I weigh 82 kg. Please use kilograms, … | meta · ✓ · ✓ | meta · ✓ · ✓ |
| 3 | How do I work out my calories with the first rule? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 4 | And how much protein should I eat? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 5 | Can I get that much without meat? | answer · ✓ · ✓ | answer · ✗ · ✓ |
| 6 | How many grams of creatine should I take per day? | unknown · ✓ · ✓ | unknown · ✓ · ✓ |
| 7 | Does it matter how many meals a day I eat? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 8 | What is time-restricted feeding? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 9 | Would that help me eat less without noticing? | answer · ✓ · ✓ | answer · ✗ · ✓ |
| 10 | What's a preload, and what could I use as one? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 11 | What should I do if my weight stops going down? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 12 | Remind me: what's my goal, and what have we agreed on so far? | meta · ✓ · ✓ | meta · ✗ · ✗ |
| 13 | Last one: recalculate my daily calories for when I'm down to 78 kg. | answer · ✓ · ✓ | answer · ✗ · ✓ |

Where the two differ, the reply without memory:

**5. memory off** (answer; searched as: Can a person get the amount of protein Gutless recommends without eating meat?)

> Yes, if you're a vegetarian rather than a vegan. Dairy and eggs (and fish, if you eat it) supply all the high-quality protein you need to maximise muscle growth [1], and you'd do just as well as if meat and poultry were on the menu [1]. Vegans have a harder time eating enough high-quality protein, which has the potential to slow muscle growth [1], but a pea protein supplement is one solution [2], and recent trials show no difference in strength gains or muscle growth between whey and pea protein [2]. The book suggests a vegan protein supplement that uses pea protein isolate as one of the main ingredients [3]. It also notes that you don't need to combine foods to get a complete protein at every meal, because your body has a free amino acid pool to make up any shortfall [5].

*Judge:* The searched question matches the context, and the reply stays on topic about vegetarian protein, but it is too long for the user's short-answer constraint.

**9. memory off** (answer; searched as: Does time-restricted feeding help people eat less without noticing?)

> Largely yes, though not entirely without noticing hunger. The main benefit of time-restricted feeding is that it's a very simple way to create the energy deficit you need to lose fat, without counting calories, cutting out food groups or sticking to complicated diet rules [1]; and because your calorie budget is spread across fewer meals, those meals can be larger and more "normal" [1]. Tell someone to reduce their feeding window, with very few rules on what they can eat during that window, and they will often lose weight [2]. In practice, a group told only to eat within a 10-hour window, with no other dietary advice, lost a little over seven pounds (3.3 kg) after 16 weeks [1]. The one caveat: you are likely to experience some degree of hunger during the fasting window, but this is offset by a reduction in hunger during the feeding window [1].

*Judge:* The searched question matches the meaning, and the reply answers the time-restricted feeding question, but it is a long paragraph rather than a short answer.

**12. memory off** (meta)

> Your goal, as it’s come up here, is fat loss — ideally in a way that helps you eat less without feeling like you’re constantly counting calories or following complicated diet rules.
>
> What we’ve established so far:
>
> Time-restricted feeding can help by making an energy deficit simpler and by letting you eat larger, more normal meals in a shorter window — though it won’t necessarily remove hunger entirely.
>
> A preload is something you eat or drink before a meal to help with satiety. Water is the cheapest, simplest option, and you can add squash or a slice of lemon, lime or cucumber; tea or coffee works similarly. An apple is another effective preload, but fruit juice doesn’t have the same benefit.
>
> If your weight stops going down, a slowdown is normal rather than a crisis. The emphasis should be on staying consistent with calories, protein and consistency, rather than trying to force faster results.
>
> If you want me to pull more specifics from the documents, just ask it as a question.

*Judge:* The reply is too long for the short-answer constraint and recaps only a vague fat-loss goal while omitting the established 8 kg/Gutless goal, vegetarian status, weight, and kg/no-pounds constraint.

**13. memory off** (answer; searched as: How many calories per day does Gutless recommend for fat loss?)

> First convert the goal weight: 78 kg ≈ 172 pounds. The simple method is to take your body weight in pounds and multiply it by a number between 10 and 12 [1]: 172 x 10 = 1720 and 172 x 12 = 2064 calories per day. The number you pick depends on activity level — not very active or slow metabolism, around 10 calories per pound; very active or fast metabolism, 12; and if you're not sure, the middle number of 11 calories per pound [3], which gives 172 x 11 = 1892 calories. Recalculating at this lower weight is expected, because a smaller body burns fewer calories [4]. The passages don't say which activity level applies to you, so use the range unless you know where you sit.

*Judge:* The reply answers the recalculation for 78 kg on track, but it does the whole calculation in pounds (172 lb) despite the user's explicit request to use kilograms.


### s2: A TTS dataset for Bashkir, learning from TatarTTS

#### Transcript with the task memory

**1. user:** I'm planning a text-to-speech dataset for Bashkir, a low-resource Turkic language, and I want to learn from TatarTTS. For now, use only the TatarTTS paper. How much audio does it have, and who recorded it?  
*searched as:* How much audio does the TatarTTS dataset contain, and who recorded it?

*answer* (expected answer) · 10.4 s

> TatarTTS contains around 70 hours of audio, made up of over 38,000 segments [1], or approximately 70 hours of transcribed audio recordings [2]. It was recorded by two speakers, one male and one female [1], described as two professional speakers (one male and one female) [2].

Sources: [1] 1570978467.pdf · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2; [2] 1570978467.pdf · (front matter) · p. 1  
Quotes: 3 verified (lowest 100)  
Memory: goal → Plan a text-to-speech dataset for Bashkir by learning from the TatarTTS paper; scope → 1570978467.pdf; + clarified: Is planning a text-to-speech dataset for Bashkir, a low-resource Turkic language  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: supported · memory 1/1, goal ✓  

**2. user:** From now on, 'the paper' means the TatarTTS paper. And please answer in bullet points.  

*meta* (expected meta) · 4.8 s

> - Noted: from now on, “the paper” means the TatarTTS paper.
> - I’ll answer in bullet points from here.
> - Ask whenever you want to continue planning the Bashkir dataset using it.

Memory: + terms: 'the paper' = the TatarTTS paper; + constraints: answer in bullet points  
Checks: kind ✓ · resolved — · constraints ✓ · on track ✓ · memory 2/2  

**3. user:** Where did the paper get its texts from?  
*searched as:* Where did TatarTTS source the texts for its speech dataset? · *scope:* 1570978467.pdf

*answer* (expected answer) · 8.3 s

> - The textual content came from the Tatar language corpus [4].
> - That corpus spans a wide range of literary genres: fiction, media texts, official documents, educational literature, and scientific publications [4].
> - The selected texts were chosen so they were free of grammatical errors, to guarantee accurate and linguistically correct content [4].

Sources: [4] 1570978467.pdf · III. DATASET CONSTRUCTION > A. Tatar Speech Corpus · p. 2  
Quotes: 3 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: supported  

**4. user:** How were the speakers chosen?  
*searched as:* How were the speakers chosen for the TatarTTS text-to-speech dataset? · *scope:* 1570978467.pdf

*answer* (expected answer) · 7.3 s

> - The speakers were selected with careful consideration, drawn from Tatar National Theatre actors [2].
> - The chosen actors had to demonstrate fluency in the Tatar language and have experience narrating TV and radio programs, ensuring the necessary language proficiency and performance skills [2].
> - They were the two speakers described as two professional speakers, one male and one female [1].

Sources: [2] 1570978467.pdf · III. DATASET CONSTRUCTION > A. Tatar Speech Corpus · p. 2; [1] 1570978467.pdf · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2  
Quotes: 3 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**5. user:** And how was the audio split and stored?  
*searched as:* How was the audio split and stored in the TatarTTS dataset? · *scope:* 1570978467.pdf

*answer* (expected answer) · 8.4 s

> - The audio was split after the collection phase: skilled transcribers manually segmented the recordings into sentence-level chunks [3].
> - These sentence-level chunks resulted in a dataset of over 38,000 segments [1].
> - Storage: recordings for the two speakers are kept in two separate folders [1].
> - Each folder holds one CSV file and one sub-folder; the CSV has N rows and 2 columns, first column = audio file name, second = the corresponding text [1].
> - The sub-folder contains the audio recordings in WAV format [1].

Sources: [3] 1570978467.pdf · III. DATASET CONSTRUCTION > A. Tatar Speech Corpus · p. 2; [1] 1570978467.pdf · III. DATASET CONSTRUCTION > B. Dataset Specifications · p. 2  
Quotes: 6 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: supported  

**6. user:** What did the evaluation show?  
*searched as:* What did the evaluation of the TatarTTS dataset show? · *scope:* 1570978467.pdf

*answer* (expected answer) · 7.6 s

> - The dataset's reliability was demonstrated by building baseline end-to-end TTS models that were evaluated using the subjective mean opinion score (MOS) measure [3].
> - The evaluation was run through a Telegram messenger bot, whose interface asked users to rate the naturalness of the speech [1].
> - The models are not without imperfections and have some limitations in terms of coherence and clear pronunciation, but they demonstrate notable naturalness and sound quality [2].
> - The findings show that even with a relatively limited amount of training data, specifically 30 hours of speech data, reasonably good performance in terms of MOS can be achieved for TTS models [2].

Sources: [3] 1570978467.pdf · (front matter) · p. 1; [1] 1570978467.pdf · IV. TTS EXPERIMENTS > B. TTS Model Training · p. 3; [2] 1570978467.pdf · VI. CONCLUSION · p. 4  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: partial  

**7. user:** How many native speakers rated the recordings?  
*searched as:* How many native speakers rated the recordings in the TatarTTS evaluation? · *scope:* 1570978467.pdf

*unknown* (expected unknown) · 7.8 s

> I don't know: the documents do not contain the answer. The passages describe how the evaluation was run (a survey with native speakers via a Telegram bot, 30 recordings per session, rated 1–5 on audio quality, pronunciation, naturalness and comprehensibility) but they never state how many native speakers took part. Do you want the number of recordings rated per session instead, or details of the evaluation criteria?

Checks: kind ✓ · resolved ✓ · constraints ✓ · on track ✓  

**8. user:** OK. I also want machine translation for Bashkir later, so from now on use the Apertium paper as well.  

*meta* (expected meta) · 6.1 s

> - Noted: the goal is now broader — a text-to-speech dataset for Bashkir now, with machine translation for Bashkir as a later aim.
> - One caveat: I can only answer from documents that are actually in this collection. The Apertium paper isn't part of it as far as I know, so I can't quote or cite it yet.
> - If you add it (or tell me the file name it's stored under), I'll treat it as a source alongside the TatarTTS paper from then on.
> - Until then, anything I say about machine translation would be outside the documents, so I'd rather not guess.
> - I'll keep answering in bullet points.
> - Want to continue with the TTS planning questions for now?

Memory: scope → 1570978467.pdf, s10590-021-09260-6.pdf; goal → Plan a text-to-speech dataset for Bashkir now, with machine translation for Bashkir as a later aim  
Checks: kind ✓ · resolved — · constraints ✓ · on track ✓ · memory 1/1  

**9. user:** Which Turkic language pairs does Apertium have?  
*searched as:* Which Turkic language pairs does Apertium support? · *scope:* 1570978467.pdf, s10590-021-09260-6.pdf

*answer* (expected answer) · 16.0 s

> - The passages do not use the word "Turkic", so here are the pairs that involve the languages named Kazakh, Tatar, Crimean Tatar and Turkish. The released language pairs are given "with indication of the translation directions and novelty" [1].
> - Released, both directions: Kazakh ⇆ Tatar [1]. Released, one direction only: Crimean Tatar → Turkish [1].
> - Also released as separate languages: Kazakh, Tatar, Crimean Tatar and Turkish [3].
> - Beyond the released set, "A selection of unreleased translation pairs with published results" includes Kazakh–Turkish and Tatar–Bashqort [5] — the Tatar–Bashqort pair is the one closest to your Bashkir (Bashqort) aim.
> - Bashqort is also named among the languages with recent Apertium work: "Recent work on other under-resourced and/or minoritised languages includes Bashqort (Tyers et al. 2012b)" [2].

Sources: [1] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 7  Conclusion · pp. 23–24; [3] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 7  Conclusion · p. 23; [5] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 5  Supporting minoritised languages > 5.2  Other languages and work ahead · pp. 20–21; [2] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 5  Supporting minoritised languages > 5.1  Released translation pairs · p. 18  
Quotes: 7 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: partial  

**10. user:** How did the anaphora module change translation accuracy?  
*searched as:* How did the anaphora module change translation accuracy in Apertium? · *scope:* 1570978467.pdf, s10590-021-09260-6.pdf

*answer* (expected answer) · 10.3 s

> - The module was manually evaluated on two language pairs, Spanish–English and Catalan–Italian, by rating the translation of anaphors with and without the module in the pipeline [1].
> - Spanish–English: accuracy improved, from 29.2% without anaphora resolution to 54.2% with it [2].
> - Catalan–Italian: accuracy fell slightly, from 83.3% to 75.0% [2].
> - Without the module, the anaphor just translates to the default in the bilingual dictionary, which in these pairs is "the male singular possessive determiner" [2].

Sources: [1] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · p. 15; [2] s10590-021-09260-6.pdf · Recent advances in Apertium, a free/open‑source rule‑based machine translation platform for low‑resource languages > 4  New modules > 4.3  Anaphora resolution > 4.3.3  Preliminary evaluation · pp. 15–16  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved — · constraints ✓ · on track ✓ · faithful: supported  

**11. user:** What does the paper say about the limitations of its models?  
*searched as:* What does the TatarTTS paper say about the limitations of its models? · *scope:* 1570978467.pdf, s10590-021-09260-6.pdf

*answer* (expected answer) · 13.3 s

> - The models are "not without their imperfections" and have "limitations in terms of coherence and clear pronunciation" [1], although they still show notable naturalness and sound quality [1].
> - The authors say the models need "further refinement" but still see them as a significant step forward for Tatar synthesis [1].
> - To strengthen the models, future versions of TatarTTS will add sentences with loanwords and expand the audio data (more samples from existing speakers and new speakers) [1].

Sources: [1] 1570978467.pdf · VI. CONCLUSION · p. 4  
Quotes: 4 verified (lowest 100)  
Checks: kind ✓ · sources+quotes ✓ · expected doc ✓ · resolved ✓ · constraints ✓ · on track ✓ · faithful: supported  

**12. user:** Summarize what we've established for my project so far.  

*meta* (expected meta) · 7.7 s

> - Your goal: plan a text-to-speech dataset for Bashkir now, with machine translation for Bashkir as a later aim.
> - You noted that Bashkir is a low-resource Turkic language.
> - "The paper" means the TatarTTS paper; the scope covers 1570978467.pdf and s10590-021-09260-6.pdf.
> - So far we checked Apertium's Turkic pairs: Kazakh⇆Tatar released both ways; Crimean Tatar→Turkish one way; Kazakh, Tatar, Crimean Tatar, Turkish also released as separate languages.
> - We looked at anaphora module accuracy: Spanish–English improved from 29.2% to 54.2%, Catalan–Italian fell slightly from 83.3% to 75.0%.
> - We covered the paper's stated model limitations: imperfections in coherence and pronunciation, need for further refinement, and future plans to add loanwords and expand audio data.
> - No dataset design decisions or concrete steps have been agreed yet—these were informational queries.

Checks: kind ✓ · resolved — · constraints ✓ · on track ✓  

**13. user:** Last question: what license is the paper's dataset released under?  
*searched as:* What license is the TatarTTS dataset released under? · *scope:* 1570978467.pdf, s10590-021-09260-6.pdf

*unknown* (expected unknown) · 6.7 s

> I don't know: the documents do not contain the answer. The passages describe the TatarTTS corpus as an open-source dataset that is publicly available, with the dataset, training recipe, and pre-trained models hosted on GitHub, but they never name a specific license. Would you like what the passages do say about how the data is released and where it can be obtained, or were you asking about a different aspect of the dataset?

Checks: kind ✓ · resolved ✓ · constraints ✓ · on track ✓  

Memory at the end:

```
Goal: Plan a text-to-speech dataset for Bashkir now, with machine translation for Bashkir as a later aim
Clarified by the user:
- [c1] Is planning a text-to-speech dataset for Bashkir, a low-resource Turkic language
Constraints:
- [k3] answer in bullet points
Terms:
- [t2] 'the paper' = the TatarTTS paper
Scope: 1570978467.pdf, s10590-021-09260-6.pdf
```

Against everything the user established: 4/4 items, goal ✓

#### Without the task memory

| turn | message | memory on: kind · constraints · on track | memory off: kind · constraints · on track |
|---:|---|---|---|
| 1 | I'm planning a text-to-speech dataset for Bashkir, a low-resource Turk… | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 2 | From now on, 'the paper' means the TatarTTS paper. And please answer i… | meta · ✓ · ✓ | meta · ✓ · ✓ |
| 3 | Where did the paper get its texts from? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 4 | How were the speakers chosen? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 5 | And how was the audio split and stored? | answer · ✓ · ✓ | answer · ✓ · ✓ |
| 6 | What did the evaluation show? | answer · ✓ · ✓ | answer · ✗ · ✓ |
| 7 | How many native speakers rated the recordings? | unknown · ✓ · ✓ | unknown · ✗ · ✓ |
| 8 | OK. I also want machine translation for Bashkir later, so from now on … | meta · ✓ · ✓ | meta · ✗ · ✓ |
| 9 | Which Turkic language pairs does Apertium have? | answer · ✓ · ✓ | answer · ✗ · ✓ |
| 10 | How did the anaphora module change translation accuracy? | answer · ✓ · ✓ | answer · ✗ · ✓ |
| 11 | What does the paper say about the limitations of its models? | answer · ✓ · ✓ | answer · ✗ · ✗ |
| 12 | Summarize what we've established for my project so far. | meta · ✓ · ✓ | meta · ✓ · ✗ |
| 13 | Last question: what license is the paper's dataset released under? | unknown · ✓ · ✓ | unknown · ✗ · ✗ |

Where the two differ, the reply without memory:

**6. memory off** (answer; searched as: What did the evaluation of the TatarTTS dataset show?)

> The evaluation used the subjective mean opinion score (MOS) measure on baseline end-to-end TTS models built to demonstrate the dataset's reliability [3]. The models are not without imperfections, with some limitations in coherence and clear pronunciation, but they demonstrate notable naturalness and sound quality [2]. The findings show that even with a relatively limited amount of training data, specifically 30 hours of speech data, reasonably good performance in terms of MOS can be achieved for TTS models [2]. The evaluation was carried out via a Telegram messenger bot interface [1].

*Judge:* The search correctly targeted the TatarTTS evaluation and the reply describes the MOS test and findings, but it is written as a paragraph instead of the required bullet points.

**7. memory off** (unknown; searched as: How many native speakers rated the recordings in the TatarTTS evaluation?)

> I don't know: the documents do not contain the answer. The passages describe how the evaluation was run — native Tatar speakers rated recordings via a Telegram bot, 30 recordings per session, on criteria scored 1 to 5 — but they never state how many speakers took part. Do you want another detail of the evaluation instead, such as how many recordings each participant rated or how many utterances were in the testing set?

*Judge:* The search question correctly captures the user's meaning about TatarTTS native-speaker raters, and the reply sensibly refuses and stays on topic, but it does not format the answer in bullet points as requested.

**8. memory off** (meta)

> Understood — I’ll treat the Apertium paper as an additional source from now on, especially for Bashkir machine translation questions. When you’re ready to ask about it, I’ll answer from that paper alongside the existing documents and include sources.

*Judge:* The reply correctly acknowledges adding the Apertium paper as a source, but it is written as a paragraph rather than the bullet points the user requires.

**9. memory off** (answer; searched as: Which Turkic language pairs does Apertium support?)

> Among the pairs in the Apertium paper, the released ones are Kazakh ⇆ Tatar [1] and Crimean Tatar → Turkish [1]. The table of unreleased translation pairs with published results also lists Kazakh–Turkisha [5] and Tatar–Bashqort [5].

*Judge:* The searched question matches the user's question and the reply lists relevant Turkic pairs, but it is written as a paragraph instead of bullet points.

**10. memory off** (answer; searched as: How did the anaphora module change translation accuracy in the Apertium paper?)

> In the Apertium paper's preliminary evaluation, adding the anaphora module helped Spanish–English but slightly hurt Catalan–Italian [2]. For Spanish–English, 120 anaphors were evaluated, with accuracy rising from 29.2% without anaphora resolution (AR) to 54.2% with it [2]. For Catalan–Italian, 108 anaphors were evaluated, with accuracy falling from 83.3% without AR to 75.0% with it [2]. The paper states that use of the module "led to an increase in accuracy of anaphor translation" for Spanish–English, but for Catalan–Italian "resulted in a slight decrease in the accuracy of resolution" [2]. The modules' gains were measured on corpora where 120 sentences (Spanish) and 108 sentences (Catalan) had at least one possessive determiner [1].

*Judge:* The reply correctly answers the anaphora-module translation-accuracy question from the Apertium paper, but it does not follow the required bullet-point format.

**11. memory off** (answer; searched as: What does the Apertium paper say about the limitations of Apertium's models?)

> The paper describes two kinds of limits. For corpus-based methods, it says what can be done is bounded by the amount of parallel text: rule-based MT is especially useful where minoritised languages lack digital texts and standardisation consensus [2]. On the modelling side, it notes that finite-state chunking has limitations, which is why the apertium-recursive module was developed to apply structural transfer rules recursively with CFGs and a GLR parser, handling nested structures such as relative clauses or prepositional phrases within prepositional phrases [4].

*Judge:* The assistant searched for and answered about the Apertium paper's MT limitations instead of the TatarTTS paper's TTS model limitations, and did not use bullet points.

**12. memory off** (meta)

> So far, the conversation has established these points from the Apertium paper:
>
> - For Turkic language pairs, the released pairs are Kazakh ⇆ Tatar and Crimean Tatar → Turkish. The table of unreleased pairs with published results also lists Kazakh–Turkisha and Tatar–Bashqort.
> - On the anaphora module, in a preliminary evaluation, Spanish–English improved from 29.2% without anaphora resolution to 54.2% with it, based on 120 anaphors. Catalan–Italian fell from 83.3% without AR to 75.0% with it, based on 108 anaphors. The paper says the module led to an increase in accuracy for Spanish–English, but the answer was cut off after that.
> - On limitations, the paper says corpus-based methods are bounded by the amount of parallel text, and rule-based MT is especially useful where minoritised languages lack digital texts and standardisation consensus. It also notes limitations of finite-state chunking, which led to apertium-recursive using CFGs and a GLR parser for nested structures such as relative clauses; that answer was also cut off.
>
> We haven’t established your project goal or what specifically you’re trying to do with this material. If you want, ask a document question and I can pull the relevant details.

*Judge:* The reply uses bullet points as constrained, but it does not summarize the established Bashkir TTS/TatarTTS project and contradicts the stated goal.

**13. memory off** (unknown; searched as: What license is the dataset associated with the Apertium paper released under?)

> I don't know: the documents do not contain the answer. The passages only say that all Apertium-related code, including language data, is free/open-source and hosted on GitHub; they do not name any license for a dataset or describe a separately released dataset. Could you say which dataset you mean (for example, the anaphora evaluation data), or whether you're asking about the licensing of the Apertium code and language data?

*Judge:* The reply grounds its refusal in the wrong paper (Apertium rather than the TatarTTS paper the user's term refers to), asks an off-topic clarifying question, and is not formatted as the requested bullet points.


<!-- scenarios:end -->
