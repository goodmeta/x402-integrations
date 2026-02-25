/**
 * Minimal Exa API client.
 */

interface ExaSearchOptions {
  query: string;
  numResults?: number;
  useAutoprompt?: boolean;
}

interface ExaResult {
  id: string;
  url: string;
  title: string;
  score: number;
  publishedDate?: string;
  author?: string;
  text?: string;
}

interface ExaResponse {
  requestId: string;
  resolvedSearchType: string;
  results: ExaResult[];
}

export async function exaSearch(
  apiKey: string,
  options: ExaSearchOptions
): Promise<ExaResponse> {
  const response = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query: options.query,
      numResults: options.numResults ?? 5,
      useAutoprompt: options.useAutoprompt ?? true,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Exa API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<ExaResponse>;
}
