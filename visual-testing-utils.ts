import fs from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import Jimp from "jimp";
import { Buffer } from "node:buffer";
import process from "node:process";

export const SCREENSHOTS_DIR = "screenshots";
export const CHANGES_DIR = "changes";
export const ERROR_LOG_FILE = "error.log";
export const VISUAL_TEST_ERROR_LOG = "visual-test-errors.log";
export const PIXELMATCH_THRESHOLD = 0.1;
export const DEFAULT_VIEWPORT_WIDTH = 1700;
export const DEFAULT_VIEWPORT_HEIGHT = 1080;

const DEFAULT_SCREENSHOT_TIMEOUT_MS = 45_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;
const DEFAULT_RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Error types for visual test failures
 */
export enum ErrorType {
  NETWORK_TIMEOUT = "NETWORK_TIMEOUT",
  SCREENSHOT_FAILURE = "SCREENSHOT_FAILURE",
  COMPARISON_ERROR = "COMPARISON_ERROR",
  FILE_IO_ERROR = "FILE_IO_ERROR",
  UNKNOWN = "UNKNOWN",
}

/**
 * Interface for tracking failed URLs
 */
export interface FailedUrl {
  url: string;
  errorType: ErrorType;
  message: string;
  timestamp: string;
}

export interface RetryOptions {
  retries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  backoffMultiplier?: number;
  jitter?: boolean;
}

export interface ScreenshotOptions extends RetryOptions {
  timeoutMs?: number;
}

/**
 * Converts unknown errors to a stable string representation.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Extracts a safe stack representation from unknown errors.
 */
export function getErrorStack(error: unknown): string {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }

  return "No stack trace available";
}

/**
 * Simple delay helper.
 */
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries an async operation with exponential backoff.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
  operationName: string = "operation",
): Promise<T> {
  const retries = Math.max(0, options.retries ?? DEFAULT_RETRIES);
  const retryDelayMs = Math.max(
    1,
    options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
  );
  const maxRetryDelayMs = Math.max(
    retryDelayMs,
    options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
  );
  const backoffMultiplier = Math.max(
    1,
    options.backoffMultiplier ?? DEFAULT_RETRY_BACKOFF_MULTIPLIER,
  );
  const jitter = options.jitter ?? true;

  let attempt = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt++;

      if (attempt > retries) {
        throw error;
      }

      const baseDelay = Math.min(
        maxRetryDelayMs,
        Math.round(retryDelayMs * Math.pow(backoffMultiplier, attempt - 1)),
      );
      const delayMs = jitter
        ? Math.max(1, Math.round(baseDelay * (0.8 + Math.random() * 0.4)))
        : baseDelay;

      console.warn(
        `Retrying ${operationName} (${attempt}/${retries}) in ${delayMs}ms after error: ${
          getErrorMessage(error)
        }`,
      );

      await sleep(delayMs);
    }
  }
}

/**
 * Converts a URL to a filename-friendly string.
 * @param url - The URL to convert.
 * @returns The filename-friendly string.
 */
