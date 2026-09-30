| metric | fixed | struct |
|---|---:|---:|
| chunks | 230 | 178 |
| chunks per document (mean) | 76.7 | 59.3 |
| length min | 333 | 50 |
| length p10 | 990 | 386 |
| length median | 996 | 1290 |
| length p90 | 999 | 1467 |
| length max | 999 | 1500 |
| length mean ± std | 991 ± 46 | 1093 ± 404 |
| small chunks (< 200 chars) | 0.0% | 2.8% |
| large chunks (> 1500 chars) | 0.0% | 0.0% |
| starts mid-sentence | 78.3% | 0.6% |
| ends mid-sentence | 92.6% | 21.3% |
| mixes 2+ sections | 17.8% | 1.1% |
| crosses a page break | 42.6% | 24.2% |
| stored chars / corpus chars | 1.18× | 1.01× |
| neighbour similarity (cosine) | 0.835 | 0.790 |
| embedding tokens | 54,102 | 46,117 |
| embedding time | 5.8 s | 4.5 s |
| storage: text + vectors | 0.94 MB | 0.75 MB |

### Per document

| document | pages | headings | fixed chunks | struct chunks |
|---|---:|---|---:|---:|
| TatarTTS: An Open-Source Text-to-Speech Synthesis Dataset for the Tatar Language (`1570978467.pdf`) | 5 | 0 from none | 27 | 17 |
| GUTLESS (`Gutless.pdf`) | 62 | 14 from fonts | 109 | 84 |
| Recent advances in Apertium, a free/open-source rule-based machine translation platform for low-resource languages (`s10590-021-09260-6.pdf`) | 28 | 26 from outline | 94 | 77 |
