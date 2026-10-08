# Benchmark effect-pdf

- Node v26.10.0 · linux/x64
- Riferimento: la pipeline di `apps/backend/src/modules/invoice-translation` su pdf.js (unpdf), replicata in `bench/baseline.ts`: apre il PDF una volta per la classificazione e una per il testo o le immagini
- effect-pdf apre il PDF una volta sola; le fixture sono generate in `bench/fixtures.ts`

## Import fattura da PDF testuale: classificazione + testo

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture  |   KB | Implementazione           | media (ms) | p99 (ms) |    × |
| -------- | ---: | ------------------------- | ---------: | -------: | ---: |
| 1 pagina |  1,6 | pdf.js (pipeline attuale) |       1,46 |     2,35 | 1,0× |
| 1 pagina |  1,6 | effect-pdf                |       1,12 |     1,88 | 1,3× |
| 8 pagine | 14,7 | pdf.js (pipeline attuale) |      16,28 |    18,36 | 1,0× |
| 8 pagine | 14,7 | effect-pdf                |       6,95 |     9,01 | 2,3× |

## Import fattura da scansione 1-bit: classificazione + immagini per il modello (PNG)

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

PDFium decodifica un'immagine a 1 bit espandendola a 8 bit per pixel, ed effect-pdf la reimpacchetta a 1 bit prima del PNG; pdf.js la decodifica direttamente a 1 bit. Per questo qui effect-pdf è più lento, mentre classificazione e testo della stessa pagina sono molto più veloci.

| Fixture               |  KB | Implementazione           | media (ms) | p99 (ms) |    × |
| --------------------- | --: | ------------------------- | ---------: | -------: | ---: |
| 1 pagina A4 a 200 dpi | 1,8 | pdf.js (pipeline attuale) |       4,34 |     6,68 | 1,0× |
| 1 pagina A4 a 200 dpi | 1,8 | effect-pdf                |       6,91 |     9,17 | 0,6× |
| 5 pagine A4 a 200 dpi | 2,2 | pdf.js (pipeline attuale) |      18,32 |    25,85 | 1,0× |
| 5 pagine A4 a 200 dpi | 2,2 | effect-pdf                |      30,85 |    33,19 | 0,6× |

## Import fattura da scansione JPEG: classificazione + immagini per il modello

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture  |   KB | Implementazione           | media (ms) | p99 (ms) |     × |
| -------- | ---: | ------------------------- | ---------: | -------: | ----: |
| 1 pagina | 26,0 | pdf.js (pipeline attuale) |      15,17 |    18,46 |  1,0× |
| 1 pagina | 26,0 | effect-pdf                |       0,37 |     1,20 | 40,6× |

## Render della pagina 1 a 900 px (PNG)

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture           |  KB | Implementazione           | media (ms) | p99 (ms) |    × |
| ----------------- | --: | ------------------------- | ---------: | -------: | ---: |
| fattura, 1 pagina | 1,6 | pdf.js (pipeline attuale) |      27,27 |    35,87 | 1,0× |
| fattura, 1 pagina | 1,6 | effect-pdf                |       8,57 |    10,14 | 3,2× |
| scansione 1-bit   | 1,8 | pdf.js (pipeline attuale) |      32,16 |    34,13 | 1,0× |
| scansione 1-bit   | 1,8 | effect-pdf                |      23,82 |    25,33 | 1,3× |

## Codifica PNG di un raster già decodificato

Riferimento: fast-png. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

Motivo di `src/png.ts` invece di fast-png: lo zlib nativo di Node comprime più in fretta del deflate in JavaScript di fast-png.

| Fixture                   |     KB | Implementazione          | media (ms) | p99 (ms) |    × |
| ------------------------- | -----: | ------------------------ | ---------: | -------: | ---: |
| render RGB 900×1273       | 3356,5 | fast-png                 |      19,93 |    23,59 | 1,0× |
| render RGB 900×1273       | 3356,5 | encodePng (zlib di Node) |       3,91 |     5,73 | 5,1× |
| scansione 1 bit 1654×2339 |  472,8 | fast-png                 |       2,98 |     4,64 | 1,0× |
| scansione 1 bit 1654×2339 |  472,8 | encodePng (zlib di Node) |       0,67 |     1,46 | 4,5× |
