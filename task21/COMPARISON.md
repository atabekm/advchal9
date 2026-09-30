| metric | fixed | struct |
|---|---:|---:|
| chunks | 230 | 182 |
| chunks per document (mean) | 76.7 | 60.7 |
| length min | 333 | 50 |
| length p10 | 990 | 375 |
| length median | 996 | 1219 |
| length p90 | 999 | 1463 |
| length max | 999 | 1500 |
| length mean ± std | 991 ± 46 | 1069 ± 405 |
| small chunks (< 200 chars) | 0.0% | 2.7% |
| large chunks (> 1500 chars) | 0.0% | 0.0% |
| starts mid-sentence | 77.8% | 0.5% |
| ends mid-sentence | 92.2% | 20.3% |
| mixes 2+ sections | 22.6% | 2.7% |
| crosses a page break | 42.6% | 23.1% |
| stored chars / corpus chars | 1.18× | 1.01× |
| neighbour similarity (cosine) | 0.835 | 0.787 |
| embedding tokens | 54,049 | 46,141 |
| embedding time | 5.3 s | 4.5 s |
| storage: text + vectors | 0.94 MB | 0.76 MB |

### Per document

| document | pages | headings | fixed chunks | struct chunks |
|---|---:|---|---:|---:|
| TatarTTS: An Open-Source Text-to-Speech Synthesis Dataset for the Tatar Language (`1570978467.pdf`) | 5 | 14 from fonts | 27 | 21 |
| GUTLESS (`Gutless.pdf`) | 62 | 14 from fonts | 109 | 84 |
| Recent advances in Apertium, a free/open-source rule-based machine translation platform for low-resource languages (`s10590-021-09260-6.pdf`) | 28 | 26 from outline | 94 | 77 |
