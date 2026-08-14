import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import { parse } from 'yaml';

import type {
  OracleEnvelopeValidation,
  OracleEnvelopeValidator,
  OracleEventEnvelope,
  ValidationIssue,
} from './oracle-event.types.js';

interface OpenApiDocument {
  readonly components?: {
    readonly schemas?: Readonly<Record<string, unknown>>;
  };
}

export class OpenApiOracleEnvelopeValidator implements OracleEnvelopeValidator {
  private readonly validateEnvelope: ValidateFunction<OracleEventEnvelope>;

  public constructor(openApiPath = defaultOpenApiPath()) {
    const document = parse(readFileSync(openApiPath, 'utf8')) as OpenApiDocument;
    const componentSchemas = document.components?.schemas;
    const envelopeSchema = componentSchemas?.['OracleEventEnvelope'];

    if (componentSchemas === undefined || envelopeSchema === undefined) {
      throw new Error('OracleEventEnvelope is missing from the OpenAPI contract');
    }

    const schema = buildStandaloneSchema(envelopeSchema, componentSchemas);
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      removeAdditional: false,
      validateFormats: true,
    });
    ajv.addFormat('uuid', UUID_PATTERN);
    ajv.addFormat('date-time', { type: 'string', validate: isDateTime });
    ajv.addFormat('int64', { type: 'number', validate: Number.isSafeInteger });
    this.validateEnvelope = ajv.compile<OracleEventEnvelope>(schema as AnySchema);
  }

  public validate(payload: unknown): OracleEnvelopeValidation {
    if (this.validateEnvelope(payload)) {
      return { valid: true, value: payload };
    }

    return {
      valid: false,
      issues: (this.validateEnvelope.errors ?? []).map(mapValidationIssue),
    };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RFC3339_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isDateTime(value: string): boolean {
  return RFC3339_DATE_TIME_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function defaultOpenApiPath(): string {
  const configured = process.env['COMMODITY_CHAIN_OPENAPI_PATH'];
  return configured === undefined
    ? fileURLToPath(new URL('../../../../packages/contracts/openapi.yaml', import.meta.url))
    : resolve(configured);
}

function buildStandaloneSchema(
  envelopeSchema: unknown,
  componentSchemas: Readonly<Record<string, unknown>>,
): unknown {
  const requiredNames = collectReferencedSchemaNames(envelopeSchema, componentSchemas);
  const definitions = Object.fromEntries(
    [...requiredNames].map((name) => {
      const definition = componentSchemas[name];
      if (definition === undefined) {
        throw new Error(`OpenAPI schema ${name} referenced by OracleEventEnvelope is missing`);
      }
      return [name, rewriteComponentReferences(definition)];
    }),
  );

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: definitions,
    ...(rewriteComponentReferences(envelopeSchema) as Readonly<Record<string, unknown>>),
  };
}

function collectReferencedSchemaNames(
  root: unknown,
  componentSchemas: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const pending: unknown[] = [root];

  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== 'object') {
      continue;
    }

    for (const [key, value] of Object.entries(current)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = componentSchemaName(value);
        if (name !== null && !names.has(name)) {
          names.add(name);
          pending.push(componentSchemas[name]);
        }
      } else {
        pending.push(value);
      }
    }
  }

  return names;
}

function rewriteComponentReferences(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteComponentReferences);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (key === '$ref' && typeof child === 'string') {
        const name = componentSchemaName(child);
        return [key, name === null ? child : `#/$defs/${name}`];
      }
      return [key, rewriteComponentReferences(child)];
    }),
  );
}

function componentSchemaName(reference: string): string | null {
  const prefix = '#/components/schemas/';
  return reference.startsWith(prefix) ? reference.slice(prefix.length) : null;
}

function mapValidationIssue(error: ErrorObject): ValidationIssue {
  const reason = error.message ?? error.keyword;
  return error.instancePath === '' ? { reason } : { field: error.instancePath, reason };
}
