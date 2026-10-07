# Benchmark effect-xml

- Node v26.10.0 · darwin/arm64 · 15 core
- Riferimento: pipeline fast-xml-parser + Schema, in `bench/baseline.ts`
- Fixture: `tests/fixtures/fattura.ts`, XML indentato; ogni fixture è verificata prima delle misure (decode, encode e XSD)
- Effect rc.116 con Schema JIT attivo per tutto il processo, come nel backend: vale sia per la pipeline attuale sia per effect-xml

## Decode: XML → fattura tipizzata

Riferimento: attuale (fast-xml-parser + Schema). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione                                                                      | media (ms) | p99 (ms) |   ops/s |     × |
| ------------------------ | -----: | ------------------------------------------------------------------------------------ | ---------: | -------: | ------: | ----: |
| 1 linea                  |    3,3 | attuale (fast-xml-parser + Schema)                                                   |      0,087 |    0,121 |  11.614 | 1,00× |
| 1 linea                  |    3,3 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      0,018 |    0,023 |  55.626 | 4,78× |
| 1 linea                  |    3,3 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      0,010 |    0,012 | 104.985 | 9,00× |
| 1 linea                  |    3,3 | effect-xml                                                                           |      0,019 |    0,023 |  53.886 | 4,62× |
| 20 linee                 |   15,9 | attuale (fast-xml-parser + Schema)                                                   |      0,377 |    0,467 |    2658 | 1,00× |
| 20 linee                 |   15,9 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      0,069 |    0,095 |  14.476 | 5,43× |
| 20 linee                 |   15,9 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      0,041 |    0,055 |  24.519 | 9,18× |
| 20 linee                 |   15,9 | effect-xml                                                                           |      0,082 |    0,110 |  12.442 | 4,61× |
| 1000 linee               |  671,2 | attuale (fast-xml-parser + Schema)                                                   |     16,599 |   19,566 |      60 | 1,00× |
| 1000 linee               |  671,2 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      2,830 |    5,138 |     358 | 5,87× |
| 1000 linee               |  671,2 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      1,758 |    2,241 |     572 | 9,44× |
| 1000 linee               |  671,2 | effect-xml                                                                           |      3,233 |    3,797 |     310 | 5,13× |
| 20 linee + allegato 1 MB | 1381,4 | attuale (fast-xml-parser + Schema)                                                   |     31,389 |   39,478 |      32 | 1,00× |
| 20 linee + allegato 1 MB | 1381,4 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      6,434 |    7,199 |     156 | 4,88× |
| 20 linee + allegato 1 MB | 1381,4 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      3,233 |    3,970 |     310 | 9,71× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml                                                                           |      4,392 |    4,823 |     228 | 7,15× |

## Encode: fattura tipizzata → XML

Riferimento: attuale (Schema + fast-xml-builder). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione                     | media (ms) | p99 (ms) |  ops/s |     × |
| ------------------------ | -----: | ----------------------------------- | ---------: | -------: | -----: | ----: |
| 1 linea                  |    3,3 | attuale (Schema + fast-xml-builder) |      0,030 |    0,036 | 34.040 | 1,00× |
| 1 linea                  |    3,3 | effect-xml                          |      0,014 |    0,018 | 72.066 | 2,11× |
| 20 linee                 |   15,9 | attuale (Schema + fast-xml-builder) |      0,131 |    0,182 |   7652 | 1,00× |
| 20 linee                 |   15,9 | effect-xml                          |      0,060 |    0,081 | 16.816 | 2,19× |
| 1000 linee               |  671,2 | attuale (Schema + fast-xml-builder) |      5,543 |    8,676 |    182 | 1,00× |
| 1000 linee               |  671,2 | effect-xml                          |      2,455 |    2,954 |    409 | 2,26× |
| 20 linee + allegato 1 MB | 1381,4 | attuale (Schema + fast-xml-builder) |      3,622 |    4,094 |    277 | 1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml                          |      3,339 |    3,709 |    300 | 1,08× |

## Parsing XML (senza Schema)

