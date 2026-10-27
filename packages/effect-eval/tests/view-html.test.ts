import { describe, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import * as Charts from "../src/chart.ts";
import * as ChartHtml from "../src/chart-html.ts";
import * as ChartMermaid from "../src/chart-mermaid.ts";
import * as ChartUnicode from "../src/chart-unicode.ts";
import * as Theme from "../src/theme.ts";
import * as View from "../src/view.ts";
import * as ViewHtml from "../src/view-html.ts";
import { sampleRuns } from "./fixtures.ts";

describe("ViewHtml.escapeHtml", () => {
  it("escapes the five special characters", () => {
    expect(ViewHtml.escapeHtml(`<a href="x">Rossi & 'Figli'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Rossi &amp; &#39;Figli&#39;&lt;/a&gt;",
    );
  });
});

const HOSTILE = "</script><script>alert(1)</script><img src=x onerror=alert(1)><!--<script>";

describe("ViewHtml.render with a hostile chart label", () => {
  const hostile = View.figure(
    Charts.Variants({
      bars: [
        { high: Option.none(), low: Option.none(), value: 0.5, variant: "safe" },
        { high: Option.none(), low: Option.none(), value: 0.7, variant: HOSTILE },
      ],
      metric: "accuracy",
      title: "accuracy by variant",
    }),
  );

  const page = (renderer: View.ChartRenderer) =>
    ViewHtml.render([hostile, View.Text({ text: "AFTER-CHART", tone: "neutral" })], {
      renderer,
      title: "run",
    });

  it.effect("puts a text chart in a pre, escaped", () =>
    Effect.gen(function* () {
      const html = yield* page(ChartUnicode.renderer());

      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<script>alert");
      expect(html).toMatch(/<pre class="chart">[^<]*&lt;\/script&gt;&lt;script&gt;/u);
    }),
  );

  it.effect("keeps every < of the chart data out of the script it embeds", () =>
    Effect.gen(function* () {
      const html = yield* page(ChartHtml.renderer({ includeScripts: false }));
      const embedded = html.slice(html.indexOf("<script>vegaEmbed") + "<script>".length);

      expect(embedded.slice(0, embedded.indexOf("</script>"))).not.toContain("<");
      expect(html.match(/<script/gu)).toHaveLength(1);
      expect(html).toContain("<p>AFTER-CHART</p>");
    }),
  );

  it.effect("falls back to the table for a drawing the page cannot show", () =>
    Effect.gen(function* () {
      const html = yield* page(ChartMermaid.renderer());

      expect(html).not.toContain("xychart-beta");
      expect(html).toContain("&lt;img src=x onerror");
    }),
  );
});

describe("ViewHtml.render", () => {
  it.effect("escapes the title, the texts and the table cells", () =>
    Effect.gen(function* () {
      const html = yield* ViewHtml.render(
        [
          View.Text({ text: "<script>alert(1)</script>", tone: Theme.tones.neutral }),
          View.table(["<th>"], [["Bianchi & Figli <srl>"]]),
        ],
        { title: "run <1>" },
      );

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("<title>run &lt;1&gt;</title>");
      expect(html).toContain("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
      expect(html).toContain("<th>&lt;th&gt;</th>");
      expect(html).toContain("<td>Bianchi &amp; Figli &lt;srl&gt;</td>");
    }),
  );

  it.effect("marks a toned cell and badge with the class of the tone", () =>
    Effect.gen(function* () {
      const html = yield* ViewHtml.render(
        [
          View.Badge({ label: "failed", tone: Theme.tones.bad }),
          View.table(["result"], [[View.cell("pass", Theme.tones.good)]]),
        ],
        { title: "run" },
      );

      expect(html).toContain('<span class="badge tone-bad">failed</span>');
      expect(html).toContain('<td class="tone-good">pass</td>');
    }),
  );

  it.effect("styles the page with the colors of the theme", () =>
    Effect.gen(function* () {
      const html = yield* ViewHtml.render([], {
        theme: { ...Theme.computis, surface: "#123456" },
        title: "run",
      });

      expect(html).toContain("background: #123456;");
    }),
  );

  it.effect("turns the dashboard tabs into radio inputs with the first one checked", () =>
    Effect.gen(function* () {
      const { head, history } = yield* sampleRuns;

      const html = yield* ViewHtml.render(View.dashboard(head, history), { title: "categorizer" });

      const labels = [...html.matchAll(/<label for="[^"]+">(?<title>[^<]+)<\/label>/gu)].map(
        (match) => match.groups?.["title"],
      );

      expect(labels).toEqual(["Summary", "Trend", "Unstable cases", "Cost", "Groups"]);
      expect(html.match(/ checked>/gu)).toHaveLength(1);
    }),
  );

  it.effect("gives two tab groups at the same depth their own radio names", () =>
    Effect.gen(function* () {
      const tabs = View.Tabs({
        tabs: [
          { children: [], title: "A" },
          { children: [], title: "B" },
        ],
      });

      const html = yield* ViewHtml.render([tabs, tabs], { title: "run" });

      const names = [...html.matchAll(/type="radio" name="(?<name>[^"]+)"/gu)].map(
        (match) => match.groups?.["name"],
      );

      const ids = [...html.matchAll(/ id="(?<id>[^"]+)"/gu)].map((match) => match.groups?.["id"]);

      expect(new Set(names).size).toBe(2);
      expect(new Set(ids).size).toBe(4);
      expect(html.match(/ checked>/gu)).toHaveLength(2);
    }),
  );

  it.effect("shows the panel of every tab, past the twelfth", () =>
    Effect.gen(function* () {
      const many = View.Tabs({
        tabs: Array.from({ length: 13 }, (_, index) => ({
          children: [View.Text({ text: `panel ${String(index + 1)}`, tone: "neutral" })],
          title: `T${String(index + 1)}`,
        })),
      });

      const html = yield* ViewHtml.render([many], { title: "run" });

      expect(html).toContain(".tabs > input:nth-of-type(13):checked ~ .panel:nth-of-type(13)");
      expect(html.match(/class="panel"/gu)).toHaveLength(13);
    }),
  );

  it.effect("embeds a figure with the html chart renderer", () =>
    Effect.gen(function* () {
      const chart = Charts.Variants({
        bars: [{ high: Option.none(), low: Option.none(), value: 0.8, variant: "small" }],
        metric: "accuracy",
        title: "accuracy by variant",
      });

      const html = yield* ViewHtml.render([View.figure(chart)], {
        renderer: ChartHtml.renderer(),
        title: "run",
      });

      expect(html).toContain("vegaEmbed(");
      expect(html).not.toContain("<table>");
    }),
  );
});
