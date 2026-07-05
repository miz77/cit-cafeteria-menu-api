import type { KvWrite } from "./documents";

export interface CloudflareKvConfig {
  accountId: string;
  apiToken: string;
  namespaceId: string;
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
