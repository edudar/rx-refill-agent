// Deterministic matching of what the patient named against records and listings
// the application retrieved. Nothing here guesses or substitutes.

const FILLER_WORDS = new Set([
  "a",
  "an",
  "and",
  "for",
  "i",
  "it",
  "medication",
  "medicine",
  "my",
  "need",
  "of",
  "one",
  "pill",
  "pills",
  "please",
  "prescription",
  "refill",
  "that",
  "the",
  "to",
  "want",
]);

function words(text: string) {
  return text
    .toLowerCase()
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

// Every meaningful word the patient used must appear in the medication name, so
// "amlodipine" matches both strengths and "10 mg" matches only "Amlodipine 10mg".
export function matchMedications<T extends { name: string }>(
  mention: string,
  medications: readonly T[],
): T[] {
  const wanted = words(mention).filter((word) => !FILLER_WORDS.has(word));
  if (!wanted.length) return [];
  return medications.filter((medication) => {
    const name = new Set(words(medication.name));
    return wanted.every((word) => name.has(word));
  });
}

const GENERIC_PHARMACY_WORDS = new Set(["pharmacy", "drugs", "rx", "store"]);

// A presented pharmacy matches when its name contains every distinctive word the
// patient used; the match must be unique.
export function findNamedPharmacy<T extends { name: string }>(
  name: string,
  pharmacies: readonly T[],
): T | undefined {
  const wanted = words(name).filter(
    (word) => !GENERIC_PHARMACY_WORDS.has(word) && !FILLER_WORDS.has(word),
  );
  if (!wanted.length) return undefined;
  const matches = pharmacies.filter((pharmacy) => {
    const listing = new Set(words(pharmacy.name));
    return wanted.every((word) => listing.has(word));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function normalizeAddress(text: string) {
  return text.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim();
}

// A stated location matches when the address contains it ("123 Market St" or
// "San Francisco"), or it contains the address's street line.
export function matchesLocation(address: string, location: string) {
  const area = normalizeAddress(location);
  const street = normalizeAddress(address.split(",")[0]);
  return (
    !!area &&
    (normalizeAddress(address).includes(area) ||
      (!!street && area.includes(street)))
  );
}
