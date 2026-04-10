import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const feedsPath = new URL("../config/feeds.json", import.meta.url);
const outputPath = new URL("../data/news.json", import.meta.url);
const malayalamPattern = /[\u0D00-\u0D7F]/u;

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const config = JSON.parse(await readFile(feedsPath, "utf8"));
  const enabledFeeds = config.filter((feed) => feed.enabled !== false);

  if (enabledFeeds.length === 0) {
    await writeNews([]);
    console.log("No enabled feeds. Wrote an empty data/news.json file.");
    return;
  }

  const results = await Promise.allSettled(enabledFeeds.map((feed) => fetchFeed(feed)));
  const collected = [];
  let failures = 0;

  results.forEach((result, index) => {
    const feed = enabledFeeds[index];
    if (result.status === "fulfilled") {
      collected.push(...result.value);
      console.log(`Fetched ${result.value.length} items from ${feed.name}.`);
      return;
    }

    failures += 1;
    console.warn(`Failed to fetch ${feed.name}: ${result.reason.message}`);
  });

  const normalized = sortAndDeduplicate(collected);
  if (normalized.length === 0) {
    const existing = await readExistingNews();
    if (existing) {
      console.warn("No new items could be generated. Preserving the existing data/news.json file.");
      return;
    }

    console.warn("No items were generated. Writing an empty data/news.json file.");
  }

  await writeNews(normalized);
  console.log(`Saved ${normalized.length} normalized items from ${enabledFeeds.length - failures} feeds.`);
}

async function fetchFeed(feed) {
  const response = await fetch(feed.url, {
    headers: {
      "accept": "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "user-agent": "NewsDeskBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const xml = await response.text();
  const blocks = extractBlocks(xml, feed.parserHints?.itemTags || ["item", "entry"]);
  return blocks.map((block) => normalizeItem(block, feed)).filter(Boolean);
}

function normalizeItem(block, feed) {
  const title = cleanText(extractTagValue(block, feed.parserHints?.titleTags || ["title"]));
  const summarySource =
    extractTagValue(block, feed.parserHints?.summaryTags || ["description", "summary", "content:encoded", "content"]) || "";
  const summary = trimSummary(cleanText(summarySource));
  const url = extractLink(block, feed);
  const publishedAt = normalizeDate(
    extractTagValue(block, feed.parserHints?.publishedTags || ["pubDate", "published", "updated", "dc:date"]),
  );
  const image = extractImage(block, summarySource);
  const language = detectLanguage(title, summary, feed.defaultLanguage);

  if (!title || !url) {
    return null;
  }

  return {
    id: buildId(url),
    title,
    summary,
    url,
    source: feed.source || deriveSourceName(feed.name, feed.category),
    category: feed.category,
    language,
    publishedAt,
    image: image || null,
    hasImage: Boolean(image),
  };
}

function extractBlocks(xml, preferredTags) {
  for (const tag of preferredTags) {
    const pattern = new RegExp(`<${escapeRegex(tag)}\\b[\\s\\S]*?<\\/${escapeRegex(tag)}>`, "gi");
    const matches = xml.match(pattern);
    if (matches && matches.length > 0) {
      return matches;
    }
  }

  return [];
}

function extractTagValue(block, tags) {
  for (const tag of tags) {
    const pattern = new RegExp(`<${escapeRegex(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeRegex(tag)}>`, "i");
    const match = block.match(pattern);
    if (match) {
      return unwrapCdata(match[1]);
    }
  }

  return "";
}

function extractLink(block, feed) {
  const directLink = cleanUrl(extractTagValue(block, feed.parserHints?.linkTags || ["link", "guid"]));
  if (directLink && /^https?:/i.test(directLink)) {
    return directLink;
  }

  const atomLink = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (atomLink) {
    return cleanUrl(atomLink[1]);
  }

  return "";
}

function extractImage(block, summaryHtml) {
  const mediaMatch = block.match(/<media:content\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (mediaMatch) {
    return cleanUrl(mediaMatch[1]);
  }

  const enclosureMatch = block.match(/<enclosure\b[^>]*url=["']([^"']+)["'][^>]*>/i);
  if (enclosureMatch) {
    return cleanUrl(enclosureMatch[1]);
  }

  const imageMatch = summaryHtml.match(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/i);
  if (imageMatch) {
    return cleanUrl(imageMatch[1]);
  }

  return "";
}

function detectLanguage(title, summary, defaultLanguage) {
  if (malayalamPattern.test(title) || malayalamPattern.test(summary)) {
    return "ml";
  }

  if (title || summary) {
    return "en";
  }

  return defaultLanguage || "en";
}

function cleanText(value) {
  if (!value) {
    return "";
  }

  return decodeEntities(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function trimSummary(value) {
  if (!value) {
    return "";
  }

  const maxLength = 220;
  if (value.length <= maxLength) {
    return value;
  }

  const trimmed = value.slice(0, maxLength);
  const lastSpace = trimmed.lastIndexOf(" ");
  return `${trimmed.slice(0, lastSpace > 120 ? lastSpace : maxLength).trim()}...`;
}

function normalizeDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function buildId(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 16);
}

function deriveSourceName(name, category) {
  const pattern = new RegExp(`\\s+${escapeRegex(category)}$`, "i");
  return name.replace(pattern, "").trim() || name;
}

function sortAndDeduplicate(items) {
  const seen = new Set();
  return items
    .filter((item) => {
      if (seen.has(item.url)) {
        return false;
      }

      seen.add(item.url);
      return true;
    })
    .sort((left, right) => {
      const leftTime = left.publishedAt ? new Date(left.publishedAt).getTime() : 0;
      const rightTime = right.publishedAt ? new Date(right.publishedAt).getTime() : 0;
      return rightTime - leftTime;
    });
}

function cleanUrl(value) {
  return decodeEntities((value || "").trim());
}

function unwrapCdata(value) {
  return value.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readExistingNews() {
  try {
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    return Array.isArray(existing) ? existing : null;
  } catch {
    return null;
  }
}

async function writeNews(items) {
  await mkdir(new URL("../data/", import.meta.url), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}
