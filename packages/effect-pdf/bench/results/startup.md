# Benchmark effect-pdf: avvio e memoria del pool

- Node v26.10.0 · linux/x64
- Ogni riga è la mediana di 3 processi separati: dall'avvio del pool alla prima classificazione completata su ogni worker, e la memoria residente (RSS) dell'intero processo in quel momento.
- Il binario di PDFium è compilato una volta nel thread principale e condiviso con i worker; i moduli che girano nei worker importano solo i moduli di Effect che usano.

| Worker | pronto dopo (ms) | RSS del processo (MB) |
| -----: | ---------------: | --------------------: |
|      1 |              136 |                   235 |
|      2 |              137 |                   285 |
|      4 |              146 |                   390 |
