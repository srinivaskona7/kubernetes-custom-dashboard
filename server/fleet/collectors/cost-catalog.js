/**
 * Cost catalog — the static rate card behind the Cost & Budget tab, and the one place the
 * dashboard's money numbers come from.
 *
 * ## Read this before trusting a number out of this file
 *
 * **Nothing here is read from a cluster or from an invoice.** The fleet credential grants
 * Kubernetes reads only; there is no BTP billing API, no AWS Cost Explorer, no SAP metering
 * endpoint behind it. So every figure this module returns is an *estimate computed from a
 * hardcoded rate card* — the one kind of number this codebase otherwise refuses to print.
 * It is allowed here on three conditions, all enforced below:
 *
 *   1. every rate carries `source`, so the UI can say where it came from;
 *   2. the rate card is overridable without a code change (`FLEET_COST_CATALOG`);
 *   3. an instance type we cannot price returns **null**, never a guessed dollar figure.
 *
 * Callers must label the output as an estimate. It does not "replicate SAP BTP billing" and
 * must not be presented as an invoice or a forecast the operator can hold anyone to. The
 * authoritative figure is the SAP Discovery Center service estimator.
 *
 * ## Two metering models that do not agree, on purpose
 *
 * This is the part that looks like a bug and is not, so it is pinned by a test:
 *
 *     m5.2xlarge   USD view:  $0.504/hr x 730 = $367.92 / month
 *                  CU  view:  4 units x 0.14 CU/hr x 730 = 408.8 CU / month
 *                  408.8 CU x $1.08 = $441.50, which is NOT $367.92 — a ~20% gap.
 *
 * Those are two different meters over the same hardware, not one total in two currencies:
 *
 *   - **USD** is the hyperscaler's on-demand list price for the machine plus a Kyma management
 *     surcharge. Per this catalog's own numbers the surcharge is not a flat percentage — it is
 *     31.25% on m5, 29.4% on c5, 25.8% on r5 — so it cannot be recomputed from the base rate
 *     and is carried per instance type as given.
 *   - **CU** is SAP's Capacity Unit meter: a normalized 2 vCPU / 8 GiB node unit at 0.14 CU/hr.
 *
 * USD is authoritative for this feature (the product decision), so **EUR is derived from USD**
 * and never from CU. Deriving EUR from the CU figure instead would reintroduce the same 20%
 * divergence *inside a currency pair*, where it reads as an arithmetic error rather than as two
 * meters. The gap between the models is exposed as `modelDivergencePct` precisely so a caller
 * cannot accidentally present one as a conversion of the other.
 *
 * ## normalizedUnits
 *
 * The catalog's own values imply the rule: `mean(cpu / 2, memGiB / 8)`, rounded. m5.2xlarge
 * (8 vCPU / 32 GiB) is 4 on both axes, so it does not discriminate — but c5.2xlarge
 * (8 / 16) is given as **3**, which is neither its CPU units (4) nor its memory units (2), and
 * r5.2xlarge (8 / 64) is **6**, which is neither 4 nor 8. Only the mean produces both. The rule
 * is written down here because it was not stated anywhere, and `derivedRate` depends on it.
 */
import { readFileSync } from 'node:fs';

/** Billing hours in a month. 730 = 365 * 24 / 12, the convention every hyperscaler quotes. */
const HOURS_PER_MONTH = 730;

/**
 * When `DEFAULT_CATALOG` below was last edited in this repository.
 *
 * This is deliberately NOT "the date these prices were true in the market" — nobody here can
 * assert that, because no price feed is reachable from this console. It is the one date that is a
 * verifiable fact about the rate card: the day its figures last changed in git. An operator
 * reading "$4,102 / month" needs to know the rates behind it are that old, and a stale rate card
 * with a visible date is a different (and far safer) object than one with no date at all.
 *
 * Keep this in step with any edit to `DEFAULT_CATALOG`; `server/fleet/__tests__/cost-provenance.test.js`
 * pins that it is a plain ISO date and that it is published on the wire.
 */
const CATALOG_AS_OF = '2026-09-21';
const CATALOG_AS_OF_BASIS = 'the date these rates were last edited in this repository, not a market quote';

