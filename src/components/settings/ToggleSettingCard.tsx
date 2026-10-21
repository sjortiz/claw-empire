interface ToggleSettingCardProps {
  label: string;
  checked: boolean;
  onToggle: () => void;
  title?: string;
  disabled?: boolean;
  describedBy?: string;
}

export function ToggleSettingCard({
  label,
  checked,
  onToggle,
  title,
  disabled = false,
  describedBy,
}: ToggleSettingCardProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5 sm:px-4"
      style={{ borderColor: "var(--th-card-border)", background: "var(--th-input-bg)" }}
    >
      <label className="text-sm" style={{ color: "var(--th-text-secondary)" }}>
        {label}
      </label>
      <button
        type="button"
        aria-pressed={checked}
        aria-label={label}
        aria-disabled={disabled}
        aria-describedby={describedBy}
        onClick={() => {
          if (!disabled) onToggle();
        }}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${disabled ? "opacity-50 cursor-not-allowed" : ""} ${checked ? "bg-blue-500" : "bg-slate-600"}`}
        title={title}
      >
        <div
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${
            checked ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
