export type FieldSchema = {
  [key: string]: FieldSchema | true | "*";
};

const PRICE_SCHEMA: FieldSchema = {
  amount: true,
  currency: true,
  display: true,
  unavailable: true,
};

const RATING_SCHEMA: FieldSchema = {
  average: true,
  count: true,
};

export const PRODUCT_FIELD_SCHEMA: FieldSchema = {
  asin: true,
  marketplace: true,
  title: true,
  brand: true,
  url: true,
  images: true,
  price: PRICE_SCHEMA,
  rating: RATING_SCHEMA,
  bullets: true,
  description: true,
  categoryPath: true,
  bsr: {
    rank: true,
    category: true,
  },
  attributes: "*",
  fetchedAt: true,
};

export const SEARCH_PAGE_FIELD_SCHEMA: FieldSchema = {
  q: true,
  page: true,
  hasMore: true,
  results: {
    asin: true,
    title: true,
    price: PRICE_SCHEMA,
    rating: RATING_SCHEMA,
    url: true,
    image: true,
  },
};
