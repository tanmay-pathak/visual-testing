import * as cheerio from "cheerio";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import pLimit from "p-limit";
import process from "node:process";
import { logError } from "./visual-testing-utils.ts";

const execAsync = promisify(exec);
const CONCURRENCY_LIMIT = 5;

/**
 * Fetches URLs from a sitemap.
 * @param sitemapUrl - The URL of the sitemap.
 * @returns A promise that resolves to an array of URLs.
 */
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    console.log(`Fetching sitemap from ${sitemapUrl}...`);

    // Use curl to fetch the sitemap content
    const { stdout, stderr } = await execAsync(`curl -k -s "${sitemapUrl}"`);

    if (stderr) {
      console.error(`Error fetching sitemap: ${stderr}`);
      return [];
    }

    console.log("Received sitemap data, parsing...");

    const $ = cheerio.load(stdout, { xmlMode: true });
    const urls: string[] = [];

    // Try different selectors for different sitemap formats
    $("url loc, sitemap loc, urlset url").each((_, element) => {
      const loc = $(element).text().trim();
      if (loc) {
        urls.push(loc);
      }
    });

    if (urls.length === 0) {
      console.log(
        "No URLs found in sitemap. Raw content:",
        stdout.substring(0, 200) + "..."
      );
    } else {
      console.log(`Found ${urls.length} URLs in sitemap.`);
    }

    return urls;
  } catch (error) {
    console.error(`Error fetching sitemap:`, error);
    return [];
  }
}

/**
 * Opens a URL in Safari browser
 * @param url - The URL to open
 */
async function openUrlInSafari(url: string): Promise<void> {
  try {
    console.log(`Opening URL in Safari: ${url}`);
    await execAsync(`open -a Safari "${url}"`);

    // Add a small delay to prevent overwhelming the system
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    logError(`Error opening URL in Safari: ${url}`, error);
  }
}

/**
 * Main function to open URLs from a sitemap in Safari
 * Usage: deno --allow-all open-sitemap-urls.ts https://followingtheirvoices.ca/sitemap.xml
 */
async function main() {
  const sitemapUrl = process.argv[2];

  if (!sitemapUrl) {
    console.error("Please provide a sitemap URL as a command-line argument.");
    console.error(
      "Usage: deno --allow-all open-sitemap-urls.ts https://followingtheirvoices.ca/sitemap.xml"
    );
    process.exit(1);
  }

  try {
    const urls = await fetchSitemapUrls(sitemapUrl);

    if (urls.length === 0) {
      console.error("No URLs found in the sitemap.");
      process.exit(1);
    }

    // Ask for confirmation before opening many URLs
    if (urls.length > 10) {
      console.log(`Warning: About to open ${urls.length} URLs in Safari.`);
      console.log("Press Ctrl+C to cancel or wait 5 seconds to continue...");

      // Wait 5 seconds to allow cancellation
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Limit concurrent browser opens to avoid overwhelming the system
    const limit = pLimit(CONCURRENCY_LIMIT);
    const tasks = urls.map((url) => limit(() => openUrlInSafari(url)));

    await Promise.all(tasks);
    console.log("All URLs have been opened in Safari.");
  } catch (error) {
    console.error("Error in main process:", error);
  }
}

main().catch(console.error);
