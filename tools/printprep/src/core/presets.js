/**
 * Printer, material and process presets.
 *
 * The defaults are the Elegoo Centauri Carbon 2: 256 mm cube, CoreXY with a bed
 * that only moves in Z, 0.4 mm hardened steel nozzle to 350 C, AC bed to 110 C,
 * 500 mm/s and 20000 mm/s2. Everything here is editable - the presets exist to
 * make the common case one click, not to constrain anything.
 *
 * Two of these numbers are load-bearing in ways that are not obvious:
 *
 *   The machine is CoreXY with a fixed bed, so where a part sits on the plate has
 *   essentially no effect on ringing. On a bed-slinger it would, and the packer
 *   would want heavy parts near the centre of travel. Here it does not, so the
 *   packer optimises purely for plate count and compactness.
 *
 *   There is no active chamber heater. That makes the enclosure a heat trap for
 *   PLA rather than a help, which is why the PLA profile says to run with the
 *   door open, and why PLA and PETG-CF cannot share a plate even at the same
 *   layer height.
 */

export const PRINTERS = {
  'elegoo-cc2': {
    name: 'Elegoo Centauri Carbon 2',
    bed: { x: 256, y: 256, z: 256 },
    origin: 'front-left',            // Orca bed coordinates, so bed centre is 128,128
    kinematics: 'corexy',
    nozzle: 0.4,
    nozzleHardened: true,
    maxNozzleC: 350,
    maxBedC: 110,
    maxSpeed: 500,
    maxAccel: 20000,
    enclosed: true,
    heatedChamber: false,
    // Keep-out for the purge chute / wiper, front right.
    excludeArea: [[246, 0], [256, 0], [256, 20], [246, 20]],
    orca: {
      printerModel: 'Elegoo Centauri Carbon 2',
      printerSettingsId: 'Elegoo Centauri Carbon 2 0.4 nozzle',
      printSettingsId: '0.20mm Standard @Elegoo CC2 0.4 nozzle',
      filamentSuffix: '@ECC2',
      gcodeFlavor: 'klipper',
      bedType: 'Textured PEI Plate',
    },
  },
  'elegoo-cc': {
    name: 'Elegoo Centauri Carbon',
    bed: { x: 256, y: 256, z: 256 },
    origin: 'front-left',
    kinematics: 'corexy',
    nozzle: 0.4,
    nozzleHardened: true,
    maxNozzleC: 320,
    maxBedC: 110,
    maxSpeed: 500,
    maxAccel: 20000,
    enclosed: true,
    heatedChamber: false,
    excludeArea: [[246, 0], [256, 0], [256, 20], [246, 20]],
    orca: {
      printerModel: 'Elegoo Centauri Carbon',
      printerSettingsId: 'Elegoo Centauri Carbon 0.4 nozzle',
      printSettingsId: '0.20mm Standard @Elegoo CC 0.4 nozzle',
      filamentSuffix: '@ECC',
      gcodeFlavor: 'klipper',
      bedType: 'Textured PEI Plate',
    },
  },
  custom: {
    name: 'Custom',
    bed: { x: 220, y: 220, z: 250 },
    origin: 'front-left',
    kinematics: 'cartesian',
    nozzle: 0.4,
    nozzleHardened: false,
    maxNozzleC: 300, maxBedC: 110, maxSpeed: 300, maxAccel: 5000,
    enclosed: false, heatedChamber: false, excludeArea: [],
    orca: { printerModel: 'Custom', printerSettingsId: '', printSettingsId: '', filamentSuffix: '', gcodeFlavor: 'marlin', bedType: 'Textured PEI Plate' },
  },
};

/**
 * Materials. Temperatures and speeds are starting points from published Elegoo
 * guidance and community profiles for this machine, not gospel - they are meant
 * to be overridden once you have printed a coupon.
 *
 * The TPU acceleration is not a typo. Stock is 20000 mm/s2; TPU wants about a
 * fortieth of that, because the filament's compliance turns any acceleration
 * into a delayed, smeared extrusion.
 */
