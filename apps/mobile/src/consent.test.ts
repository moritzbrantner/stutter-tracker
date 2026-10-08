import { EMPTY_CONSENT_LEDGER } from "@stutter-tracker/shared";
import { describe, expect, it } from "vitest";
import { hasRemoteConsent, setRemoteConsent, withdrawOtherServerConsent } from "./consent";

const a = "https://a.example.com";
const b = "https://b.example.com";

describe("mobile remote consent", () => {
  it("denies by default and binds a grant to the exact normalized URL", () => {
    expect(hasRemoteConsent(EMPTY_CONSENT_LEDGER, a)).toBe(false);
    const ledger = setRemoteConsent(EMPTY_CONSENT_LEDGER, `${a}/`, true);
    expect(hasRemoteConsent(ledger, a)).toBe(true);
    expect(hasRemoteConsent(ledger, b)).toBe(false);
    expect(hasRemoteConsent(ledger, "")).toBe(false);
  });

  it("records revocation", () => {
    const ledger = setRemoteConsent(setRemoteConsent(EMPTY_CONSENT_LEDGER, a, true), a, false);
    expect(hasRemoteConsent(ledger, a)).toBe(false);
    expect(ledger).toHaveLength(2);
  });

  it("withdraws consent when the URL is edited, so returning needs consent again", () => {
    const granted = setRemoteConsent(EMPTY_CONSENT_LEDGER, a, true);
    const edited = withdrawOtherServerConsent(granted, b);
    expect(hasRemoteConsent(edited, a)).toBe(false);
    expect(withdrawOtherServerConsent(edited, a)).toBe(edited);
    expect(withdrawOtherServerConsent(granted, a)).toBe(granted);
  });
});
