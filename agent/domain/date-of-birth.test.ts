import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDateOfBirth } from "./date-of-birth.js";

test("normalizes common DOB formats without relying on the runtime locale", () => {
  for (const input of [
    "1988-03-12",
    "1988/3/12",
    "1988.3.12",
    "March 12, 1988",
    "12 March 1988",
    "12-Mar-1988",
    "Mar. 12th, 1988",
    "the 12th of March 1988",
    "  MARCH 12, 1988  ",
  ]) {
    assert.equal(normalizeDateOfBirth(input), "1988-03-12", input);
  }
  assert.equal(normalizeDateOfBirth("12/31/1988"), "1988-12-31");
  assert.equal(normalizeDateOfBirth("31/12/1988"), "1988-12-31");
  assert.equal(normalizeDateOfBirth("31.12.1988"), "1988-12-31");
  assert.equal(normalizeDateOfBirth("11/11/1988"), "1988-11-11");
  assert.equal(normalizeDateOfBirth("29 Feb 2000"), "2000-02-29");
  assert.equal(normalizeDateOfBirth("Sept. 12, 1988"), "1988-09-12");
  assert.equal(normalizeDateOfBirth("1/1/1988"), "1988-01-01");
});

test("rejects ambiguous dates, incomplete years, and invalid calendar dates", () => {
  for (const input of [
    "03/04/1988",
    "3-12-1988",
    "03/12/88",
    "March 1988",
    "February 30, 1988",
    "29 February 1900",
    "1988-13-12",
    "13/13/1988",
    "1988/03-12",
    "",
    "not a date",
  ]) {
    assert.equal(normalizeDateOfBirth(input), null, input);
  }
});
