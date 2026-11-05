# Purge / red-team patches

Red-team and hardening host patch library with presets and a Drill console. Currently unmounted.

## Contents
  - 82 host-file patch rules, re-audited for 0.2.2-rc.1 (docs/host-patch-audit-0.2.2-rc.1.md).
  - Presets, default prompts and the Drill console.

## Notes
  - Unmounted by default; enabling requires Apply and a restart.
  - Host code ships inside app.asar, so the patch route only applies to writable host trees.
