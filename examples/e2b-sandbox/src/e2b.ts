/**
 * Minimal E2B API client for sandbox creation.
 */

interface CreateSandboxOptions {
  template: string;
  timeoutMs: number;
}

interface SandboxInfo {
  sandboxId: string;
  templateId: string;
  clientId: string;
  startedAt: string;
  expiresAt: string;
}

export async function createSandbox(
  apiKey: string,
  options: CreateSandboxOptions
): Promise<SandboxInfo> {
  const response = await fetch("https://api.e2b.dev/sandboxes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      templateID: options.template,
      timeout: Math.floor(options.timeoutMs / 1000),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "(no body)");
    throw new Error(`E2B API error ${response.status}: ${text}`);
  }

  return response.json() as Promise<SandboxInfo>;
}
