import Redis from "ioredis";

function createRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[FlickXI] REDIS_URL is not set; using single-instance realtime state.");
    }
    return null;
  }

  return new Redis(url, {
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
}

export const realtimeRedis = createRedis();

export function fieldsToObject(fields: string[]) {
  const result: Record<string, string> = {};
  for (let index = 0; index + 1 < fields.length; index += 2) {
    result[fields[index]] = fields[index + 1];
  }
  return result;
}
