import { expect, test } from "@playwright/test";

test("opens the tracker dashboard", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Speech Log" }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /record/i })).toBeVisible();
  await expect(page.getByText("Transcript will appear here.")).toBeVisible();
  await expect(page.getByLabel("Transcription engine")).toHaveValue("browser");
});

test("restores a saved session from local storage", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "stutter-tracker:sessions",
      JSON.stringify([
        {
          id: "e2e-session",
          startedAt: "2026-05-19T10:00:00.000Z",
          segments: [
            {
              text: "I I want to start",
              startSeconds: 0,
              endSeconds: 3,
              confidence: 0.93,
              isFinal: true,
            },
          ],
          pauses: [],
          report: {
            totalDurationSeconds: 3,
            wordCount: 4,
            stutterCount: 1,
            stuttersPerMinute: 20,
            severity: "high",
            events: [
              {
                kind: "wordRepetition",
                startSeconds: 0,
                endSeconds: 1.2,
                text: "I I",
                detail: "Repeated word sequence",
                confidence: 0.78,
              },
            ],
            byKind: { wordRepetition: 1 },
          },
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator(".session-row").click();

  await expect(page.getByText("I I want to start").first()).toBeVisible();
  await expect(page.getByText("Repeated word sequence")).toBeVisible();
});

test("records and stops with fake media devices", async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== "chromium-fake-media",
    "fake media flags are configured for this project",
  );

  await page.goto("/");
  await page.getByRole("button", { name: /record/i }).click();
  await expect(page.getByRole("button", { name: /stop/i })).toBeVisible();
  await page.getByRole("button", { name: /stop/i }).click();
  await expect(page.getByRole("button", { name: /record/i })).toBeVisible();
});
