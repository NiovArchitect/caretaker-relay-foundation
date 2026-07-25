import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import {
  createNotificationIfNew,
  countUnreadForPrincipal,
  markAllSeenForPrincipal,
  markSeen,
  resolveStaleNotifications,
  listNotificationsForPrincipal,
} from "../../../packages/care-domain/src/services/notifications.js";

describe("notification unread lifecycle", () => {
  it("counts only unseen unresolved as unread", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "CARE_UPDATE",
      priority: "info",
      title: "A",
      body: "a",
      sourceType: "test",
      sourceId: "a1",
      actionType: "open",
      actionTarget: "t",
      dedupeKey: "k-a",
    });
    createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "CARE_UPDATE",
      priority: "info",
      title: "B",
      body: "b",
      sourceType: "test",
      sourceId: "b1",
      actionType: "open",
      actionTarget: "t",
      dedupeKey: "k-b",
    });
    expect(countUnreadForPrincipal(store, "p-sadeil", "cr-olivia")).toBeGreaterThanOrEqual(2);
    const all = listNotificationsForPrincipal(store, "p-sadeil", "cr-olivia");
    const one = all.find((n) => n.dedupeKey === "k-a")!;
    markSeen(store, "p-sadeil", one.id);
    const after = countUnreadForPrincipal(store, "p-sadeil", "cr-olivia");
    expect(after).toBeLessThan(
      listNotificationsForPrincipal(store, "p-sadeil", "cr-olivia").length,
    );
  });

  it("dedupes same dedupeKey while unresolved", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "NEW_COORDINATION_MESSAGE",
      priority: "attention",
      title: "Msg",
      body: "hello",
      sourceType: "coordination",
      sourceId: "m1",
      actionType: "open_coordination",
      actionTarget: "c",
      dedupeKey: "coord:m1:p-sadeil",
    });
    const b = createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "NEW_COORDINATION_MESSAGE",
      priority: "attention",
      title: "Msg",
      body: "hello again",
      sourceType: "coordination",
      sourceId: "m1",
      actionType: "open_coordination",
      actionTarget: "c",
      dedupeKey: "coord:m1:p-sadeil",
    });
    expect(a.id).toBe(b.id);
  });

  it("markAllSeen and resolveStale clear unread", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "CARE_UPDATE",
      priority: "info",
      title: "Old",
      body: "old",
      sourceType: "test",
      sourceId: "old1",
      actionType: "open",
      actionTarget: "t",
      dedupeKey: "k-old",
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const changed = resolveStaleNotifications(store, "p-sadeil", {
      careRecipientId: "cr-olivia",
      olderThanMs: 0,
    });
    expect(changed).toBeGreaterThan(0);
    expect(countUnreadForPrincipal(store, "p-sadeil", "cr-olivia")).toBe(0);

    createNotificationIfNew(store, {
      principalId: "p-sadeil",
      careRecipientId: "cr-olivia",
      type: "CARE_UPDATE",
      priority: "info",
      title: "New",
      body: "new",
      sourceType: "test",
      sourceId: "n1",
      actionType: "open",
      actionTarget: "t",
      dedupeKey: "k-new2",
    });
    expect(countUnreadForPrincipal(store, "p-sadeil", "cr-olivia")).toBeGreaterThan(0);
    markAllSeenForPrincipal(store, "p-sadeil", "cr-olivia");
    expect(countUnreadForPrincipal(store, "p-sadeil", "cr-olivia")).toBe(0);
  });
});
