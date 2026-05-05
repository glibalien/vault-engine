/**
 * Widget inference + helpers over describe-schema responses.
 *
 * The inference table is canonical — bundles MUST agree. See spec
 * docs/superpowers/specs/2026-05-03-mcp-app-foundations-2-3-design.md.
 */
import type { FieldType, Schema, SchemaField, WidgetValue } from "./types.js";

export function inferWidget(fieldType: FieldType, listItemType?: FieldType): WidgetValue {
  switch (fieldType) {
    case "string": return "text";
    case "enum": return "enum";
    case "number": return "number";
    case "date": return "date";
    case "boolean": return "bool";
    case "reference": return "link";
    case "list":
      if (listItemType === "reference") return "link";
      // string / enum / number / date / boolean → tags
      return "tags";
  }
}

export function widgetForField(field: SchemaField): WidgetValue {
  return field.ui?.widget ?? inferWidget(field.type, field.list_item_type);
}

export function claimedFields(schema: Schema): SchemaField[] {
  return schema.fields;
}

export function filterableFields(schema: Schema): SchemaField[] {
  return schema.fields.filter(f => widgetForField(f) !== "textarea");
}
