import { Schema } from "effect";

export const verdictClasses = {
  errored: "errored",
  missed: "missed",
  partial: "partial",
  right: "right",
  wrong: "wrong",
} as const;
export type VerdictClass = (typeof verdictClasses)[keyof typeof verdictClasses];

export const tones = {
  bad: "bad",
  good: "good",
  info: "info",
  neutral: "neutral",
  warn: "warn",
} as const;
export type Tone = (typeof tones)[keyof typeof tones];

export const ThemeSchema = Schema.Struct({
  border: Schema.String,
  font: Schema.String,
  highlight: Schema.String,
  muted: Schema.String,
  series: Schema.Array(Schema.String),
  surface: Schema.String,
  text: Schema.String,
  tones: Schema.Struct({
    bad: Schema.String,
    good: Schema.String,
    info: Schema.String,
    neutral: Schema.String,
    warn: Schema.String,
  }),
  verdicts: Schema.Struct({
    errored: Schema.String,
    excluded: Schema.String,
    gap: Schema.String,
    missed: Schema.String,
    partial: Schema.String,
    right: Schema.String,
    unscored: Schema.String,
    wrong: Schema.String,
  }),
});
export type Theme = typeof ThemeSchema.Type;

export const computis: Theme = {
  border: "#EBEBEA",
  font: "Google Sans Flex, system-ui, sans-serif",
  highlight: "#80EF80",
  muted: "#9F9F9D",
  series: [
    "#001A01",
    "#4092E7",
    "#00A9B3",
    "#4AA651",
    "#7A9E23",
    "#B38900",
    "#D0750A",
    "#DB6656",
    "#D1649C",
    "#9E77DC",
    "#7685E9",
  ],
  surface: "#FFFFFF",
  text: "#001A01",
  tones: {
    bad: "#E55767",
    good: "#27A139",
    info: "#048AF5",
    neutral: "#9F9F9D",
    warn: "#D29E00",
  },
  verdicts: {
    errored: "#048AF5",
    excluded: "#9F9F9D",
    gap: "#9E77DC",
    missed: "#FFEAEB",
    partial: "#D29E00",
    right: "#27A139",
    unscored: "#D6D6D4",
    wrong: "#E55767",
  },
};

export const seriesColor = (theme: Theme, index: number) =>
  theme.series[index % theme.series.length] ?? theme.text;
