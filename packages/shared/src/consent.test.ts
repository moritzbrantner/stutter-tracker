import { describe, expect, test } from "bun:test";

import {
  CONSENT_PURPOSES,
  type ConsentDecision,
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

  test("rejects the whole ledger when any entry is malformed", () => {
    const grant: ConsentDecision = {
      purpose: "remoteAnalysis",
      granted: true,
      at: "2026-10-01T00:00:00.000Z",
      scope: server,
    };
    expect(parseConsentLedger([grant])).toEqual([grant]);
    // A corrupted withdrawal must not let the older grant resurface.
    for (const corrupt of [
      { purpose: "remoteAnalysis", granted: false, at: "not a date", scope: server },
      { purpose: "remoteAnalysis", granted: false, at: "2026-10-02T00:00:00.000Z" },
      { purpose: "everything", granted: true, at: "2026-10-01T00:00:00.000Z", scope: "" },
      { purpose: "modelTraining", granted: "yes", at: "2026-10-01T00:00:00.000Z", scope: "" },
      null,
    ]) {
      expect(parseConsentLedger([grant, corrupt])).toBeNull();
    }
    expect(parseConsentLedger({ not: "an array" })).toBeNull();
  });

  test("rejects recording an unknown purpose", () => {
    expect(() =>
      recordConsent(EMPTY_CONSENT_LEDGER, { purpose: "recording" as never, granted: true }),
    ).toThrow("Unknown consent purpose");
  });
});
