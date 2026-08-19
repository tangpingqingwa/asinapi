import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Product, ProductBsr } from "../../types.js";
import type { AdapterResult, ProductAdapter } from "../types.js";

export const DEFAULT_FIXTURE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures",
);

export const DEFAULT_HTML_DIR = join(DEFAULT_FIXTURE_DIR, "html");

const MAX_IMAGES = 10;
const DEFAULT_FETCHED_AT = "2026-01-15T12:00:00.000Z";

type FixtureIndex = {
  htmlByAsin: Map<string, string>;
  shortToAsin: Map<string, string>;
};

export type FixtureAdapterOptions = {
  dir?: string;
  htmlDir?: string;
};

export function createFixtureAdapter(
  options: FixtureAdapterOptions = {},
): ProductAdapter {
  const index = loadFixtureIndex(
    options.dir ?? DEFAULT_FIXTURE_DIR,
    options.htmlDir ?? DEFAULT_HTML_DIR,
  );
  return {
    resolveShortCode(code: string): string | null {
      return index.shortToAsin.get(code) ?? null;
    },
    async fetchProduct(request): Promise<AdapterResult> {
      const html = index.htmlByAsin.get(request.asin);
      if (html === undefined) {
        return { ok: false, code: "product_unavailable" };
      }
      return parseProductHtml(request.asin, html);
    },
  };
}

export function loadFixtureIndex(dir: string, htmlDir: string): FixtureIndex {
  const htmlByAsin = new Map<string, string>();
  const shortToAsin = new Map<string, string>();

  const htmlFiles = readdirSync(htmlDir)
    .filter((name) => name.endsWith(".html"))
    .sort();
  for (const file of htmlFiles) {
    const asin = file.replace(/\.html$/, "").toUpperCase();
    if (htmlByAsin.has(asin)) {
      throw new Error(`duplicate fixture HTML for ${asin}`);
    }
    htmlByAsin.set(asin, readFileSync(join(htmlDir, file), "utf8"));
  }

  const shortPath = join(dir, "short-links.json");
  const raw: unknown = JSON.parse(readFileSync(shortPath, "utf8"));
  if (!isRecord(raw)) {
    throw new Error("short-links.json must be an object");
  }
  for (const [code, asin] of Object.entries(raw)) {
    if (typeof asin !== "string") {
      throw new Error(`short-links.json ${code} must be an ASIN string`);
    }
    if (shortToAsin.has(code)) {
      throw new Error(`duplicate short code ${code}`);
    }
    shortToAsin.set(code, asin.toUpperCase());
  }

  return { htmlByAsin, shortToAsin };
}

export function parseProductHtml(asin: string, html: string): AdapterResult {
  if (isBlocked(html)) {
    return { ok: false, code: "upstream_blocked" };
  }
  if (isUnavailablePage(html)) {
    return { ok: false, code: "product_unavailable" };
  }

  const title = textById(html, "productTitle");
  if (title === null || title === "") {
    return { ok: false, code: "product_unavailable" };
  }

  const images = extractImages(html);
  const price = extractPrice(html);
  const rating = extractRating(html);
  const bullets = extractBullets(html);
  const description = textById(html, "productDescription");
  const categoryPath = extractCategoryPath(html);
  const bsr = extractBsr(html);
  const attributes = extractAttributes(html);
  const brand = extractBrand(html);
  const fetchedAt =
    metaContent(html, "asinapi-fetched-at") ?? DEFAULT_FETCHED_AT;

  const product: Product = {
    asin,
    marketplace: "US",
    title,
    brand,
    url: `https://www.amazon.com/dp/${asin}`,
    images: images.slice(0, MAX_IMAGES),
    price,
    rating,
    bullets,
    description,
    categoryPath,
    bsr,
    attributes,
    fetchedAt,
  };
  return { ok: true, product };
}

