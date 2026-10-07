# Benchmark effect-xml (con sottoclasse di String, come nel backend)

- Node v26.10.0 · darwin/arm64 · 15 core
- Riferimento: pipeline fast-xml-parser + Schema, in `bench/baseline.ts`
- Fixture: `tests/fixtures/fattura.ts`, XML indentato; ogni fixture è verificata prima delle misure (decode, encode e XSD)
- Effect rc.116 con Schema JIT attivo per tutto il processo, come nel backend: vale sia per la pipeline attuale sia per effect-xml

## Decode: XML → fattura tipizzata

Riferimento: attuale (fast-xml-parser + Schema). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione                                                                      | media (ms) | p99 (ms) |   ops/s |      × |
| ------------------------ | -----: | ------------------------------------------------------------------------------------ | ---------: | -------: | ------: | -----: |
| 1 linea                  |    3,3 | attuale (fast-xml-parser + Schema)                                                   |      0,104 |    0,206 |    9856 |  1,00× |
| 1 linea                  |    3,3 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      0,019 |    0,028 |  52.399 |  5,36× |
| 1 linea                  |    3,3 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      0,010 |    0,016 | 100.331 | 10,22× |
| 1 linea                  |    3,3 | effect-xml                                                                           |      0,034 |    0,042 |  29.958 |  3,08× |
| 20 linee                 |   15,9 | attuale (fast-xml-parser + Schema)                                                   |      0,436 |    0,539 |    2299 |  1,00× |
| 20 linee                 |   15,9 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      0,072 |    0,104 |  13.934 |  6,04× |
| 20 linee                 |   15,9 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      0,043 |    0,058 |  23.523 | 10,19× |
| 20 linee                 |   15,9 | effect-xml                                                                           |      0,152 |    0,182 |    6637 |  2,87× |
| 1000 linee               |  671,2 | attuale (fast-xml-parser + Schema)                                                   |     19,820 |   22,974 |      51 |  1,00× |
| 1000 linee               |  671,2 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |      2,935 |    3,537 |     342 |  6,75× |
| 1000 linee               |  671,2 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      1,764 |    2,333 |     570 | 11,23× |
| 1000 linee               |  671,2 | effect-xml                                                                           |      6,330 |    9,193 |     159 |  3,13× |
| 20 linee + allegato 1 MB | 1381,4 | attuale (fast-xml-parser + Schema)                                                   |     40,825 |   51,387 |      25 |  1,00× |
| 20 linee + allegato 1 MB | 1381,4 | solo Schema della pipeline attuale (union con wrapper, su output di fast-xml-parser) |     16,478 |   17,318 |      61 |  2,48× |
| 20 linee + allegato 1 MB | 1381,4 | solo Schema di effect-xml (FatturaElettronicaSchema, su oggetto encoded)             |      8,353 |    8,754 |     120 |  4,89× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml                                                                           |      9,840 |   10,239 |     102 |  4,15× |

## Encode: fattura tipizzata → XML

Riferimento: attuale (Schema + fast-xml-builder). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione                     | media (ms) | p99 (ms) |  ops/s |     × |
| ------------------------ | -----: | ----------------------------------- | ---------: | -------: | -----: | ----: |
| 1 linea                  |    3,3 | attuale (Schema + fast-xml-builder) |      0,033 |    0,045 | 31.023 | 1,00× |
| 1 linea                  |    3,3 | effect-xml                          |      0,014 |    0,021 | 70.216 | 2,27× |
| 20 linee                 |   15,9 | attuale (Schema + fast-xml-builder) |      0,141 |    0,193 |   7145 | 1,00× |
| 20 linee                 |   15,9 | effect-xml                          |      0,060 |    0,082 | 16.721 | 2,34× |
| 1000 linee               |  671,2 | attuale (Schema + fast-xml-builder) |      5,780 |    6,060 |    173 | 1,00× |
| 1000 linee               |  671,2 | effect-xml                          |      2,528 |    3,657 |    399 | 2,29× |
| 20 linee + allegato 1 MB | 1381,4 | attuale (Schema + fast-xml-builder) |      8,714 |    9,445 |    115 | 1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml                          |      8,459 |    8,705 |    118 | 1,03× |

## Parsing XML (senza Schema)

