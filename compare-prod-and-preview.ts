import { Browser } from "@playwright/test";
import pLimit from "p-limit";
import * as cheerio from "cheerio";
import process from "node:process";
import {
  compareScreenshots,
  createDiffImage,
  createTestBrowser,
  ensureDirectoriesExist,
  saveComparisonScreenshots,
  takeScreenshot,
  transformUrl,
  urlToFilename,
} from "./visual-testing-utils.ts";

const CONCURRENCY_LIMIT = 20;

/**
 * Fetches URLs from a sitemap.
 * @param sitemapUrl - The URL of the sitemap.
 * @returns A promise that resolves to an array of URLs.
 */
async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    console.log(`Fetching sitemap from ${sitemapUrl}...`);

    // Use Deno.Command to use curl with SSL certificate bypass
    // @ts-expect-error: Deno stuff.
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
        `Failed to fetch sitemap. Error: ${new TextDecoder().decode(stderr)}`
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
 * Runs a visual test comparing production and preview environments for a given URL.
 * @param prodUrl - The production URL to test.
 * @param previewDomain - The preview domain to compare against.
 * @param browser - The Playwright browser instance.
 */
async function runVisualTest(
  prodUrl: string,
  previewDomain: string,
  browser: Browser
) {
  const prodPage = await browser.newPage();
  const previewPage = await browser.newPage();

  try {
    const filename = urlToFilename(prodUrl);
    const previewUrl = transformUrl(prodUrl, previewDomain);

    const [prodScreenshot, previewScreenshot] = await Promise.all([
      takeScreenshot(prodPage, prodUrl),
      takeScreenshot(previewPage, previewUrl),
    ]);

    saveComparisonScreenshots(
      filename,
      prodScreenshot,
      previewScreenshot
    );

    // Compare screenshots
    const diffPixels = await compareScreenshots(
      prodScreenshot,
      previewScreenshot
    );

    // Create diff image only if differences are detected
    if (diffPixels > 0) {
      await createDiffImage(prodScreenshot, previewScreenshot, filename);
      console.log(
        `Visual changes detected between prod and preview for ${prodUrl}: ${diffPixels} pixels different`
      );
    }
  } catch (error) {
    console.error(`Error running visual test for ${prodUrl}:`, error);
  } finally {
    await Promise.all([prodPage.close(), previewPage.close()]);
  }
}

/**
 * Main function to run the visual tests.
 * Sample run: deno --allow-read --allow-env --allow-sys --allow-ffi --allow-write --allow-run --allow-net compare-prod-and-preview.ts https://zu.com/sitemap-0.xml deploy-preview-320--zuc-web.netlify.app
 */
async function main() {
  const [sitemapUrl, previewDomain] = process.argv.slice(2);

  if (!sitemapUrl) {
    console.error("Please provide a sitemap URL as a command-line argument.");
    process.exit(1);
  }

  ensureDirectoriesExist();

  const browser = await createTestBrowser();
  const limit = pLimit(CONCURRENCY_LIMIT);

  try {
    const urlsFromSitemap = await fetchSitemapUrls(sitemapUrl);
    const uniqueUrls = [...new Set(urlsFromSitemap)];

    const tasks = uniqueUrls.map((url) =>
      limit(() => runVisualTest(url, previewDomain, browser))
    );
    await Promise.all(tasks);
  } catch (error) {
    console.error(`Error running visual tests:`, error);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
