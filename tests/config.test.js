import { test } from "node:test";
import assert from "node:assert/strict";
import {
  usdPerHourToUactPerBlock,
  uactPerBlockToUsdPerHour,
  AVG_BLOCK_TIME_SECONDS,
  UACT_PER_USD,
} from "../src/config.js";

test("constants match Akash Console source-of-truth", () => {
  assert.equal(AVG_BLOCK_TIME_SECONDS, 6.098);
  assert.equal(UACT_PER_USD, 1_000_000);
});

test("usd→uact conversion matches UI prices observed on console", () => {
  // From live Console bid screen at 2026-05-25:
  //   nvidia-a100      $1.23/hr
  //   nvidia-pro6000se $1.86/hr
  //   nvidia-h100      $2.52/hr
  // Round-trip should land within 1 uact/block of expectation.
  // Floating-point round can shift by ±1 uact; check within tolerance.
  const within = (got, expected) => assert.ok(Math.abs(got - expected) <= 1, `${got} vs ${expected}`);
  within(usdPerHourToUactPerBlock(1.23), 2083);
  within(usdPerHourToUactPerBlock(1.86), 3150);
  within(usdPerHourToUactPerBlock(2.52), 4268);
});

test("round-trip USD → uact → USD stays within 0.001 USD", () => {
  for (const usd of [0.5, 1.0, 2.0, 5.0, 10.0]) {
    const uact = usdPerHourToUactPerBlock(usd);
    const back = uactPerBlockToUsdPerHour(uact);
    assert.ok(Math.abs(back - usd) < 0.001, `${usd} → ${uact} → ${back}`);
  }
});

test("$1/hr produces a cap that filters the live bid screen correctly", () => {
  // At $1/hr cap, $1.23 a100, $1.86 pro6000se, $2.52 h100 should all exceed.
  const cap = usdPerHourToUactPerBlock(1.0);
  assert.ok(usdPerHourToUactPerBlock(1.23) > cap);
  assert.ok(usdPerHourToUactPerBlock(1.86) > cap);
  assert.ok(usdPerHourToUactPerBlock(2.52) > cap);
});
