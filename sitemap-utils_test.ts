import { parseSitemapXml } from "./sitemap-utils.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals<T>(actual: T, expected: T): void {
  const actualSerialized = JSON.stringify(actual);
  const expectedSerialized = JSON.stringify(expected);
  assert(
    actualSerialized === expectedSerialized,
    `Expected ${expectedSerialized}, got ${actualSerialized}`,
  );
}

Deno.test("parseSitemapXml parses urlset loc entries", () => {
  const xml = `
<?xml version="1.0" encoding="UTF-8"?>
<urlset>
  <url><loc>https://example.com/a</loc></url>
  <url><loc>https://example.com/b</loc></url>
</urlset>`;

  const parsed = parseSitemapXml(xml);

  assertEquals(parsed.urls, ["https://example.com/a", "https://example.com/b"]);
  assertEquals(parsed.nestedSitemaps, []);
});

Deno.test("parseSitemapXml parses sitemap index loc entries", () => {
  const xml = `
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex>
  <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;

  const parsed = parseSitemapXml(xml);

  assertEquals(parsed.urls, []);
  assertEquals(parsed.nestedSitemaps, [
    "https://example.com/sitemap-1.xml",
    "https://example.com/sitemap-2.xml",
  ]);
});

Deno.test("parseSitemapXml throws on invalid xml input", () => {
  let threw = false;

  try {
    parseSitemapXml("not xml");
  } catch {
    threw = true;
  }

  assert(threw, "Expected parseSitemapXml to throw for invalid XML input");
});
