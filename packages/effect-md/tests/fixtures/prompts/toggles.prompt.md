---
input:
  enabled: Literal(true, false)
  level?: Literal(0, 1, 2)
  mode: Literal(false, "auto")
---
{{#if enabled}}on{{else}}off{{/if}}
{{#if level}}level {{level}}{{/if}}
{{> ./flag.partial.md show=false}}
{{#if mode}}mode {{mode}}{{else}}manual{{/if}}
