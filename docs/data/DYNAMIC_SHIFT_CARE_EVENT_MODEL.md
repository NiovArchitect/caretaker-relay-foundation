# Dynamic Shift Care Event Model

Shift lifecycle events are durable via `SHIFT_ASSIGN_V1` CareUpdate rows and care-event ETL on handoff.

Each shift may record: start, tasks, observations, meals, mobility, mood, medication confirmation (if authorized), incident, correction, unfinished work, end, handoff, acknowledgment.

Required attributes: recipient, actor, role, assignment id, event time, report time, source, status, audit.

Implementation: `dsp-assignment.ts`, `care-event-etl.ts`, `handoff-lifecycle.ts`.