Riferimento: fast-xml-parser. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione     | media (ms) | p99 (ms) |   ops/s |       × |
| ------------------------ | -----: | ------------------- | ---------: | -------: | ------: | ------: |
| 1 linea                  |    3,3 | fast-xml-parser     |      0,065 |    0,091 |  15.556 |   1,00× |
| 1 linea                  |    3,3 | txml                |      0,012 |    0,015 |  84.107 |   5,38× |
| 1 linea                  |    3,3 | eksml               |      0,006 |    0,007 | 169.318 |  10,82× |
| 1 linea                  |    3,3 | effect-xml tokenize |      0,006 |    0,007 | 176.257 |  11,35× |
| 20 linee                 |   15,9 | fast-xml-parser     |      0,301 |    0,377 |    3337 |   1,00× |
| 20 linee                 |   15,9 | txml                |      0,055 |    0,076 |  18.269 |   5,45× |
| 20 linee                 |   15,9 | eksml               |      0,028 |    0,035 |  36.490 |  10,87× |
| 20 linee                 |   15,9 | effect-xml tokenize |      0,028 |    0,034 |  35.835 |  10,71× |
| 1000 linee               |  671,2 | fast-xml-parser     |     13,117 |   13,743 |      76 |   1,00× |
| 1000 linee               |  671,2 | txml                |      2,308 |    2,730 |     435 |   5,68× |
| 1000 linee               |  671,2 | eksml               |      1,238 |    1,552 |     813 |  10,59× |
| 1000 linee               |  671,2 | effect-xml tokenize |      1,167 |    1,291 |     858 |  11,24× |
| 20 linee + allegato 1 MB | 1381,4 | fast-xml-parser     |     22,685 |   33,084 |      45 |   1,00× |
| 20 linee + allegato 1 MB | 1381,4 | txml                |      0,079 |    0,113 |  12.846 | 287,96× |
| 20 linee + allegato 1 MB | 1381,4 | eksml               |      0,051 |    0,067 |  19.783 | 444,25× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml tokenize |      0,197 |    0,240 |    5103 | 115,38× |

## Validazione XSD

Riferimento: xmllint-wasm. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione           | media (ms) | p99 (ms) |  ops/s |       × |
| ------------------------ | -----: | ------------------------- | ---------: | -------: | -----: | ------: |
| 1 linea                  |    3,3 | xmllint-wasm              |     20,052 |   21,134 |     50 |   1,00× |
| 1 linea                  |    3,3 | effect-xml (libxml2-wasm) |      0,036 |    0,045 | 28.342 | 562,79× |
| 20 linee                 |   15,9 | xmllint-wasm              |     20,176 |   21,612 |     50 |   1,00× |
| 20 linee                 |   15,9 | effect-xml (libxml2-wasm) |      0,173 |    0,246 |   5830 | 116,80× |
| 1000 linee               |  671,2 | xmllint-wasm              |     38,820 |   46,460 |     26 |   1,00× |
| 1000 linee               |  671,2 | effect-xml (libxml2-wasm) |      7,185 |    8,418 |    139 |   5,40× |
| 20 linee + allegato 1 MB | 1381,4 | xmllint-wasm              |     30,306 |   31,182 |     33 |   1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml (libxml2-wasm) |      1,896 |    2,638 |    530 |  15,98× |

## Scrittura XML (senza Schema)

Riferimento: fast-xml-builder. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione   | media (ms) | p99 (ms) |   ops/s |     × |
| ------------------------ | -----: | ----------------- | ---------: | -------: | ------: | ----: |
| 1 linea                  |    3,3 | fast-xml-builder  |      0,018 |    0,024 |  56.454 | 1,00× |
| 1 linea                  |    3,3 | effect-xml writer |      0,003 |    0,003 | 396.404 | 6,99× |
| 20 linee                 |   15,9 | fast-xml-builder  |      0,082 |    0,107 |  12.203 | 1,00× |
| 20 linee                 |   15,9 | effect-xml writer |      0,012 |    0,017 |  83.357 | 6,79× |
| 1000 linee               |  671,2 | fast-xml-builder  |      3,483 |    4,435 |     288 | 1,00× |
| 1000 linee               |  671,2 | effect-xml writer |      0,509 |    0,892 |    1997 | 6,85× |
| 20 linee + allegato 1 MB | 1381,4 | fast-xml-builder  |      0,300 |    0,507 |    3538 | 1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml writer |      0,115 |    0,133 |    8685 | 2,60× |