/**
 * `DEFAULT_CATALOG` has **no region dimension** — one rate per instance type, worldwide.
 *
 * Real hyperscaler pricing varies by region by double-digit percentages, so this is a material
 * limitation and is carried as an explicit `null` region plus the sentence below rather than
 * being left for an operator in eu-central-1 to assume was handled. An override file may supply
 * its own `region`/`asOf` via `__meta` (see `loadCatalog`).
 */
const CATALOG_REGION = null;
const CATALOG_REGION_NOTE = 'no region dimension — rates are a single built-in list';

/** 1 CU = EUR 1.00 = USD 1.08. Only used for the CU meter, never to convert the USD total. */
const CU_RATE_EUR = 1.0;
const CU_RATE_USD = 1.08;

/** EUR per USD, applied to the authoritative USD figure. */
const EUR_PER_USD = CU_RATE_EUR / CU_RATE_USD;

/** SAP's normalized node unit, and what one costs per hour on the CU meter. */
const NORMALIZED_UNIT = { cpu: 2, memoryGiB: 8, hourlyCu: 0.14 };

/**
 * Dollars per normalized-unit-hour, for an instance type that is NOT in the catalog.
 *
 * Taken from the m5 (general purpose) family, which is the reference shape for a Kyma worker
 * pool: $0.504/hr / 4 units = $0.126. The catalog's other families imply different figures
 * ($0.1467 for c5, $0.1057 for r5), so this is a general-purpose approximation and nothing
 * more — which is why every rate built from it is marked `source: 'derived'`.
 */
const DERIVED_USD_PER_UNIT_HOUR = 0.126;

/**
 * The rate card. `totalHourlyUsd` is the authoritative figure; `nodeHourlyUsd` and
 * `sapFeeHourlyUsd` are carried where known so the UI can show the split, and are absent for
 * Azure/GCP because the source did not break them out — absent, not zero.
 */
const DEFAULT_CATALOG = {
  aws: {
    'm5.2xlarge': { cpu: 8, memGiB: 32, normalizedUnits: 4, nodeHourlyUsd: 0.384, sapFeeHourlyUsd: 0.120, totalHourlyUsd: 0.504 },
    'm5.4xlarge': { cpu: 16, memGiB: 64, normalizedUnits: 8, nodeHourlyUsd: 0.768, sapFeeHourlyUsd: 0.240, totalHourlyUsd: 1.008 },
    'm5.8xlarge': { cpu: 32, memGiB: 128, normalizedUnits: 16, nodeHourlyUsd: 1.536, sapFeeHourlyUsd: 0.480, totalHourlyUsd: 2.016 },
    'm5.12xlarge': { cpu: 48, memGiB: 192, normalizedUnits: 24, nodeHourlyUsd: 2.304, sapFeeHourlyUsd: 0.720, totalHourlyUsd: 3.024 },
    'c5.2xlarge': { cpu: 8, memGiB: 16, normalizedUnits: 3, nodeHourlyUsd: 0.340, sapFeeHourlyUsd: 0.100, totalHourlyUsd: 0.440 },
    'r5.2xlarge': { cpu: 8, memGiB: 64, normalizedUnits: 6, nodeHourlyUsd: 0.504, sapFeeHourlyUsd: 0.130, totalHourlyUsd: 0.634 }
  },
  azure: {
    'Standard_D8_v3': { cpu: 8, memGiB: 32, normalizedUnits: 4, totalHourlyUsd: 0.500 },
    'Standard_D16_v3': { cpu: 16, memGiB: 64, normalizedUnits: 8, totalHourlyUsd: 1.000 }
  },
  gcp: {
    'n2-standard-8': { cpu: 8, memGiB: 32, normalizedUnits: 4, totalHourlyUsd: 0.510 },
    'n2-standard-16': { cpu: 16, memGiB: 64, normalizedUnits: 8, totalHourlyUsd: 1.020 }
  }
};

/** `spec.providerID` prefix -> catalog key. `gce://` is GCP's, not `gcp://`. */
const PROVIDER_PREFIXES = [
  ['aws://', 'aws'],
  ['azure://', 'azure'],
  ['gce://', 'gcp'],
  ['gcp://', 'gcp']
];

/**
 * The catalog in force, `DEFAULT_CATALOG` unless `FLEET_COST_CATALOG` names a JSON file.
 *
 * Overridable because a hardcoded price is wrong the moment a region, a discount or a contract
 * differs, and an operator must be able to correct it without a rebuild. A malformed or
 * unreadable override is NOT silently ignored — it throws at load, because falling back to
 * default prices while the operator believes their own file is in force would be the worst of
 * both worlds.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{catalog: object, source: string, region: string|null, regionNote: string|null,
 *            asOf: string|null, asOfBasis: string|null}}
 */
