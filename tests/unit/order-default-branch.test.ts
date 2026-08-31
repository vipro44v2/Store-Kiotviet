import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsClient } from "@/lib/sync/default-branch";

const mocks = vi.hoisted(() => ({ getActiveBranches: vi.fn() }));

vi.mock("@/lib/kiotviet/branches", () => ({
  getActiveKiotVietBranches: mocks.getActiveBranches,
}));

import { resolveDefaultBranchId } from "@/lib/sync/default-branch";

function clientWith(query: ReturnType<typeof vi.fn>) {
  return { query } as unknown as SettingsClient;
}

beforeEach(() => vi.clearAllMocks());

describe("default KiotViet branch initialization", () => {
  it("uses an existing valid defaultBranchId", async () => {
    const query = vi.fn();
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);

    await expect(
      resolveDefaultBranchId(clientWith(query), { defaultBranchId: "42" }),
    ).resolves.toBe(42);

    expect(mocks.getActiveBranches).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });

  it("automatically configures the only active branch", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);
    const query = vi.fn().mockResolvedValue({
      rows: [{ default_branch_id: "42" }],
    });

    await expect(resolveDefaultBranchId(clientWith(query), {})).resolves.toBe(
      42,
    );

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_build_object('defaultBranchId'"),
      [42, [42]],
    );
  });

  it("replaces a stale defaultBranchId with the only active branch", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);
    const query = vi.fn().mockResolvedValue({
      rows: [{ default_branch_id: "42" }],
    });

    await expect(
      resolveDefaultBranchId(clientWith(query), { defaultBranchId: 99 }),
    ).resolves.toBe(42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("system_settings.value || EXCLUDED.value"),
      [42, [42]],
    );
  });

  it("rejects a stale defaultBranchId when multiple branches are active", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
      { id: 43, branchName: "Secondary", isActive: true },
    ]);
    const query = vi.fn();

    await expect(
      resolveDefaultBranchId(clientWith(query), { defaultBranchId: 99 }),
    ).rejects.toThrow("Multiple active KiotViet branches");
    expect(query).not.toHaveBeenCalled();
  });

  it("does not use an inactive configured branch", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Active", isActive: true },
    ]);
    const query = vi.fn().mockResolvedValue({
      rows: [{ default_branch_id: "42" }],
    });

    await expect(
      resolveDefaultBranchId(clientWith(query), { defaultBranchId: 99 }),
    ).resolves.toBe(42);
    expect(query).toHaveBeenCalled();
  });

  it.each([null, "", "abc", "-7", "1.5"])(
    "safely replaces malformed defaultBranchId %j",
    async (defaultBranchId) => {
      mocks.getActiveBranches.mockResolvedValue([
        { id: 42, branchName: "Main", isActive: true },
      ]);
      const query = vi.fn().mockResolvedValue({
        rows: [{ default_branch_id: "42" }],
      });

      await expect(
        resolveDefaultBranchId(clientWith(query), { defaultBranchId }),
      ).resolves.toBe(42);

      const sql = String(query.mock.calls[0][0]);
      expect(sql).toContain("WHERE CASE");
      expect(sql).toContain(
        "WHEN system_settings.value->>'defaultBranchId' ~ '^[1-9][0-9]*$'",
      );
      expect(sql).toContain(
        "THEN (system_settings.value->>'defaultBranchId')::bigint",
      );
      expect(query.mock.calls[0][1]).toEqual([42, [42]]);
    },
  );

  it("fails safely when multiple active branches exist", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
      { id: 43, branchName: "Secondary", isActive: true },
    ]);

    await expect(
      resolveDefaultBranchId(clientWith(vi.fn()), {}),
    ).rejects.toThrow("Multiple active KiotViet branches");
  });

  it("fails clearly when no active branches exist", async () => {
    mocks.getActiveBranches.mockResolvedValue([]);

    await expect(
      resolveDefaultBranchId(clientWith(vi.fn()), {}),
    ).rejects.toThrow("No active KiotViet branches exist");
  });

  it("preserves all other orders settings with a JSONB merge", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);
    const query = vi.fn().mockResolvedValue({
      rows: [{ default_branch_id: "42" }],
    });

    await resolveDefaultBranchId(clientWith(query), {
      autoCreate: true,
      paidOnly: false,
      syncCustomers: true,
      syncCancellation: false,
    });

    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("system_settings.value || EXCLUDED.value");
    expect(sql).not.toContain("value=EXCLUDED.value");
  });

  it("does not corrupt settings during concurrent order/customer initialization", async () => {
    mocks.getActiveBranches.mockResolvedValue([
      { id: 42, branchName: "Main", isActive: true },
    ]);
    const settings: Record<string, unknown> = {
      autoCreate: true,
      paidOnly: true,
      syncCustomers: true,
      syncCancellation: true,
      syncRefunds: true,
      futureSetting: "preserved",
    };
    let initialized = false;
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO system_settings")) {
        if (initialized) return { rows: [] };
        initialized = true;
        Object.assign(settings, { defaultBranchId: 42 });
        return { rows: [{ default_branch_id: "42" }] };
      }
      return { rows: [{ default_branch_id: String(settings.defaultBranchId) }] };
    });

    await expect(
      Promise.all([
        resolveDefaultBranchId(clientWith(query), {}),
        resolveDefaultBranchId(clientWith(query), {}),
      ]),
    ).resolves.toEqual([42, 42]);
    expect(settings).toEqual({
      autoCreate: true,
      paidOnly: true,
      syncCustomers: true,
      syncCancellation: true,
      syncRefunds: true,
      futureSetting: "preserved",
      defaultBranchId: 42,
    });
  });
});
