import * as cheerio from "cheerio";
import {
  getErrorMessage,
  type RetryOptions,
  withRetry,
} from "./visual-testing-utils.ts";

const DEFAULT_SITEMAP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_NESTED_DEPTH = 8;

export interface SitemapFetchOptions extends RetryOptions {
  timeoutMs?: number;
  maxUrls?: number;
  followNestedSitemaps?: boolean;
  maxNestedDepth?: number;
}

export interface ParsedSitemap {
  urls: string[];
  nestedSitemaps: string[];
}

function toAbsoluteUrl(urlCandidate: string, parentSitemapUrl: string): string {
  try {
    return new URL(urlCandidate, parentSitemapUrl).toString();
  } catch {
    return urlCandidate;
  }
}

export function parseSitemapXml(xmlContent: string): ParsedSitemap {
  const trimmed = xmlContent.trim();

  if (!trimmed.includes("<")) {
    throw new Error("Sitemap response is not valid XML.");
  }

  const $ = cheerio.load(trimmed, { xmlMode: true });
  const urls = new Set<string>();
  const nestedSitemaps = new Set<string>();

  $("url > loc, urlset > url > loc, urlset url loc").each((_, element) => {
    const loc = $(element).text().trim();
    if (loc) {
      urls.add(loc);
    }
  });

  $("sitemap > loc, sitemapindex > sitemap > loc").each((_, element) => {
    const loc = $(element).text().trim();
    if (loc) {
      nestedSitemaps.add(loc);
    }
  });

  if (urls.size === 0 && nestedSitemaps.size === 0) {
    throw new Error("No URLs or nested sitemaps found in sitemap XML.");
  }

  return {
    urls: [...urls],
    nestedSitemaps: [...nestedSitemaps],
  };
}

async function fetchSitemapContent(
  sitemapUrl: string,
  options: SitemapFetchOptions,
): Promise<string> {
  const timeoutMs = Math.max(
    1_000,
    options.timeoutMs ?? DEFAULT_SITEMAP_TIMEOUT_MS,
  );
  const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1_000));

  return await withRetry(
    async () => {
      const command = new Deno.Command("curl", {
        args: [
          "-k",
          "-sS",
          "--max-time",
          String(timeoutSeconds),
          sitemapUrl,
        ],
      });

      const { code, stdout, stderr } = await command.output();

      if (code !== 0) {
        const stderrText = new TextDecoder().decode(stderr).trim();
        throw new Error(
          `Failed to fetch sitemap ${sitemapUrl}: ${
            stderrText || `curl exited with code ${code}`
          }`,
        );
      }

      const xmlContent = new TextDecoder().decode(stdout);
      if (!xmlContent.trim()) {
        throw new Error(`Empty sitemap response from ${sitemapUrl}`);
      }

      return xmlContent;
    },
    options,
    `fetchSitemap(${sitemapUrl})`,
  );
}

async function collectSitemapUrls(
  sitemapUrl: string,
  options: SitemapFetchOptions,
  visitedSitemaps: Set<string>,
  currentDepth: number,
): Promise<string[]> {
  const maxDepth = Math.max(
    0,
    options.maxNestedDepth ?? DEFAULT_MAX_NESTED_DEPTH,
  );
  const followNestedSitemaps = options.followNestedSitemaps ?? true;

  if (visitedSitemaps.has(sitemapUrl)) {
    return [];
  }

  if (currentDepth > maxDepth) {
    console.warn(
      `Skipping nested sitemap ${sitemapUrl} because max depth (${maxDepth}) was reached.`,
    );
    return [];
  }

  visitedSitemaps.add(sitemapUrl);
  console.log(`Fetching sitemap from ${sitemapUrl}...`);

  let content: string;
  try {
    content = await fetchSitemapContent(sitemapUrl, options);
  } catch (error) {
    console.error(
      `Unable to fetch sitemap ${sitemapUrl}: ${getErrorMessage(error)}`,
    );
    return [];
  }

  let parsed: ParsedSitemap;
  try {
    parsed = parseSitemapXml(content);
  } catch (error) {
    console.error(
      `Unable to parse sitemap ${sitemapUrl}: ${getErrorMessage(error)}`,
    );
    return [];
  }

  const urls: string[] = parsed.urls.map((url) =>
    toAbsoluteUrl(url, sitemapUrl)
  );

  if (!followNestedSitemaps || parsed.nestedSitemaps.length === 0) {
    return urls;
  }

  for (const nestedSitemap of parsed.nestedSitemaps) {
    const nestedSitemapUrl = toAbsoluteUrl(nestedSitemap, sitemapUrl);
    const nestedUrls = await collectSitemapUrls(
      nestedSitemapUrl,
      options,
      visitedSitemaps,
      currentDepth + 1,
    );
    urls.push(...nestedUrls);
  }

  return urls;
}

/**
 * Fetches and parses a sitemap (and nested sitemap indexes) into a de-duplicated URL list.
 */
export async function fetchSitemapUrls(
  sitemapUrl: string,
  options: SitemapFetchOptions = {},
): Promise<string[]> {
  const visitedSitemaps = new Set<string>();
  const urls = await collectSitemapUrls(
    sitemapUrl,
    options,
    visitedSitemaps,
    0,
  );
  const uniqueUrls = [...new Set(urls)];

  if (uniqueUrls.length === 0) {
    console.warn(`No URLs discovered from sitemap ${sitemapUrl}.`);
    return [];
  }

  if (options.maxUrls && options.maxUrls > 0) {
    return uniqueUrls.slice(0, options.maxUrls);
  }

  return uniqueUrls;
}
