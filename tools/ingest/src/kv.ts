import type { KvWrite } from "./documents";

export interface CloudflareKvConfig {
  accountId: string;
  apiToken: string;
  namespaceId: string;
}

export class CloudflareKvReadError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly body: string | null = null
  ) {
    super(message);
  }
}

export async function getKvValue(
  config: CloudflareKvConfig,
  key: string,
  fetchImpl: typeof fetch = fetch
): Promise<string | null> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`
  );

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.apiToken}`
      }
    });
  } catch (error) {
    throw new CloudflareKvReadError(
      `Failed to read KV key ${key}: ${error instanceof Error ? error.message : String(error)}`,
      null
    );
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CloudflareKvReadError(`Failed to read KV key ${key}: ${response.status} ${body}`, response.status, body);
  }

  return response.text();
}

export async function uploadKvWrites(
  config: CloudflareKvConfig,
  writes: readonly KvWrite[],
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  for (const write of writes) {
    await putKvValue(config, write, fetchImpl);
  }
}

async function putKvValue(config: CloudflareKvConfig, write: KvWrite, fetchImpl: typeof fetch): Promise<void> {
  const url = new URL(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(write.key)}`
  );

  if (write.expirationTtl) {
    url.searchParams.set("expiration_ttl", String(write.expirationTtl));
  }

  const response = await fetchImpl(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      "content-type": "application/json; charset=utf-8"
    },
    body: write.value
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Failed to write KV key ${write.key}: ${response.status} ${body}`);
  }
}