export const MATERIALS = {
  PLA: {
    name: 'PLA', nozzleC: 215, bedC: 60, firstNozzleC: 220, firstBedC: 60,
    fanPct: 100, accel: 10000, outerSpeed: 180, innerSpeed: 300, infillSpeed: 270,
    orcaType: 'PLA', colour: '#7fbf5f', shrinkPct: 0.3,
    note: 'Run with the door open. This enclosure has no chamber heater, so it just traps heat, and PLA softens in it.',
  },
  PETG: {
    name: 'PETG', nozzleC: 240, bedC: 75, firstNozzleC: 245, firstBedC: 75,
    fanPct: 50, accel: 8000, outerSpeed: 140, innerSpeed: 220, infillSpeed: 200,
    orcaType: 'PETG', colour: '#4a9fd4', shrinkPct: 0.4,
  },
  'PETG-CF': {
    name: 'PETG-CF', nozzleC: 250, bedC: 75, firstNozzleC: 255, firstBedC: 75,
    fanPct: 35, accel: 6000, outerSpeed: 120, innerSpeed: 180, infillSpeed: 170,
    orcaType: 'PETG', colour: '#3a4048', shrinkPct: 0.2,
    note: 'Dry it first. The stock nozzle is hardened, so no nozzle change is needed. Crack the door on long bridges.',
  },
  TPU: {
    name: 'TPU 95A', nozzleC: 225, bedC: 45, firstNozzleC: 230, firstBedC: 45,
    fanPct: 40, accel: 500, outerSpeed: 25, innerSpeed: 35, infillSpeed: 40,
    orcaType: 'TPU', colour: '#d4954a', shrinkPct: 0.0,
    note: 'Acceleration drops to 500 mm/s2, about a fortieth of stock. TPU turns acceleration into smeared extrusion.',
  },
};

/** Layer-height ladder, in the OrcaSlicer family's naming. */
export const QUALITIES = [
  { h: 0.08, name: 'Extra Fine' },
  { h: 0.12, name: 'Fine' },
  { h: 0.16, name: 'Optimal' },
  { h: 0.20, name: 'Standard' },
  { h: 0.24, name: 'Draft' },
  { h: 0.28, name: 'Extra Draft' },
];

export const INFILL_PATTERNS = [
  'grid', 'gyroid', 'cubic', 'adaptivecubic', 'triangles', 'honeycomb',
  'crosshatch', 'lightning', 'rectilinear', 'concentric',
];

/** Default process settings. Per-part overrides start from these. */
export function defaultProcess(printer = PRINTERS['elegoo-cc2'], material = MATERIALS.PLA) {
  return {
    layerHeight: 0.20,
    firstLayerHeight: 0.20,
    lineWidth: printer.nozzle * 1.05,
    wallLoops: 3,
    topShellLayers: 5,
    bottomShellLayers: 4,
    infillPct: 20,
    infillPattern: 'grid',
    supports: false,
    supportType: 'tree(auto)',
    supportThresholdDeg: 40,
    brim: 'auto_brim',
    brimWidth: 5,
    seam: 'aligned',
    material: material.name,
    nozzleC: material.nozzleC,
    bedC: material.bedC,
  };
}

/**
 * The joint fit stops.
 *
 * A slider with free numbers invites values that cannot print; these are the
 * five that are worth having, and the slider snaps to them. Standard is the
 * joint script's own defaults. tol is the clearance across the mating face,
 * bossFit the per-side clearance on the locating boss flanks - the only fit that
 * controls position - and shaftFit the deliberately loose clearance on the snap
 * shafts, which exists so the snaps cannot argue with the boss about location.
 */
export const FIT_STOPS = [
  { key: 'press', label: 'Press', tol: 0.05, bossFit: 0.06, shaftFit: 0.20,
    note: 'Needs a measured printer and a mallet. It will not come apart again.' },
  { key: 'tight', label: 'Tight', tol: 0.10, bossFit: 0.08, shaftFit: 0.25,
    note: 'For a well-tuned machine and a joint you do not intend to open.' },
  { key: 'standard', label: 'Standard', tol: 0.15, bossFit: 0.10, shaftFit: 0.30,
    note: 'The design default. Start here, print the coupon, then move if it binds or rattles.' },
  { key: 'loose', label: 'Loose', tol: 0.20, bossFit: 0.13, shaftFit: 0.35,
    note: 'For a machine that runs wide, or for PETG, which swells a little.' },
  { key: 'free', label: 'Free', tol: 0.25, bossFit: 0.15, shaftFit: 0.40,
    note: 'Assembles with no force. Location gets sloppy; use only if everything else binds.' },
];

export const DEFAULT_FIT = 2;   // Standard