export function urlToFilename(url: string): string {
  return url.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getRunTimestamp(date: Date = new Date()): string {
  return date
    .toISOString()
    .replace(/[:]/g, "-")
    .replace(/\.\d+z$/i, "z");
}

/**
 * Creates a run-specific output directory path under the provided base directory.
 */
export async function createRunSubdirectory(
  baseDir: string,
  defaultPrefix: string,
  runName?: string,
): Promise<string> {
  await fsPromises.mkdir(baseDir, { recursive: true });

  const prefix = sanitizePathSegment(defaultPrefix) || "run";
  const customName = runName ? sanitizePathSegment(runName) : "";
  const namePart = customName ? `${prefix}-${customName}` : prefix;
  const runDir = path.join(baseDir, `${namePart}-${getRunTimestamp()}`);

  await fsPromises.mkdir(runDir, { recursive: true });
  return runDir;
}

/**
 * Takes a screenshot of the given URL using browserless service.
 * @param url - The URL to capture.
 * @param options - Screenshot and retry options.
 * @returns A buffer containing the screenshot.
 */
export async function takeScreenshot(
  url: string,
  options: ScreenshotOptions = {},
): Promise<Buffer> {
  const timeoutMs = Math.max(
    1_000,
    options.timeoutMs ?? DEFAULT_SCREENSHOT_TIMEOUT_MS,
  );

  try {
    const launchArgs = JSON.stringify({
      args: [
        "--ignore-certificate-errors",
        "--ignore-certificate-errors-spki-list",
        "--ignore-ssl-errors",
        "--disable-web-security",
      ],
    });

    const baseUrl = process.env.BASE_URL;
    const apiToken = process.env.API_TOKEN;

    if (!apiToken || !baseUrl) {
      throw new Error(
        "BASE_URL and API_TOKEN environment variables are required but not set.",
      );
    }

    const browserlessUrl =
      `${baseUrl}/screenshot?token=${apiToken}&launch=${launchArgs}`;

    return await withRetry(
      async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(browserlessUrl, {
            method: "POST",
            headers: {
              "Cache-Control": "no-cache",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              url,
              options: {
                fullPage: true,
                type: "png",
              },
              viewport: {
                width: DEFAULT_VIEWPORT_WIDTH,
                height: 2000,
              },
              scrollPage: true,
              addScriptTag: [
                {
                  content: `
    const style = document.createElement('style');
    style.innerHTML = '* { animation: none !important; transition: none !important; }';
    style.innerHTML += '[data-aos], [data-scroll], [data-animation], [data-scroll-reveal], .reveal, .animated, .animate__animated { opacity: 1 !important; transform: none !important; visibility: visible !important; }';
    document.head.appendChild(style);

    setTimeout(() => {
      if (window.AOS) window.AOS.init({ disable: true });
      if (window.ScrollReveal) window.ScrollReveal().reveal = () => {};
      if (window.WOW) window.WOW.prototype.show = () => {};

      document.querySelectorAll('[data-aos], [data-scroll], [data-animation], [data-scroll-reveal], .reveal, .animated, .animate__animated, [class*="reveal-"], [class*="scroll-"], [class*="fade-"]').forEach(el => {
        el.style.opacity = '1';
        el.style.transform = 'none';
        el.style.visibility = 'visible';
        el.classList.add('aos-animate', 'is-visible', 'in-view', 'active');
      });

      window.IntersectionObserver = function() {
        return {
          observe: () => {},
          unobserve: () => {},
          disconnect: () => {}
        };
      };
    }, 500);
  `,
                },
              ],
            }),
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(
              `Failed to take screenshot: ${response.status} ${response.statusText}`,
            );
          }

          const imageBuffer = await response.arrayBuffer();
          return Buffer.from(imageBuffer);
        } finally {
          clearTimeout(timeout);
        }
      },
      options,
      `takeScreenshot(${url})`,
    );
  } catch (error) {
    logError(`Error taking screenshot for URL ${url}`, error);
    throw error;
  }
}

/**
 * Compares two screenshots and returns the number of differing pixels.
 * @param oldImage - The buffer of the old screenshot.
 * @param newImage - The buffer of the new screenshot.
 * @param handleDifferentSizes - Whether to handle different image sizes.
 * @returns The number of differing pixels.
 */
export async function compareScreenshots(
  oldImage: Buffer,
  newImage: Buffer,
  handleDifferentSizes: boolean = false,
): Promise<number> {
  if (handleDifferentSizes) {
    const oldJimp = await Jimp.read(oldImage);
    const newJimp = await Jimp.read(newImage);

    const oldWidth = oldJimp.getWidth();
    const oldHeight = oldJimp.getHeight();
    const newWidth = newJimp.getWidth();
    const newHeight = newJimp.getHeight();

    if (oldWidth !== newWidth || oldHeight !== newHeight) {
      const maxWidth = Math.max(oldWidth, newWidth);
      const maxHeight = Math.max(oldHeight, newHeight);

      oldJimp.resize(maxWidth, maxHeight);
      newJimp.resize(maxWidth, maxHeight);

      const oldResized = PNG.sync.read(
        await oldJimp.getBufferAsync(Jimp.MIME_PNG),
      );
      const newResized = PNG.sync.read(
        await newJimp.getBufferAsync(Jimp.MIME_PNG),
      );

      const diff = new PNG({ width: maxWidth, height: maxHeight });

      return pixelmatch(
        oldResized.data,
        newResized.data,
        diff.data,
        maxWidth,
        maxHeight,
        { threshold: PIXELMATCH_THRESHOLD },
      );
    }
  }

  const img1 = PNG.sync.read(oldImage);
  const img2 = PNG.sync.read(newImage);
  const { width, height } = img1;
  const diff = new PNG({ width, height });

  return pixelmatch(img1.data, img2.data, diff.data, width, height, {
    threshold: PIXELMATCH_THRESHOLD,
  });
}

/**
 * Creates a diff image showing the differences between two screenshots and saves to specified directory.
 * @param oldImage - The buffer of the old screenshot.
 * @param newImage - The buffer of the new screenshot.
 * @param filename - The filename to save the diff image as.
 * @param outputDir - The directory to save the diff image in.
 */
