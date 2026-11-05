# Tool output slimming

Condenses oversized tool output: the model sees a short notice with byte counts; the full text goes to the spill store and can be fetched later.

## How it works
  - Hooks the tools/post-execute waterfall shared by native and PTC execution.
  - Content-aware condensation with line/byte thresholds and an rtk condensed notice.

## Caveat
  - Native mode: condensation changes what the model sees.
  - PTC mode: only the session-log dispatch content is condensed; the program value and model context are unchanged.
