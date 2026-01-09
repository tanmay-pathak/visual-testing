import pLimit from "p-limit";
import * as cheerio from "cheerio";
import process from "node:process";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import {
  classifyError,
  compareScreenshots,
  createDiffImage,
  ensureDirectoriesExistAsync,
  type FailedUrl,
  logVisualTestError,
  saveComparisonScreenshotsAsync,
  takeScreenshot,
  transformUrl,
  urlToFilename,
  writeErrorSummary,
} from "./visual-testing-utils.ts";

// Calculate optimal concurrency based on CPU cores
const cpuCount = os.cpus().length;
const SCREENSHOT_CONCURRENCY = Math.max(10, cpuCount * 2); // I/O-bound, can be higher
const COMPARISON_CONCURRENCY = Math.max(2, Math.floor(cpuCount * 0.75)); // CPU-bound
const FILE_IO_CONCURRENCY = 20; // Fast I/O operations

// Create separate limiters
const screenshotLimiter = pLimit(SCREENSHOT_CONCURRENCY);
const comparisonLimiter = pLimit(COMPARISON_CONCURRENCY);
const fileIoLimiter = pLimit(FILE_IO_CONCURRENCY);

const CACHE_DIR = ".cache";
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// URL filters to exclude unnecessary URLs
const URL_FILTERS = {
  excludePatterns: [
    /\/api\//, // API endpoints
    /\.xml$/, // Sitemaps
    /\.rss$/, // RSS feeds
    /\.json$/, // JSON endpoints
    /\/wp-json\//, // WordPress API
    /\/admin\//, // Admin panels
  ],
};

/**
 * Fetches URLs from a sitemap.
 * @param sitemapUrl - The URL of the sitemap.
 * @returns A promise that resolves to an array of URLs.
 */
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    console.log(`Fetching sitemap from ${sitemapUrl}...`);

    // Use Deno.Command to use curl with SSL certificate bypass
    const command = new Deno.Command("curl", {
      args: [
        "-k", // Ignore SSL certificate errors
        "-s", // Silent mode
        sitemapUrl,
      ],
    });

    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      console.error(
        `Failed to fetch sitemap. Error: ${new TextDecoder().decode(stderr)}`,
      );
      return [];
    }

    const data = new TextDecoder().decode(stdout);
    console.log("Received sitemap data, parsing...");

    const $ = cheerio.load(data, { xmlMode: true });
    const urls: string[] = [];

    // Try different selectors for different sitemap formats
    $("url loc, sitemap loc, urlset url").each((_, element) => {
      const loc = $(element).text().trim();
      if (loc) {
        urls.push(loc);
      }
    });

    if (urls.length === 0) {
      console.log("Raw sitemap content:", data);
    }

    return urls;
  } catch (error) {
    console.error(`Error fetching sitemap:`, error);
    return [];
  }
}

/**
 * Checks if a URL should be tested based on filter patterns.
 * @param url - The URL to check.
 * @returns True if the URL should be tested, false otherwise.
 */
function shouldTestUrl(url: string): boolean {
  return !URL_FILTERS.excludePatterns.some((pattern) => pattern.test(url));
}

/**
 * Gets a cached production screenshot if available and not expired.
 * @param filename - The filename for the screenshot.
 * @returns The cached screenshot buffer or null if not available/expired.
 */
async function getCachedProdScreenshot(
  filename: string,
): Promise<Buffer | null> {
  const cachePath = path.join(CACHE_DIR, `${filename}_prod.png`);

  try {
    const stats = await fsPromises.stat(cachePath);
    const age = Date.now() - stats.mtimeMs;

    if (age < CACHE_TTL) {
      console.log(`✓ Using cached prod screenshot for ${filename}`);
      return await fsPromises.readFile(cachePath);
    }
  } catch {
    // Cache miss
  }

  return null;
}

/**
 * Caches a production screenshot.
 * @param filename - The filename for the screenshot.
 * @param buffer - The screenshot buffer to cache.
 */
