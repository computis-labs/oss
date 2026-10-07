---
input:
  items: Array(String)
---
Items:
{{#each items as |entry|}}
  {{> ./item.partial.md value=entry}}
{{/each}}