export async function createDiffImageWithPath(
  oldImage: Buffer,
  newImage: Buffer,
  filename: string,
  outputDir: string,
): Promise<void> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const oldJimp = await Jimp.read(oldImage);
  const newJimp = await Jimp.read(newImage);

  const oldWidth = oldJimp.getWidth();
  const oldHeight = oldJimp.getHeight();
  const newWidth = newJimp.getWidth();
  const newHeight = newJimp.getHeight();

  const maxWidth = Math.max(oldWidth, newWidth);
  const maxHeight = Math.max(oldHeight, newHeight);

  if (oldWidth !== maxWidth || oldHeight !== maxHeight) {
    oldJimp.resize(maxWidth, maxHeight);
  }

  if (newWidth !== maxWidth || newHeight !== maxHeight) {
    newJimp.resize(maxWidth, maxHeight);
  }

  const oldBuffer = await oldJimp.getBufferAsync(Jimp.MIME_PNG);
  const newBuffer = await newJimp.getBufferAsync(Jimp.MIME_PNG);

  const img1 = PNG.sync.read(oldBuffer);
  const img2 = PNG.sync.read(newBuffer);
  const diff = new PNG({ width: maxWidth, height: maxHeight });

  pixelmatch(img1.data, img2.data, diff.data, maxWidth, maxHeight, {
    threshold: PIXELMATCH_THRESHOLD,
  });

  const diffJimp = await Jimp.read(PNG.sync.write(diff));
  const composite = new Jimp(maxWidth * 3, maxHeight);

  composite.composite(oldJimp, 0, 0);
  composite.composite(newJimp, maxWidth, 0);
  composite.composite(diffJimp, maxWidth * 2, 0);

  const outputPath = path.join(outputDir, `${filename}_diff.png`);
  await composite.writeAsync(outputPath);
}

/**
 * Creates a diff image showing the differences between two screenshots.
 * @param oldImage - The buffer of the old screenshot.
 * @param newImage - The buffer of the new screenshot.
 * @param filename - The filename to save the diff image as.
 */
export async function createDiffImage(
  oldImage: Buffer,
  newImage: Buffer,
  filename: string,
  outputDir: string = CHANGES_DIR,
): Promise<void> {
  await createDiffImageWithPath(oldImage, newImage, filename, outputDir);
}

/**
 * Logs error to both console and error log file.
 */
export function logError(message: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${message}: ${getErrorMessage(error)}\n`;

  console.error(errorMessage);
  fs.appendFileSync(ERROR_LOG_FILE, errorMessage);
}

/**
 * Classifies an error into an ErrorType based on its properties.
 */
export function classifyError(error: unknown): ErrorType {
  const message = getErrorMessage(error).toLowerCase();

  if (
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("abort")
  ) {
    return ErrorType.NETWORK_TIMEOUT;
  }
  if (message.includes("screenshot") || message.includes("capture")) {
    return ErrorType.SCREENSHOT_FAILURE;
  }
  if (message.includes("enoent") || message.includes("eacces")) {
    return ErrorType.FILE_IO_ERROR;
  }
  if (message.includes("compare") || message.includes("pixelmatch")) {
    return ErrorType.COMPARISON_ERROR;
  }

  return ErrorType.UNKNOWN;
}

/**
 * Logs a visual test error to the dedicated error log file (no console output).
 */
export function logVisualTestError(
  url: string,
  error: unknown,
  errorNumber: number,
): void {
  const timestamp = new Date().toISOString();
  const errorType = classifyError(error);
  const errorMessage = getErrorMessage(error);
  const stackTrace = getErrorStack(error);

  const logEntry = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
❌ Error #${errorNumber}: ${errorType.replace(/_/g, " ")}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

URL:         ${url}
Time:        ${timestamp}

Error Type:  ${errorType}
Message:     ${errorMessage}

Stack Trace:
${stackTrace.split("\n").slice(0, 5).join("\n")}

`;

  fs.appendFileSync(VISUAL_TEST_ERROR_LOG, logEntry);
}

/**
 * Writes the error summary to the visual test error log.
 */
export interface ErrorSummary {
  totalUrls: number;
  urlsWithChanges: number;
  urlsFailed: number;
  failedUrls: FailedUrl[];
}

export function writeErrorSummary(summary: ErrorSummary): void {
  const errorCounts: Record<ErrorType, number> = {
    [ErrorType.NETWORK_TIMEOUT]: 0,
    [ErrorType.SCREENSHOT_FAILURE]: 0,
    [ErrorType.COMPARISON_ERROR]: 0,
    [ErrorType.FILE_IO_ERROR]: 0,
    [ErrorType.UNKNOWN]: 0,
  };

  summary.failedUrls.forEach((failed) => {
    errorCounts[failed.errorType]++;
  });

  const summaryText = `
╔══════════════════════════════════════════════════════════════╗
║                    SUMMARY                                   ║
╚══════════════════════════════════════════════════════════════╝

Total URLs Processed:    ${summary.totalUrls}
URLs with Changes:       ${summary.urlsWithChanges}
URLs Failed:             ${summary.urlsFailed}

Error Breakdown:
${
    Object.entries(errorCounts)
      .filter(([_, count]) => count > 0)
      .map(([type, count]) => `  • ${type.replace(/_/g, " ")}: ${count}`)
      .join("\n")
  }

${
    summary.failedUrls.length > 0
      ? `Failed URLs:
${
        summary.failedUrls.map((f, i) =>
          `  ${i + 1}. ${f.url} (${f.errorType})`
        ).join("\n")
      }
`
      : ""
  }
═════════════════════════════════════════════════════════════════
`;

  fs.appendFileSync(VISUAL_TEST_ERROR_LOG, summaryText);
}

