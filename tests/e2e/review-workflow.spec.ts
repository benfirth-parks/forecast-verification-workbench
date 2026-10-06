// Browser walkthrough of the Phase 1 workflow against a fresh local database.
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const bulletin = readFileSync(new URL("../fixtures/avcan/SYNTHETIC-in-season.json", import.meta.url), "utf8");

test("import → review → hindsight → adjudicate → analytics, and viewer is read-only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "administrator" }).click();
  await expect(page.getByText("RESEARCH PROTOTYPE")).toBeVisible();

  // Validate then commit the bulletin.
  await page.getByRole("link", { name: "Imports" }).click();
  await page.getByLabel("Payload").fill(bulletin);
  await page.getByRole("button", { name: "Validate (dry run)" }).click();
  await expect(page.getByText(/accepted 1/)).toBeVisible();
  await page.getByRole("button", { name: "Commit" }).click();
  await expect(page.getByText(/casesCreated 1/)).toBeVisible();

  // Open the case from the queue.
  await page.getByRole("link", { name: "Review queue" }).click();
  await page.getByRole("link", { name: "2027-01-15" }).click();
  await expect(page.getByText("Original forecast")).toBeVisible();
  await expect(page.getByText("The day's calls for 2027-01-15")).toBeVisible();
  await expect(page.getByText("No morning meeting entry")).toBeVisible();
  await expect(page.getByText("Differences are locked")).toBeVisible();

  // Independent hindsight first.
  await page.locator("#hindsight-rating-alp").selectOption("4");
  await page.locator("#hindsight-rating-tln").selectOption("2");
  await page.locator("#hindsight-rating-btl").selectOption("1");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Forecast vs hindsight")).toBeVisible();
  await expect(page.getByText("-1 under")).toBeVisible();
  await page.getByRole("button", { name: "Finalize hindsight" }).click();
  await expect(page.getByText(/Version 1 · final/)).toBeVisible();

  // Coverage + evidence, adjudication, finalize.
  await page.getByLabel("Rationale (required)").fill("Synthetic: clear day, field team in area");
  await page.getByLabel("Overall coverage").selectOption("high");
  await page.getByLabel(/^Visibility/).selectOption("high");
  await page.getByRole("button", { name: "Add coverage statement" }).click();
  await page.getByRole("button", { name: "Classify evidence" }).click();
  await expect(page.getByText(/Last run: supported_negative/)).toBeVisible();
  await page.getByRole("button", { name: "Save adjudication draft" }).click();
  await page.getByRole("button", { name: "Finalize", exact: true }).click();
  await page.getByRole("button", { name: "Finalize case" }).click();
  await expect(page.getByText(/Review: final/)).toBeVisible();

  // Analytics reflects the finalized case.
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page.getByText(/1\s+of 1 cases included/)).toBeVisible();
  await page.screenshot({ path: "test-results/analytics.png", fullPage: true });

  // Viewer cannot edit.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "viewer", exact: true }).click();
  await page.getByRole("link", { name: "Review queue" }).click();
  await page.getByRole("link", { name: "2027-01-15" }).click();
  await expect(page.getByText("Original forecast")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Finalize case" })).toHaveCount(0);
  await page.screenshot({ path: "test-results/case-viewer.png", fullPage: true });
});
