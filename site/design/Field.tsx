// A form field: label, input and a hint, tied together for a screen reader. Not used by a public page today; the
// account area will be.
import type { InputHTMLAttributes } from 'react';

export function Field({ id, label, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { id: string; label: string; hint?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint ? <p className="hint" id={`${id}-hint`}>{hint}</p> : null}
    </div>
  );
}
