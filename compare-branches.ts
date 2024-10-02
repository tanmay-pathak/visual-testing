import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import {
  compareScreenshots,
  createDiffImageWithPath,
  takeScreenshot,
  urlToFilename,
} from "./visual-testing-utils.ts";

const BASE_DIR = path.join(os.homedir(), "visual-testing-compare");
const SCREENSHOTS_DIR = path.join(BASE_DIR, "base");
const CHANGES_DIR = path.join(BASE_DIR, "changes");

async function runVisualTest(
  url: string,
  isBaseline: boolean,
) {
  const filename = urlToFilename(url);
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${filename}.png`);
  const newScreenshot = await takeScreenshot(url);

  if (!isBaseline && fs.existsSync(screenshotPath)) {
    const oldScreenshot = fs.readFileSync(screenshotPath);
    const diffPixels = await compareScreenshots(oldScreenshot, newScreenshot);

    if (diffPixels > 0) {
      console.log(
        `Visual changes detected for ${url}: ${diffPixels} pixels different`,
      );

      // Use the custom changes directory in the user's home folder
      await createDiffImageWithPath(
        oldScreenshot,
        newScreenshot,
        filename,
        CHANGES_DIR,
      );
    } else {
      console.log(`No visual changes detected for ${url}`);
    }
  } else {
    console.log(
      `Taking ${isBaseline ? "baseline" : "new"} screenshot for ${url}`,
    );
  }

  fs.writeFileSync(screenshotPath, newScreenshot);
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
 * Sample run: deno --allow-all compare-branches.ts http://localhost:4321/work test
 */
async function main() {
  // Ensure directories exist
  if (!fs.existsSync(BASE_DIR)) {
    fs.mkdirSync(BASE_DIR);
  }

  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR);
  }

  if (!fs.existsSync(CHANGES_DIR)) {
    fs.mkdirSync(CHANGES_DIR);
  }

  const [url, branchName] = process.argv.slice(2);
  if (!url || !branchName) {
    console.error(
      "Please provide both a URL and branch name as command-line arguments.",
    );
    process.exit(1);
  }

  try {
    // Switch to main branch and take baseline screenshots
    await switchBranch("main");
    await runVisualTest(url, true);

    // Switch to target branch and take new screenshots for comparison
    await switchBranch(branchName);
    await runVisualTest(url, false);
  } catch (error) {
    console.error(`Error running visual comparison:`, error);
  }
}

main().catch(console.error);
