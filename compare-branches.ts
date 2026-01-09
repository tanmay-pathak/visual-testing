import { promises as fsPromises } from "node:fs";
import process from "node:process";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import {
  classifyError,
  compareScreenshots,
  createDiffImageWithPath,
  takeScreenshot,
  urlToFilename,
  logVisualTestError,
  type FailedUrl,
} from "./visual-testing-utils.ts";

const BASE_DIR = path.join(os.homedir(), "visual-testing-compare");
const SCREENSHOTS_DIR = path.join(BASE_DIR, "base");
const CHANGES_DIR = path.join(BASE_DIR, "changes");

type VisualTestResult = boolean | null; // true=changes detected, false=no changes, null=comparison failed

async function runVisualTest(
  url: string,
  isBaseline: boolean,
  failedUrls: FailedUrl[],
): Promise<VisualTestResult> {
  try {
    const filename = urlToFilename(url);
    const screenshotPath = path.join(SCREENSHOTS_DIR, `${filename}.png`);
    const newScreenshot = await takeScreenshot(url);

    if (!isBaseline) {
      // Try to read the baseline screenshot directly (no access check to avoid race condition)
      try {
        const oldScreenshot = await fsPromises.readFile(screenshotPath);
        const diffPixels = await compareScreenshots(
          oldScreenshot,
          newScreenshot,
          true, // Auto-resize enabled to handle different dimensions
        );

        if (diffPixels > 0) {
          console.log(
            `✗ Visual changes detected for ${url}: ${diffPixels} pixels different`,
          );

          await createDiffImageWithPath(
            oldScreenshot,
            newScreenshot,
            filename,
            CHANGES_DIR,
          );
          return true;
        } else {
          console.log(`✓ No visual changes detected for ${url}`);
          return false;
        }
      } catch (err) {
        // Handle baseline read errors
        if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
          // Baseline missing - fail explicitly to prevent creating wrong baseline from changes branch
          throw new Error(
            `Baseline screenshot not found for ${url}. Run with baseline creation mode first.`,
            { cause: err },
          );
        }
        // Re-throw any other read error with context
        throw new Error(
          `Failed to read baseline screenshot: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }

    // Create baseline screenshot
    console.log(`Taking baseline screenshot for ${url}`);
    await fsPromises.writeFile(screenshotPath, newScreenshot);
    return false;
  } catch (error) {
    // Log error to dedicated error log file
    logVisualTestError(url, error, failedUrls.length + 1);

    // Track failed URL
    const errorType = classifyError(error);
    failedUrls.push({
      url,
      errorType,
      message: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });

    // CRITICAL: If baseline capture failed, we must exit the entire script.
    // Without a valid baseline, any comparison would be meaningless or misleading.
    // This is intentional behavior - don't proceed with comparisons when baseline is unavailable.
    if (isBaseline) {
      throw error;
    }

    // Return null to indicate comparison failure (distinct from "no changes")
    return null;
  }
}

async function switchBranch(branchName: string) {
  try {
    execSync(`git checkout ${branchName}`, { stdio: "inherit" });
    // Wait for any file system changes to settle
    execSync("git reset --hard HEAD", { stdio: "inherit" });
    // Wait a few seconds for any build processes or file watchers to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error) {
    console.error(`Failed to switch to branch ${branchName}`);
    throw error;
  }
}

/**
 * Main function to run the visual tests.
 *
 * Compares screenshots between two git branches to detect visual changes.
 *
 * Sample run: deno --env-file=.env --allow-all compare-branches.ts http://localhost:4321/work test
 *
 * @param url - The URL to capture screenshots from (typically localhost)
 * @param branchName - The name of the branch to compare against 'main'
 *
 * Features:
 * - Auto-resizes screenshots if dimensions differ between branches
 * - Logs errors to visual-test-errors.log with classification
 * - Saves baseline and comparison screenshots in ~/visual-testing-compare
 */
async function main() {
  const [url, branchName] = process.argv.slice(2);
  if (!url || !branchName) {
    console.error(
      "Please provide both a URL and branch name as command-line arguments.",
    );
    process.exit(1);
  }

  // Ensure directories exist (after argument validation)
  await fsPromises.mkdir(BASE_DIR, { recursive: true });
  await fsPromises.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await fsPromises.mkdir(CHANGES_DIR, { recursive: true });

  const failedUrls: FailedUrl[] = [];
  let urlsWithChanges = 0;
  let urlsPassed = 0;
  let urlsFailed = 0;

  try {
    // Switch to main branch and take baseline screenshots
    await switchBranch("main");
    await runVisualTest(url, true, failedUrls);

    // Switch to target branch and take new screenshots for comparison
    await switchBranch(branchName);
    const comparisonResult = await runVisualTest(url, false, failedUrls);

    // Handle the three possible states: true=changes, false=no changes, null=failed
    if (comparisonResult === true) {
      urlsWithChanges++;
    } else if (comparisonResult === false) {
      urlsPassed++;
    } else {
      urlsFailed++;
    }

    const totalUrls = urlsWithChanges + urlsPassed + urlsFailed;

    console.log(`\n=== Summary ===`);
    console.log(`URLs tested: ${totalUrls}`);
    console.log(`  ✓ Passed: ${urlsPassed}`);
    console.log(`  ✗ Changes: ${urlsWithChanges}`);
    if (urlsFailed > 0) {
      console.log(`  ⚠ Failed: ${urlsFailed}`);
    }

    if (failedUrls.length > 0) {
      console.log(
        `\n⚠️  ${failedUrls.length} error(s) occurred. Check visual-test-errors.log for details.`,
      );
    }
  } catch (error) {
    console.error(`Error running visual comparison:`, error);
  }
}

main().catch(console.error);
