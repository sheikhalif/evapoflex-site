/**
 * OrcaSlicer / ElegooSlicer project export.
 *
 * The output is the Bambu-flavoured 3MF both slicers treat as native. Getting
 * treated as native is the whole game, and it hangs on details that took real
 * source-reading to pin down:
 *
 *   The Application metadata string decides everything. OrcaSlicer's importer
 *   only honours instance transforms and per-object settings when the file
 *   declares a known application; otherwise transforms get baked into vertices
 *   and the plate layout is re-centred. "OrcaSlicer-1.2.0" is the one string
 *   that both OrcaSlicer (compatible old version, no warning) and ElegooSlicer
 *   (below its 1.3.0 dialog threshold) open without any dialog. It is a
 *   coincidence of two version checks in two repos, so re-verify after slicer
 *   updates. Never let the substring "PrusaSlicer" near this field - it routes
 *   the file to a geometry-only import path.
 *
 *   filament_colour must exist and be non-empty in project_settings.config or
 *   the config loader throws and the file "won't open". Its length defines the
 *   filament count, which fixes the required length of
 *   different_settings_to_system and inherits_group (filaments + 2).
 *
 *   Naming a real system preset in printer/print/filament_settings_id and
 *   listing ONLY changed keys in different_settings_to_system makes the slicer
 *   reset every unlisted key to that preset's value - a partial config is the
 *   designed path, not a hack.
 *
 *   The 3MF transform attribute is 12 numbers, the first nine a row-major 3x3
 *   whose COLUMNS are the basis vectors (row-vector convention), then the
 *   translation. Mesh vertices stay in part-local coordinates and placement
 *   lives entirely in the build item, which is also what makes position and
 *   rotation readable in the slicer's sidebar.
 */

const APP_TAG = 'OrcaSlicer-1.2.0';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f9 = (v) => {
  const r = Number(v.toPrecision(9));
  return Object.is(r, -0) ? '0' : String(r);
};

/**
 * @param {object[]} objects  [{id, name, mesh: {vertProperties, triVerts}, transform: {rot, x, y}, overrides}]
 *   transform.rot is the yaw on the plate; x, y the plate position in mm.
 *   overrides is {layer_height, wall_loops, ...} using Orca key names, or {}.
 * @param {object} printer  from presets: {orca, bed}
 * @param {object} material from presets
 * @param {object} proc     global process settings (defaultProcess shape)
 */
export async function build3MF(objects, printer, material, proc, { writeZip }) {
  const model = modelXML(objects);
  const modelSettings = modelSettingsXML(objects);
  const projectSettings = projectSettingsJSON(objects, printer, material, proc);

  return writeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: model },
    { name: 'Metadata/model_settings.config', data: modelSettings },
    { name: 'Metadata/project_settings.config', data: projectSettings },
  ]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

