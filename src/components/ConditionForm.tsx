import { Checkbox, NumberField, SelectField, Text, TextField } from '@capra/core';
import { formFields, type FormField } from '../lib/conditionForm.ts';
import type { ConditionSchema } from '../lib/types.ts';

export interface ConditionFormProps {
  schema: ConditionSchema | undefined;
  values: Record<string, unknown>;
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
}

/**
 * The condition's settings form, generated from its own JSON Schema.
 *
 * Nothing about the fields is written here — labels, help text, options, and limits all
 * come from the schema the platform returned. `conf.name` is deliberately absent: it is
 * the feed identity and is filled in per feed at build time.
 */
export function ConditionForm({ schema, values, errors, onChange }: ConditionFormProps) {
  const fields = formFields(schema);

  if (fields.length === 0) {
    return (
      <Text variant="body-sm-normal" color="subtle">
        This condition takes no settings beyond the feed it watches.
      </Text>
    );
  }

  return (
    <div className="form-stack">
      {fields.map((field) => (
        <Field
          key={field.key}
          field={field}
          value={values[field.key]}
          error={errors[field.key]}
          onChange={onChange}
        />
      ))}
    </div>
  );
}

interface FieldProps {
  field: FormField;
  value: unknown;
  error?: string;
  onChange: (key: string, value: unknown) => void;
}

function Field({ field, value, error, onChange }: FieldProps) {
  const label = field.required ? `${field.label} *` : field.label;
  // The schema's own description is the help text; the error replaces it when set,
  // which is how Capra's field layout is documented to behave.
  const helperText = error ?? field.description;
  const appearance = error ? 'danger' : 'default';

  if (field.kind === 'boolean') {
    return (
      <div className="form-field">
        <Checkbox
          checked={value === true}
          onChange={(event) => onChange(field.key, event.target.checked)}
        >
          {field.label}
        </Checkbox>
        {field.description ? (
          <Text variant="body-xs-normal" color="subtle" as="div">
            {field.description}
          </Text>
        ) : null}
      </div>
    );
  }

  if (field.kind === 'enum') {
    return (
      <div className="form-field">
        <SelectField
          label={label}
          helperText={helperText}
          items={field.options.map((option) => ({ id: option, label: option }))}
          value={value === undefined || value === null ? undefined : String(value)}
          onChange={(key) => onChange(field.key, key === null ? undefined : String(key))}
        />
      </div>
    );
  }

  if (field.kind === 'number') {
    return (
      <div className="form-field">
        <NumberField
          label={label}
          helperText={helperText}
          appearance={appearance}
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          onChange={(next) => onChange(field.key, next)}
        />
      </div>
    );
  }

  const durationHint =
    field.kind === 'duration' && field.minDurationSeconds !== null
      ? `Minimum ${field.minDurationSeconds}s.`
      : null;

  return (
    <div className="form-field">
      <TextField
        label={label}
        helperText={
          helperText && durationHint
            ? `${helperText} ${durationHint}`
            : (helperText ?? durationHint ?? undefined)
        }
        appearance={appearance}
        placeholder={field.kind === 'duration' ? '60s' : undefined}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(next) => onChange(field.key, next)}
      />
    </div>
  );
}
