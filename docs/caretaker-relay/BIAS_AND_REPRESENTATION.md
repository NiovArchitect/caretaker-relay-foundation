# Bias and Representation

**Last updated:** 2026-07-22  
**Rule:** Do not claim fairness has been proven.

## Scope

Caretaker Relay may produce unequal quality of care coordination support across populations if models, speech systems, or design assumptions favor certain caregivers or care recipients.

## Dimensions to account for

| Dimension | Risk | Synthetic test now? | Needs real participants later? |
| --- | --- | --- | --- |
| Age | Ageist language; wrong assumptions about capacity | Limited | Yes |
| Disability | Accessibility of UI; speech differences | Partial (a11y prefs) | Yes |
| Speech differences | STT failure (STT not live) | No live STT | Yes |
| Language | Non-English care updates under-extracted | Golden g-013 partial | Yes |
| Accent | STT bias | No | Yes |
| Literacy | Dense UI; complex verify text | Design review only | Yes |
| Caregiver relationship | Family vs paid power dynamics | Access model tests | Yes |
| Professional vs family caregiver | Different jargon / notes | Golden professional vs family | Yes |
| High/low technical familiarity | Drop-off on multi-step verify | Lab burden metrics only | Yes |

## What we can test synthetically now

- Diverse **text** variants in golden dataset (concise, rambling, typo-heavy, professional note, family speech, negation, multilingual sample).  
- Access isolation across roles (family, professional, provider, revoked, unauthorized).  
- Refusal behavior under adversarial prompts (not demographic fairness).  

## What we must not claim

- Fairness proven  
- Equal performance across accents/languages  
- Caregiver-validated usability across literacy levels  
- Absence of harmful stereotyping in model outputs under live LLM  

## Mitigations in product design

- Human confirmation for moderate/high consequence  
- Uncertainty preservation (REPORTED / UNCERTAIN)  
- Correction without erasing history  
- Preference for refusal over fabricated certainty  
- Explicit “not a clinician” boundaries  
- Evidence-mode labels so demos are not mistaken for validated field performance  

## Future evaluation plan (not done)

1. Recruit diverse caregivers with informed consent  
2. Measure extraction quality by language/literacy  
3. Usability sessions on verify/handoff  
4. Review live model outputs for biased clinical language  
5. Update this document with results tagged `[CAREGIVER INPUT]` / `[VALIDATED]` only when real  