function loadCatalog(env = process.env) {
  const file = env.FLEET_COST_CATALOG;
  if (!file) {
    return {
      catalog: DEFAULT_CATALOG,
      source: 'built-in',
      region: CATALOG_REGION,
      regionNote: CATALOG_REGION_NOTE,
      asOf: CATALOG_AS_OF,
      asOfBasis: CATALOG_AS_OF_BASIS
    };
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error(`FLEET_COST_CATALOG is not an object: ${file}`);
  /*
    An override file may state the two things the built-in card cannot: which region its prices
    are for, and when they were quoted. They live under `__meta` so the rest of the file stays a
    plain provider -> instance-type map, and `__meta` is stripped out here — leaving it in would
    make it look like a fourth hyperscaler to every consumer that iterates the catalog.
    Absent `__meta` fields stay null: "the operator's file did not say" is not "worldwide", and
    it is certainly not today's date.
  */
  const meta = parsed.__meta && typeof parsed.__meta === 'object' ? parsed.__meta : {};
  const catalog = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key !== '__meta') catalog[key] = value;
  }
  return {
    catalog,
    source: `file:${file}`,
    region: typeof meta.region === 'string' && meta.region ? meta.region : null,
    regionNote: typeof meta.region === 'string' && meta.region ? null : 'this override file states no region',
    asOf: typeof meta.asOf === 'string' && meta.asOf ? meta.asOf : null,
    asOfBasis: typeof meta.asOf === 'string' && meta.asOf ? 'as stated by the override file' : null
  };
}

/** Which provider a node's `spec.providerID` names, or null when it is absent or unrecognised. */
function providerOf(providerId) {
  const id = String(providerId == null ? '' : providerId).toLowerCase();
  for (const [prefix, key] of PROVIDER_PREFIXES) {
    if (id.startsWith(prefix)) return key;
  }
  return null;
}

/**
 * SAP normalized node units for a shape, by the mean rule the catalog's own values imply.
 * Rounded to one decimal rather than to an integer: a 4 vCPU / 8 GiB node is 1.5 units, and
 * rounding that to 2 would overstate its cost by a third.
 */
function normalizedUnitsFor(cpu, memGiB) {
  if (!(cpu > 0) || !(memGiB > 0)) return null;
  const units = (cpu / NORMALIZED_UNIT.cpu + memGiB / NORMALIZED_UNIT.memoryGiB) / 2;
  return Math.round(units * 10) / 10;
}

/**
 * The CU meter for a shape — hourly and monthly, independent of any dollar figure.
 *
 * @param {number} totalCpu vCPU
 * @param {number} totalMemGiB GiB
 * @returns {{normalizedUnits: number, hourlyCu: number, monthlyCu: number,
 *            monthlyEurOnCuMeter: number}|null} null when the shape is unknown
 */
