// Consent ledger for data that leaves the device. On-device recording needs no entry: pressing
// Record is the consent (owner decision on #54). Every purpose here is denied until granted.

export type ConsentPurpose =
  | "remoteAnalysis"
  | "clinicianSharing"
  | "researchContribution"
  | "modelTraining";

export const CONSENT_PURPOSES: readonly ConsentPurpose[] = [
  "remoteAnalysis",
  "clinicianSharing",
  "researchContribution",
  "modelTraining",
];

export type ConsentDecision = {
  purpose: ConsentPurpose;
  granted: boolean;
  /** When the decision was made; decisions migrated from older storage use the migration time. */
  at: string;
  /** What the decision covers, e.g. the exact server URL for remote analysis. */
  scope: string;
};

/** Append-only: a revocation is a new entry, so history shows what was allowed when. */
export type ConsentLedger = readonly ConsentDecision[];

export const EMPTY_CONSENT_LEDGER: ConsentLedger = [];

export class ConsentRequiredError extends Error {
  constructor(
    readonly purpose: ConsentPurpose,
    readonly scope: string,
  ) {
    super(`${purpose} needs consent${scope ? ` for ${scope}` : ""}`);
  }
}

export function recordConsent(
  ledger: ConsentLedger,
  decision: { purpose: ConsentPurpose; granted: boolean; scope?: string; at?: Date },
): ConsentLedger {
  if (!CONSENT_PURPOSES.includes(decision.purpose)) {
    throw new Error(`Unknown consent purpose ${String(decision.purpose)}.`);
  }
  return [
    ...ledger,
    {
      purpose: decision.purpose,
      granted: decision.granted,
      at: (decision.at ?? new Date()).toISOString(),
      scope: decision.scope ?? "",
    },
  ];
}

/** The latest decision for this purpose and exact scope; none means denied. */
export function currentConsent(
  ledger: ConsentLedger,
  purpose: ConsentPurpose,
  scope = "",
): ConsentDecision | null {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const decision = ledger[index];
    if (decision.purpose === purpose && decision.scope === scope) {
      return decision;
    }
  }
  return null;
}

export function hasConsent(ledger: ConsentLedger, purpose: ConsentPurpose, scope = "") {
  return currentConsent(ledger, purpose, scope)?.granted === true;
}

/** Throws unless the latest decision for exactly this purpose and scope is a grant. */
export function requireConsent(ledger: ConsentLedger, purpose: ConsentPurpose, scope = "") {
  if (!hasConsent(ledger, purpose, scope)) {
    throw new ConsentRequiredError(purpose, scope);
  }
}

/**
 * Reads a ledger from untrusted storage. Any malformed entry makes the whole ledger unreadable
 * (null): dropping just that entry could expose an older grant that a corrupted withdrawal
 * superseded. Callers treat null as "no consent".
 */
export function parseConsentLedger(value: unknown): ConsentLedger | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.every(isConsentDecision) ? value : null;
}

function isConsentDecision(entry: unknown): entry is ConsentDecision {
  return (
    typeof entry === "object" &&
    entry !== null &&
    CONSENT_PURPOSES.includes((entry as ConsentDecision).purpose) &&
    typeof (entry as ConsentDecision).granted === "boolean" &&
    typeof (entry as ConsentDecision).at === "string" &&
    Number.isFinite(Date.parse((entry as ConsentDecision).at)) &&
    typeof (entry as ConsentDecision).scope === "string"
  );
}