async function cacheProdScreenshot(
  filename: string,
  buffer: Buffer,
): Promise<void> {
  await fsPromises.mkdir(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${filename}_prod.png`);
  await fsPromises.writeFile(cachePath, buffer);
}

/**
 * Cleans up old cache files.
 * @param maxAgeMs - Maximum age in milliseconds for cache files to keep.
 */
async function cleanOldCache(
  maxAgeMs: number = 7 * 24 * 60 * 60 * 1000,
): Promise<void> {
  try {
    const files = await fsPromises.readdir(CACHE_DIR);
    const now = Date.now();

    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      const stats = await fsPromises.stat(filePath);
      const age = now - stats.mtimeMs;

      if (age > maxAgeMs) {
        await fsPromises.unlink(filePath);
        console.log(`Deleted old cache file: ${file}`);
      }
    }
  } catch {
    // Cache directory doesn't exist yet
  }
}

/**
 * Runs a visual test comparing production and preview environments for a given URL.
 * @param prodUrl - The production URL to test.
 * @param previewDomain - The preview domain to compare against.
 * @param getErrorNumber - Callback function to get the next error number.
 * @param failedUrls - Array to track failed URLs.
 * @returns True if visual changes were detected, false otherwise.
 */
async function runVisualTest(
  prodUrl: string,
  previewDomain: string,
  getErrorNumber: () => number,
  failedUrls: FailedUrl[],
): Promise<boolean> {
  try {
    const filename = urlToFilename(prodUrl);
    const previewUrl = transformUrl(prodUrl, previewDomain);

    // Check cache for prod screenshot only (preview is always fresh)
    let prodScreenshot = await getCachedProdScreenshot(filename);

    if (!prodScreenshot) {
      prodScreenshot = await takeScreenshot(prodUrl);
      await cacheProdScreenshot(filename, prodScreenshot);
    }

    // Always take fresh preview screenshot
    const previewScreenshot = await takeScreenshot(previewUrl);

    // Save screenshots with file I/O limiter (using async version)
    await fileIoLimiter(() =>
      saveComparisonScreenshotsAsync(
        filename,
        prodScreenshot,
        previewScreenshot,
      )
    );

    // Compare screenshots with comparison limiter (auto-resize if dimensions differ)
    const diffPixels = await comparisonLimiter(() =>
      compareScreenshots(
        prodScreenshot,
        previewScreenshot,
        true, // handleDifferentSizes: auto-resize to match dimensions
      )
    );

    // Create diff image only if differences are detected
    if (diffPixels > 0) {
      await createDiffImage(prodScreenshot, previewScreenshot, filename);
      console.log(
        `✗ Changes: ${prodUrl} (${diffPixels} pixels)`,
      );
      return true;
    } else {
      console.log(`✓ No changes: ${prodUrl}`);
      return false;
    }
  } catch (error) {
    // Log error to dedicated error log file (no console output)
    const errorNumber = getErrorNumber();
    logVisualTestError(prodUrl, error, errorNumber);

    // Track failed URL
    const errorType = classifyError(error);
    failedUrls.push({
      url: prodUrl,
      errorType,
      message: error?.message || String(error),
      timestamp: new Date().toISOString(),
    });

    return false;
  }
}

/**
 * Main function to run the visual tests.
 * Sample run: deno --allow-all compare-prod-and-preview.ts https://zu.com/sitemap-0.xml deploy-preview-385--zuc-web.netlify.app
 */
async function main() {
  const [sitemapUrl, previewDomain] = process.argv.slice(2);

  if (!sitemapUrl) {
    console.error("Please provide a sitemap URL as a command-line argument.");
    process.exit(1);
  }

  await ensureDirectoriesExistAsync();

  // Initialize error log file with header
  await fsPromises.writeFile(
    "./visual-test-errors.log",
    `╔══════════════════════════════════════════════════════════════╗
║           VISUAL TEST ERROR LOG                              ║
║           Started: ${new Date().toISOString()}                 ║
╚══════════════════════════════════════════════════════════════╝

`
  );

  // Clean old cache files (older than 7 days)
  await cleanOldCache();

  console.log(`Screenshot concurrency: ${SCREENSHOT_CONCURRENCY}`);
  console.log(`Comparison concurrency: ${COMPARISON_CONCURRENCY}`);
  console.log(`File I/O concurrency: ${FILE_IO_CONCURRENCY}`);

  try {
    const urlsFromSitemap = await fetchSitemapUrls(sitemapUrl);
    const uniqueUrls = [...new Set(urlsFromSitemap)];
    const filteredUrls = uniqueUrls.filter((url) => shouldTestUrl(url));

    console.log(
      `Processing ${filteredUrls.length} URLs (filtered from ${uniqueUrls.length})`,
    );

    let processed = 0;
    let withChanges = 0;
    let errorCount = 0;
    const failedUrls: FailedUrl[] = [];
    const startTime = Date.now();

    const tasks = filteredUrls.map((url) =>
      screenshotLimiter(async () => {
        const hadChanges = await runVisualTest(
          url,
          previewDomain,
          () => {
            // Error callback: increment error count and return the error number
            errorCount++;
            return errorCount;
          },
          failedUrls,
        );
        if (hadChanges) withChanges++;
        processed++;

        // Log progress every 10 URLs or on completion
        const shouldLog = processed % 10 === 0 || processed === filteredUrls.length;

        if (shouldLog) {
          const elapsed = (Date.now() - startTime) / 1000;
          const rate = processed / elapsed;
          const remaining = filteredUrls.length > processed
            ? (filteredUrls.length - processed) / rate
            : 0;
          console.log(
            `Progress: ${processed}/${filteredUrls.length} (${rate.toFixed(2)} URLs/sec${remaining > 0 ? `, ~${Math.floor(remaining)}s remaining` : ''})`,
          );
        }
      })
    );

    await Promise.all(tasks);

    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\n=== Summary ===`);
    console.log(`Processed: ${processed} URLs`);
    console.log(`With changes: ${withChanges}`);
    console.log(`Time: ${totalTime.toFixed(2)}s`);
    console.log(`Rate: ${(processed / totalTime).toFixed(2)} URLs/sec`);

    // Write error summary if there were any failures
    if (failedUrls.length > 0) {
      writeErrorSummary({
        totalUrls: processed,
        urlsWithChanges: withChanges,
        urlsFailed: failedUrls.length,
        failedUrls,
      });
      console.log(`\n⚠️  ${failedUrls.length} URL(s) failed. See visual-test-errors.log for details.`);
    }
  } catch (error) {
    console.error(`Error running visual tests:`, error);
  }
}

main().catch(console.error);