function calculateCapacityUnits(totalCpu, totalMemGiB) {
  const normalizedUnits = normalizedUnitsFor(totalCpu, totalMemGiB);
  if (normalizedUnits === null) return null;
  const hourlyCu = normalizedUnits * NORMALIZED_UNIT.hourlyCu;
  const monthlyCu = hourlyCu * HOURS_PER_MONTH;
  return {
    normalizedUnits,
    hourlyCu: round(hourlyCu, 4),
    monthlyCu: round(monthlyCu, 2),
    // What the CU meter alone would bill, in EUR. Deliberately NOT named `monthlyEur`: the
    // authoritative EUR figure is derived from USD, and these two differ by ~20%.
    monthlyEurOnCuMeter: round(monthlyCu * CU_RATE_EUR, 2)
  };
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Money and CUs for one machine shape.
 *
 * @param {object} entry a catalog entry, or a `{cpu, memGiB}` shape for the derived path
 * @param {string} source 'catalog' | 'derived'
 */
function rateFrom(entry, source) {
  const cpu = entry.cpu;
  const memGiB = entry.memGiB;
  const units = entry.normalizedUnits != null ? entry.normalizedUnits : normalizedUnitsFor(cpu, memGiB);
  const totalHourlyUsd = entry.totalHourlyUsd != null
    ? entry.totalHourlyUsd
    : round(units * DERIVED_USD_PER_UNIT_HOUR, 4);

  const monthlyUsd = round(totalHourlyUsd * HOURS_PER_MONTH, 2);
  const cu = calculateCapacityUnits(cpu, memGiB) || { normalizedUnits: units, hourlyCu: null, monthlyCu: null };
  const monthlyUsdOnCuMeter = cu.monthlyCu == null ? null : cu.monthlyCu * CU_RATE_USD;

  return {
    cpu,
    memGiB,
    normalizedUnits: units,
    // The authoritative pair. EUR is derived from USD — see the module note.
    hourlyUsd: round(totalHourlyUsd, 4),
    monthlyUsd,
    monthlyEur: round(monthlyUsd * EUR_PER_USD, 2),
    // The split, where the catalog states it. Null means "not broken out", not "free".
    nodeHourlyUsd: entry.nodeHourlyUsd != null ? entry.nodeHourlyUsd : null,
    sapFeeHourlyUsd: entry.sapFeeHourlyUsd != null ? entry.sapFeeHourlyUsd : null,
    // The second meter, kept beside the first and never folded into it.
    hourlyCu: cu.hourlyCu,
    monthlyCu: cu.monthlyCu,
    /**
     * How far the CU meter's dollar equivalent sits from the authoritative USD figure, as a
     * percentage of the latter. ~20% for every catalog entry. Exposed so a caller that shows
     * both meters can disclose the divergence instead of letting an operator discover it by
     * multiplying two numbers on the screen and getting a third.
     */
    modelDivergencePct: monthlyUsdOnCuMeter == null || monthlyUsd === 0
      ? null
      : round(((monthlyUsdOnCuMeter - monthlyUsd) / monthlyUsd) * 100, 1),
    source
  };
}

/**
 * The rate for an instance type, or **null** when it cannot be priced.
 *
 * Three outcomes, and the third is the one that matters:
 *
 *   - the type is in the catalog                     -> `source: 'catalog'`
 *   - it is not, but the node's real shape is known  -> `source: 'derived'`, priced off the m5
 *     family's per-unit rate. An approximation, and it says so.
 *   - it is not, and the shape is unknown            -> **null**. No dollar figure is invented
 *     for a machine we know nothing about; the caller reports it as unpriced, the same way
 *     every other collector reports a read it could not make.
 *
 * `shape` should come from the node's own `status.capacity` (via topology.js), which is a real
 * read — so the derived path is a guess about *price*, never about the hardware.
 *
 * @param {string} instanceType e.g. 'm5.2xlarge'
 * @param {string} [providerId] the node's `spec.providerID`; narrows the lookup when present
 * @param {{cpu?: number, memGiB?: number}} [shape] the node's measured capacity
 * @param {{catalog?: object}} [opts]
 */
function getMachineRate(instanceType, providerId, shape, opts = {}) {
  const { catalog } = opts.catalog ? { catalog: opts.catalog } : loadCatalog();
  const type = typeof instanceType === 'string' ? instanceType : '';
  const provider = providerOf(providerId);

  // A provider from providerID is authoritative; without one, every family is searched, because
  // instance-type names do not collide across the three hyperscalers.
  const providers = provider && catalog[provider] ? [provider] : Object.keys(catalog);
  for (const key of providers) {
    const entry = catalog[key] && catalog[key][type];
    if (entry) return { ...rateFrom(entry, 'catalog'), instanceType: type, provider: key };
  }

  const cpu = shape && Number(shape.cpu) > 0 ? Number(shape.cpu) : null;
  const memGiB = shape && Number(shape.memGiB) > 0 ? Number(shape.memGiB) : null;
  if (cpu === null || memGiB === null) return null;

  return {
    ...rateFrom({ cpu, memGiB }, 'derived'),
    instanceType: type || null,
    provider: provider || null
  };
}

export default {
  HOURS_PER_MONTH,
  CATALOG_AS_OF,
  CATALOG_AS_OF_BASIS,
  CATALOG_REGION,
  CATALOG_REGION_NOTE,
  CU_RATE_EUR,
  CU_RATE_USD,
  EUR_PER_USD,
  NORMALIZED_UNIT,
  DERIVED_USD_PER_UNIT_HOUR,
  DEFAULT_CATALOG,
  loadCatalog,
  providerOf,
  normalizedUnitsFor,
  calculateCapacityUnits,
  getMachineRate
};
