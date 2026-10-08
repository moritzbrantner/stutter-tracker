import {
  type ConsentLedger,
  hasConsent,
  recordConsent,
  withdrawOtherScopes,
} from "@stutter-tracker/shared";

export function normalizeServerUrl(url: string) {
  return url.trim().replace(/\/+$/, "");
}

export function hasRemoteConsent(ledger: ConsentLedger, serverUrl: string) {
  const url = normalizeServerUrl(serverUrl);
  return url !== "" && hasConsent(ledger, "remoteAnalysis", url);
}

export function setRemoteConsent(ledger: ConsentLedger, serverUrl: string, granted: boolean) {
  return recordConsent(ledger, {
    purpose: "remoteAnalysis",
    granted,
    scope: normalizeServerUrl(serverUrl),
  });
}

/**
 * Editing the server URL withdraws every remote-analysis grant for other URLs, so returning to
 * an earlier URL needs consent again.
 */
export function withdrawOtherServerConsent(ledger: ConsentLedger, serverUrl: string) {
  return withdrawOtherScopes(ledger, "remoteAnalysis", normalizeServerUrl(serverUrl));
}