Riferimento: fast-xml-parser. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione     | media (ms) | p99 (ms) |  ops/s |       × |
| ------------------------ | -----: | ------------------- | ---------: | -------: | -----: | ------: |
| 1 linea                  |    3,3 | fast-xml-parser     |      0,076 |    0,104 | 13.160 |   1,00× |
| 1 linea                  |    3,3 | txml                |      0,024 |    0,032 | 42.661 |   3,24× |
| 1 linea                  |    3,3 | eksml               |      0,025 |    0,034 | 40.595 |   3,08× |
| 1 linea                  |    3,3 | effect-xml tokenize |      0,019 |    0,026 | 52.191 |   3,97× |
| 20 linee                 |   15,9 | fast-xml-parser     |      0,359 |    0,490 |   2801 |   1,00× |
| 20 linee                 |   15,9 | txml                |      0,105 |    0,128 |   9562 |   3,42× |
| 20 linee                 |   15,9 | eksml               |      0,117 |    0,139 |   8601 |   3,08× |
| 20 linee                 |   15,9 | effect-xml tokenize |      0,095 |    0,118 | 10.562 |   3,77× |
| 1000 linee               |  671,2 | fast-xml-parser     |     15,724 |   18,760 |     64 |   1,00× |
| 1000 linee               |  671,2 | txml                |      4,305 |    4,651 |    233 |   3,65× |
| 1000 linee               |  671,2 | eksml               |      4,806 |    5,126 |    208 |   3,27× |
| 1000 linee               |  671,2 | effect-xml tokenize |      3,894 |    4,253 |    257 |   4,04× |
| 20 linee + allegato 1 MB | 1381,4 | fast-xml-parser     |     22,564 |   33,631 |     45 |   1,00× |
| 20 linee + allegato 1 MB | 1381,4 | txml                |      0,129 |    0,154 |   7798 | 175,08× |
| 20 linee + allegato 1 MB | 1381,4 | eksml               |      0,140 |    0,162 |   7158 | 160,96× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml tokenize |      0,264 |    0,340 |   3799 |  85,53× |

## Validazione XSD

Riferimento: xmllint-wasm. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione           | media (ms) | p99 (ms) |  ops/s |       × |
| ------------------------ | -----: | ------------------------- | ---------: | -------: | -----: | ------: |
| 1 linea                  |    3,3 | xmllint-wasm              |     20,386 |   21,878 |     49 |   1,00× |
| 1 linea                  |    3,3 | effect-xml (libxml2-wasm) |      0,036 |    0,046 | 27.952 | 565,57× |
| 20 linee                 |   15,9 | xmllint-wasm              |     20,138 |   21,298 |     50 |   1,00× |
| 20 linee                 |   15,9 | effect-xml (libxml2-wasm) |      0,172 |    0,198 |   5850 | 117,39× |
| 1000 linee               |  671,2 | xmllint-wasm              |     36,308 |   39,573 |     28 |   1,00× |
| 1000 linee               |  671,2 | effect-xml (libxml2-wasm) |      7,068 |    7,409 |    142 |   5,14× |
| 20 linee + allegato 1 MB | 1381,4 | xmllint-wasm              |     31,137 |   37,607 |     32 |   1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml (libxml2-wasm) |      1,903 |    2,605 |    529 |  16,36× |

## Scrittura XML (senza Schema)

Riferimento: fast-xml-builder. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture                  |     KB | Implementazione   | media (ms) | p99 (ms) |   ops/s |     × |
| ------------------------ | -----: | ----------------- | ---------: | -------: | ------: | ----: |
| 1 linea                  |    3,3 | fast-xml-builder  |      0,020 |    0,027 |  49.644 | 1,00× |
| 1 linea                  |    3,3 | effect-xml writer |      0,003 |    0,003 | 397.545 | 7,97× |
| 20 linee                 |   15,9 | fast-xml-builder  |      0,092 |    0,117 |  10.871 | 1,00× |
| 20 linee                 |   15,9 | effect-xml writer |      0,012 |    0,015 |  82.024 | 7,51× |
| 1000 linee               |  671,2 | fast-xml-builder  |      3,898 |    4,934 |     257 | 1,00× |
| 1000 linee               |  671,2 | effect-xml writer |      0,513 |    0,911 |    1981 | 7,60× |
| 20 linee + allegato 1 MB | 1381,4 | fast-xml-builder  |      0,312 |    0,532 |    3406 | 1,00× |
| 20 linee + allegato 1 MB | 1381,4 | effect-xml writer |      0,116 |    0,137 |    8612 | 2,68× |
