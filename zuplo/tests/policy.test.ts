/**
 * Tests for the x402 Zuplo inbound policy (v2).
 *
 * Uses Vitest. Mocks fetch and the Zuplo runtime so the policy can be tested
 * without a live Zuplo or facilitator instance.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import policy, { X402PolicyOptions } from "../src/policy";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@zuplo/runtime", () => ({}));

function makeRequest(headers: Record<string, string> = {}, url = "https://api.example.com/data") {
  return {
    headers: new Headers(headers),
    url,
    clone() {
      return makeRequest(headers, url);
    },
  } as unknown as import("@zuplo/runtime").ZuploRequest;
}

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
  facilitatorUrl: "https://x402.stablecoin.xyz",
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
 * Encodes a payment payload as the base64 header value.
 */
function encodePaymentHeader(payload: Record<string, unknown>): string {
  return btoa(JSON.stringify(payload));
}

/**
 * v2 payment payload — matches SBC facilitator's expected format.
 */
const validPayload = {
  x402Version: 2,
  resource: "https://api.example.com/data",
  accepted: {
    scheme: "exact",
    network: "eip155:8453",
  },
  payload: {
    signature: "0xdeadbeef",
    authorization: {
      from: "0xPayerAddress",
      to: "0xFacilitatorAddress",
      value: "1000000",
      validAfter: "0",
      validBefore: "999999999999",
      nonce: "1",
    },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("x402 Zuplo Policy (v2)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // Case 1: No payment header → 402
  // -------------------------------------------------------------------------
  describe("when no payment header is present", () => {
    it("returns HTTP 402 with x402 v2 payment requirements", async () => {
      const request = makeRequest();
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(402);

      const body = await response.json();
      expect(body.x402Version).toBe(2);
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

    it("sets PAYMENT-REQUIRED header with base64-encoded requirements", async () => {
      const request = makeRequest();
      const context = makeContext();

      const result = (await policy(request, context, defaultOptions, "x402")) as Response;
      const header = result.headers.get("PAYMENT-REQUIRED");
      expect(header).toBeTruthy();

      const decoded = JSON.parse(atob(header!));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.accepts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: Reads PAYMENT-SIGNATURE header (v2 primary)
  // -------------------------------------------------------------------------
  describe("when PAYMENT-SIGNATURE header is present (v2)", () => {
    it("uses PAYMENT-SIGNATURE header for payment verification", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, txHash: "0xabc" }),
        } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");
      expect(result).toBe(request);
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: Falls back to X-PAYMENT header (v1 compat)
  // -------------------------------------------------------------------------
  describe("when only X-PAYMENT header is present (v1 fallback)", () => {
    it("accepts X-PAYMENT header for backward compatibility", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, txHash: "0xabc" }),
        } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "X-PAYMENT": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");
      expect(result).toBe(request);
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: Malformed payment header → 402 with error
  // -------------------------------------------------------------------------
  describe("when payment header is malformed", () => {
    it("returns HTTP 402 with error message if header is not valid base64 JSON", async () => {
      const request = makeRequest({ "PAYMENT-SIGNATURE": "not-valid-base64!!!" });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(402);

      const body = await response.json();
      expect(body.error).toBe("Invalid payment header");
      expect(body.accepts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Case 5: Facilitator verifies + settles → pass through
  // -------------------------------------------------------------------------
  describe("when payment is valid and settlement succeeds", () => {
    it("returns the original request (pass-through)", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayerAddress", invalidReason: null }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, txHash: "0xabc123" }),
        } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");
      expect(result).toBe(request);
    });

    it("calls facilitator /verify then /settle endpoints", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: true, txHash: "0xabc" }),
        } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      await policy(request, context, defaultOptions, "x402");

      expect(fetchMock).toHaveBeenCalledTimes(2);

      const [verifyUrl] = fetchMock.mock.calls[0];
      expect(verifyUrl).toBe("https://x402.stablecoin.xyz/verify");

      const [settleUrl] = fetchMock.mock.calls[1];
      expect(settleUrl).toBe("https://x402.stablecoin.xyz/settle");

      // Verify the body structure
      const verifyBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(verifyBody.paymentPayload).toEqual(validPayload);
      expect(verifyBody.paymentRequirements.payTo).toBe(defaultOptions.payTo);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: settle: false skips settlement
  // -------------------------------------------------------------------------
  describe("when settle is false", () => {
    it("skips settlement and passes through after verification", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
      } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const opts = { ...defaultOptions, settle: false };
      const result = await policy(request, context, opts, "x402");

      expect(result).toBe(request);
      expect(fetchMock).toHaveBeenCalledTimes(1); // only /verify, no /settle
    });
  });

  // -------------------------------------------------------------------------
  // Case 7: Facilitator rejects payment → 401
  // -------------------------------------------------------------------------
  describe("when facilitator rejects the payment", () => {
    it("returns HTTP 401 with the invalidReason", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          isValid: false,
          payer: null,
          invalidReason: "Insufficient balance",
        }),
      } as unknown as Response);

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      const response = result as Response;
      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe("Payment verification failed");
      expect(body.reason).toBe("Insufficient balance");
    });
  });

  // -------------------------------------------------------------------------
  // Case 8: Settlement fails → 402
  // -------------------------------------------------------------------------
  describe("when settlement fails", () => {
    it("returns HTTP 402 with settlement error", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ success: false, error: "Nonce already used" }),
        } as unknown as Response);
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(402);

      const body = await (result as Response).json();
      expect(body.reason).toBe("Nonce already used");
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: Facilitator unreachable → 502
  // -------------------------------------------------------------------------
  describe("when the facilitator is unreachable", () => {
    it("returns HTTP 502 if verify fetch throws", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network timeout"));

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
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
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(502);
    });

    it("returns HTTP 502 if settle fetch throws", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ isValid: true, payer: "0xPayer", invalidReason: null }),
        } as unknown as Response)
        .mockRejectedValueOnce(new Error("Connection refused"));
      globalThis.fetch = fetchMock;

      const request = makeRequest({
        "PAYMENT-SIGNATURE": encodePaymentHeader(validPayload),
      });
      const context = makeContext();

      const result = await policy(request, context, defaultOptions, "x402");

      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(502);
    });
  });

  // -------------------------------------------------------------------------
  // Case 10: Defaults applied correctly
  // -------------------------------------------------------------------------
  describe("optional fields default correctly", () => {
    it("applies default description, timeout, and token metadata when omitted", async () => {
      const minimalOptions: X402PolicyOptions = {
        facilitatorUrl: "https://x402.stablecoin.xyz",
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
