# News Desk

News Desk is a very lightweight personal news website and PWA for Malayalam, Kerala, India, and world headlines. It is static-first, text-first, mobile-first, and designed to deploy cleanly on GitHub Pages without browser-side RSS fetching.

Live GitHub Pages URL:

- `https://anoopsimon.github.io/newshub/`

## Project overview

The site reads a single generated file, `data/news.json`, and renders it with plain HTML, CSS, and vanilla JavaScript. RSS ingestion happens in a build/update script so the frontend stays fast, static, and GitHub Pages friendly.

## Features

- Lightweight editorial layout with a mobile-first reading experience
- Tabs for All, Malayalam, Kottayam, Trivandrum, Kochi, Focus, Kerala, India, World, and Saved
- Strict Malayalam filtering using normalized `language === "ml"`
- Images never load by default; users must tap `Load image`
- Read and saved states stored locally with `localStorage`
- Inline article reader using an iframe, with external open fallback when a publisher blocks embedding
- Red and blue themes using CSS variables
- PWA support with `manifest.json` and a service worker
- Zero runtime dependencies for the frontend and feed pipeline
- Tiny local server and small BusyBox-based Docker image

## Architecture

- `config/feeds.json`: source-of-truth feed configuration
- `scripts/fetch-news.mjs`: fetches RSS, parses entries, cleans content, normalizes output
- `data/news.json`: static generated news dataset used by the frontend
- `index.html`, `styles.css`, `app.js`: static UI
- `sw.js`, `manifest.json`: PWA assets
- `.github/workflows/fetch-news.yml`: scheduled/manual GitHub Pages deployment

## Feed config explanation

Every feed lives in `config/feeds.json` as a single object. The fetch script iterates the enabled feed list automatically and applies the same normalization flow to every source.

Each feed object supports:

- `id`
- `name`
- `url`
- `category`
- `defaultLanguage`
- `enabled`
- optional `source`
- optional `parserHints`

`parserHints` is available for feed-specific XML variations without changing the core script. Supported hint groups are `itemTags`, `titleTags`, `summaryTags`, `linkTags`, and `publishedTags`.

Current seeded feeds include:

- Onmanorama Kerala
- OneIndia Malayalam news
- OneIndia Kottayam
- OneIndia Trivandrum
- OneIndia Kochi
- OneIndia Focus

## How to add a new RSS feed

Add one object to `config/feeds.json` and nothing else.

Example:

```json
{
  "id": "example-world",
  "name": "Example World",
  "url": "https://example.com/rss.xml",
  "category": "World",
  "defaultLanguage": "en",
  "enabled": true
}
```

Then run:

```bash
npm run fetch:news
```

No frontend logic, rendering code, filters, or script internals need to change.

## Feed ingestion flow

1. The script reads `config/feeds.json`.
2. It fetches each enabled RSS feed.
3. It extracts feed items and normalizes them into a shared schema.
4. It detects Malayalam with the Unicode range `\u0D00-\u0D7F`.
5. It extracts an optional image using this priority:
   1. `media:content`
   2. `enclosure`
   3. first `<img>` in description HTML
6. It strips HTML, truncates summaries, deduplicates by URL, sorts newest first, and writes `data/news.json`.

OneIndia feed note:

- The current Malayalam OneIndia feed URL used by this project is `https://malayalam.oneindia.com/rss/feeds/malayalam-news-fb.xml`.
- If OneIndia changes its RSS path again later, only `config/feeds.json` needs to be updated.

## Why static JSON is used instead of direct browser RSS fetching

GitHub Pages cannot safely rely on live browser RSS requests because browser-side feed fetching is commonly blocked by CORS and inconsistent feed server policies. Generating one static JSON file ahead of time keeps the frontend simple, fast, cacheable, and production-safe.

## Local run steps

Requirements:

- Node.js 18 or newer

Generate or refresh news data:

```bash
npm run fetch:news
```

Start the tiny static server:

```bash
npm start
```

Open `http://127.0.0.1:8080`.

## Docker steps

Build the image:

```bash
docker build -t news-desk .
```

Run the container:

```bash
docker run --rm -p 8080:8080 news-desk
```

Open `http://127.0.0.1:8080`.

## GitHub Pages deployment steps

1. Push the project to a GitHub repository.
2. In GitHub, open `Settings > Pages`.
3. Set `Source` to `GitHub Actions`.
4. Ensure the default branch is `main`, or adjust the workflow trigger if you use another branch.
5. Run the workflow manually once with `workflow_dispatch` to create the first deployment if you do not want to wait for the next scheduled run.

Expected published URL:

- `https://anoopsimon.github.io/newshub/`

The workflow:

- fetches and normalizes RSS data
- commits `data/news.json` back to the repository only when it changed
- skips commit and deployment when scheduled/manual runs produce no content change
- deploys the static site through GitHub Pages Actions

## Schedule customization

Edit the `cron` entry in `.github/workflows/fetch-news.yml`.

- Every 15 minutes: `*/15 * * * *`
- Every 30 minutes: `*/30 * * * *`
- Every hour: `0 * * * *`
- Every 3 hours: `0 */3 * * *`

## Limitations

- This environment could not reach the seed RSS feeds while generating the project, so `data/news.json` is committed as an empty array by default.
- The XML parser is intentionally lightweight and regex-based to avoid dependencies. It is designed for common RSS/Atom structures, not every edge case in the wild.
- iPhone home-screen support is intentionally minimal and avoids Apple-specific extras beyond standard manifest/meta support.
- Read and saved state is local to one browser and device.
- Some publishers block iframe embedding with response headers. In those cases the inline reader may appear blank and `Open source` should be used instead.

## Future enhancements

- Add more Kerala, India, and world feeds through `config/feeds.json`
- Add a `source` filter or source badges rail
- Add a manual refresh timestamp in the generated JSON
- Add optional offline article snapshotting for saved stories
- Generate dedicated PNG app icons if stronger iPhone install branding is needed
