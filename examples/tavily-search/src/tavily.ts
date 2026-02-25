/**
 * Minimal Tavily API client.
 * Only what we need for the x402 demo — no extra dependencies.
 */

interface TavilySearchOptions {
  query: string;
  maxResults?: number;
  searchDepth?: "basic" | "advanced";
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
}

interface TavilyResponse {
  query: string;
  results: TavilyResult[];
  responseTime: number;
}

export async function tavilySearch(
  apiKey: string,
  options: TavilySearchOptions
): Promise<TavilyResponse> {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: options.query,
      max_results: options.maxResults ?? 5,
      search_depth: options.searchDepth ?? "basic",
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`Tavily API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<TavilyResponse>;
}
