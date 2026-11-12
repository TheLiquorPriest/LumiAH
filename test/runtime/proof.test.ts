// The proof `lumiah status` (and `up`, before it ends a running runtime's link) shows `GET /healthz`
// that it holds the runtime's config, where the runtime listens on an address other machines reach.
// It is bound to its moment: whatever catches one (a program of another account's on the runtime's
// port while the runtime is down) can show it nowhere, and learns nothing of the secret.

import { describe, expect, test } from "bun:test";
import { HealthProofs, healthProof, PROOF_WINDOW_MS } from "../../src/runtime/proof";

const SECRET = "a".repeat(64);
const NOW = 1_700_000_000_000;

describe("a health proof", () => {
  test("made now with the relay's secret holds once; shown again it holds no more", async () => {
    const proofs = new HealthProofs(() => SECRET, () => NOW);
    const proof = await healthProof(SECRET, NOW);
    expect(proof).toMatch(/^1700000000000\.[0-9a-f]{32}\.[0-9a-f]{64}$/);
    expect(proof).not.toContain(SECRET);
    expect(await proofs.holds(proof)).toBe(true);
    expect(await proofs.holds(proof)).toBe(false);
    // Each one made is new: two made at the same moment are two proofs.
    expect(await proofs.holds(await healthProof(SECRET, NOW))).toBe(true);
  });

  test("holds only near its time, made with this secret, in its own form", async () => {
    const proofs = new HealthProofs(() => SECRET, () => NOW);
    expect(await proofs.holds(await healthProof(SECRET, NOW - PROOF_WINDOW_MS - 1))).toBe(false);
    expect(await proofs.holds(await healthProof(SECRET, NOW + PROOF_WINDOW_MS + 1))).toBe(false);
    expect(await proofs.holds(await healthProof(SECRET, NOW - PROOF_WINDOW_MS))).toBe(true);
    expect(await proofs.holds(await healthProof("b".repeat(64), NOW))).toBe(false);
    const [at, nonce, mac] = (await healthProof(SECRET, NOW)).split(".");
    // Its time moved to make an old one look new breaks it.
    expect(await proofs.holds(`${Number(at) + 1}.${nonce}.${mac}`)).toBe(false);
    for (const shown of ["", "a hash of the secret", `${NOW}.${nonce}`, `${NOW}.${nonce}.${mac}.x`]) expect(await proofs.holds(shown)).toBe(false);
  });

  test("taken ones are let go once out of the window, and stay refused while in it", async () => {
    let now = NOW;
    const proofs = new HealthProofs(() => SECRET, () => now);
    const proof = await healthProof(SECRET, NOW);
    expect(await proofs.holds(proof)).toBe(true);
    now = NOW + PROOF_WINDOW_MS;
    expect(await proofs.holds(proof)).toBe(false);
    now = NOW + PROOF_WINDOW_MS + 1;
    // By now it is too old to hold anyway.
    expect(await proofs.holds(proof)).toBe(false);
  });
});
