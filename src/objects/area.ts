/**
 * InfoArea (AREA). Active on save, no activation step. The resource answers JSON on BW/4HANA
 * and XML on classic releases; the legacy reader handles both.
 */
import { MEDIA_TYPES, bwSeg, freshRead, type BwClient } from '../bw/client.js';
import { validateArgs } from '../format/validate.js';
import { ToolError } from '../format/errors.js';
import { bwCreateInfoArea, bwGetInfoarea, bwMoveObject } from '../legacy/infoarea.js';
import { bwDelete } from '../legacy/delete.js';
import type { JsonObject } from '../catalog/tools.js';
import { isNotFound, statusText, type Location, type ObjectAdapter, type Spec, type WriteAction } from './adapter.js';

const CREATE: JsonObject = {
  type: 'object',
  properties: {
    description: { type: 'string' },
    parent: { type: 'string' },
  },
  required: ['description'],
  additionalProperties: false,
};
const UPDATE: JsonObject = { ...CREATE, required: [] };

interface AreaInfo {
  name: string;
  label: string;
  parent: string | null;
  status: string;
}

async function info(client: BwClient, name: string): Promise<AreaInfo> {
  const parsed = JSON.parse(await bwGetInfoarea(client, name)) as {
    name: string;
    label: string;
    parent_area: string | null;
    object_status: string;
  };
  return { name: parsed.name, label: parsed.label, parent: parsed.parent_area, status: parsed.object_status };
}

export const areaAdapter: ObjectAdapter = {
  type: 'AREA',
  label: 'InfoArea',

  describe(action) {
    const lines = [
      `AREA ${action} spec`,
      `  description   text, max 60${action === 'create' ? '                      (required)' : ''}`,
      '  parent        parent InfoArea; omit for top level',
      'An InfoArea is active as soon as it is saved. Objects are placed in it through their own',
      'info_area field (IOBJ, ADSO).',
    ];
    if (action === 'update') {
      lines.push('update moves the InfoArea to another parent. Changing the description is not supported yet.');
    }
    lines.push('Example', '  {"action":"create","type":"AREA","name":"ZSALES","spec":{"description":"Sales","parent":"ZBENCH_GENAIHUB"}}');
    return lines.join('\n');
  },

  check(action: WriteAction, name: string, spec: Spec | undefined) {
    if (action === 'delete') return [];
    const errors = validateArgs(action === 'create' ? CREATE : UPDATE, spec ?? {}).errors;
    if (!/^[A-Z0-9_]{1,30}$/i.test(name)) errors.push('name: 1–30 characters A–Z, 0–9, _');
    if (typeof spec?.description === 'string' && spec.description.length > 60) errors.push('description: at most 60 characters');
    return errors;
  },

  dependsOn(_action, _name, spec) {
    return typeof spec?.parent === 'string' ? [{ type: 'AREA', name: spec.parent.toUpperCase() }] : [];
  },

  targetInfoArea(name) {
    return name.toUpperCase();
  },

  async locate(client, name): Promise<Location> {
    try {
      await info(client, name);
      return { exists: true, infoArea: name.toUpperCase() };
    } catch (err) {
      if (isNotFound(err)) return { exists: false };
      throw err;
    }
  },

  async read(client, name, { detail }) {
    if (detail === 'raw') {
      return (await freshRead(`/sap/bw/modeling/area/${bwSeg(name.toLowerCase())}`, MEDIA_TYPES['area'])).body;
    }
    const a = await info(client, name);
    return [
      `AREA ${a.name} "${a.label}" · ${statusText(a.status)} · parent ${a.parent ?? '(top level)'}`,
      `Contents: bw_search(info_area="${a.name}")`,
    ].join('\n');
  },

  async create(name, spec, ctx) {
    await bwCreateInfoArea(ctx.client, {
      name,
      description: String(spec.description),
      parent_info_area: typeof spec.parent === 'string' ? spec.parent : undefined,
      package: ctx.package,
    });
    return { status: 'created', activated: true };
  },

  async update(name, spec, ctx) {
    const current = await info(ctx.client, name);
    const notes: string[] = [];
    if (typeof spec.description === 'string' && spec.description !== current.label) {
      throw new ToolError(
        'not_implemented',
        `Changing the description of InfoArea ${name.toUpperCase()} is not supported yet.`,
        'Leave description out, or change it in the BW Modeling Tools.',
      );
    }
    const parent = typeof spec.parent === 'string' ? spec.parent.toUpperCase() : undefined;
    if (parent && parent !== (current.parent ?? '')) {
      await bwMoveObject(ctx.client, { objectType: 'area', objectName: name, targetInfoArea: parent });
      notes.push(`moved to ${parent}`);
      return { status: 'changed', activated: true, notes };
    }
    return { status: 'unchanged' };
  },

  async delete(name, ctx) {
    await bwDelete(ctx.client, 'area', name);
    return { status: 'deleted' };
  },
};
