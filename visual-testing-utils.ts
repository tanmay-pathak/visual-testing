import { Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import Jimp from "jimp";
import { Buffer } from "node:buffer";
import { chromium } from "@playwright/test";

export const SCREENSHOTS_DIR = "screenshots";
export const CHANGES_DIR = "changes";
export const ERROR_LOG_FILE = "error.log";
export const PIXELMATCH_THRESHOLD = 0.1;
export const DEFAULT_VIEWPORT_WIDTH = 1700;
export const DEFAULT_VIEWPORT_HEIGHT = 1080;
export const SCREENSHOT_OPTIONS = { fullPage: true };

/**
 * Converts a URL to a filename-friendly string.
 * @param url - The URL to convert.
 * @returns The filename-friendly string.
 */
export function urlToFilename(url: string): string {
  return url.replace(/[^a-z0-9]/gi, "_").toLowerCase();
}

/**
 * Takes a screenshot of the given URL.
 * @param page - The Playwright page instance.
 * @param url - The URL to capture.
 * @param width - The viewport width for the screenshot.
 * @param waitForLazyLoading - Whether to wait for lazy loaded content
 * @returns A buffer containing the screenshot.
 */
export async function takeScreenshot(
  page: Page,
  url: string,
  width: number = DEFAULT_VIEWPORT_WIDTH,
  waitForLazyLoading: boolean = false,
): Promise<Buffer> {
  try {
    await page.setViewportSize({ width, height: DEFAULT_VIEWPORT_HEIGHT });

    // Enable reduced motion before navigating to the page
    await page.emulateMedia({ reducedMotion: "reduce" });

    await page.goto(url);

    if (waitForLazyLoading) {
      // Wait for any lazy loaded content
      await page.waitForTimeout(1000);

      // Scroll to bottom and back to top to ensure all lazy content loads
      await page.evaluate(() => globalThis.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
      await page.evaluate(() => globalThis.scrollTo(0, 0));
      await page.waitForTimeout(500);
    }

    return await page.screenshot(SCREENSHOT_OPTIONS);
  } catch (error) {
    logError(`Error taking screenshot for URL ${url}`, error);
    throw error; // Re-throw to allow caller to handle
  }
}

/**
 * Compares two screenshots and returns the number of differing pixels.
 * @param oldImage - The buffer of the old screenshot.
 * @param newImage - The buffer of the new screenshot.
 * @param handleDifferentSizes - Whether to handle different image sizes
 * @returns The number of differing pixels.
 */
export async function compareScreenshots(
  oldImage: Buffer,
  newImage: Buffer,
  handleDifferentSizes: boolean = false,
): Promise<number> {
  if (handleDifferentSizes) {
    // Use Jimp to resize images if they don't match
    const oldJimp = await Jimp.read(oldImage);
    const newJimp = await Jimp.read(newImage);

    // Get dimensions
    const oldWidth = oldJimp.getWidth();
    const oldHeight = oldJimp.getHeight();
    const newWidth = newJimp.getWidth();
    const newHeight = newJimp.getHeight();

    // If dimensions don't match, resize to the larger of each dimension
    if (oldWidth !== newWidth || oldHeight !== newHeight) {
      const maxWidth = Math.max(oldWidth, newWidth);
      const maxHeight = Math.max(oldHeight, newHeight);

      // Resize both images to match the larger dimensions
      oldJimp.resize(maxWidth, maxHeight);
      newJimp.resize(maxWidth, maxHeight);

      // Convert back to PNG for comparison
      const oldResized = PNG.sync.read(
        await oldJimp.getBufferAsync(Jimp.MIME_PNG),
      );
      const newResized = PNG.sync.read(
        await newJimp.getBufferAsync(Jimp.MIME_PNG),
      );

      // Create diff using resized images
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

  // Images already match in size, use original comparison
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
  // Create the output directory if it doesn't exist
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Load images with Jimp
  const oldJimp = await Jimp.read(oldImage);
  const newJimp = await Jimp.read(newImage);

  // Get dimensions
  const oldWidth = oldJimp.getWidth();
  const oldHeight = oldJimp.getHeight();
  const newWidth = newJimp.getWidth();
  const newHeight = newJimp.getHeight();

  // Determine max dimensions for the composite image
  const maxWidth = Math.max(oldWidth, newWidth);
  const maxHeight = Math.max(oldHeight, newHeight);

  // Resize if necessary
  if (oldWidth !== maxWidth || oldHeight !== maxHeight) {
    oldJimp.resize(maxWidth, maxHeight);
  }

  if (newWidth !== maxWidth || newHeight !== maxHeight) {
    newJimp.resize(maxWidth, maxHeight);
  }

  // Convert back to PNG for pixelmatch
  const oldBuffer = await oldJimp.getBufferAsync(Jimp.MIME_PNG);
  const newBuffer = await newJimp.getBufferAsync(Jimp.MIME_PNG);

  const img1 = PNG.sync.read(oldBuffer);
  const img2 = PNG.sync.read(newBuffer);
  const diff = new PNG({ width: maxWidth, height: maxHeight });

  pixelmatch(img1.data, img2.data, diff.data, maxWidth, maxHeight, {
    threshold: PIXELMATCH_THRESHOLD,
  });

  const diffJimp = await Jimp.read(PNG.sync.write(diff));

  // Create composite image with all three images side by side
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
): Promise<void> {
  // Use the createDiffImageWithPath function with the default CHANGES_DIR
  await createDiffImageWithPath(oldImage, newImage, filename, CHANGES_DIR);
}

/**
 * Logs error to both console and error log file
 * @param message - Error message to log
 * @param error - Error object
 */
// deno-lint-ignore no-explicit-any
export function logError(message: string, error: any): void {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] ${message}: ${error}\n`;

  console.error(errorMessage);

  // Append to error log file
  fs.appendFileSync(ERROR_LOG_FILE, errorMessage);
}

/**
 * Transforms a URL by replacing its base domain with a new one.
 * @param originalUrl - The original URL to transform.
 * @param newBaseDomain - The new base domain to use.
 * @returns The transformed URL.
 */
export function transformUrl(
  originalUrl: string,
  newBaseDomain: string | null,
): string {
  if (!newBaseDomain) return originalUrl;
  try {
    const url = new URL(originalUrl);
    return originalUrl.replace(url.origin, `https://${newBaseDomain}`);
  } catch (error) {
    logError(`Error transforming URL ${originalUrl}`, error);
    return originalUrl;
  }
}

/**
 * Ensures the necessary directories exist
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
 * Creates a browser instance with security settings for testing
 * @returns A Promise that resolves to the browser instance
 */
export async function createTestBrowser() {
  // Check if BROWSERLESS_URL environment variable is set (for Docker)
  const browserlessUrl = process.env.BROWSERLESS_URL || 'ws://localhost:3000';
  const browserlessToken = process.env.BROWSERLESS_TOKEN || '6R0W53R135510';
  
  const wsEndpoint = `${browserlessUrl}?token=${browserlessToken}`;
  console.log(`Connecting to browserless at ${wsEndpoint}`);
  
  try {
    return await chromium.connectOverCDP(wsEndpoint);
  } catch (error) {
    console.error(`Failed to connect to browserless: ${error}`);
    throw error;
  }
}

/**
 * Saves screenshots for URL comparison
 * @param filename - Base filename to use for the screenshots
 * @param screenshot1 - Buffer of the first screenshot
 * @param screenshot2 - Buffer of the second screenshot
 * @returns Object containing paths to the saved screenshots
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
 * Logs the results of visual comparison
 * @param diffPixels - Number of pixels that differ between images
 * @param filename - Base filename used for the comparison
 * @param screenshot1Path - Path to the first screenshot
 * @param screenshot2Path - Path to the second screenshot
 */
export function logComparisonResults(
  diffPixels: number,
  filename: string,
  screenshot1Path: string,
  screenshot2Path: string,
): void {
  const diffPath = path.join(CHANGES_DIR, `${filename}_diff.png`);

  if (diffPixels > 0) {
    console.log(`Visual differences detected: ${diffPixels} pixels different`);
    console.log(`Comparison saved to ${diffPath}`);
  } else {
    console.log(`No visual differences detected`);
    console.log(`Comparison saved to ${diffPath}`);
  }

  console.log(
    `Screenshots saved to:\n1. ${screenshot1Path}\n2. ${screenshot2Path}`,
  );
}

/**
 * Performs a complete visual comparison of two URLs
 * @param url1 - The first URL to test
 * @param url2 - The second URL to test
 * @param viewportWidth - Optional width to use for both screenshots
 */
export async function performUrlComparison(
  url1: string,
  url2: string,
  viewportWidth: number = DEFAULT_VIEWPORT_WIDTH,
): Promise<void> {
  ensureDirectoriesExist();

  const browser = await createTestBrowser();

  try {
    const page = await browser.newPage();

    try {
      console.log(`Comparing URLs at viewport width ${viewportWidth}px:`);
      console.log(`1. ${url1}`);
      console.log(`2. ${url2}`);

      const filename = urlToFilename(url1);

      // Take screenshots of both URLs with the same width
      const screenshot1 = await takeScreenshot(page, url1, viewportWidth, true);
      const screenshot2 = await takeScreenshot(page, url2, viewportWidth, true);

      // Save both screenshots
      const { screenshot1Path, screenshot2Path } = saveComparisonScreenshots(
        filename,
        screenshot1,
        screenshot2,
      );

      // Compare screenshots
      const diffPixels = await compareScreenshots(
        screenshot1,
        screenshot2,
        true,
      );

      // Always create diff image regardless of pixel differences
      await createDiffImage(screenshot1, screenshot2, filename);

      // Log the results
      logComparisonResults(
        diffPixels,
        filename,
        screenshot1Path,
        screenshot2Path,
      );
    } catch (error) {
      logError(`Error comparing URLs`, error);
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
  }
}
