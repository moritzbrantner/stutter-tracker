import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("Tauri invoke is unavailable in tests");
  }),
  isTauri: () => false,
}));
