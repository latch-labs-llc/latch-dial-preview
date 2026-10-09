/** v0.16: what a scanned code means. */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { parseScan, routeFor } from "../src/lib/scan";

const A = Keypair.generate().publicKey.toBase58();

describe("parseScan", () => {
  it("bare address, solana: URI (amount/label carried into the pay screen), and our own links in full or as a hash route", () => {
    expect(parseScan(` ${A} `)).toEqual({ kind: "address", address: A });
    const sp = parseScan(`solana:${A}?amount=12.5&label=Bakery&message=Two%20loaves`);
    expect(sp?.kind).toBe("pay");
    if (sp?.kind === "pay") {
      expect(sp.address).toBe(A);
      expect(sp.query.get("amount")).toBe("12.5");
      expect(sp.query.get("for")).toBe("Two loaves");
      expect(sp.query.get("src")).toBe("scan");
    }
    const pay = parseScan(`https://dial.latchlabs.org/#/pay?to=${A}&amount=120&for=Used%20road%20bike`);
    expect(pay?.kind).toBe("pay");
    if (pay?.kind === "pay") expect(routeFor(pay)).toBe(`/pay?to=${A}&amount=120&for=Used+road+bike`);
    expect(parseScan(`#/u/sam_92`)).toEqual({ kind: "user", name: "sam_92" });
    expect(parseScan(`https://dial.latchlabs.org/#/deal/${A}?k=abc`)).toEqual({ kind: "deal", address: A, k: "abc" });
    expect(parseScan(`#/pay?req=eyJ0`)).toEqual({ kind: "request", req: "eyJ0" });
    expect(routeFor({ kind: "address", address: A })).toBe(`/pay?to=${A}&src=scan`);
  });
  it("refuses junk, a malformed address in a link, and unknown routes", () => {
    expect(parseScan("")).toBeNull();
    expect(parseScan("hello world")).toBeNull();
    expect(parseScan("https://example.com/")).toBeNull();
    expect(parseScan("#/pay?to=notanaddress")).toBeNull();
    expect(parseScan("#/settings")).toBeNull();
    expect(parseScan("solana:nope")).toBeNull();
    expect(parseScan(`#/deal/nope`)).toBeNull();
  });
});
