---
input:
  note?: String
  status: NullOr(Literal("open", "closed"))
  data: Json
---
{{#unless note}}
No note.
{{else}}
Note: {{note}}
{{/unless}}
{{#if status != null}}
Status: {{status}}
{{/if}}
{{#if status == "open"}}
Still open.
{{/if}}
Data: {{json data indent=0}}
