interface ProgressBarProps {
  label: string
  /** 0 to 100; `null` while the total is not known. */
  percent: number | null
}

/** Thin bar below a line of text; without a value a bar moves along (still, with reduced motion). */
export function ProgressBar({ label, percent }: ProgressBarProps) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={percent === null ? undefined : 0}
      aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent === null ? undefined : percent}
      className="bg-muted mt-2 h-1 overflow-hidden rounded-full"
    >
      {percent === null ? (
        <i className="bg-foreground block h-full w-[30%] animate-[indeterminate_1.2s_ease-in-out_infinite] rounded-full motion-reduce:w-full motion-reduce:animate-none motion-reduce:opacity-35" />
      ) : (
        <i className="bg-foreground block h-full rounded-full transition-[width] duration-100 ease-linear motion-reduce:transition-none" style={{ width: `${percent}%` }} />
      )}
    </div>
  )
}
