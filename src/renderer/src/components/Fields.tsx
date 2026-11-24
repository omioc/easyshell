import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';

import { IconCheck, IconChevronDown } from './Icons';
import { Popover } from './Overlay';
import type { PopoverAnchor } from './Overlay';

export interface FieldProps {
  label: string;
  hint?: string;
  error?: string | null;
  htmlFor?: string;
  children: ReactNode;
  /** Label and control on one line (used by the compact settings rows). */
  inline?: boolean;
}

export function Field({ label, hint, error, htmlFor, children, inline }: FieldProps) {
  return (
    <div className="field" data-inline={inline ? 'true' : 'false'}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="field-control">
        {children}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : hint ? (
          <p className="field-hint">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

interface BaseInputProps {
  value: string;
  id?: string;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  type?: InputHTMLAttributes<HTMLInputElement>['type'];
  spellCheck?: boolean;
  readOnly?: boolean;
  /** Stable hook for the UI tests that drive specific fields. */
  testId?: string;
}
export interface TextInputProps extends BaseInputProps {
  onValueChange: (value: string) => void;
  onEnter?: () => void;
}

export function TextInput({
  value,
  onValueChange,
  onEnter,
  id,
  placeholder,
  mono,
  invalid,
  disabled,
  autoFocus,
  inputMode,
  type = 'text',
  spellCheck = false,
  readOnly,
  testId,
}: TextInputProps) {
  return (
    <input
      id={id}
      className="input"
      data-testid={testId}
      data-mono={mono ? 'true' : undefined}
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      inputMode={inputMode}
      spellCheck={spellCheck}
      readOnly={readOnly}
      aria-invalid={invalid ? 'true' : undefined}
      data-invalid={invalid ? 'true' : undefined}
      onChange={(event) => onValueChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && onEnter) {
          event.preventDefault();
          onEnter();
        }
      }}
    />
  );
}


export interface DebouncedInputProps extends BaseInputProps {
  onCommit: (value: string) => void;
  /** Trailing delay in ms; text fields commit at ~250ms, never per keystroke. */
  delay?: number;
}

/**
 * Text input that reports its value on a trailing delay, so a settings write
 * does not fire (and re-theme the app) on every character.
 */
export function DebouncedInput({
  value,
  onCommit,
  delay = 250,
  id,
  placeholder,
  mono,
  invalid,
  disabled,
  type = 'text',
}: DebouncedInputProps) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const timer = useRef<number | null>(null);
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  const schedule = (next: string) => {
    setDraft(next);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      commitRef.current(next);
    }, delay);
  };

  const flush = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
    commitRef.current(draft);
  };

  return (
    <input
      id={id}
      className="input"
      data-mono={mono ? 'true' : undefined}
      type={type}
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      spellCheck={false}
      aria-invalid={invalid ? 'true' : undefined}
      data-invalid={invalid ? 'true' : undefined}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={() => {
        editing.current = false;
        flush();
      }}
      onChange={(event) => schedule(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') flush();
      }}
    />
  );
}

export interface NumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  id?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  testId?: string;
}

export function NumberInput({
  value,
  onCommit,
  id,
  min,
  max,
  step = 1,
  disabled,
  testId,
}: NumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(String(value));
  }, [value]);

  const commit = (raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min ?? 0, parsed));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      id={id}
      data-testid={testId}
      className="input input-number"
      type="number"
      value={draft}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onFocus={() => {
        editing.current = true;
      }}
      onBlur={() => {
        editing.current = false;
        commit(draft);
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        commit(event.target.value);
      }}
    />
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  testId?: string;
}

/**
 * A real dropdown, not a `<select>`.
 *
 * The native control draws its own arrow and its own list in the OS's colours:
 * a grey 3D popup on Windows, something else again on macOS, and no way to put
 * the app's surface, radius, shadow or font on either half. So the trigger is a
 * button that wears the same clothes as an `.input`, and the list is the app's
 * own popover with the same rows as a menu.
 *
 * Keyboard follows the listbox pattern: Enter/Space/Arrow opens, arrows walk the
 * options (Popover does that part), Enter or a click picks one, Escape closes.
 * The trigger keeps `aria-haspopup`/`aria-expanded`, and each row is an
 * `option` with `aria-selected`, so a screen reader still hears a dropdown.
 */
export function Select({ value, options, onChange, id, disabled, ariaLabel, testId }: SelectProps) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const [width, setWidth] = useState(0);
  const current = options.find((option) => option.value === value) ?? options[0];

  const show = () => {
    const node = trigger.current;
    if (!node || disabled) return;
    const rect = node.getBoundingClientRect();
    setWidth(rect.width);
    setAnchor({ x: rect.left, y: rect.bottom + 4, origin: 'top left' });
    setOpen(true);
  };

  /** Closing puts focus back on the trigger only when the user chose or escaped. */
  const close = (refocus = false) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };

  const choose = (next: string) => {
    onChange(next);
    close(true);
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="select"
        data-testid={testId}
        data-open={open ? 'true' : undefined}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(true) : show())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            show();
          }
        }}
      >
        <span className="select-label">{current?.label ?? ''}</span>
        <IconChevronDown size={12} />
      </button>

      <Popover
        open={open}
        anchor={anchor}
        onClose={() => close()}
        label={ariaLabel ?? current?.label ?? ''}
        className="select-menu"
        role="listbox"
      >
        <div className="select-list" style={{ minWidth: width }}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="select-option"
              onClick={() => choose(option.value)}
              onKeyDown={(event) => {
                // Owned here rather than by the sheet: closing a dropdown must
                // not also close the panel behind it.
                if (event.key === 'Escape') {
                  event.preventDefault();
                  event.stopPropagation();
                  close(true);
                }
              }}
            >
              <span className="select-option-label">{option.label}</span>
              {option.value === value ? <IconCheck size={13} /> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, disabled }: SwitchProps) {
  const id = useId();
  return (
    <span className="switch">
      <input
        id={id}
        className="switch-input"
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
    </span>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Stable hook for the UI tests that drive a specific choice. */
  testId?: string;
}

export interface SegmentedProps<T extends string> {
  name: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** Radio group styled as a segmented control: real radios, arrow-key native. */
export function Segmented<T extends string>({ name, value, options, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <label key={option.value} className="segmented-option" data-selected={option.value === value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            data-testid={option.testId}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  );
}