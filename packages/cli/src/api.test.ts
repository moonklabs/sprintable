import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("200 응답 → true", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const { ping } = await import("./api.js?v=1");
    expect(await ping("https://app.sprintable.ai", "sk_test")).toBe(true);
  });

  it("네트워크 에러 → false", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network"));
    const { ping } = await import("./api.js?v=2");
    expect(await ping("https://app.sprintable.ai", "sk_test")).toBe(false);
  });

  it("401 응답 → false", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
    const { ping } = await import("./api.js?v=3");
    expect(await ping("https://app.sprintable.ai", "sk_bad")).toBe(false);
  });
});

describe("createTeamMember payload", () => {
  it("type=agent으로 POST 요청", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "uuid-1", name: "Bot", type: "agent", api_key: "sk_live_xxx" }),
    });
    const { createTeamMember } = await import("./api.js?v=4");
    const result = await createTeamMember("https://app.sprintable.ai", "sk_admin", {
      project_id: "proj-1",
      org_id: "org-1",
      type: "agent",
      name: "Bot",
    });
    expect(result.api_key).toBe("sk_live_xxx");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/team-members"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
