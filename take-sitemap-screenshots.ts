import pLimit from "p-limit";
import process from "node:process";
import path from "node:path";
import { parseArgs } from "node:util";
import { promises as fsPromises } from "node:fs";
import { fetchSitemapUrls } from "./sitemap-utils.ts";
import {
  ensureDirectoriesExistAsync,
  getErrorMessage,
  logError,
  type ScreenshotOptions,
  SCREENSHOTS_DIR,
  takeScreenshot,
  urlToFilename,
} from "./visual-testing-utils.ts";

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface ScriptConfig {
  sitemapUrl?: string;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  maxUrls?: number;
  help: boolean;
}

function printHelp(): void {
  console.log(`Usage:
  deno run --env-file=.env --allow-all take-sitemap-screenshots.ts <sitemap_url> [options]

Options:
  --concurrency <n>      Number of parallel screenshots (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <ms>      Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>          Retries for sitemap/screenshot requests (default: ${DEFAULT_RETRIES})
  --retry-delay-ms <ms>  Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --max-urls <n>         Process at most n URLs
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

function getScriptConfig(args: string[]): ScriptConfig {
  const parsedArgs = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      retries: { type: "string" },
      "retry-delay-ms": { type: "string" },
      "max-urls": { type: "string" },
    },
  });

  return {
    sitemapUrl: parsedArgs.positionals[0],
    concurrency:
      parsePositiveInt(parsedArgs.values.concurrency, "concurrency") ??
        DEFAULT_CONCURRENCY,
    timeoutMs:
      parsePositiveInt(parsedArgs.values["timeout-ms"], "timeout-ms") ??
        DEFAULT_TIMEOUT_MS,
    retries: parsePositiveInt(parsedArgs.values.retries, "retries") ??
      DEFAULT_RETRIES,
    retryDelayMs: parsePositiveInt(
      parsedArgs.values["retry-delay-ms"],
      "retry-delay-ms",
    ) ?? DEFAULT_RETRY_DELAY_MS,
    maxUrls: parsePositiveInt(parsedArgs.values["max-urls"], "max-urls"),
    help: parsedArgs.values.help ?? false,
  };
}

function getScreenshotOptions(config: ScriptConfig): ScreenshotOptions {
  return {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    retryDelayMs: config.retryDelayMs,
  };
}

async function takeAndSaveScreenshot(
  url: string,
  screenshotOptions: ScreenshotOptions,
): Promise<boolean> {
  try {
    const screenshotBuffer = await takeScreenshot(url, screenshotOptions);
    const filename = urlToFilename(url);
    const outputPath = path.join(SCREENSHOTS_DIR, `${filename}.png`);
    await fsPromises.writeFile(outputPath, screenshotBuffer);
    console.log(`Screenshot saved for ${url} at ${outputPath}`);
    return true;
  } catch (error) {
    logError(`Failed to take or save screenshot for ${url}`, error);
    return false;
  }
}

/**
 * Main function to run the screenshot process.
 */
async function main(): Promise<number> {
  if (!process.env.BASE_URL || !process.env.API_TOKEN) {
    console.error(
      "Error: BASE_URL and API_TOKEN environment variables are required.",
    );
    return 1;
  }

  let config: ScriptConfig;
  try {
    config = getScriptConfig(process.argv.slice(2));
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  if (config.help) {
    printHelp();
    return 0;
  }

  if (!config.sitemapUrl) {
    console.error(
      "Please provide a sitemap URL as the first positional argument.",
    );
    printHelp();
    return 1;
  }

  console.log(`Starting screenshot process for sitemap: ${config.sitemapUrl}`);
  console.log(
    `Concurrency: ${config.concurrency}, timeout: ${config.timeoutMs}ms, retries: ${config.retries}`,
  );

  await ensureDirectoriesExistAsync();
  const limit = pLimit(config.concurrency);

  try {
    const urlsFromSitemap = await fetchSitemapUrls(config.sitemapUrl, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
      maxUrls: config.maxUrls,
    });

    if (urlsFromSitemap.length === 0) {
      console.error("No URLs found from the sitemap. Exiting.");
      return 1;
    }

    console.log(
      `Found ${urlsFromSitemap.length} unique URLs. Taking screenshots with concurrency limit ${config.concurrency}...`,
    );

    const screenshotOptions = getScreenshotOptions(config);
    let failedCount = 0;

    const tasks = urlsFromSitemap.map((url) =>
      limit(async () => {
        const success = await takeAndSaveScreenshot(url, screenshotOptions);
        if (!success) {
          failedCount++;
        }
      })
    );

    await Promise.all(tasks);

    if (failedCount > 0) {
      console.error(`Completed with ${failedCount} failed URL(s).`);
      return 1;
    }

    console.log("Screenshot process completed.");
    return 0;
  } catch (error) {
    logError("An error occurred during the screenshot process", error);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}