function modelXML(objects) {
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">${APP_TAG}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">EvapoFlex Print Prep</metadata>
 <resources>`);
  for (const o of objects) {
    const { vertProperties: V, triVerts: T } = o.mesh;
    parts.push(`  <object id="${o.id}" name="${esc(o.name)}" type="model">\n   <mesh>\n    <vertices>`);
    const nv = V.length / 3;
    const vlines = new Array(nv);
    for (let i = 0; i < nv; i++) {
      vlines[i] = `     <vertex x="${f9(V[i * 3])}" y="${f9(V[i * 3 + 1])}" z="${f9(V[i * 3 + 2])}"/>`;
    }
    parts.push(vlines.join('\n'));
    parts.push('    </vertices>\n    <triangles>');
    const nt = T.length / 3;
    const tlines = new Array(nt);
    for (let i = 0; i < nt; i++) {
      tlines[i] = `     <triangle v1="${T[i * 3]}" v2="${T[i * 3 + 1]}" v3="${T[i * 3 + 2]}"/>`;
    }
    parts.push(tlines.join('\n'));
    parts.push('    </triangles>\n   </mesh>\n  </object>');
  }
  parts.push(' </resources>\n <build>');
  for (const o of objects) {
    // matrix12 is [col0, col1, col2, translation] of the column-vector 3x4 -
    // exactly the order the 3MF attribute wants. If only a yaw and a position
    // were given, build it here.
    let m = o.matrix12;
    if (!m) {
      const t = o.transform || { rot: 0, x: 128, y: 128, z: 0 };
      const c = Math.cos(t.rot || 0), s = Math.sin(t.rot || 0);
      m = [c, s, 0, -s, c, 0, 0, 0, 1, t.x, t.y, t.z || 0];
    }
    parts.push(`  <item objectid="${o.id}" transform="${m.map(f9).join(' ')}" printable="1"/>`);
  }
  parts.push(' </build>\n</model>\n');
  return parts.join('\n');
}

function modelSettingsXML(objects) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>\n<config>'];
  for (const o of objects) {
    parts.push(`  <object id="${o.id}">\n    <metadata key="name" value="${esc(o.name)}"/>`);
    for (const [k, v] of Object.entries(o.overrides || {})) {
      parts.push(`    <metadata key="${esc(k)}" value="${esc(v)}"/>`);
    }
    parts.push(`    <part id="${o.id}" subtype="normal_part">
      <metadata key="name" value="${esc(o.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
    </part>
  </object>`);
  }
  parts.push(`  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="locked" value="false"/>`);
  objects.forEach((o, i) => {
    parts.push(`    <model_instance>
      <metadata key="object_id" value="${o.id}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="${400 + i}"/>
    </model_instance>`);
  });
  parts.push('  </plate>\n  <assemble>\n  </assemble>\n</config>\n');
  return parts.join('\n');
}

function projectSettingsJSON(objects, printer, material, proc) {
  const orca = printer.orca;
  const bed = printer.bed;
  const filamentName = `${material.orcaType === 'TPU' ? 'Generic TPU' : 'Elegoo ' + material.orcaType} ${orca.filamentSuffix}`.trim();

  // Only the keys we deliberately set differ from the named system presets; the
  // slicer resets everything unlisted back to the preset.
  const processDiff = ['layer_height', 'wall_loops', 'sparse_infill_density', 'sparse_infill_pattern',
    'enable_support', 'brim_type', 'seam_position'];
  const filamentDiff = ['nozzle_temperature', 'hot_plate_temp', 'textured_plate_temp'];

  const cfg = {
    version: '1.2.0',
    name: 'project_settings',
    from: 'project',

    printer_settings_id: orca.printerSettingsId,
    print_settings_id: orca.printSettingsId,
    filament_settings_id: [filamentName],

    printer_model: orca.printerModel,
    printer_variant: '0.4',
    printer_technology: 'FFF',
    gcode_flavor: orca.gcodeFlavor,
    nozzle_diameter: [String(printer.nozzle)],
    printable_area: [`0x0`, `${bed.x}x0`, `${bed.x}x${bed.y}`, `0x${bed.y}`],
    printable_height: String(bed.z),
    curr_bed_type: orca.bedType,

    layer_height: String(proc.layerHeight),
    initial_layer_print_height: String(proc.firstLayerHeight),
    wall_loops: String(proc.wallLoops),
    top_shell_layers: String(proc.topShellLayers),
    bottom_shell_layers: String(proc.bottomShellLayers),
    sparse_infill_density: `${proc.infillPct}%`,
    sparse_infill_pattern: proc.infillPattern,
    enable_support: proc.supports ? '1' : '0',
    support_type: proc.supportType,
    support_threshold_angle: String(proc.supportThresholdDeg),
    brim_type: proc.brim,
    brim_width: String(proc.brimWidth),
    seam_position: proc.seam,

    filament_type: [material.orcaType],
    filament_colour: [material.colour || '#2d7cb5'],
    filament_diameter: ['1.75'],
    nozzle_temperature: [String(material.nozzleC)],
    nozzle_temperature_initial_layer: [String(material.firstNozzleC)],
    hot_plate_temp: [String(material.bedC)],
    hot_plate_temp_initial_layer: [String(material.firstBedC)],
    textured_plate_temp: [String(material.bedC)],
    textured_plate_temp_initial_layer: [String(material.firstBedC)],

    different_settings_to_system: [processDiff.join(';'), filamentDiff.join(';'), ''],
    inherits_group: ['', '', ''],
  };
  return JSON.stringify(cfg, null, 1);
}

/** Orca key names for the per-part override card. */
export function orcaOverrides(partProc, globalProc) {
  const out = {};
  const set = (key, val, gval) => { if (String(val) !== String(gval)) out[key] = String(val); };
  set('layer_height', partProc.layerHeight, globalProc.layerHeight);
  set('wall_loops', partProc.wallLoops, globalProc.wallLoops);
  if (partProc.infillPct !== globalProc.infillPct) out.sparse_infill_density = `${partProc.infillPct}%`;
  set('sparse_infill_pattern', partProc.infillPattern, globalProc.infillPattern);
  if (partProc.supports !== globalProc.supports) out.enable_support = partProc.supports ? '1' : '0';
  set('support_type', partProc.supportType, globalProc.supportType);
  set('brim_type', partProc.brim, globalProc.brim);
  set('seam_position', partProc.seam, globalProc.seam);
  set('top_shell_layers', partProc.topShellLayers, globalProc.topShellLayers);
  set('bottom_shell_layers', partProc.bottomShellLayers, globalProc.bottomShellLayers);
  return out;
}