/**
 * Transforms a URL by replacing its base domain with a new one.
 */
export function transformUrl(
  originalUrl: string,
  newBaseDomain: string | null,
): string {
  if (!newBaseDomain) return originalUrl;

  try {
    const url = new URL(originalUrl);
    return originalUrl.replace(url.origin, newBaseDomain);
  } catch (error) {
    logError(`Error transforming URL ${originalUrl}`, error);
    return originalUrl;
  }
}

/**
 * Ensures the necessary directories exist.
 */
export function ensureDirectoriesExist(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR);
  }

  if (!fs.existsSync(CHANGES_DIR)) {
    fs.mkdirSync(CHANGES_DIR);
  }
}

/**
 * Async version of ensureDirectoriesExist.
 */
export async function ensureDirectoriesExistAsync(): Promise<void> {
  await Promise.all([
    fsPromises.mkdir(SCREENSHOTS_DIR, { recursive: true }),
    fsPromises.mkdir(CHANGES_DIR, { recursive: true }),
  ]);
}

/**
 * Saves screenshots for URL comparison.
 */
export function saveComparisonScreenshots(
  filename: string,
  screenshot1: Buffer,
  screenshot2: Buffer,
): { screenshot1Path: string; screenshot2Path: string } {
  const screenshot1Path = path.join(SCREENSHOTS_DIR, `${filename}_prod.png`);
  const screenshot2Path = path.join(SCREENSHOTS_DIR, `${filename}_preview.png`);

  fs.writeFileSync(screenshot1Path, screenshot1);
  fs.writeFileSync(screenshot2Path, screenshot2);

  return { screenshot1Path, screenshot2Path };
}

/**
 * Async version of saveComparisonScreenshots.
 */
export async function saveComparisonScreenshotsAsync(
  filename: string,
  screenshot1: Buffer,
  screenshot2: Buffer,
): Promise<{ screenshot1Path: string; screenshot2Path: string }> {
  const screenshot1Path = path.join(SCREENSHOTS_DIR, `${filename}_prod.png`);
  const screenshot2Path = path.join(SCREENSHOTS_DIR, `${filename}_preview.png`);

  await Promise.all([
    fsPromises.writeFile(screenshot1Path, screenshot1),
    fsPromises.writeFile(screenshot2Path, screenshot2),
  ]);

  return { screenshot1Path, screenshot2Path };
}

/**
 * Logs the results of visual comparison.
 */
export function logComparisonResults(
  diffPixels: number,
  filename: string,
  screenshot1Path: string,
  screenshot2Path: string,
  changesOutputDir: string = CHANGES_DIR,
): void {
  const diffPath = path.join(changesOutputDir, `${filename}_diff.png`);

  if (diffPixels > 0) {
    console.log(`Visual differences detected: ${diffPixels} pixels different`);
    console.log(`Comparison saved to ${diffPath}`);
  } else {
    console.log("No visual differences detected");
    console.log(`Comparison saved to ${diffPath}`);
  }

  console.log(
    `Screenshots saved to:\n1. ${screenshot1Path}\n2. ${screenshot2Path}`,
  );
}

/**
 * Performs a complete visual comparison of two URLs.
 */
export async function performUrlComparison(
  url1: string,
  url2: string,
  screenshotOptions: ScreenshotOptions = {},
  changesOutputDir: string = CHANGES_DIR,
): Promise<void> {
  ensureDirectoriesExist();

  try {
    console.log("Comparing URLs");
    console.log(`1. ${url1}`);
    console.log(`2. ${url2}`);

    const filename = urlToFilename(url1);

    const screenshot1 = await takeScreenshot(url1, screenshotOptions);
    const screenshot2 = await takeScreenshot(url2, screenshotOptions);

    const { screenshot1Path, screenshot2Path } = saveComparisonScreenshots(
      filename,
      screenshot1,
      screenshot2,
    );

    const diffPixels = await compareScreenshots(
      screenshot1,
      screenshot2,
      true,
    );

    await createDiffImage(screenshot1, screenshot2, filename, changesOutputDir);

    logComparisonResults(
      diffPixels,
      filename,
      screenshot1Path,
      screenshot2Path,
      changesOutputDir,
    );
  } catch (error) {
    logError("Error comparing URLs", error);
    throw error;
  }
}
