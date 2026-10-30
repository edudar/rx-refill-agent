import assert from "node:assert/strict";
import test from "node:test";
import { findNamedPharmacy, matchMedications } from "./refill-choices.js";

const medications = [
  { name: "Amlodipine 5mg" },
  { name: "Amlodipine 10mg" },
  { name: "Alprazolam 0.5mg" },
];

test("medication mentions must use only words from the record's name", () => {
  const names = (mention: string) =>
    matchMedications(mention, medications).map(({ name }) => name);
  assert.deepEqual(names("my amlodipine"), [
    "Amlodipine 5mg",
    "Amlodipine 10mg",
  ]);
  assert.deepEqual(names("Amlodipine 10 mg"), ["Amlodipine 10mg"]);
  assert.deepEqual(names("the 10mg one"), ["Amlodipine 10mg"]);
  assert.deepEqual(names("alprazolam 0.5 mg please"), ["Alprazolam 0.5mg"]);
  assert.deepEqual(names("Metoprolol 25mg"), []);
  assert.deepEqual(names("my medication"), [], "generic words match nothing");
  assert.deepEqual(names("amlo"), [], "partial words never match");
});

test("a named pharmacy must match exactly one presented listing", () => {
  const presented = [
    { name: "Bay Pharmacy" },
    { name: "Mission Rx" },
    { name: "Bay Area Drugs" },
  ];
  assert.equal(findNamedPharmacy("Mission Rx", presented)?.name, "Mission Rx");
  assert.equal(findNamedPharmacy("the Bay Pharmacy", presented), undefined);
  assert.equal(
    findNamedPharmacy("Bay Area", presented)?.name,
    "Bay Area Drugs",
  );
  assert.equal(findNamedPharmacy("pharmacy", presented), undefined);
  assert.equal(findNamedPharmacy("Sunset Drugs", presented), undefined);
});
