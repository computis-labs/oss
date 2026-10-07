import { Schema } from "effect";
import { Base64 } from "effect/encoding";
import { FatturaElettronica } from "./fattura-xsd.gen.ts";

export const FatturaXml = FatturaElettronica;
export type FatturaEncoded = typeof FatturaXml.Encoded;

const amount = (cents: number) => (cents / 100).toFixed(2);

const line = (index: number) => ({
  AliquotaIVA: "22.00",
  AltriDatiGestionali: [{ RiferimentoTesto: `CM-${String(index)}`, TipoDato: "COMMESSA" }],
  CodiceArticolo: [{ CodiceTipo: "INTERNO", CodiceValore: `ART-${String(index)}` }],
  Descrizione: `Attività di consulenza & sviluppo software, modulo n. ${String(index)}`,
  NumeroLinea: String(index),
  PrezzoTotale: "100.00",
  PrezzoUnitario: "50.00",
  Quantita: "2.00",
  UnitaMisura: "ore",
});

const specs = [
  { attachmentBytes: 0, lines: 1, name: "1 linea" },
  { attachmentBytes: 0, lines: 20, name: "20 linee" },
  { attachmentBytes: 0, lines: 1000, name: "1000 linee" },
  { attachmentBytes: 1_048_576, lines: 20, name: "20 linee + allegato 1 MB" },
] as const;

const decodeFattura = Schema.decodeUnknownSync(FatturaXml);

export const fatturaFixtures = specs.map((spec) => {
  const body: FatturaEncoded["FatturaElettronicaBody"][number] = {
    DatiBeniServizi: {
      DatiRiepilogo: [
        {
          AliquotaIVA: "22.00",
          EsigibilitaIVA: "I",
          ImponibileImporto: amount(spec.lines * 10_000),
          Imposta: amount(spec.lines * 2200),
        },
      ],
      DettaglioLinee: [
        line(1),
        ...Array.from({ length: spec.lines - 1 }, (_, index) => line(index + 2)),
      ],
    },
    DatiGenerali: {
      DatiGeneraliDocumento: {
        Causale: ["Servizi professionali del mese di aprile 2026"],
        Data: "2026-04-30",
        Divisa: "EUR",
        ImportoTotaleDocumento: amount(spec.lines * 12_200),
        Numero: "FT-2026-0001",
        TipoDocumento: "TD01",
      },
    },
    DatiPagamento: [
      {
        CondizioniPagamento: "TP02",
        DettaglioPagamento: [
          {
            DataScadenzaPagamento: "2026-05-30",
            IBAN: "IT60X0542811101000000123456",
            ImportoPagamento: amount(spec.lines * 12_200),
            ModalitaPagamento: "MP05",
          },
        ],
      },
    ],
  };
  const document: FatturaEncoded = {
    FatturaElettronicaBody: [
      spec.attachmentBytes === 0
        ? body
        : {
            ...body,
            Allegati: [
              {
                Attachment: Base64.encode(
                  Uint8Array.from(
                    { length: spec.attachmentBytes },
                    (_, index) => (index * 31 + 7) % 256,
                  ),
                ),
                FormatoAttachment: "PDF",
                NomeAttachment: "fattura.pdf",
              },
            ],
          },
    ],
    FatturaElettronicaHeader: {
      CedentePrestatore: {
        DatiAnagrafici: {
          Anagrafica: { Denominazione: "Fornitore Esempio S.r.l." },
          IdFiscaleIVA: { IdCodice: "01234567890", IdPaese: "IT" },
          RegimeFiscale: "RF01",
        },
        Sede: {
          CAP: "00100",
          Comune: "Roma",
          Indirizzo: "Via Roma 1",
          Nazione: "IT",
          Provincia: "RM",
        },
      },
      CessionarioCommittente: {
        DatiAnagrafici: {
          Anagrafica: { Denominazione: "Cliente Esempio S.p.A." },
          IdFiscaleIVA: { IdCodice: "09876543210", IdPaese: "IT" },
        },
        Sede: {
          CAP: "20100",
          Comune: "Milano",
          Indirizzo: "Corso Italia 20",
          Nazione: "IT",
          Provincia: "MI",
        },
      },
      DatiTrasmissione: {
        CodiceDestinatario: "ABCDEF1",
        FormatoTrasmissione: "FPR12",
        IdTrasmittente: { IdCodice: "01234567890", IdPaese: "IT" },
        ProgressivoInvio: "00001",
      },
    },
    versione: "FPR12",
  };
  return { fattura: decodeFattura(document), name: spec.name };
});
