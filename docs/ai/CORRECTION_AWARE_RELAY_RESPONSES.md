# Correction-Aware Relay Responses

- Voided medication administrations are excluded from current-truth projection.
- History may still explain corrections.
- `LAST_MEDICATION_ADMINISTRATIONS` prefers non-voided rows.

Tests: `tests/unit/care/relay-medication-correction-matrix.test.ts`
