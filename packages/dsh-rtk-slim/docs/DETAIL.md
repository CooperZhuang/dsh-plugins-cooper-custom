# Tool output slimming

Condenses oversized tool output: the model sees a short notice with byte counts; the full text goes to the spill store and can be fetched later.

## How it works
  - Hooks the tools/post-execute waterfall shared by native and PTC execution, without `prepend` (innermost), so it sees the original result.
  - Uses the external rtk: a recognized family picks `-f <filter>`; anything else goes through a bare `rtk pipe`.
  - Replaces the original only when the condensation passes four gates: verbatim markers, failure evidence, a sane ratio and a strict shrink.

## Caveat
  - Native mode: condensation changes what the model sees.
  - Only the model-visible `content` is replaced; a decision that carries `value` is passed through unchanged.
