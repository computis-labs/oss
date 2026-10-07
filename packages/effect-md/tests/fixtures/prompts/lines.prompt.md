---
input:
  lines: [{ description: String, amount?: Number }]
---
{{#each lines as |line|}}
{{@index}}. {{line.description}}{{#if line.amount}} ({{line.amount}}){{/if}}{{#unless @last}},{{/unless}}
{{else}}
No lines.
{{/each}}
