import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  compareScreenshots,
  createDiffImageWithPath,
  createRunSubdirectory,
  getErrorMessage,
  type ScreenshotOptions,
  takeScreenshot,
  urlToFilename,
} from "./visual-testing-utils.ts";

const BASE_DIR = path.join(os.homedir(), "visual-testing-compare");
const SCREENSHOTS_DIR = path.join(BASE_DIR, "base");
const CHANGES_DIR = path.join(BASE_DIR, "changes");
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

function printHelp(): void {
  console.log(`Usage:
  deno run --env-file=.env --allow-all compare-branches.ts <url> <branch_name> [options]

Options:
  --timeout-ms <ms>      Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>          Retries for screenshot requests (default: ${DEFAULT_RETRIES})
  --retry-delay-ms <ms>  Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --run-name <name>      Optional label for the run output folder
  --help, -h             Show this help
`);
}

function parsePositiveInt(
  value: string | undefined,
  flagName: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for --${flagName}: ${value}`);
  }

  return parsed;
}

function ensureDirectoriesExist(): void {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(CHANGES_DIR, { recursive: true });
}

function runGitCommand(command: string): string {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function assertCleanWorkingTree(): void {
  const statusOutput = runGitCommand("git status --porcelain");
  if (statusOutput.length > 0) {
    throw new Error(
      "Working tree is not clean (tracked or untracked changes found). Commit/stash/clean before running compare-branches.",
    );
  }
}

function getCurrentBranch(): string {
  return runGitCommand("git rev-parse --abbrev-ref HEAD");
}

async function switchBranch(branchName: string): Promise<void> {
  try {
    execSync(`git checkout ${branchName}`, { stdio: "inherit" });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  } catch (error) {
    console.error(`Failed to switch to branch ${branchName}`);
    throw error;
  }
}

async function runVisualTest(
  url: string,
  isBaseline: boolean,
  screenshotOptions: ScreenshotOptions,
  changesOutputDir: string,
): Promise<void> {
  const filename = urlToFilename(url);
  const screenshotPath = path.join(SCREENSHOTS_DIR, `${filename}.png`);
  const newScreenshot = await takeScreenshot(url, screenshotOptions);

  if (!isBaseline && fs.existsSync(screenshotPath)) {
    const oldScreenshot = fs.readFileSync(screenshotPath);
    const diffPixels = await compareScreenshots(
      oldScreenshot,
      newScreenshot,
      true,
    );

    if (diffPixels > 0) {
      console.log(
        `Visual changes detected for ${url}: ${diffPixels} pixels different`,
      );
      await createDiffImageWithPath(
        oldScreenshot,
        newScreenshot,
        filename,
        changesOutputDir,
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

/**
 * Main function to run the visual tests.
 */
async function main(): Promise<number> {
  let parsedArgs;

  try {
    parsedArgs = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        "timeout-ms": { type: "string" },
        retries: { type: "string" },
        "retry-delay-ms": { type: "string" },
        "run-name": { type: "string" },
      },
    });
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  if (parsedArgs.values.help) {
    printHelp();
    return 0;
  }

  const url = parsedArgs.positionals[0];
  const branchName = parsedArgs.positionals[1];

  if (!url || !branchName) {
    console.error("Please provide URL and branch name positional arguments.");
    printHelp();
    return 1;
  }

  let screenshotOptions: ScreenshotOptions;
  try {
    screenshotOptions = {
      timeoutMs:
        parsePositiveInt(parsedArgs.values["timeout-ms"], "timeout-ms") ??
          DEFAULT_TIMEOUT_MS,
      retries: parsePositiveInt(parsedArgs.values.retries, "retries") ??
        DEFAULT_RETRIES,
      retryDelayMs: parsePositiveInt(
        parsedArgs.values["retry-delay-ms"],
        "retry-delay-ms",
      ) ?? DEFAULT_RETRY_DELAY_MS,
    };
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  ensureDirectoriesExist();
  const runChangesDir = await createRunSubdirectory(
    CHANGES_DIR,
    "branch-compare",
    parsedArgs.values["run-name"],
  );
  console.log(`Diff output directory: ${runChangesDir}`);

  let originalBranch: string | null = null;

  try {
    assertCleanWorkingTree();
    originalBranch = getCurrentBranch();

    await switchBranch("main");
    await runVisualTest(url, true, screenshotOptions, runChangesDir);

    await switchBranch(branchName);
    await runVisualTest(url, false, screenshotOptions, runChangesDir);

    return 0;
  } catch (error) {
    console.error(`Error running visual comparison: ${getErrorMessage(error)}`);
    return 1;
  } finally {
    if (originalBranch) {
      try {
        const currentBranch = getCurrentBranch();
        if (currentBranch !== originalBranch) {
          await switchBranch(originalBranch);
        }
      } catch (restoreError) {
        console.error(
          `Failed to restore original branch: ${getErrorMessage(restoreError)}`,
        );
      }
    }
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}
