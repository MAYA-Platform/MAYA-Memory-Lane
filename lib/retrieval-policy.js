/** Provisional offline calibration, not a claim of live provider accuracy. */
export const SUPPORT_CALIBRATION = Object.freeze({
  version: 1, model: 'typesafe/jev-1.13', source: 'synthetic_labeled_contract_fixtures',
  positive: Object.freeze([1.94, 1.99, 2]),
  negative: Object.freeze([0, 0.4, 1, 1.49, 1.65, 1.82])
});

export function calibrateSupport({ positive, negative }) {
  if (!positive.length || !negative.length || [...positive, ...negative].some(n => !Number.isFinite(n) || n < 0 || n > 2)) throw Error('Invalid calibration');
  const floor = Math.min(...positive);
  if (Math.max(...negative) >= floor) throw Error('Calibration labels overlap; abstain until reviewed');
  return floor;
}

export const SUPPORT_FLOOR = calibrateSupport(SUPPORT_CALIBRATION);
