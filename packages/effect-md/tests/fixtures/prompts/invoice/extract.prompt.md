---
description: Extract a foreign invoice
input:
  source: Literal("file", "text")
  text?: String
  pdf?: File
---
<system>
Sei un contabile. {{> ../shared/contract.partial.md}}
</system>

<user>
{{#if source == "text"}}
Il testo del PDF:
{{#if text}}
{{untrusted text}}
{{/if}}
{{else if pdf}}
Il PDF allegato:
{{file pdf}}
{{/if}}
</user>
