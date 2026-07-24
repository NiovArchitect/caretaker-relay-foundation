# Provider Collaboration Acceptance

## Synthetic principal

- Care person id: `p-dr-shah`
- Display: Dr. Priya Shah
- Lab password: `drshah-lab-password` (synthetic only)
- Listed in `GET /api/v1/care/auth/lab-principals`
- Roles: provider / physician
- Relationship: active on Evelyn (`cr-olivia`)

## Acceptance criteria

1. Caregiver can ask clinical-judgment questions without Relay diagnosing.
2. Relay offers: “Want me to ask Dr. Shah?”
3. Confirm creates in-app clarification + durable notification for Dr. Shah.
4. Dr. Shah logs in independently and sees the request.
5. Response is professional-source evidence.
6. Caregiver receives durable notification.
7. Accepting guidance stores `PROVIDER_GUIDANCE_V1` and refreshes handoff.
8. No fake email/SMS.

## Not in scope

External EHR writeback, e-prescribe, emergency triage.
