import { Ajv, type ErrorObject } from "ajv";

/** JSON Schema of spec.json; also shown to SpecWriter, so descriptions are written for the model. */
export const specSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  title: "PlugForge plugin spec",
  type: "object",
  additionalProperties: false,
  required: ["name", "package", "mainClass", "description", "commands", "acceptance"],
  properties: {
    name: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{1,63}$", description: "Plugin name in plugin.yml, PascalCase, e.g. SimpleHomes" },
    package: { type: "string", pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$", description: "Java package, e.g. dev.plugforge.simplehomes" },
    mainClass: { type: "string", pattern: "^[A-Z][A-Za-z0-9_]*$", description: "Main class simple name, e.g. SimpleHomesPlugin" },
    description: { type: "string", minLength: 1, maxLength: 300 },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "usage"],
        properties: {
          name: { type: "string", pattern: "^[a-z0-9_-]+$" },
          description: { type: "string", minLength: 1 },
          usage: { type: "string", minLength: 1, description: "e.g. /home [name]" },
          aliases: { type: "array", items: { type: "string", pattern: "^[a-z0-9_-]+$" } },
          permission: {
            type: "string",
            pattern: "^[a-z0-9_.-]+$",
            description: "Only when Bukkit's default denial is fine; omit it when a custom noPermission message is wanted",
          },
          checksPermission: {
            type: "string",
            pattern: "^[a-z0-9_.-]+$",
            description: "Permission the command checks in code (sending its own noPermission message) instead of declaring it in plugin.yml",
          },
          playerOnly: { type: "boolean" },
        },
      },
    },
    permissions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["node", "default"],
        properties: {
          node: { type: "string", pattern: "^[a-z0-9_.-]+$" },
          description: { type: "string" },
          default: { enum: ["true", "false", "op", "not op"] },
        },
      },
    },
    config: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "type", "default"],
        properties: {
          key: { type: "string", pattern: "^[a-z0-9_-]+(\\.[a-z0-9_-]+)*$", description: "Dotted config.yml path, e.g. homes.max-per-player" },
          type: { enum: ["string", "int", "double", "boolean", "string-list"] },
          default: {},
          description: { type: "string" },
        },
      },
    },
    guis: {
      type: "array",
      description: "Inventory menus: exact titles and button names, so code and live tests agree before the code exists",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "rows", "items"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9_-]+$" },
          title: { type: "string", minLength: 1, description: "Exact plain-text title; may contain %placeholders%" },
          rows: { type: "integer", minimum: 1, maximum: 6 },
          openedBy: { type: "string", description: "Command or action that opens it, e.g. /shop" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "material", "action"],
              properties: {
                name: { type: "string", minLength: 1, description: "Exact plain-text display name; may contain %placeholders%" },
                material: { type: "string", pattern: "^[A-Z0-9_]+$", description: "Bukkit Material, e.g. BREAD" },
                slot: { type: "integer", minimum: 0, maximum: 53 },
                action: { type: "string", minLength: 1, description: "What a click does" },
              },
            },
          },
        },
      },
    },
    messages: {
      type: "object",
      description: "Every text the plugin sends, by camelCase key. Plain text; placeholders like %player% are allowed",
      propertyNames: { pattern: "^[a-z][A-Za-z0-9]*$" },
      additionalProperties: { type: "string", minLength: 1 },
    },
    acceptance: {
      type: "array",
      minItems: 1,
      // Cumulative over build phases; per-phase growth is limited by SpecWriter.
      maxItems: 80,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text"],
        properties: {
          id: { type: "string", pattern: "^AC[0-9]+$" },
          text: { type: "string", minLength: 1, description: "One observable behaviour a unit test can check" },
        },
      },
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description: "Defaults the agent chose because the user did not say (shown to the user for approval)",
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(specSchema);

function describe(e: ErrorObject): string {
  const at = e.instancePath ? e.instancePath.slice(1).replaceAll("/", ".") : "(root)";
  if (e.keyword === "additionalProperties") return `${at}: unknown field '${String(e.params.additionalProperty)}'`;
  if (e.keyword === "enum") return `${at}: must be one of ${(e.params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`;
  return `${at}: ${e.message}`;
}

/** Schema errors as short "path: problem" lines, empty when valid. */
export function schemaErrors(value: unknown): string[] {
  return validate(value) ? [] : [...new Set((validate.errors ?? []).map(describe))];
}
