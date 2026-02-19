import pLimit from "p-limit";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { promises as fsPromises } from "node:fs";
import { Buffer } from "node:buffer";
import { fetchSitemapUrls } from "./sitemap-utils.ts";
import {
  classifyError,
  compareScreenshots,
  createDiffImage,
  createRunSubdirectory,
  ensureDirectoriesExistAsync,
  type FailedUrl,
  getErrorMessage,
  logVisualTestError,
  saveComparisonScreenshotsAsync,
  type ScreenshotOptions,
  takeScreenshot,
  transformUrl,
  urlToFilename,
  writeErrorSummary,
} from "./visual-testing-utils.ts";

const cpuCount = os.cpus().length;
const DEFAULT_SCREENSHOT_CONCURRENCY = Math.max(10, cpuCount * 2);
const DEFAULT_COMPARISON_CONCURRENCY = Math.max(2, Math.floor(cpuCount * 0.75));
const DEFAULT_FILE_IO_CONCURRENCY = 20;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CACHE_CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const PROGRESS_LOG_INTERVAL = 10;

const CACHE_DIR = ".cache";

const URL_FILTERS = {
  excludePatterns: [
    /\/api\//,
    /\.xml$/,
    /\.rss$/,
    /\.json$/,
    /\/wp-json\//,
    /\/admin\//,
  ],
};

interface ScriptConfig {
  screenshotConcurrency: number;
  comparisonConcurrency: number;
  fileIoConcurrency: number;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  cacheTtlMs: number;
  cacheCleanupAgeMs: number;
  maxUrls?: number;
  noCache: boolean;
  runName?: string;
}

interface RuntimeLimiters {
  comparisonLimiter: ReturnType<typeof pLimit>;
  fileIoLimiter: ReturnType<typeof pLimit>;
}

function printHelp(): void {
  console.log(`Usage:
  deno run --env-file=.env --allow-all compare-prod-and-preview.ts <sitemap_url> [preview_domain] [options]

Options:
  --concurrency <n>             Screenshot concurrency (default: ${DEFAULT_SCREENSHOT_CONCURRENCY})
  --comparison-concurrency <n>  Pixel comparison concurrency (default: ${DEFAULT_COMPARISON_CONCURRENCY})
  --file-io-concurrency <n>     File write concurrency (default: ${DEFAULT_FILE_IO_CONCURRENCY})
  --timeout-ms <ms>             Request timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --retries <n>                 Retries for sitemap/screenshot requests (default: ${DEFAULT_RETRIES})
  --retry-delay-ms <ms>         Base retry delay (default: ${DEFAULT_RETRY_DELAY_MS})
  --cache-ttl-ms <ms>           Cached prod screenshot TTL (default: ${DEFAULT_CACHE_TTL_MS})
  --cache-cleanup-age-ms <ms>   Remove cache files older than this (default: ${DEFAULT_CACHE_CLEANUP_AGE_MS})
  --max-urls <n>                Process at most n filtered URLs
  --run-name <name>             Optional label for the run output folder
  --no-cache                    Disable prod screenshot cache for this run
  --help, -h                    Show this help
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

function normalizePreviewDomain(
  previewDomain: string | undefined,
): string | null {
  if (!previewDomain) {
    return null;
  }

  try {
    return new URL(previewDomain).toString();
  } catch {
    return `https://${previewDomain}`;
  }
}

function getScriptConfig(args: string[]): {
  sitemapUrl?: string;
  previewDomain: string | null;
  help: boolean;
  config: ScriptConfig;
} {
  const parsedArgs = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      concurrency: { type: "string" },
      "comparison-concurrency": { type: "string" },
      "file-io-concurrency": { type: "string" },
      "timeout-ms": { type: "string" },
      retries: { type: "string" },
      "retry-delay-ms": { type: "string" },
      "cache-ttl-ms": { type: "string" },
      "cache-cleanup-age-ms": { type: "string" },
      "max-urls": { type: "string" },
      "run-name": { type: "string" },
      "no-cache": { type: "boolean" },
    },
  });

  const screenshotConcurrency = parsePositiveInt(
    parsedArgs.values.concurrency,
    "concurrency",
  ) ?? DEFAULT_SCREENSHOT_CONCURRENCY;
  const comparisonConcurrency = parsePositiveInt(
    parsedArgs.values["comparison-concurrency"],
    "comparison-concurrency",
  ) ?? DEFAULT_COMPARISON_CONCURRENCY;
  const fileIoConcurrency = parsePositiveInt(
    parsedArgs.values["file-io-concurrency"],
    "file-io-concurrency",
  ) ?? DEFAULT_FILE_IO_CONCURRENCY;
  const timeoutMs =
    parsePositiveInt(parsedArgs.values["timeout-ms"], "timeout-ms") ??
      DEFAULT_TIMEOUT_MS;
  const retries = parsePositiveInt(parsedArgs.values.retries, "retries") ??
    DEFAULT_RETRIES;
  const retryDelayMs = parsePositiveInt(
    parsedArgs.values["retry-delay-ms"],
    "retry-delay-ms",
  ) ?? DEFAULT_RETRY_DELAY_MS;
  const cacheTtlMs = parsePositiveInt(
    parsedArgs.values["cache-ttl-ms"],
    "cache-ttl-ms",
  ) ?? DEFAULT_CACHE_TTL_MS;
  const cacheCleanupAgeMs = parsePositiveInt(
    parsedArgs.values["cache-cleanup-age-ms"],
    "cache-cleanup-age-ms",
  ) ?? DEFAULT_CACHE_CLEANUP_AGE_MS;
  const maxUrls = parsePositiveInt(parsedArgs.values["max-urls"], "max-urls");

  return {
    sitemapUrl: parsedArgs.positionals[0],
    previewDomain: normalizePreviewDomain(parsedArgs.positionals[1]),
    help: parsedArgs.values.help ?? false,
    config: {
      screenshotConcurrency,
      comparisonConcurrency,
      fileIoConcurrency,
      timeoutMs,
      retries,
      retryDelayMs,
      cacheTtlMs,
      cacheCleanupAgeMs,
      maxUrls,
      runName: parsedArgs.values["run-name"],
      noCache: parsedArgs.values["no-cache"] ?? false,
    },
  };
}

