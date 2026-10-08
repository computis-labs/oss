# Benchmark effect-pdf

- Node v26.11.1 · linux/x64
- Riferimento: pipeline pdf.js (unpdf), in `bench/baseline.ts`: apre il PDF una volta per la classificazione e una per il testo o le immagini
- effect-pdf apre il PDF una volta sola; le fixture sono generate in `bench/fixtures.ts`

## Import fattura da PDF testuale: classificazione + testo

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture  |   KB | Implementazione           | media (ms) | p99 (ms) |    × |
| -------- | ---: | ------------------------- | ---------: | -------: | ---: |
| 1 pagina |  1,6 | pdf.js (pipeline attuale) |       1,42 |     2,57 | 1,0× |
| 1 pagina |  1,6 | effect-pdf                |       1,16 |     1,90 | 1,2× |
| 8 pagine | 14,7 | pdf.js (pipeline attuale) |      14,90 |    18,65 | 1,0× |
| 8 pagine | 14,7 | effect-pdf                |       6,88 |     7,99 | 2,2× |

## Import fattura da scansione 1-bit: classificazione + immagini per il modello (PNG)

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

PDFium decodifica un'immagine a 1 bit espandendola a 8 bit per pixel, ed effect-pdf la reimpacchetta a 1 bit prima del PNG; pdf.js la decodifica direttamente a 1 bit. Per questo qui effect-pdf è più lento, mentre classificazione e testo della stessa pagina sono molto più veloci.

| Fixture               |  KB | Implementazione           | media (ms) | p99 (ms) |    × |
| --------------------- | --: | ------------------------- | ---------: | -------: | ---: |
| 1 pagina A4 a 200 dpi | 1,8 | pdf.js (pipeline attuale) |       4,40 |     6,64 | 1,0× |
| 1 pagina A4 a 200 dpi | 1,8 | effect-pdf                |       7,02 |     8,37 | 0,6× |
| 5 pagine A4 a 200 dpi | 2,2 | pdf.js (pipeline attuale) |      18,05 |    23,16 | 1,0× |
| 5 pagine A4 a 200 dpi | 2,2 | effect-pdf                |      32,05 |    36,04 | 0,6× |

## Import fattura da scansione JPEG: classificazione + immagini per il modello

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture  |   KB | Implementazione           | media (ms) | p99 (ms) |     × |
| -------- | ---: | ------------------------- | ---------: | -------: | ----: |
| 1 pagina | 26,0 | pdf.js (pipeline attuale) |      15,32 |    19,01 |  1,0× |
| 1 pagina | 26,0 | effect-pdf                |       0,38 |     1,19 | 40,0× |

## Render della pagina 1 a 900 px (PNG)

Riferimento: pdf.js (pipeline attuale). La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

| Fixture           |  KB | Implementazione           | media (ms) | p99 (ms) |    × |
| ----------------- | --: | ------------------------- | ---------: | -------: | ---: |
| fattura, 1 pagina | 1,6 | pdf.js (pipeline attuale) |      26,72 |    29,92 | 1,0× |
| fattura, 1 pagina | 1,6 | effect-pdf                |       9,11 |    10,04 | 2,9× |
| scansione 1-bit   | 1,8 | pdf.js (pipeline attuale) |      31,85 |    42,52 | 1,0× |
| scansione 1-bit   | 1,8 | effect-pdf                |      24,47 |    25,57 | 1,3× |

## Codifica PNG di un raster già decodificato

Riferimento: fast-png. La colonna × è la velocità rispetto al riferimento, sulla stessa fixture.

Motivo di `src/png.ts` invece di fast-png: `CompressionStream` usa lo zlib nativo della piattaforma, che comprime più in fretta del deflate in JavaScript di fast-png.

| Fixture                   |     KB | Implementazione               | media (ms) | p99 (ms) |    × |
| ------------------------- | -----: | ----------------------------- | ---------: | -------: | ---: |
| render RGB 900×1273       | 3356,5 | fast-png                      |      19,65 |    22,14 | 1,0× |
| render RGB 900×1273       | 3356,5 | encodePng (CompressionStream) |       4,05 |     4,69 | 4,8× |
| scansione 1 bit 1654×2339 |  472,8 | fast-png                      |       3,16 |     6,75 | 1,0× |
| scansione 1 bit 1654×2339 |  472,8 | encodePng (CompressionStream) |       1,10 |     4,48 | 2,9× |
