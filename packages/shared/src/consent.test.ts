import { describe, expect, test } from "bun:test";

import {
  CONSENT_PURPOSES,
  ConsentRequiredError,
  currentConsent,
  EMPTY_CONSENT_LEDGER,
  hasConsent,
  parseConsentLedger,
  recordConsent,
  requireConsent,
} from "./consent";

const server = "https://compute.example.com";

describe("consent ledger", () => {
  test("denies every purpose by default", () => {
    for (const purpose of CONSENT_PURPOSES) {
      expect(hasConsent(EMPTY_CONSENT_LEDGER, purpose)).toBe(false);
      expect(() => requireConsent(EMPTY_CONSENT_LEDGER, purpose)).toThrow(ConsentRequiredError);
    }
  });

  test("grants apply only to the exact purpose and scope", () => {
    const ledger = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "remoteAnalysis",
      granted: true,
      scope: server,
    });

    expect(hasConsent(ledger, "remoteAnalysis", server)).toBe(true);
    expect(hasConsent(ledger, "remoteAnalysis", "https://other.example.com")).toBe(false);
    expect(hasConsent(ledger, "researchContribution", server)).toBe(false);
    expect(hasConsent(ledger, "modelTraining")).toBe(false);
  });

  test("revocation is appended and wins for future checks without erasing history", () => {
    const granted = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "clinicianSharing",
      granted: true,
      at: new Date("2026-10-01T00:00:00.000Z"),
    });
    const revoked = recordConsent(granted, {
      purpose: "clinicianSharing",
      granted: false,
      at: new Date("2026-10-02T00:00:00.000Z"),
    });

    expect(hasConsent(revoked, "clinicianSharing")).toBe(false);
    expect(currentConsent(revoked, "clinicianSharing")?.at).toBe("2026-10-02T00:00:00.000Z");
    expect(revoked).toHaveLength(2);
    expect(granted).toHaveLength(1);
  });

  test("explicit denial is recorded and stays a denial", () => {
    const ledger = recordConsent(EMPTY_CONSENT_LEDGER, {
      purpose: "modelTraining",
      granted: false,
    });
    expect(currentConsent(ledger, "modelTraining")?.granted).toBe(false);
    expect(() => requireConsent(ledger, "modelTraining")).toThrow("modelTraining needs consent");
  });

  test("never treats malformed or unknown stored entries as grants", () => {
    const ledger = parseConsentLedger([
      { purpose: "remoteAnalysis", granted: true, at: "2026-10-01T00:00:00.000Z", scope: server },
      { purpose: "everything", granted: true, at: "2026-10-01T00:00:00.000Z", scope: "" },
      { purpose: "modelTraining", granted: "yes", at: "2026-10-01T00:00:00.000Z", scope: "" },
      { purpose: "researchContribution", granted: true, at: "not a date", scope: "" },
      null,
    ]);

    expect(ledger).toHaveLength(1);
    expect(hasConsent(ledger, "modelTraining")).toBe(false);
    expect(hasConsent(ledger, "researchContribution")).toBe(false);
    expect(parseConsentLedger({ not: "an array" })).toEqual([]);
  });

  test("rejects recording an unknown purpose", () => {
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "recording" as never, granted: true }),
    ).toThrow("Unknown consent purpose");
  });
});
