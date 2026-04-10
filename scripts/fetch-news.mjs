import crypto from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";

const feedsPath = new URL("../config/feeds.json", import.meta.url);
const outputPath = new URL("../data/news.json", import.meta.url);
const articlesDir = new URL("../data/articles/", import.meta.url);
const malayalamPattern = /[\u0D00-\u0D7F]/u;
const retentionHours = 48;

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

  const normalized = filterRecentItems(sortAndDeduplicate(collected), retentionHours);
  await enrichArticleContent(normalized, enabledFeeds);
  if (normalized.length === 0) {
    const existing = await readExistingNews();
    if (existing) {
      console.warn("No new items could be generated. Preserving the existing data/news.json file.");
      return;
    }

    console.warn("No items were generated. Writing an empty data/news.json file.");
  }

  await writeArticleFiles(normalized);
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
    _feedId: feed.id,
    title,
    summary,
    url,
    source: feed.source || deriveSourceName(feed.name, feed.category),
    category: feed.category,
    language,
    publishedAt,
    image: image || null,
    hasImage: Boolean(image),
    content: null,
  };
}

async function enrichArticleContent(items, feeds) {
  const feedMap = new Map(feeds.map((feed) => [feed.id, feed]));
  const queue = [];
  const perFeedCounts = new Map();

  for (const item of items) {
    const feed = feedMap.get(item._feedId);
    const articleContent = feed?.articleContent;
    if (!articleContent?.enabled) {
      continue;
    }

    const seenCount = perFeedCounts.get(feed.id) || 0;
    const maxItems = articleContent.maxItems || 0;
    if (maxItems > 0 && seenCount >= maxItems) {
      continue;
    }

    perFeedCounts.set(feed.id, seenCount + 1);
    queue.push({ item, feed });
  }

  for (const entry of queue) {
    try {
      entry.item.content = await fetchArticleContent(entry.item.url, entry.feed.articleContent);
    } catch (error) {
      console.warn(`Failed to fetch article body for ${entry.item.url}: ${error.message}`);
    }
  }

  for (const item of items) {
    delete item._feedId;
  }
}

async function fetchArticleContent(url, articleContent) {
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "user-agent": "NewsDeskBot/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const html = await response.text();
  const content = extractArticleContent(html, articleContent);
  return content ? trimContent(content) : null;
}

function extractArticleContent(html, articleContent) {
  if (articleContent.strategy === "jsonLdArticleBody") {
    return extractJsonLdArticleBody(html);
  }

  return null;
}

function extractJsonLdArticleBody(html) {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of scripts) {
    const json = parseJson(match[1]);
    const body = findArticleBody(json);
    if (body) {
      return body;
    }
  }

  return null;
}

function findArticleBody(value) {
  if (!value) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const body = findArticleBody(entry);
      if (body) {
        return body;
      }
    }
    return null;
  }

  if (typeof value === "object") {
    const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (type.some((entry) => typeof entry === "string" && /Article$/i.test(entry)) && typeof value.articleBody === "string") {
      return cleanText(value.articleBody);
    }

    if (value["@graph"]) {
      const body = findArticleBody(value["@graph"]);
      if (body) {
        return body;
      }
    }

    for (const nested of Object.values(value)) {
      const body = findArticleBody(nested);
      if (body) {
        return body;
      }
    }
  }

  return null;
}

function parseJson(value) {
  try {
    return JSON.parse(value.trim());
  } catch {
    return null;
  }
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

function trimContent(value) {
  if (!value) {
    return "";
  }

  const normalized = value.replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalized.length <= 4000) {
    return normalized;
  }

  const clipped = normalized.slice(0, 4000);
  const lastBreak = Math.max(clipped.lastIndexOf("\n\n"), clipped.lastIndexOf(". "));
  return `${clipped.slice(0, lastBreak > 2000 ? lastBreak : 4000).trim()}...`;
}

function filterRecentItems(items, hours) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return items.filter((item) => {
    if (!item.publishedAt) {
      return true;
    }

    const time = new Date(item.publishedAt).getTime();
    return Number.isFinite(time) && time >= cutoff;
  });
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

async function writeArticleFiles(items) {
  await rm(articlesDir, { recursive: true, force: true });
  await mkdir(articlesDir, { recursive: true });

  for (const item of items) {
    if (!item.content) {
      item.hasArticleContent = false;
      item.articlePath = null;
      delete item.content;
      continue;
    }

    const articleFileName = `${item.id}.json`;
    const articlePath = new URL(articleFileName, articlesDir);
    const articlePayload = {
      id: item.id,
      url: item.url,
      title: item.title,
      source: item.source,
      publishedAt: item.publishedAt,
      content: item.content,
    };

    await writeFile(articlePath, `${JSON.stringify(articlePayload, null, 2)}\n`, "utf8");
    item.hasArticleContent = true;
    item.articlePath = `data/articles/${articleFileName}`;
    delete item.content;
  }
}