function shouldTestUrl(url: string): boolean {
  return !URL_FILTERS.excludePatterns.some((pattern) => pattern.test(url));
}

async function getCachedProdScreenshot(
  filename: string,
  cacheTtlMs: number,
): Promise<Buffer | null> {
  const cachePath = path.join(CACHE_DIR, `${filename}_prod.png`);

  try {
    const stats = await fsPromises.stat(cachePath);
    const age = Date.now() - stats.mtimeMs;

    if (age < cacheTtlMs) {
      console.log(`✓ Using cached prod screenshot for ${filename}`);
      return await fsPromises.readFile(cachePath);
    }
  } catch {
    // Cache miss
  }

  return null;
}

async function cacheProdScreenshot(
  filename: string,
  buffer: Buffer,
): Promise<void> {
  await fsPromises.mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${filename}_prod.png`);
  await fsPromises.writeFile(cachePath, buffer);
}

async function cleanOldCache(maxAgeMs: number): Promise<void> {
  try {
    const files = await fsPromises.readdir(CACHE_DIR);
    const now = Date.now();

    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(CACHE_DIR, file);
        const stats = await fsPromises.stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAgeMs) {
          await fsPromises.unlink(filePath);
          console.log(`Deleted old cache file: ${file}`);
        }
      }),
    );
  } catch {
    // Cache directory does not exist yet
  }
}

function getScreenshotOptions(config: ScriptConfig): ScreenshotOptions {
  return {
    timeoutMs: config.timeoutMs,
    retries: config.retries,
    retryDelayMs: config.retryDelayMs,
  };
}

async function runVisualTest(
  prodUrl: string,
  previewDomain: string | null,
  getErrorNumber: () => number,
  failedUrls: FailedUrl[],
  config: ScriptConfig,
  limiters: RuntimeLimiters,
  changesOutputDir: string,
): Promise<boolean> {
  try {
    const filename = urlToFilename(prodUrl);
    const previewUrl = transformUrl(prodUrl, previewDomain);
    const screenshotOptions = getScreenshotOptions(config);

    let prodScreenshot: Buffer | null = null;
    if (!config.noCache) {
      prodScreenshot = await getCachedProdScreenshot(
        filename,
        config.cacheTtlMs,
      );
    }

    if (!prodScreenshot) {
      prodScreenshot = await takeScreenshot(prodUrl, screenshotOptions);
      if (!config.noCache) {
        await cacheProdScreenshot(filename, prodScreenshot);
      }
    }

    const previewScreenshot = await takeScreenshot(
      previewUrl,
      screenshotOptions,
    );

    await limiters.fileIoLimiter(() =>
      saveComparisonScreenshotsAsync(
        filename,
        prodScreenshot,
        previewScreenshot,
      )
    );

    const diffPixels = await limiters.comparisonLimiter(() =>
      compareScreenshots(prodScreenshot, previewScreenshot, true)
    );

    if (diffPixels > 0) {
      await createDiffImage(
        prodScreenshot,
        previewScreenshot,
        filename,
        changesOutputDir,
      );
      console.log(`✗ Changes: ${prodUrl} (${diffPixels} pixels)`);
      return true;
    }

    console.log(`✓ No changes: ${prodUrl}`);
    return false;
  } catch (error) {
    const errorNumber = getErrorNumber();
    logVisualTestError(prodUrl, error, errorNumber);

    failedUrls.push({
      url: prodUrl,
      errorType: classifyError(error),
      message: getErrorMessage(error),
      timestamp: new Date().toISOString(),
    });

    return false;
  }
}

async function initializeErrorLog(): Promise<void> {
  await fsPromises.writeFile(
    "./visual-test-errors.log",
    `╔══════════════════════════════════════════════════════════════╗
║           VISUAL TEST ERROR LOG                              ║
║           Started: ${new Date().toISOString()}                 ║
╚══════════════════════════════════════════════════════════════╝

`,
  );
}

/**
 * Main function to run the visual tests.
 */
async function main(): Promise<number> {
  let parsedConfig;

  try {
    parsedConfig = getScriptConfig(process.argv.slice(2));
  } catch (error) {
    console.error(getErrorMessage(error));
    printHelp();
    return 1;
  }

  if (parsedConfig.help) {
    printHelp();
    return 0;
  }

  const { sitemapUrl, previewDomain, config } = parsedConfig;

  if (!sitemapUrl) {
    console.error(
      "Please provide a sitemap URL as the first positional argument.",
    );
    printHelp();
    return 1;
  }

  await ensureDirectoriesExistAsync();
  await initializeErrorLog();
  await cleanOldCache(config.cacheCleanupAgeMs);
  const runChangesDir = await createRunSubdirectory(
    "changes",
    "prod-preview",
    config.runName,
  );

  console.log(`Screenshot concurrency: ${config.screenshotConcurrency}`);
  console.log(`Comparison concurrency: ${config.comparisonConcurrency}`);
  console.log(`File I/O concurrency: ${config.fileIoConcurrency}`);
  console.log(`Timeout: ${config.timeoutMs}ms, retries: ${config.retries}`);
  console.log(`Diff output directory: ${runChangesDir}`);

  const screenshotLimiter = pLimit(config.screenshotConcurrency);
  const comparisonLimiter = pLimit(config.comparisonConcurrency);
  const fileIoLimiter = pLimit(config.fileIoConcurrency);

  try {
    const urlsFromSitemap = await fetchSitemapUrls(sitemapUrl, {
      timeoutMs: config.timeoutMs,
      retries: config.retries,
      retryDelayMs: config.retryDelayMs,
    });

    if (urlsFromSitemap.length === 0) {
      console.error("No URLs discovered from sitemap. Exiting.");
      return 1;
    }

    const filteredUrls = urlsFromSitemap.filter((url) => shouldTestUrl(url));
    const targetUrls = config.maxUrls
      ? filteredUrls.slice(0, config.maxUrls)
      : filteredUrls;

    if (targetUrls.length === 0) {
      console.error("No URLs remained after filtering. Exiting.");
      return 1;
    }

    console.log(
      `Processing ${targetUrls.length} URLs (filtered from ${urlsFromSitemap.length})`,
    );

    let processed = 0;
    let withChanges = 0;
    let errorCount = 0;
    const failedUrls: FailedUrl[] = [];
    const startTime = Date.now();

    const tasks = targetUrls.map((url) =>
      screenshotLimiter(async () => {
        const hadChanges = await runVisualTest(
          url,
          previewDomain,
          () => {
            errorCount++;
            return errorCount;
          },
          failedUrls,
          config,
          { comparisonLimiter, fileIoLimiter },
          runChangesDir,
        );

        if (hadChanges) {
          withChanges++;
        }

        processed++;

        const shouldLog = processed % PROGRESS_LOG_INTERVAL === 0 ||
          processed === targetUrls.length;

        if (shouldLog) {
          const elapsed = (Date.now() - startTime) / 1_000;
          const rate = processed / Math.max(elapsed, 1);
          const remaining = targetUrls.length > processed
            ? (targetUrls.length - processed) / Math.max(rate, 0.1)
            : 0;

          console.log(
            `Progress: ${processed}/${targetUrls.length} (${
              rate.toFixed(2)
            } URLs/sec${
              remaining > 0 ? `, ~${Math.floor(remaining)}s remaining` : ""
            })`,
          );
        }
      })
    );

    await Promise.all(tasks);

    const totalTime = (Date.now() - startTime) / 1_000;
    console.log("\n=== Summary ===");
    console.log(`Processed: ${processed} URLs`);
    console.log(`With changes: ${withChanges}`);
    console.log(`Time: ${totalTime.toFixed(2)}s`);
    console.log(
      `Rate: ${(processed / Math.max(totalTime, 1)).toFixed(2)} URLs/sec`,
    );

    if (failedUrls.length > 0) {
      writeErrorSummary({
        totalUrls: processed,
        urlsWithChanges: withChanges,
        urlsFailed: failedUrls.length,
        failedUrls,
      });
      console.log(
        `\n⚠️  ${failedUrls.length} URL(s) failed. See visual-test-errors.log for details.`,
      );
    }

    return 0;
  } catch (error) {
    console.error(`Error running visual tests: ${getErrorMessage(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  const code = await main();
  if (code !== 0) {
    process.exit(code);
  }
}
