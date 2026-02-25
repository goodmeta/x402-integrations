/**
 * Tests for the x402 Zuplo inbound policy.
 *
 * Uses Vitest. Mocks fetch and the Zuplo runtime so the policy can be tested
 * without a live Zuplo or facilitator instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import policy, { X402PolicyOptions } from "../src/policy";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock @zuplo/runtime so the import in policy.ts resolves during tests.
vi.mock("@zuplo/runtime", () => ({}));

/**
 * Creates a minimal ZuploRequest-like object.
 */
function makeRequest(headers: Record<string, string> = {}, url = "https://api.example.com/data") {
  return {
    headers: new Headers(headers),
    url,
    clone() {
      return makeRequest(headers, url);
    },
  } as unknown as import("@zuplo/runtime").ZuploRequest;
}

/**
 * Creates a minimal ZuploContext-like object.
 */
function makeContext() {
  return {
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as import("@zuplo/runtime").ZuploContext;
}

const defaultOptions: X402PolicyOptions = {
  facilitatorUrl: "https://facilitator.stablecoin.xyz",
  payTo: "0xMerchantWallet",
  network: "eip155:8453",
  asset: "0xUSDCTokenAddress",
  maxAmountRequired: "1000000",
  description: "Access to test endpoint",
  maxTimeoutSeconds: 300,
  tokenName: "USD Coin",
  tokenVersion: "2",
};

/**
 * Encodes a payment payload object as the X-PAYMENT header value.
 */
function encodePaymentHeader(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

const validPayload = {
  scheme: "exact",
  x402Version: 1,
  payload: {
    signature: "0xdeadbeef",
    authorization: { from: "0xPayerAddress", value: "1000000" },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("x402 Zuplo Policy", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: No X-PAYMENT header → 402
  // -------------------------------------------------------------------------
  describe("when X-PAYMENT header is absent", () => {
    it("returns HTTP 402 with x402 payment requirements body", async () => {
      const request = makeRequest(); // no headers
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(402);

      const body = await response.json();
      expect(body.x402Version).toBe(1);
      expect(body.error).toBe("Payment Required");
      expect(body.accepts).toHaveLength(1);

      const accept = body.accepts[0];
      expect(accept.scheme).toBe("exact");
      expect(accept.network).toBe(defaultOptions.network);
      expect(accept.maxAmountRequired).toBe(defaultOptions.maxAmountRequired);
      expect(accept.payTo).toBe(defaultOptions.payTo);
      expect(accept.asset).toBe(defaultOptions.asset);
      expect(accept.maxTimeoutSeconds).toBe(defaultOptions.maxTimeoutSeconds);
      expect(accept.extra.name).toBe(defaultOptions.tokenName);
      expect(accept.extra.version).toBe(defaultOptions.tokenVersion);
    });

    it("sets X-Payment-Version header to '1' on 402 responses", async () => {
      const request = makeRequest();
      const context = makeContext();

      const result = (await policy(request, context, defaultOptions, "x402")) as Response;
      expect(result.headers.get("X-Payment-Version")).toBe("1");
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Malformed X-PAYMENT header → 400
  // -------------------------------------------------------------------------
  describe("when X-PAYMENT header is malformed", () => {
    it("returns HTTP 400 if the header is not valid base64 JSON", async () => {
      const request = makeRequest({ "X-PAYMENT": "not-valid-base64!!!" });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Valid header, facilitator confirms → pass through
  // -------------------------------------------------------------------------
  describe("when X-PAYMENT is present and facilitator validates it", () => {
    it("returns the original request (pass-through) when payment is valid", async () => {
      // Arrange: facilitator returns isValid = true
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isValid: true, payer: "0xPayerAddress", invalidReason: null }),
      } as unknown as Response);

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      // Policy returns the request object to signal pass-through
      expect(result).toBe(request);
    });

    it("calls the facilitator /verify endpoint with the correct body", async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      await policy(request, context, defaultOptions, "x402");

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://facilitator.stablecoin.xyz/verify");
      expect(init.method).toBe("POST");

      const sentBody = JSON.parse(init.body as string);
      expect(sentBody.paymentPayload).toEqual(validPayload);
      expect(sentBody.paymentRequirements.payTo).toBe(defaultOptions.payTo);
      expect(sentBody.paymentRequirements.maxAmountRequired).toBe(
        defaultOptions.maxAmountRequired
      );
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Valid header, facilitator rejects → 401
  // -------------------------------------------------------------------------
  describe("when X-PAYMENT is present but facilitator rejects it", () => {
    it("returns HTTP 401 with the invalidReason from the facilitator", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          isValid: false,
          payer: null,
          invalidReason: "Payment amount insufficient",
        }),
      } as unknown as Response);

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe("Payment verification failed");
      expect(body.reason).toBe("Payment amount insufficient");
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: Facilitator unreachable → 502
  // -------------------------------------------------------------------------
  describe("when the facilitator is unreachable", () => {
    it("returns HTTP 502 if fetch throws a network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(502);
    });

    it("returns HTTP 502 if the facilitator returns a non-2xx status", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      } as unknown as Response);

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(502);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: Defaults are applied correctly
  // -------------------------------------------------------------------------
  describe("optional fields default correctly", () => {
    it("applies default description, timeout, and token metadata when omitted", async () => {
      const minimalOptions: X402PolicyOptions = {
        facilitatorUrl: "https://facilitator.stablecoin.xyz",
        payTo: "0xWallet",
        network: "eip155:8453",
        asset: "0xToken",
        maxAmountRequired: "500000",
      };

      const request = makeRequest();
      const context = makeContext();

      const result = (await policy(request, context, minimalOptions, "x402")) as Response;
      const body = await result.json();
      const accept = body.accepts[0];

      expect(accept.description).toBe("Access to this API endpoint");
      expect(accept.maxTimeoutSeconds).toBe(300);
      expect(accept.extra.name).toBe("Stable Coin");
      expect(accept.extra.version).toBe("1");
    });
  });
});
