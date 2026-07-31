/**
 * Care-recipient self ownership — unit coverage for Journey 1 + bind security.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCareStore } from "@caretaker-relay/care-domain";
import {
  setupSelfCareSpace,
  bindProvisionalToRecipient,
  createProvisionalRecipient,
  defaultInviteAccess,
  normalizeInviteRole,
} from "@caretaker-relay/care-domain";

describe("recipient-self setup (any preferred name)", () => {
  let store: MemoryCareStore;

  beforeEach(() => {
    store = new MemoryCareStore();
  });

  it("creates a new recipient + care_recipient relationship for any name", () => {
    const r = setupSelfCareSpace(store, {
      actorPersonId: "p-acct-self-1",
      actorDisplayName: "Jordan Lee",
      preferredName: "Jordan Lee",
      confirmation: "I am creating a care space for myself",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.created).toBe(true);
    expect(r.careRecipientId).toMatch(/^cr-/);
    const recipient = store.getRecipient(r.careRecipientId);
    expect(recipient?.displayName).toBe("Jordan Lee");
    const rel = store.getRelationship(r.careRecipientId, "p-acct-self-1");
    expect(rel?.role).toBe("care_recipient");
    expect(rel?.status).toBe("active");
    expect(rel?.access.informationCategories).toContain("Medications");
    expect(rel?.access.allowedActions).not.toContain("invite");
  });

  it("is idempotent for the same actor", () => {
    const a = setupSelfCareSpace(store, {
      actorPersonId: "p-acct-self-2",
      actorDisplayName: "Sam",
      preferredName: "Sam Rivera",
    });
    const b = setupSelfCareSpace(store, {
      actorPersonId: "p-acct-self-2",
      actorDisplayName: "Sam",
      preferredName: "Different Name",
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(b.created).toBe(false);
    expect(b.careRecipientId).toBe(a.careRecipientId);
  });

  it("does not grant access by name-only provisional bind to existing recipient", () => {
    store.upsertRecipient({
      id: "cr-existing",
      displayName: "Evelyn Carter",
      preferredName: "Evelyn",
      householdId: "hh-x",
    });
    const p = createProvisionalRecipient(store, {
      preferredName: "Evelyn Carter",
      createdByPersonId: "p-acct-wrong",
      createdByDisplayName: "Wrong Person",
      claimedAuthority: "self",
    });
    const bind = bindProvisionalToRecipient(store, p, {
      careRecipientId: "cr-existing",
      actorPersonId: "p-acct-wrong",
      actorDisplayName: "Wrong Person",
    });
    expect(bind.ok).toBe(false);
    if (bind.ok) return;
    expect(bind.code).toBe("FORBIDDEN");
    expect(store.getRelationship("cr-existing", "p-acct-wrong")).toBeUndefined();
  });

  it("normalizes recipient_self alias and scopes meds for care_recipient", () => {
    expect(normalizeInviteRole("recipient_self")).toBe("care_recipient");
    expect(normalizeInviteRole("self")).toBe("care_recipient");
    const access = defaultInviteAccess("care_recipient");
    expect(access.informationCategories).toContain("Medications");
    expect(access.allowedActions).toContain("view_medications");
    expect(access.allowedActions).not.toContain("invite");
  });
});
