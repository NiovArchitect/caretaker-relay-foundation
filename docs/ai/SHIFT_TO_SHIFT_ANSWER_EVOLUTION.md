# Shift-to-Shift Answer Evolution

Relay answers are composed from current-state projections + authorized recent events at request time.

Sequential shifts must change answers when durable observations/handoffs are saved.

Tests: `tests/unit/care/relay-shift-evolution.test.ts` (≥3 recipients × 3 shifts).
