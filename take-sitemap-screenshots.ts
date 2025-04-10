import pLimit from "p-limit";
import * as cheerio from "cheerio";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";
import {
  takeScreenshot,
  urlToFilename,
  ensureDirectoriesExist,
  logError,
  SCREENSHOTS_DIR,
} from "./visual-testing-utils.ts";

// Reference Deno types for Deno.Command if used in this script
/// <reference types="https://deno.land/x/deno_node/v22.0.0/src/node/process.d.ts" />

const CONCURRENCY_LIMIT = 5;

/**
 * Fetches URLs from a sitemap.
 * @param sitemapUrl - The URL of the sitemap.
 * @returns A promise that resolves to an array of URLs.
 */
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    console.log(`Fetching sitemap from ${sitemapUrl}...`);

    // Use Deno.Command to use curl with SSL certificate bypass
    // Ensure this script is run with Deno and appropriate permissions (--allow-run)
    // @ts-ignore: Deno types might not be recognized by all editors
    const command = new Deno.Command("curl", {
      args: [
        "-k", // Ignore SSL certificate errors
        "-s", // Silent mode
        sitemapUrl,
      ],
    });

    // @ts-ignore: Deno types might not be recognized by all editors
    const { code, stdout, stderr } = await command.output();

    if (code !== 0) {
      const errorOutput = new TextDecoder().decode(stderr);
      console.error(
        `Failed to fetch sitemap. Exit code: ${code}. Error: ${errorOutput}`
      );
      logError(`Failed to fetch sitemap ${sitemapUrl}`, errorOutput);
      return [];
    }

    const data = new TextDecoder().decode(stdout);
    console.log("Received sitemap data, parsing...");

    const $ = cheerio.load(data, { xmlMode: true });
    const urls: string[] = [];

    // Try different selectors for different sitemap formats
    $("url loc, sitemap loc, urlset url loc").each((_, element) => {
      const loc = $(element).text().trim();
      if (loc) {
        urls.push(loc);
      }
    });

    // If the primary sitemap contains links to other sitemaps, fetch them recursively
    const sitemapLinks = $("sitemap > loc")
      .map((_, el) => $(el).text().trim())
      .get();
    if (sitemapLinks.length > 0 && urls.length === 0) {
      // Avoid infinite loops for malformed sitemaps referencing themselves
      console.log(
        `Found ${sitemapLinks.length} nested sitemaps. Fetching URLs from them...`
      );
      const nestedUrlsPromises = sitemapLinks.map((link) =>
        fetchSitemapUrls(link)
      );
      const nestedUrlsArrays = await Promise.all(nestedUrlsPromises);
      nestedUrlsArrays.forEach((nestedUrls) => urls.push(...nestedUrls));
    }

    if (urls.length === 0) {
      console.warn(`No URLs found in sitemap: ${sitemapUrl}`);
      console.log("Raw sitemap content sample:", data.substring(0, 500));
    } else {
      console.log(`Found ${urls.length} URLs in ${sitemapUrl}.`);
    }

    return urls;
  } catch (error) {
    logError(`Error fetching sitemap ${sitemapUrl}`, error);
    return [];
  }
}

/**
 * Takes a screenshot for a given URL and saves it.
 * @param url - The URL to take a screenshot of.
 */
async function takeAndSaveScreenshot(url: string): Promise<void> {
  try {
    const screenshotBuffer = await takeScreenshot(url);
    const filename = urlToFilename(url);
    const outputPath = path.join(SCREENSHOTS_DIR, `${filename}.png`);
    fs.writeFileSync(outputPath, screenshotBuffer);
    console.log(`Screenshot saved for ${url} at ${outputPath}`);
  } catch (error) {
    logError(`Failed to take or save screenshot for ${url}`, error);
    // Continue with other URLs even if one fails
  }
}

/**
 * Main function to run the screenshot process.
 * Sample run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env take-sitemap-screenshots.ts https://example.com/sitemap.xml
 */
async function main() {
  // Ensure environment variables are loaded if using a .env file
  // Example: await config({ export: true });

  if (!process.env.BASE_URL || !process.env.API_TOKEN) {
    console.error(
      "Error: BASE_URL and API_TOKEN environment variables are required."
    );
    console.log("Please set them directly or use a .env file.");
    process.exit(1);
  }

  const [sitemapUrl] = process.argv.slice(2);

  if (!sitemapUrl) {
    console.error("Please provide a sitemap URL as a command-line argument.");
    console.error(
      "Example: deno run --allow-all take-sitemap-screenshots.ts https://example.com/sitemap.xml"
    );
    process.exit(1);
  }

  console.log(`Starting screenshot process for sitemap: ${sitemapUrl}`);

  ensureDirectoriesExist(); // Ensures SCREENSHOTS_DIR exists
  const limit = pLimit(CONCURRENCY_LIMIT);

  try {
    const urlsFromSitemap = await fetchSitemapUrls(sitemapUrl);
    const uniqueUrls = [...new Set(urlsFromSitemap)]; // Remove duplicates

    if (uniqueUrls.length === 0) {
      console.error("No URLs found from the sitemap. Exiting.");
      process.exit(1);
    }

    console.log(
      `Found ${uniqueUrls.length} unique URLs. Taking screenshots with concurrency limit ${CONCURRENCY_LIMIT}...`
    );

    const tasks = uniqueUrls.map((url) =>
      limit(() => takeAndSaveScreenshot(url))
    );

    await Promise.all(tasks);
    console.log("Screenshot process completed.");
  } catch (error) {
    logError("An error occurred during the main process", error);
    process.exit(1);
  }
}

main().catch((error) => {
  logError("Unhandled error in main execution", error);
  process.exit(1);
});