function isBlocked(html: string): boolean {
  return (
    /id=["']captchacharacters["']/i.test(html) ||
    /name=["']asinapi-blocked["']/i.test(html) ||
    /enter the characters you see below/i.test(html)
  );
}

function isUnavailablePage(html: string): boolean {
  return (
    /asinapi:unavailable/i.test(html) ||
    /name=["']asinapi-unavailable["']/i.test(html) ||
    /sorry!\s*we couldn't find that page/i.test(html) ||
    /id=["']g["'][\s\S]*alt=["']dogs of amazon/i.test(html)
  );
}

function extractBrand(html: string): string | null {
  const raw = textById(html, "bylineInfo");
  if (raw === null || raw === "") {
    return null;
  }
  return raw
    .replace(/^brand:\s*/i, "")
    .replace(/^visit the\s+/i, "")
    .replace(/\s+store$/i, "")
    .trim() || null;
}

function extractImages(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (url: string | null): void => {
    if (url === null || url === "" || seen.has(url)) {
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      return;
    }
    seen.add(url);
    urls.push(url);
  };

  const landing = tagById(html, "landingImage");
  if (landing !== null) {
    push(attr(landing, "data-old-hires"));
    push(attr(landing, "src"));
  }

  const imgRe = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = imgRe.exec(html)) !== null) {
    const tag = match[0];
    if (/id=["']landingImage["']/i.test(tag) || /class=["'][^"']*a-dynamic-image/i.test(tag)) {
      push(attr(tag, "data-old-hires"));
      push(attr(tag, "src"));
    }
  }
  return urls;
}

function extractPrice(html: string): Product["price"] {
  const availability = textById(html, "availability") ?? "";
  const unavailable =
    /currently unavailable/i.test(availability) ||
    /name=["']asinapi-out-of-stock["']/i.test(html);

  const offscreen = firstMatch(
    html,
    /<span[^>]*class=["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  const block = textById(html, "priceblock_ourprice");
  const displayRaw = decode(offscreen ?? block ?? "");
  const parsed = parseUsd(displayRaw);

  if (unavailable) {
    return {
      amount: null,
      currency: "USD",
      display: parsed.display,
      unavailable: true,
    };
  }
  return {
    amount: parsed.amount,
    currency: "USD",
    display: parsed.display,
    unavailable: false,
  };
}

function parseUsd(display: string): { amount: number | null; display: string | null } {
  const trimmed = display.trim();
  if (trimmed === "") {
    return { amount: null, display: null };
  }
  const match = /\$([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.([0-9]{2}))?/.exec(trimmed);
  if (match === null || match[1] === undefined) {
    return { amount: null, display: trimmed };
  }
  const whole = match[1].replace(/,/g, "");
  const cents = match[2] ?? "00";
  const amount = Number(`${whole}.${cents}`);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    display: trimmed,
  };
}

function extractRating(html: string): Product["rating"] {
  const popover = tagById(html, "acrPopover");
  const titleAttr = popover === null ? null : attr(popover, "title");
  const averageMatch =
    titleAttr === null ? null : /([0-9]+(?:\.[0-9]+)?)\s+out of 5/i.exec(titleAttr);
  const countText = textById(html, "acrCustomerReviewText") ?? "";
  const countMatch = /([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)\s+ratings?/i.exec(countText);
  return {
    average:
      averageMatch?.[1] !== undefined ? Number(averageMatch[1]) : null,
    count:
      countMatch?.[1] !== undefined
        ? Number(countMatch[1].replace(/,/g, ""))
        : null,
  };
}

function extractBullets(html: string): string[] {
  const block = innerById(html, "feature-bullets");
  if (block === null) {
    return [];
  }
  const bullets: string[] = [];
  const itemRe = /<span[^>]*class=["'][^"']*a-list-item[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(block)) !== null) {
    const text = decode(match[1] ?? "");
    if (text === "" || /see more product details/i.test(text)) {
      continue;
    }
    bullets.push(text);
  }
  return bullets;
}

function extractCategoryPath(html: string): string[] {
  const block = innerById(html, "wayfinding-breadcrumbs_feature_div");
  if (block === null) {
    return [];
  }
  const path: string[] = [];
  const linkRe = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(block)) !== null) {
    const text = decode(match[1] ?? "");
    if (text === "" || /back to results/i.test(text)) {
      continue;
    }
    path.push(text);
  }
  return path;
}

function extractBsr(html: string): ProductBsr[] | null {
  const list: ProductBsr[] = [];
  const dataRe =
    /<li\b[^>]*data-rank=["']([0-9]+)["'][^>]*data-category=["']([^"']+)["'][^>]*>/gi;
  let dataMatch: RegExpExecArray | null;
  while ((dataMatch = dataRe.exec(html)) !== null) {
    if (dataMatch[1] === undefined || dataMatch[2] === undefined) {
      continue;
    }
    list.push({ rank: Number(dataMatch[1]), category: decode(dataMatch[2]) });
  }
  if (list.length > 0) {
    return list;
  }

  const rankBlock = textById(html, "SalesRank") ?? "";
  const visible = /#([0-9]{1,3}(?:,[0-9]{3})*)\s+in\s+([^(\n]+)/.exec(rankBlock);
  if (visible?.[1] === undefined || visible[2] === undefined) {
    return null;
  }
  return [
    {
      rank: Number(visible[1].replace(/,/g, "")),
      category: visible[2].trim(),
    },
  ];
}

function extractAttributes(html: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const rowRe = /<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html)) !== null) {
    const key = decode(match[1] ?? "");
    const value = decode(match[2] ?? "");
    if (key === "" || value === "") {
      continue;
    }
    attributes[key] = value;
  }
  return attributes;
}

function textById(html: string, id: string): string | null {
  const inner = innerById(html, id);
  return inner === null ? null : decode(inner);
}

function innerById(html: string, id: string): string | null {
  const tag = tagById(html, id);
  if (tag === null) {
    return null;
  }
  const open = html.indexOf(tag);
  if (open < 0) {
    return null;
  }
  const afterOpen = open + tag.length;
  const nameMatch = /^<([a-z0-9]+)/i.exec(tag);
  if (nameMatch?.[1] === undefined) {
    return null;
  }
  const close = new RegExp(`</${nameMatch[1]}>`, "i").exec(html.slice(afterOpen));
  if (close === null || close.index === undefined) {
    return null;
  }
  return html.slice(afterOpen, afterOpen + close.index);
}

function tagById(html: string, id: string): string | null {
  const re = new RegExp(
    `<[a-z0-9]+\\b[^>]*id=["']${escapeRegExp(id)}["'][^>]*>`,
    "i",
  );
  return firstMatch(html, re);
}

function attr(tag: string, name: string): string | null {
  const re = new RegExp(`${escapeRegExp(name)}=["']([^"']+)["']`, "i");
  const match = re.exec(tag);
  return match?.[1] ?? null;
}

function metaContent(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta\\b[^>]*name=["']${escapeRegExp(name)}["'][^>]*content=["']([^"']+)["'][^>]*>`,
    "i",
  );
  const match = re.exec(html);
  return match?.[1] ?? null;
}

function firstMatch(html: string, re: RegExp): string | null {
  const match = re.exec(html);
  return match?.[1] ?? match?.[0] ?? null;
}

function decode(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
