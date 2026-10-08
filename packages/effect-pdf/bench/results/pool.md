# Benchmark effect-pdf: pool di worker

- Node v26.10.0 · linux/x64 · 16 core
- Mediana di 7 esecuzioni dopo 2 di riscaldamento. La colonna × è la velocità rispetto al motore in-process.
- «Event loop bloccato» è il ritardo più lungo misurato sul thread principale durante il lavoro: con il motore in-process il server non risponde ad altre richieste per tutto quel tempo.

## 16 fatture testuali di 1 pagina aperte insieme: classificazione + testo

| Motore                         | tempo (ms, mediana) |    × | event loop bloccato al massimo (ms) |
| ------------------------------ | ------------------: | ---: | ----------------------------------: |
| in-process (thread principale) |                20,3 | 1,0× |                                22,4 |
| 1 worker                       |                23,8 | 0,9× |                                 2,2 |
| 2 worker                       |                12,5 | 1,6× |                                 2,4 |
| 4 worker                       |                 8,2 | 2,5× |                                 2,3 |

## 16 scansioni 1-bit aperte insieme: classificazione + immagini per il modello

| Motore                         | tempo (ms, mediana) |    × | event loop bloccato al massimo (ms) |
| ------------------------------ | ------------------: | ---: | ----------------------------------: |
| in-process (thread principale) |               102,9 | 1,0× |                               105,0 |
| 1 worker                       |               109,2 | 0,9× |                                 2,2 |
| 2 worker                       |                56,1 | 1,8× |                                 2,4 |
| 4 worker                       |                30,7 | 3,3× |                                 2,6 |

## Contratto di 48 pagine: classificazione + testo

| Motore                         | tempo (ms, mediana) |    × | event loop bloccato al massimo (ms) |
| ------------------------------ | ------------------: | ---: | ----------------------------------: |
| in-process (thread principale) |                64,3 | 1,0× |                                67,1 |
| 1 worker                       |                65,8 | 1,0× |                                 2,2 |
| 2 worker                       |                37,6 | 1,7× |                                 2,1 |
| 4 worker                       |                26,3 | 2,4× |                                 2,1 |

## Contratto di 48 pagine: render di tutte le pagine a 900 px

| Motore                         | tempo (ms, mediana) |    × | event loop bloccato al massimo (ms) |
| ------------------------------ | ------------------: | ---: | ----------------------------------: |
| in-process (thread principale) |               561,8 | 1,0× |                               565,7 |
| 1 worker                       |               575,3 | 1,0× |                                 2,2 |
| 2 worker                       |               291,3 | 1,9× |                                 2,9 |
| 4 worker                       |               164,8 | 3,4× |                                 3,1 |
